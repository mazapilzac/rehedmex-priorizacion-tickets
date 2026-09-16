// Diagnóstico de solo lectura: revisa qué tanto de la config de priorización
// ya existe en una instancia antes de tocar nada.
// Uso: node diagnostico.js [archivo-de-config-sin-.js]  (default: config.local)
const path = require('path');
const configFile = process.argv[2] || 'config.local';
const config = require(path.resolve(__dirname, configFile));
const OdooClient = require('./odoo_client');

const CAMPOS_ESPERADOS = [
  'x_motivo',
  'x_tipo_cliente',
  'x_impacto',
  'x_peso_motivo',
  'x_antiguedad',
  'x_override',
  'x_score',
  'x_zona',
];

async function main() {
  const client = new OdooClient(config.odoo);
  const uid = await client.authenticate();
  console.log(`Autenticado OK. uid=${uid}, db=${config.odoo.db}`);

  const modeloHelpdesk = await client.execute('ir.model', 'search_read', [
    [['model', '=', 'helpdesk.ticket']],
    ['id', 'name'],
  ]);
  console.log('Modelo helpdesk.ticket instalado:', modeloHelpdesk.length > 0);
  if (modeloHelpdesk.length === 0) {
    console.log('=> Falta instalar/activar la app Helpdesk en esta instancia.');
    return;
  }

  const camposTicket = await client.fieldsGet('helpdesk.ticket', CAMPOS_ESPERADOS);
  console.log('\nCampos ya existentes en helpdesk.ticket:');
  for (const campo of CAMPOS_ESPERADOS) {
    console.log(`  ${campo}: ${camposTicket[campo] ? 'EXISTE (' + camposTicket[campo].type + ')' : 'falta'}`);
  }

  const equipos = await client.searchRead('helpdesk.team', [], ['id', 'name']);
  console.log('\nEquipos de Helpdesk:');
  equipos.forEach((e) => console.log(`  [${e.id}] ${e.name}`));

  const totalTickets = await client.execute('helpdesk.ticket', 'search_count', [[]]);
  console.log(`\nTotal de tickets en la instancia: ${totalTickets}`);

  const crons = await client.searchRead(
    'ir.cron',
    [['name', 'ilike', 'priorizacion']],
    ['id', 'name', 'active', 'interval_number', 'interval_type']
  );
  console.log('\nCrons relacionados a "priorizacion":', crons.length ? crons : '(ninguno)');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
