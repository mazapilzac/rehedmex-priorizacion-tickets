// Aplica en la BD de pruebas la mejora diseñada en §9 del handoff:
// antigüedad continua (interpolación), desempate por create_date en vistas,
// y umbrales de estrellas recalibrados.
//
// NOTA: Odoo 19 no permite cambiar el ttype de un campo existente vía RPC
// ("Elimínelo y créelo de nuevo"). Borrar campos está bloqueado por política
// de seguridad de esta sesión. En vez de eso, se crean x_antiguedad2 y
// x_score2 (Float) nuevos, y se migran cron + vistas a usarlos. Los campos
// viejos (x_antiguedad, x_score, ids 92988/92992) quedan huérfanos — se
// pueden borrar después a mano desde Studio cuando se quiera, sin prisa.
// Idempotente: si los campos/vistas ya están migrados, los vuelve a escribir
// igual (no falla), y create() de un campo que ya existe con el mismo name
// fallaría, así que primero se revisa si ya existe.
const config = require('./config.local');
const OdooClient = require('./odoo_client');

const MODEL_ID = 1252; // Helpdesk Ticket

const NUEVO_CRON_CODE = `now = datetime.datetime.now()
reactivos = [12, 9, 1]
agendados = [10, 23, 24]
scored = reactivos + agendados

anclas_reactivo = [(0, 0), (1, 0), (4, 2), (8, 4), (24, 8), (48, 14)]
anclas_agendado = [(0, 0), (2, 0), (4, 3), (7, 6), (14, 10)]

def interpolar(x, anclas):
    if x <= anclas[0][0]:
        return float(anclas[0][1])
    for i in range(len(anclas) - 1):
        x0, y0 = anclas[i]
        x1, y1 = anclas[i + 1]
        if x <= x1:
            return round(y0 + (y1 - y0) * (x - x0) / (x1 - x0), 2)
    return float(anclas[-1][1])

tickets = env['helpdesk.ticket'].search([('team_id', 'in', scored), ('stage_id.fold', '=', False)])
for t in tickets:
    if not t.create_date:
        continue
    delta = now - t.create_date
    horas = delta.total_seconds() / 3600.0
    dias = delta.days
    if t.team_id.id in reactivos:
        a = interpolar(horas, anclas_reactivo)
    else:
        a = interpolar(dias, anclas_agendado)

    vals = {}
    if t.x_antiguedad2 != a:
        vals['x_antiguedad2'] = a
        t.write(vals)
        vals = {}

    score = t.x_score2
    if t.x_override or score >= 18:
        prio = '3'
    elif score >= 11:
        prio = '2'
    elif score >= 5:
        prio = '1'
    else:
        prio = '0'
    col = 1 if t.x_override else 0
    if t.priority != prio:
        vals['priority'] = prio
    if t.color != col:
        vals['color'] = col
    if vals:
        t.write(vals)`;

async function main() {
  const client = new OdooClient(config.odoo);
  await client.authenticate();

  console.log('1) Creando x_antiguedad2 (Float) si no existe...');
  let existentes = await client.fieldsGet('helpdesk.ticket', ['x_antiguedad2', 'x_score2']);
  if (!existentes.x_antiguedad2) {
    await client.execute('ir.model.fields', 'create', [{
      model_id: MODEL_ID,
      name: 'x_antiguedad2',
      field_description: 'Antiguedad (puntos, continua)',
      ttype: 'float',
      store: true,
      state: 'manual',
      copied: true,
    }]);
    console.log('   creado.');
  } else {
    console.log('   ya existía.');
  }

  console.log('2) Creando x_score2 (Float, computed) si no existe...');
  existentes = await client.fieldsGet('helpdesk.ticket', ['x_antiguedad2', 'x_score2']);
  if (!existentes.x_score2) {
    await client.execute('ir.model.fields', 'create', [{
      model_id: MODEL_ID,
      name: 'x_score2',
      field_description: 'Prioridad (score, continuo)',
      ttype: 'float',
      store: true,
      state: 'manual',
      compute: "for record in self:\n    if record.x_override:\n        record['x_score2'] = 999\n    else:\n        record['x_score2'] = (record.x_peso_motivo or 0) + (record.x_impacto or 0) + (record.x_antiguedad2 or 0)",
      depends: 'x_peso_motivo,x_impacto,x_antiguedad2,x_override',
    }]);
    console.log('   creado.');
  } else {
    console.log('   ya existía.');
  }

  console.log('3) Actualizando código del cron (id 131) para usar los campos nuevos...');
  await client.execute('ir.cron', 'write', [[131], { code: NUEVO_CRON_CODE }]);
  console.log('   OK.');

  console.log('4) Actualizando vistas (form, list, kanban) para usar x_score2 + desempate por create_date...');
  await client.execute('ir.ui.view', 'write', [
    [9661],
    { arch: `<data><xpath expr="//field[@name='partner_id']" position="after"><field name="x_motivo"/><field name="x_score2" readonly="1"/><field name="x_override"/></xpath></data>` },
  ]);
  await client.execute('ir.ui.view', 'write', [
    [9662],
    {
      arch: `<data><xpath expr="//field[@name='stage_id']" position="after"><field name="x_score2"/><field name="x_override" column_invisible="1"/></xpath><xpath expr="//list" position="attributes"><attribute name="default_order">x_score2 desc, create_date asc</attribute><attribute name="decoration-danger">x_override</attribute></xpath></data>`,
    },
  ]);
  await client.execute('ir.ui.view', 'write', [
    [9664],
    { arch: `<data><xpath expr="//kanban" position="attributes"><attribute name="default_order">x_score2 desc, create_date asc</attribute></xpath></data>` },
  ]);
  console.log('   OK.');

  console.log('5) Disparando el cron manualmente para recalcular todo ahora...');
  await client.execute('ir.cron', 'method_direct_trigger', [[131]]);
  console.log('   OK.');

  console.log('\nListo. Corre verificar.js para revisar resultados.');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
