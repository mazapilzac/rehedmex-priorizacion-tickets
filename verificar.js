const config = require('./config.local');
const OdooClient = require('./odoo_client');

async function main() {
  const client = new OdooClient(config.odoo);
  await client.authenticate();

  const tickets = await client.searchRead(
    'helpdesk.ticket',
    [['team_id', 'in', [12, 9, 1, 10, 23, 24]], ['stage_id.fold', '=', false]],
    ['id', 'name', 'team_id', 'x_motivo', 'x_impacto', 'x_peso_motivo', 'x_antiguedad2', 'x_score2', 'priority', 'x_override', 'create_date'],
    { order: 'x_score2 desc, create_date asc', limit: 15 }
  );
  console.log('Top 15 por x_score2 (desc), desempate create_date (asc):');
  tickets.forEach((t) => {
    console.log(
      `  #${t.id} [${t.team_id[1]}] motivo=${t.x_motivo || '-'} impacto=${t.x_impacto} peso=${t.x_peso_motivo} antig=${t.x_antiguedad2} score=${t.x_score2} prio=${t.priority} override=${t.x_override} creado=${t.create_date}`
    );
  });

  const conDecimales = await client.execute('helpdesk.ticket', 'search_count', [
    [['x_antiguedad2', '>', 0], ['x_antiguedad2', 'not in', [0, 2, 3, 4, 6, 8, 10, 14]]],
  ]);
  console.log(`\nTickets con antigüedad continua (valor no redondo, prueba de que interpola de verdad): ${conDecimales}`);

  const distribucionPrioridad = {};
  for (const p of ['0', '1', '2', '3']) {
    distribucionPrioridad[p] = await client.execute('helpdesk.ticket', 'search_count', [
      [['team_id', 'in', [12, 9, 1, 10, 23, 24]], ['stage_id.fold', '=', false], ['priority', '=', p]],
    ]);
  }
  console.log('\nDistribución de estrellas (umbrales recalibrados):', distribucionPrioridad);
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
