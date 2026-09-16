// Replica desde cero (idempotente) toda la configuración de priorización de
// tickets en una BD de Odoo Online nueva: campos, cron y vistas. Resuelve los
// modelos y vistas base por xmlid (no por id crudo), así que sirve igual en
// cualquier BD que tenga Helpdesk instalado (segunda BD de pruebas, y más
// adelante producción). Incluye ya la mejora de antigüedad continua (§9 del
// handoff) — no crea la versión vieja escalonada.
//
// Uso: node replicar_configuracion.js <config-file-sin-extension>
// Ej:  node replicar_configuracion.js config.local2

const path = require('path');
const OdooClient = require('./odoo_client');

const TIPOS_CLIENTE = [
  { value: 'residencial', name: 'Residencial' },
  { value: 'empresarial', name: 'Empresarial' },
  { value: 'dedicado', name: 'Dedicado' },
];

const MOTIVOS = [
  { value: 'sin_servicio', name: 'Sin servicio (caída total)' },
  { value: 'intermitencia', name: 'Intermitencia recurrente' },
  { value: 'lentitud', name: 'Lentitud / degradación' },
  { value: 'falla_equipo', name: 'Falla de equipo (ONU/CPE/router)' },
  { value: 'falla_pbx', name: 'Falla de telefonía (PBX)' },
  { value: 'consulta', name: 'Consulta / soporte técnico' },
  { value: 'instalacion', name: 'Instalación nueva' },
  { value: 'reactivacion', name: 'Reactivación / reconexión' },
  { value: 'cambio_domicilio', name: 'Cambio de domicilio' },
  { value: 'upgrade', name: 'Upgrade / aumento de plan' },
  { value: 'cambio_plan', name: 'Cambio de plan' },
  { value: 'mantenimiento', name: 'Mantenimiento / revisión' },
  { value: 'retiro', name: 'Retiro de equipo / baja' },
  { value: 'facturacion', name: 'Facturación / administrativo' },
];

const CRON_CODE = `now = datetime.datetime.now()
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
    if t.x_antiguedad != a:
        vals['x_antiguedad'] = a
        t.write(vals)
        vals = {}

    score = t.x_score
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

async function getXmlidResId(client, module, name) {
  const [rec] = await client.searchRead('ir.model.data', [['module', '=', module], ['name', '=', name]], ['res_id']);
  if (!rec) throw new Error(`No se encontró el xmlid ${module}.${name}`);
  return rec.res_id;
}

async function fieldExists(client, model, name) {
  const f = await client.fieldsGet(model, [name]);
  return !!f[name];
}

async function crearSelectionField(client, { modelXmlModule, modelXmlName, name, description, opciones }) {
  if (await fieldExists(client, modelXmlModule === 'base' && modelXmlName === 'model_res_partner' ? 'res.partner' : 'helpdesk.ticket', name)) {
    console.log(`   ${name}: ya existe.`);
    return;
  }
  const modelId = await getXmlidResId(client, modelXmlModule, modelXmlName);
  const fieldId = await client.execute('ir.model.fields', 'create', [{
    model_id: modelId,
    name,
    field_description: description,
    ttype: 'selection',
    store: true,
    state: 'manual',
  }]);
  for (let i = 0; i < opciones.length; i++) {
    await client.execute('ir.model.fields.selection', 'create', [{
      field_id: fieldId,
      value: opciones[i].value,
      name: opciones[i].name,
      sequence: i,
    }]);
  }
  console.log(`   ${name}: creado con ${opciones.length} opciones.`);
}

async function crearCampoSimple(client, model, vals) {
  if (await fieldExists(client, model, vals.name)) {
    console.log(`   ${vals.name}: ya existe.`);
    return;
  }
  await client.execute('ir.model.fields', 'create', [vals]);
  console.log(`   ${vals.name}: creado.`);
}

async function crearOActualizarVista(client, { name, model, type, inheritModule, inheritName, arch, priority }) {
  const inheritId = await getXmlidResId(client, inheritModule, inheritName);
  const existentes = await client.searchRead('ir.ui.view', [['name', '=', name], ['inherit_id', '=', inheritId]], ['id']);
  if (existentes.length > 0) {
    await client.execute('ir.ui.view', 'write', [[existentes[0].id], { arch }]);
    console.log(`   vista "${name}": actualizada (id ${existentes[0].id}).`);
    return existentes[0].id;
  }
  const id = await client.execute('ir.ui.view', 'create', [{
    name,
    model,
    type,
    inherit_id: inheritId,
    arch,
    priority: priority || 16,
  }]);
  console.log(`   vista "${name}": creada (id ${id}).`);
  return id;
}

async function main() {
  const configFile = process.argv[2] || 'config.local';
  const config = require(path.resolve(process.cwd(), configFile));
  const client = new OdooClient(config.odoo);
  const uid = await client.authenticate();
  console.log(`Autenticado OK. uid=${uid}, db=${config.odoo.db}\n`);

  const helpdeskTicketModelId = await getXmlidResId(client, 'helpdesk', 'model_helpdesk_ticket');

  console.log('1) Campo res.partner.x_tipo_cliente...');
  await crearSelectionField(client, {
    modelXmlModule: 'base',
    modelXmlName: 'model_res_partner',
    name: 'x_tipo_cliente',
    description: 'Tipo de cliente',
    opciones: TIPOS_CLIENTE,
  });

  console.log('2) Campo helpdesk.ticket.x_motivo...');
  await crearSelectionField(client, {
    modelXmlModule: 'helpdesk',
    modelXmlName: 'model_helpdesk_ticket',
    name: 'x_motivo',
    description: 'Motivo (priorización)',
    opciones: MOTIVOS,
  });

  console.log('3) Campo helpdesk.ticket.x_impacto (computed)...');
  await crearCampoSimple(client, 'helpdesk.ticket', {
    model_id: helpdeskTicketModelId,
    name: 'x_impacto',
    field_description: 'Impacto (priorización)',
    ttype: 'integer',
    store: true,
    state: 'manual',
    compute: "mapa = {'residencial': 1, 'empresarial': 3, 'dedicado': 5}\nfor record in self:\n    record['x_impacto'] = mapa.get(record.partner_id.x_tipo_cliente, 1)",
    depends: 'partner_id.x_tipo_cliente',
  });

  console.log('4) Campo helpdesk.ticket.x_peso_motivo (computed)...');
  await crearCampoSimple(client, 'helpdesk.ticket', {
    model_id: helpdeskTicketModelId,
    name: 'x_peso_motivo',
    field_description: 'Peso del motivo',
    ttype: 'integer',
    store: true,
    state: 'manual',
    compute: "mapa = {'sin_servicio':10,'intermitencia':7,'lentitud':5,'falla_equipo':5,'falla_pbx':5,'consulta':1,'instalacion':8,'reactivacion':6,'cambio_domicilio':5,'upgrade':5,'cambio_plan':3,'mantenimiento':3,'retiro':2,'facturacion':1}\nfor record in self:\n    record['x_peso_motivo'] = mapa.get(record.x_motivo, 0)",
    depends: 'x_motivo',
  });

  console.log('5) Campo helpdesk.ticket.x_antiguedad (Float, manual)...');
  await crearCampoSimple(client, 'helpdesk.ticket', {
    model_id: helpdeskTicketModelId,
    name: 'x_antiguedad',
    field_description: 'Antiguedad (puntos, continua)',
    ttype: 'float',
    store: true,
    state: 'manual',
    copied: true,
  });

  console.log('6) Campo helpdesk.ticket.x_override (Boolean)...');
  await crearCampoSimple(client, 'helpdesk.ticket', {
    model_id: helpdeskTicketModelId,
    name: 'x_override',
    field_description: 'Override critico',
    ttype: 'boolean',
    store: true,
    state: 'manual',
  });

  console.log('7) Campo helpdesk.ticket.x_score (Float, computed)...');
  await crearCampoSimple(client, 'helpdesk.ticket', {
    model_id: helpdeskTicketModelId,
    name: 'x_score',
    field_description: 'Prioridad (score)',
    ttype: 'float',
    store: true,
    state: 'manual',
    compute: "for record in self:\n    if record.x_override:\n        record['x_score'] = 999\n    else:\n        record['x_score'] = (record.x_peso_motivo or 0) + (record.x_impacto or 0) + (record.x_antiguedad or 0)",
    depends: 'x_peso_motivo,x_impacto,x_antiguedad,x_override',
  });

  console.log('8) Campo helpdesk.ticket.x_zona (related a partner_id.x_studio_zona)...');
  await crearCampoSimple(client, 'helpdesk.ticket', {
    model_id: helpdeskTicketModelId,
    name: 'x_zona',
    field_description: 'Zona',
    ttype: 'selection',
    related: 'partner_id.x_studio_zona',
    store: true,
    state: 'manual',
  });

  console.log('\n9) Cron "Priorizacion - recalcular antiguedad y score"...');
  const cronExistente = await client.searchRead('ir.cron', [['name', '=', 'Priorizacion - recalcular antiguedad y score']], ['id']);
  if (cronExistente.length > 0) {
    await client.execute('ir.cron', 'write', [[cronExistente[0].id], { code: CRON_CODE, active: true }]);
    console.log(`   cron: actualizado (id ${cronExistente[0].id}).`);
  } else {
    const cronId = await client.execute('ir.cron', 'create', [{
      name: 'Priorizacion - recalcular antiguedad y score',
      model_id: helpdeskTicketModelId,
      state: 'code',
      code: CRON_CODE,
      interval_number: 30,
      interval_type: 'minutes',
      active: true,
    }]);
    console.log(`   cron: creado (id ${cronId}).`);
  }

  console.log('\n10) Vistas...');
  await crearOActualizarVista(client, {
    name: 'res.partner.form.priorizacion',
    model: 'res.partner',
    type: 'form',
    inheritModule: 'base',
    inheritName: 'view_partner_form',
    arch: `<data><xpath expr="//field[@name='l10n_mx_edi_curp']" position="after"><label for="x_tipo_cliente"/><field name="x_tipo_cliente" nolabel="1"/></xpath></data>`,
  });

  await crearOActualizarVista(client, {
    name: 'helpdesk.ticket.form.priorizacion',
    model: 'helpdesk.ticket',
    type: 'form',
    inheritModule: 'helpdesk',
    inheritName: 'helpdesk_ticket_view_form',
    arch: `<data><xpath expr="//field[@name='partner_id']" position="after"><field name="x_motivo"/><field name="x_score" readonly="1"/><field name="x_override"/></xpath></data>`,
  });

  await crearOActualizarVista(client, {
    name: 'helpdesk.ticket.list.priorizacion',
    model: 'helpdesk.ticket',
    type: 'list',
    inheritModule: 'helpdesk',
    inheritName: 'helpdesk_tickets_view_tree',
    arch: `<data><xpath expr="//field[@name='stage_id']" position="after"><field name="x_score"/><field name="x_override" column_invisible="1"/><field name="x_zona" optional="show"/></xpath><xpath expr="//list" position="attributes"><attribute name="default_order">x_score desc, create_date asc</attribute><attribute name="decoration-danger">x_override</attribute></xpath></data>`,
  });

  await crearOActualizarVista(client, {
    name: 'helpdesk.ticket.kanban.priorizacion',
    model: 'helpdesk.ticket',
    type: 'kanban',
    inheritModule: 'helpdesk',
    inheritName: 'helpdesk_ticket_view_kanban',
    arch: `<data><xpath expr="//kanban" position="attributes"><attribute name="default_order">x_score desc, create_date asc</attribute></xpath></data>`,
  });

  console.log('\n11) Disparando el cron para poblar todo por primera vez...');
  const [cronFinal] = await client.searchRead('ir.cron', [['name', '=', 'Priorizacion - recalcular antiguedad y score']], ['id']);
  await client.execute('ir.cron', 'method_direct_trigger', [[cronFinal.id]]);
  console.log('   OK.');

  console.log('\nReplicación completa terminada sin errores.');
}

main().catch((err) => {
  console.error('\nError:', err.message || err);
  process.exit(1);
});
