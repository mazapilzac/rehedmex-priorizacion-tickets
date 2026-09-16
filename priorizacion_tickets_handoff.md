# Priorización de Tickets — REHEDMEX (documento de traspaso)

> Contexto para continuar el proyecto en **Claude Code**. Resume el diseño, lo ya
> construido, decisiones, trampas y backlog. Está en español; el código en inglés.

---

## 1. Contexto de negocio

- **Empresa:** REHEDMEX / REHEDMAS — ISP en Saltillo (Coahuila) con operación en Zacatecas.
- **Sistema:** Odoo, operación centrada en **Helpdesk** (~9,439 tickets en la instancia).
- **Objetivo:** dar a cada ticket un **score de prioridad calculado** para mejorar los
  tiempos de atención, romper empates de la cola, y rutear por cercanía geográfica.
- **Stack alrededor:** MikroWisp (gestión ISP), The Dude (monitoreo), FreePBX (telefonía),
  Studio (mucha personalización previa en `helpdesk.ticket` y `res.partner`).

## 2. Modelo de priorización (definición funcional)

**Fórmula (aditiva):**

```
score = peso_motivo + impacto + antiguedad      # o 999 si override
```

Se eligió **aditivo** (no multiplicativo) a propósito: en un ISP la continuidad del
servicio manda; la gravedad de la falla domina y el valor del cliente refuerza, no
amplifica. Un corte total no debe perder contra la lentitud de un cliente premium.

### Factores

**Impacto** — por tipo de cliente (`res.partner.x_tipo_cliente`):

| Valor        | Puntos |
|--------------|--------|
| residencial  | 1      |
| empresarial  | 3      |
| dedicado     | 5      |

**Peso del motivo** — `helpdesk.ticket.x_motivo` (una sola escala para fallas y agendados):

| Clave             | Etiqueta                          | Peso |
|-------------------|-----------------------------------|------|
| sin_servicio      | Sin servicio (caída total)        | 10   |
| intermitencia     | Intermitencia recurrente          | 7    |
| lentitud          | Lentitud / degradación            | 5    |
| falla_equipo      | Falla de equipo (ONU/CPE/router)  | 5    |
| falla_pbx         | Falla de telefonía (PBX)          | 5    |
| consulta          | Consulta / soporte técnico        | 1    |
| instalacion       | Instalación nueva                 | 8    |
| reactivacion      | Reactivación / reconexión         | 6    |
| cambio_domicilio  | Cambio de domicilio               | 5    |
| upgrade           | Upgrade / aumento de plan         | 5    |
| cambio_plan       | Cambio de plan                    | 3    |
| mantenimiento     | Mantenimiento / revisión          | 3    |
| retiro            | Retiro de equipo / baja           | 2    |
| facturacion       | Facturación / administrativo      | 1    |

**Antigüedad** — la escribe un cron (no es computed: depende del paso del tiempo).
Dos velocidades según el **arquetipo del equipo**:

- **Reactivo (por horas):** `<1h→0, <4h→2, <8h→4, <24h→8, >=24h→14`
- **Agendado (por días):** `<2d→0, <=4d→3, <=7d→6, >7d→10`

**Override** — booleano manual; fuerza `score = 999` (tope de la cola).

**Zona** — `helpdesk.ticket.x_zona` (related a `partner_id.x_studio_zona`), para
**agrupar la cola por cercanía** y ordenar por score dentro de cada zona (anti ping-pong
del técnico). NO entra en el score; es capa de ruteo, no de prioridad.

### Arquetipo por equipo (en la BD de pruebas los IDs fueron)

| Equipo                    | ID (test) | Arquetipo |
|---------------------------|-----------|-----------|
| SOPORTE TECNICO           | 12        | reactivo  |
| INFRAESTRUCTURA           | 9         | reactivo  |
| ATENCION AL CLIENTE       | 1         | reactivo  |
| INSTALACIONES             | 10        | agendado  |
| RECUPERACION DE CLIENTES  | 23        | agendado  |
| PROMESA DE PAGO           | 24        | agendado  |
| ADMINISTRACION            | 13        | (sin score) |

> **Importante:** los IDs son de la BD de pruebas. En el módulo (ver §4) esto se hace
> portable con un campo `x_archetipo` por equipo, en vez de IDs fijos.

### Mapeo a estrellas nativas y color (pulido visual)

El cron también mapea el score al campo nativo `priority` (estrellas) y a `color`:

- `priority`: override o `score>=11` → '3'; `>=6` → '2'; `>=3` → '1'; resto '0'.
- `color`: 1 (rojo) si override, 0 si no. El kanban usa `highlight_color="color"`.
- Lista: `decoration-danger="x_override"` (fila roja).

## 3. Estado actual

### Construido y VALIDADO en la BD de pruebas (Odoo Online, vía RPC / campos manuales)

Campos:
- `res.partner.x_tipo_cliente` (selection)
- `helpdesk.ticket.x_motivo` (selection, 14 opciones)
- `helpdesk.ticket.x_impacto` (integer, computed de `partner_id.x_tipo_cliente`)
- `helpdesk.ticket.x_peso_motivo` (integer, computed de `x_motivo`)
- `helpdesk.ticket.x_antiguedad` (integer, lo escribe el cron)
- `helpdesk.ticket.x_override` (boolean)
- `helpdesk.ticket.x_score` (integer, computed = peso+impacto+antiguedad, o 999)
- `helpdesk.ticket.x_zona` (selection, related a `partner_id.x_studio_zona`)

Automatización:
- Cron `ir.cron` "Priorizacion - recalcular antiguedad y score", cada 30 min:
  recalcula antigüedad por arquetipo y actualiza `priority` y `color`.

Vistas (herencias):
- Form ticket: `x_motivo`, `x_score`, `x_override`, `x_zona` tras `partner_id`.
- Lista ticket: columna `x_score` + `default_order="x_score desc"` + `decoration-danger`.
- Kanban ticket: `default_order="x_score desc"`.
- Form contacto: `x_tipo_cliente` tras `l10n_mx_edi_curp` (con label explícito).

Prueba de punta a punta: ticket con motivo=sin_servicio + cliente dedicado → score 29;
marcado override → 999, 3 estrellas, rojo. Correcto.

### Pendiente / abierto

- **Calidad de datos (bloqueante real):** `x_motivo` y `x_tipo_cliente` están casi vacíos
  en los tickets reales. Sin ellos el score ≈ "solo antigüedad", y como casi todo es
  viejo, **casi todos empatan en el tope**. Poblar estos datos es el mayor multiplicador.
- **Antigüedad se satura y umbrales de estrellas — DISEÑADO, pendiente de aplicar en
  vivo.** Ver §9 para la fórmula (antigüedad continua por interpolación + desempate por
  `create_date` + umbrales recalibrados) y el código listo en
  `cron_recalcular_prioridad.py`. Falta: cambiar `x_antiguedad`/`x_score` de Integer a
  Float, actualizar la Acción Planificada en Odoo Online, y `default_order` de las vistas.
- **Variable "plan / mensualidad"** (idea del usuario: "el que paga más, primero").
  Diferida. El plan es selección de nombres, no precio → requiere mapear plan→mensualidad,
  ESCALAR a un rango acotado (que no aplaste al outage) y resolver el solape con
  `x_tipo_cliente` (ambos miden valor del cliente; el plan debería refinar/reemplazar al
  impacto, no apilarse).
- **Fase 2 coordenadas** ("siguiente más cercano"): requiere geocodificar (~75% de
  contactos sin lat/long) y una herramienta de despacho que calcule distancia desde la
  posición del técnico. Es proyecto aparte. Hoy la Zona (81% poblada) cubre el ruteo.
- **Revertir el ticket de prueba 8908** (quedó con override/motivo de prueba).

## 4. El módulo Odoo (para odoo.sh / on-premise)

Existe un addon empaquetado: **`rehedmex_priorizacion`** (entregado como zip). Es la vía
para versionar y desplegar en odoo.sh o servidor propio. Estructura:

```
rehedmex_priorizacion/
  __manifest__.py            # depends: ['helpdesk']
  __init__.py
  models/__init__.py
  models/res_partner.py      # x_tipo_cliente (Selection)
  models/helpdesk_team.py    # x_archetipo (Selection: reactivo/agendado) -> PORTABLE
  models/helpdesk_ticket.py  # x_motivo, x_tipo_cliente(related), x_zona(related),
                             # x_impacto, x_peso_motivo, x_antiguedad, x_override,
                             # x_score (computes) + cron_recalcular_prioridad()
  data/ir_cron.xml           # cron cada 30 min -> model.cron_recalcular_prioridad()
  views/helpdesk_team_views.xml
  views/helpdesk_ticket_views.xml
  views/res_partner_views.xml
  README.md
```

Refs de vistas base confirmadas en la instancia:
- Form ticket: `helpdesk.helpdesk_ticket_view_form`
- Lista ticket: `helpdesk.helpdesk_tickets_view_tree`
- Kanban ticket: `helpdesk.helpdesk_ticket_view_kanban`
- Form equipo: `helpdesk.helpdesk_team_view_form`
- Form contacto: `base.view_partner_form`
- Modelo: `helpdesk.model_helpdesk_ticket`, `helpdesk.model_helpdesk_team`

**Correcciones que le faltan al módulo (sincronizar con lo aprendido en test):**
1. `res_partner_views.xml`: colocar `x_tipo_cliente` **después de `l10n_mx_edi_curp`
   con label explícito** (hoy está tras `phone`, que lo deja sin etiqueta / invisible).
2. Añadir la vista **kanban** con `default_order="x_score desc"`.
3. Lista: añadir `decoration-danger="x_override"` (+ campo `x_override` column_invisible)
   y columna `x_zona optional`.
4. El método del cron debe también setear `priority` (estrellas) y `color` (rojo override),
   como quedó en test.
5. `x_zona` depende del campo Studio `x_studio_zona` en `res.partner` (existe en la BD de
   REHEDMEX). Documentar esa dependencia.

Lógica del cron (versión módulo, Python real; en Odoo Online el cron va en `state='code'`
y OJO: safe_eval **prohíbe `record.campo = x` (STORE_ATTR)**, usar `record.write({...})`):

```python
@api.model
def cron_recalcular_prioridad(self):
    from datetime import datetime
    now = datetime.now()
    tickets = self.search([('team_id.x_archetipo', '!=', False),
                           ('stage_id.fold', '=', False)])
    for t in tickets:
        if not t.create_date:
            continue
        delta = now - t.create_date
        horas, dias = delta.total_seconds()/3600.0, delta.days
        a = self._puntos_antiguedad(t.team_id.x_archetipo, horas, dias)
        if t.x_antiguedad != a:
            t.x_antiguedad = a   # en módulo Python OK; en cron Online usar write()
```

## 5. Entornos y despliegue (CRÍTICO)

- **Producción decidida (ahora): Odoo Online (SaaS).** Odoo Online **NO permite instalar
  módulos personalizados** — solo Studio y apps de la tienda. Por tanto, en Online el
  módulo NO aplica: hay que **replicar la configuración** (campos manuales + acción
  planificada + reglas + ajustes de vista), tal como se hizo en la BD de pruebas.
- **Vía de replicación a Online:** repetir en la instancia real los mismos campos/cron/
  vistas. Se puede por Studio a mano (runbook) o por RPC (`/web/dataset/call_kw`) contra
  la instancia autenticada, que es como se construyó el test.
- **Futuro: odoo.sh** (Git-backed) o **on-premise** — ahí SÍ corre el módulo, y odoo.sh
  despliega al hacer `git push`. El usuario evaluará precios/ventajas de sh después.
- La **BD de pruebas es un trial y caduca**; su contenido es desechable.

## 6. Trampas encontradas (para no repetirlas)

- **El tiempo no se recalcula solo:** un computed basado en `now()` se queda congelado
  (now() no es dependencia). Requiere **cron** que reescriba `x_antiguedad`; el `x_score`
  (computed que depende de `x_antiguedad`) se recalcula al reescribirla.
- **safe_eval del cron de Odoo prohíbe STORE_ATTR** (`t.campo = x`). Usar `t.write({...})`.
- **Caché de vistas multi-worker en Odoo Online (SaaS):** tras editar una vista por RPC,
  el navegador puede servir la versión vieja un rato; sincroniza sola en segundos/reloads.
- **Colocación de campos en formularios:** insertar un `<field>` tras un campo con widget
  especial (p. ej. `vat`/autocomplete, o el bloque de teléfono) puede dejarlo **sin
  etiqueta**. Usar un anclaje en un campo "normal" o `<label for=.../> + <field nolabel="1"/>`.
- **Related selection a campo Studio:** `x_zona` = related a `partner_id.x_studio_zona`
  funciona; documentar la dependencia del campo Studio.

## 7. Cómo continuar en Claude Code (sugerencia)

1. **Repo del módulo:** inicializar/clonar el repo con `rehedmex_priorizacion`, aplicar las
   5 correcciones de §4, y dejarlo listo para odoo.sh. Mantener commits limpios.
2. **Script de replicación a Odoo Online:** un script Python (RPC `call_kw`) idempotente
   que cree/actualice los campos, el cron, las reglas y las vistas en la instancia real
   (equivalente al módulo, pero como campos manuales para SaaS). Útil ya, porque prod = Online.
3. **Mejoras de algoritmo:** antigüedad continua + desempate por fecha; recalibración de
   umbrales; (después) variable de plan escalada.
4. **Datos:** rutina de carga masiva de `x_tipo_cliente` y captura de `x_motivo`.

> Regla de oro del proyecto: **el score vale lo que valen sus datos.** Antes de sumar
> variables, poblar motivo/tipo y arreglar la saturación de antigüedad.

## 8. Backlog priorizado (impacto vs esfuerzo)

1. **[Alto/Bajo]** ~~Antigüedad continua + desempate por fecha~~ — diseñado, ver §9.
   Falta aplicarlo en producción.
2. **[Alto/Medio]** Poblar `x_tipo_cliente` (masivo) y `x_motivo` (en captura).
3. **[Alto/Medio]** Script RPC idempotente de replicación a producción (Online).
4. **[Medio/Bajo]** ~~Recalibrar umbrales de estrellas~~ — diseñado, ver §9.
5. **[Medio/Medio]** Sincronizar el módulo (5 correcciones) para el futuro sh.
6. **[Medio/Alto]** Variable de plan/mensualidad (mapear, escalar, resolver solape).
7. **[Alto/Alto]** SLA por tipo/motivo; integración The Dude→override de caída masiva.
8. **[Alto/Alto]** Fase 2 coordenadas + despacho por cercanía (requiere geocodificación).
9. **[Alto/Alto]** BI: tableros de tiempos de atención, SLA, reincidencia, zona, técnico.

## 9. Antigüedad continua + desempate + umbrales recalibrados (diseño)

Resuelve backlog #1 y #4. Código completo y listo para pegar en la Acción Planificada:
`Priorizaticket/cron_recalcular_prioridad.py`.

**Antigüedad continua** — interpolación lineal por tramos entre las mismas anclas que ya
existían, pero **el tope se corre más lejos** para que los tickets viejos dejen de
empatar todos en el mismo escalón instantáneamente:

- Reactivo (horas): anclas `(0,0) (1,0) (4,2) (8,4) (24,8) (48,14)` — el tope 14 se
  alcanza a las 48h (antes: escalón a las 24h). Más allá de 48h se queda plano en 14.
- Agendado (días): anclas `(0,0) (2,0) (4,3) (7,6) (14,10)` — el tope 10 se alcanza a
  los 14 días (antes: escalón a los 7 días).

Esto **reduce** los empates (los tickets de 24-48h / 4-14d ahora se distribuyen en vez
de saltar todos al tope), pero no los elimina para los ticket aún más viejos — para eso:

**Desempate por fecha de creación** — no se codifica en el número de antigüedad (eso
lo saturaría igual); se resuelve en la vista con `default_order="x_score desc,
create_date asc"` en lista y kanban. Entre dos tickets con el mismo score, gana el más
antiguo (FIFO), determinista y sin tocar la fórmula.

**Umbrales de estrellas recalibrados** — rango real del score sin override: mínimo ~2
(residencial + consulta + antigüedad 0), máximo ~29 (dedicado + sin_servicio +
antigüedad máxima reactivo). Los umbrales viejos (3★ desde 11) quedaban muy bajos
respecto a ese rango:

| Estrellas | Antes  | Ahora |
|-----------|--------|-------|
| 3★        | >=11   | >=18  |
| 2★        | >=6    | >=11  |
| 1★        | >=3    | >=5   |

Ejemplo de sanity check: sin_servicio+dedicado ya arranca en 2★ (score 15) y sube a 3★
solo con ~8h de antigüedad (score 19) — un corte total en cliente dedicado escala rápido
sin partir directo en el tope.

**Requisitos para aplicar en producción (Odoo Online, vía RPC o Studio):**
1. Cambiar `x_antiguedad` de Integer a Float (dígitos 6,2).
2. Cambiar `x_score` de Integer a Float (la fórmula del computed no cambia).
3. Reemplazar el código de la Acción Planificada por el de `cron_recalcular_prioridad.py`.
4. Añadir `create_date asc` como segundo criterio de `default_order` en lista y kanban.

**Constantes ajustables** (si al ver resultados reales hay que afinar): las anclas de
antigüedad y los tres umbrales de estrellas están como constantes nombradas al inicio
del archivo `.py`, no hay que tocar la lógica de interpolación para recalibrar.

### Aplicado en la BD de pruebas (`priorizaciondeticket.odoo.com`) — 2026-09-15

**Trampa nueva encontrada:** Odoo 19 no permite cambiar el `ttype` de un campo existente
vía RPC (`ir.model.fields.write`) — responde "Elimínelo y créelo de nuevo". Borrar campos
está bloqueado por política de seguridad del entorno de agente usado. Solución sin
borrado: se crearon campos **nuevos** en paralelo en vez de mutar los viejos:

- `x_antiguedad2` (Float, id 92996) — reemplaza a `x_antiguedad` (Integer, id 92988).
- `x_score2` (Float, id 92998, computed) — reemplaza a `x_score` (Integer, id 92992).

El cron (id 131) y las vistas form/list/kanban de priorización (ids 9661/9662/9664) ya
apuntan a los campos `...2`. **Los campos viejos `x_antiguedad`/`x_score` quedaron
huérfanos** (ya no los escribe ni los muestra nada) — se pueden borrar a mano desde
Studio cuando se quiera (ahí sí es un click, sin restricción). Si se llega a portar esto
al módulo Odoo (§4) o a producción, ahí conviene crearlos ya como Float desde el inicio
con los nombres definitivos `x_antiguedad`/`x_score`, sin arrastrar el sufijo `2`.

Verificado con datos reales (script `verificar.js`): 7 tickets con antigüedad continua
no redonda (prueba de que interpola), y el desempate por `create_date` ordena
correctamente varios tickets con el mismo score por fecha de creación ascendente.
Distribución de estrellas resultante en equipos con score: 0★=0, 1★=9, 2★=490, 3★=17 —
sigue concentrada en 2★ porque **la causa raíz sigue siendo la falta de
`x_motivo`/`x_tipo_cliente` poblados** (backlog #2), no el algoritmo de antigüedad.

Scripts usados (en el repo, ver `Priorizaticket/`): `odoo_client.js` (cliente RPC
genérico), `diagnostico.js` / `inspeccionar_campos.js` (solo lectura),
`aplicar_antiguedad_continua.js` (idempotente, es el que hizo el cambio),
`verificar.js`. Snapshot del estado previo en `snapshots/v0.1-estado-antes-de-antiguedad-continua.md`.
