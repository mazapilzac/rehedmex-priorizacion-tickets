const config = require('./config.local');
const OdooClient = require('./odoo_client');

async function main() {
  const client = new OdooClient(config.odoo);
  await client.authenticate();

  const campos = await client.searchRead(
    'ir.model.fields',
    [['model', '=', 'helpdesk.ticket'], ['name', 'in', ['x_score', 'x_antiguedad', 'x_impacto', 'x_peso_motivo', 'x_zona']]],
    ['name', 'ttype', 'compute', 'depends', 'store', 'related']
  );
  console.log(JSON.stringify(campos, null, 2));

  const cron = await client.searchRead(
    'ir.cron',
    [['name', 'ilike', 'priorizacion']],
    ['id', 'name', 'code', 'model_id', 'state']
  );
  console.log('\n--- CRON ---');
  console.log(JSON.stringify(cron, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
