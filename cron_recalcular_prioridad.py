# Cron "Priorizacion - recalcular antiguedad y score" (v2: antiguedad continua)
#
# Pensado para pegarse tal cual en una Accion Planificada de Odoo Online
# (Ajustes tecnicos > Automatizacion > Acciones planificadas, campo "Codigo Python",
# modelo helpdesk.ticket). safe_eval PROHIBE `record.campo = x` (STORE_ATTR):
# siempre usar record.write({...}).
#
# Requiere, antes de activar esto en produccion:
#   - x_antiguedad: cambiar de Integer a Float (dígitos 6,2)
#   - x_score: cambiar de Integer a Float (la formula de la computed no cambia,
#     solo que ahora suma un float en vez de un int)
#   - Vistas lista/kanban: default_order="x_score desc, create_date asc"
#     (el desempate real de los tickets ya saturados en el tope lo da esto,
#     no la interpolacion)

from datetime import datetime

# --- Curvas de antigüedad (hora/día -> puntos), interpoladas linealmente entre anclas ---
# Reactivo: igual que antes hasta 24h (0,2,4,8), pero el tope 14 ahora se alcanza
# hasta las 48h en vez de ser un escalón instantáneo a las 24h. Esto reduce (no
# elimina) los empates entre tickets de 24-48h; más allá de 48h todos empatan en
# 14 y el desempate final lo da create_date en la vista.
ANTIGUEDAD_REACTIVO = [(0, 0), (1, 0), (4, 2), (8, 4), (24, 8), (48, 14)]

# Agendado: mismo criterio, tope 10 ahora a los 14 días en vez de 7.
ANTIGUEDAD_AGENDADO = [(0, 0), (2, 0), (4, 3), (7, 6), (14, 10)]

# --- Umbrales de estrellas recalibrados ---
# Rango real del score (sin override): min ~2 (residencial+consulta+antiguedad 0),
# max ~29 (dedicado+sin_servicio+antiguedad max reactivo). Los umbrales viejos
# (>=11 -> 3 estrellas) dejaban 3 estrellas casi a la mitad del rango real.
UMBRAL_3_ESTRELLAS = 18
UMBRAL_2_ESTRELLAS = 11
UMBRAL_1_ESTRELLA = 5


def _interpolar(x, anchors):
    """Interpolación lineal por tramos. x menor a la primera ancla -> primer valor;
    x mayor a la última ancla -> se queda plano en el último valor (el tope)."""
    if x <= anchors[0][0]:
        return float(anchors[0][1])
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x <= x1:
            return round(y0 + (y1 - y0) * (x - x0) / (x1 - x0), 2)
    return float(anchors[-1][1])


def puntos_antiguedad(archetipo, horas, dias):
    if archetipo == 'reactivo':
        return _interpolar(horas, ANTIGUEDAD_REACTIVO)
    if archetipo == 'agendado':
        return _interpolar(dias, ANTIGUEDAD_AGENDADO)
    return 0.0


def prioridad_desde_score(score, override):
    if override or score >= UMBRAL_3_ESTRELLAS:
        return '3'
    if score >= UMBRAL_2_ESTRELLAS:
        return '2'
    if score >= UMBRAL_1_ESTRELLA:
        return '1'
    return '0'


# ============ Cuerpo del cron (pegar desde aquí en la Acción Planificada) ============
now = datetime.now()
tickets = env['helpdesk.ticket'].search([
    ('team_id.x_archetipo', '!=', False),
    ('stage_id.fold', '=', False),
])

for t in tickets:
    if not t.create_date:
        continue

    delta = now - t.create_date
    horas = delta.total_seconds() / 3600.0
    dias = delta.days
    antiguedad = puntos_antiguedad(t.team_id.x_archetipo, horas, dias)

    vals = {}
    if t.x_antiguedad != antiguedad:
        vals['x_antiguedad'] = antiguedad
        t.write(vals)  # x_score (computed) se recalcula solo al reescribir antiguedad
        vals = {}

    priority = prioridad_desde_score(t.x_score, t.x_override)
    color = 1 if t.x_override else 0

    if t.priority != priority:
        vals['priority'] = priority
    if t.color != color:
        vals['color'] = color
    if vals:
        t.write(vals)
