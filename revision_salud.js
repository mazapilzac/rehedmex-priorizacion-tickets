// Revisión de salud genérica, solo lectura, para cualquier instancia ya
// configurada. No escribe nada (a diferencia de revision_completa.js, que sí
// hacía una prueba en vivo de override — aquí se omite a propósito quando la
// instancia es producción con datos reales).
//
// Uso: node revision_salud.js <config-sin-.js> [sufijo-campos]
// Ej:  node revision_salud.js config.produccion        (campos x_antiguedad/x_score)
//      node revision_salud.js config.local 2           (campos x_antiguedad2/x_score2)
const path = require('path');
const configFile = process.argv[2] || 'config.local';
const sufijo = process.argv[3] || '';
const config = require(path.resolve(__dirname, configFile));
const OdooClient = require('./odoo_client');

const CAMPO_ANTIGUEDAD = 'x_antiguedad' + sufijo;
const CAMPO_SCORE = 'x_score' + sufijo;
const EQUIPOS_REACTIVOS = [12, 9, 1];
const EQUIPOS_AGENDADOS = [10, 23, 24];
const EQUIPOS_SCORED = [...EQUIPOS_REACTIVOS, ...EQUIPOS_AGENDADOS];
const EQUIPO_SIN_SCORE = 13; // ADMINISTRACION

async function main() {
  const client = new OdooClient(config.odoo);
  await client.authenticate();
  const problemas = [];

  const [cron] = await client.searchRead('ir.cron', [['name', '=', 'Priorizacion - recalcular antiguedad y score']], ['active', 'interval_number', 'interval_type', 'nextcall']);
  console.log('1) Cron:', cron.active ? 'ACTIVO' : 'INACTIVO', `cada ${cron.interval_number} ${cron.interval_type}`, 'próxima corrida:', cron.nextcall);
  if (!cron.active) problemas.push('El cron está inactivo.');

  const sinScore = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', '=', EQUIPO_SIN_SCORE], [CAMPO_ANTIGUEDAD, '!=', 0]],
    ['id', CAMPO_ANTIGUEDAD],
    { limit: 5 }
  );
  console.log(`\n2) Tickets de ADMINISTRACION con ${CAMPO_ANTIGUEDAD} != 0 (no deberían tocarse):`, sinScore.length);
  if (sinScore.length > 0) problemas.push('ADMINISTRACION tiene tickets tocados por el cron.');

  const sinMotivo = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', 'in', EQUIPOS_SCORED], ['x_motivo', '=', false], ['stage_id.fold', '=', false]],
    ['id', 'x_peso_motivo', 'x_impacto', CAMPO_SCORE],
    { limit: 5 }
  );
  console.log(`\n3) Tickets activos sin x_motivo (peso debería quedar en 0, sin error):`, sinMotivo.length);
  const conError = sinMotivo.filter((t) => t.x_peso_motivo !== 0);
  if (conError.length > 0) problemas.push('Hay tickets sin x_motivo cuyo x_peso_motivo no cayó en 0.');

  const conZona = await client.execute('helpdesk.ticket', 'search_count', [[['x_zona', '!=', false]]]);
  const total = await client.execute('helpdesk.ticket', 'search_count', [[]]);
  console.log(`\n4) Tickets con x_zona poblada: ${conZona} de ${total} (${((conZona / total) * 100).toFixed(1)}%)`);

  const totalActivos = await client.execute('helpdesk.ticket', 'search_count', [[['team_id', 'in', EQUIPOS_SCORED], ['stage_id.fold', '=', false]]]);
  const conAntiguedad = await client.execute('helpdesk.ticket', 'search_count', [[['team_id', 'in', EQUIPOS_SCORED], ['stage_id.fold', '=', false], [CAMPO_ANTIGUEDAD, '>', 0]]]);
  console.log(`\n5) Tickets activos en equipos con score: ${totalActivos}, con ${CAMPO_ANTIGUEDAD} > 0: ${conAntiguedad}`);

  const scores = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', 'in', EQUIPOS_SCORED], ['stage_id.fold', '=', false]],
    [CAMPO_SCORE],
    { limit: 5000 }
  );
  const valores = scores.map((t) => t[CAMPO_SCORE]);
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  console.log(`\n6) Rango de ${CAMPO_SCORE} en tickets activos con score: min=${min} max=${max} (n=${valores.length})`);
  if (min < 0) problemas.push('Hay scores negativos.');

  const dist = {};
  for (const p of ['0', '1', '2', '3']) {
    dist[p] = await client.execute('helpdesk.ticket', 'search_count', [[['team_id', 'in', EQUIPOS_SCORED], ['stage_id.fold', '=', false], ['priority', '=', p]]]);
  }
  console.log('\n7) Distribución de estrellas:', JSON.stringify(dist));

  console.log('\n=== RESUMEN ===');
  console.log(problemas.length === 0 ? 'Todo en orden, sin problemas detectados.' : problemas);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
