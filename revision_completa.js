// Revisión de salud del setup en la BD de pruebas antes de replicar a una
// segunda base. Solo lectura, no modifica nada.
const config = require('./config.local');
const OdooClient = require('./odoo_client');

const EQUIPOS_REACTIVOS = [12, 9, 1];
const EQUIPOS_AGENDADOS = [10, 23, 24];
const EQUIPOS_SCORED = [...EQUIPOS_REACTIVOS, ...EQUIPOS_AGENDADOS];
const EQUIPO_SIN_SCORE = 13; // ADMINISTRACION

async function main() {
  const client = new OdooClient(config.odoo);
  await client.authenticate();
  const problemas = [];

  // 1) Cron activo y con el intervalo esperado
  const [cron] = await client.searchRead('ir.cron', [['id', '=', 131]], ['active', 'interval_number', 'interval_type', 'nextcall']);
  console.log('1) Cron:', cron.active ? 'ACTIVO' : 'INACTIVO', `cada ${cron.interval_number} ${cron.interval_type}`, 'próxima corrida:', cron.nextcall);
  if (!cron.active) problemas.push('El cron está inactivo.');
  if (cron.interval_number !== 30 || cron.interval_type !== 'minutes') problemas.push('El intervalo del cron cambió de 30 minutos.');

  // 2) Equipo sin score (ADMINISTRACION) no debe tener x_antiguedad2 tocado por el cron
  const sinScore = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', '=', EQUIPO_SIN_SCORE], ['x_antiguedad2', '!=', 0]],
    ['id', 'x_antiguedad2'],
    { limit: 5 }
  );
  console.log(`\n2) Tickets de ADMINISTRACION con x_antiguedad2 != 0 (no deberían tocarse):`, sinScore.length);
  if (sinScore.length > 0) problemas.push(`ADMINISTRACION tiene ${sinScore.length} tickets con x_antiguedad2 poblado; el cron no debería tocarlos.`);

  // 3) Override: debe forzar score=999, prioridad 3, color 1
  const overrides = await client.searchRead(
    'helpdesk.ticket',
    [['x_override', '=', true]],
    ['id', 'x_score2', 'priority', 'color']
  );
  console.log(`\n3) Tickets con override=true: ${overrides.length}`);
  overrides.forEach((t) => {
    const ok = t.x_score2 === 999 && t.priority === '3' && t.color === 1;
    console.log(`   #${t.id} score=${t.x_score2} prio=${t.priority} color=${t.color} ${ok ? 'OK' : 'MAL'}`);
    if (!ok) problemas.push(`Ticket override #${t.id} no tiene score=999/prio=3/color=1.`);
  });
  if (overrides.length === 0) console.log('   (ninguno activo ahora mismo, no se puede validar en vivo)');

  // 4) Motivo/tipo_cliente vacíos no deben romper el cálculo (deben caer a 0/1 sin error)
  const sinMotivo = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', 'in', EQUIPOS_SCORED], ['x_motivo', '=', false], ['stage_id.fold', '=', false]],
    ['id', 'x_peso_motivo', 'x_impacto', 'x_score2'],
    { limit: 5 }
  );
  console.log(`\n4) Tickets activos sin x_motivo (peso debería quedar en 0, sin error):`, sinMotivo.length);
  sinMotivo.forEach((t) => console.log(`   #${t.id} peso=${t.x_peso_motivo} impacto=${t.x_impacto} score=${t.x_score2}`));
  const conError = sinMotivo.filter((t) => t.x_peso_motivo !== 0);
  if (conError.length > 0) problemas.push('Hay tickets sin x_motivo cuyo x_peso_motivo no cayó en 0.');

  // 5) Campos huérfanos (x_antiguedad, x_score viejos) - confirmar que ya no los usa ninguna vista
  const vistasConViejos = await client.searchRead(
    'ir.ui.view',
    [['model', '=', 'helpdesk.ticket'], ['arch_db', 'like', '"x_score"']],
    ['id', 'name']
  );
  console.log(`\n5) Vistas que aún referencian el campo viejo x_score (debería ser 0):`, vistasConViejos.length);
  if (vistasConViejos.length > 0) {
    vistasConViejos.forEach((v) => console.log(`   ${v.name} (id ${v.id})`));
    problemas.push('Hay vistas que todavía referencian x_score (el campo viejo, ya huérfano).');
  }

  // 6) x_zona sigue funcionando (no debió tocarse)
  const conZona = await client.execute('helpdesk.ticket', 'search_count', [[['x_zona', '!=', false]]]);
  const total = await client.execute('helpdesk.ticket', 'search_count', [[]]);
  console.log(`\n6) Tickets con x_zona poblada: ${conZona} de ${total} (${((conZona / total) * 100).toFixed(1)}%)`);

  // 7) Rango de x_score2 sano (sin negativos, sin nulls inesperados en equipos con score)
  const scores = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', 'in', EQUIPOS_SCORED], ['stage_id.fold', '=', false]],
    ['x_score2'],
    { limit: 5000 }
  );
  const valores = scores.map((t) => t.x_score2);
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  console.log(`\n7) Rango de x_score2 en tickets activos con score: min=${min} max=${max} (n=${valores.length})`);
  if (min < 0) problemas.push('Hay scores negativos, algo está mal en la fórmula.');

  console.log('\n=== RESUMEN ===');
  if (problemas.length === 0) {
    console.log('Todo en orden, sin problemas detectados.');
  } else {
    console.log(`${problemas.length} problema(s) encontrado(s):`);
    problemas.forEach((p) => console.log('  - ' + p));
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
