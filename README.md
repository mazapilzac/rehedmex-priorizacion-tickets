# rehedmex-priorizacion-tickets

Priorización automática de tickets de Helpdesk en Odoo para **REHEDMEX/REHEDMAS**
(ISP en Saltillo/Zacatecas). Cada ticket recibe un **score calculado** para ordenar la
cola de atención, romper empates y ayudar a rutear por zona.

Documento completo de contexto, decisiones y trampas encontradas:
**[priorizacion_tickets_handoff.md](priorizacion_tickets_handoff.md)** — léelo primero,
este README es solo un mapa rápido del repo.

## Estado actual

**En producción** (`erp.rehedmas.com`), corriendo sobre ~9,480 tickets reales, cron
activo cada 30 minutos, sin errores. Ver §11 del handoff para el detalle de la
implementación.

Pendiente real: poblar `x_motivo` y `x_tipo_cliente` con datos reales (hoy el score
depende casi solo de antigüedad porque esos campos están vacíos). Se decidió poblarlos
directamente en producción, no en las bases de pruebas.

## El modelo, en corto

```
score = peso_del_motivo + impacto_del_cliente + antigüedad      (o 999 si hay override)
```

Aditivo a propósito: en un ISP la continuidad del servicio manda, no debe perder contra
el valor del cliente. Antigüedad es continua (interpolada, no escalonada) y el desempate
final entre scores iguales lo da la fecha de creación del ticket. Detalle completo,
tablas de pesos y umbrales en el handoff, §2 y §9.

## Estructura del repo

| Archivo | Qué hace |
|---|---|
| `priorizacion_tickets_handoff.md` | Documento vivo de contexto — la fuente de verdad del proyecto. |
| `odoo_client.js` | Cliente RPC genérico (XML-RPC) reutilizable para cualquier instancia Odoo. |
| `replicar_configuracion.js` | **El script principal.** Crea desde cero, de forma idempotente, los 8 campos + cron + 4 vistas en cualquier BD de Odoo Online con Helpdesk instalado. Usado para producción y para la segunda BD de pruebas. |
| `cron_recalcular_prioridad.py` | El algoritmo de priorización en Python puro, para referencia/lectura (el mismo código vive embebido en `replicar_configuracion.js` y se sube a la Acción Planificada de Odoo). |
| `diagnostico.js` | Solo lectura — revisa qué tanto de la config ya existe en una instancia antes de tocar nada. |
| `inspeccionar_campos.js` | Solo lectura — muestra la definición exacta (ttype, compute, depends) de los campos/cron ya creados. |
| `revision_salud.js` | Solo lectura — batería de checks de sanidad (cron activo, equipos sin score intactos, rango de scores, distribución de estrellas). |
| `aplicar_antiguedad_continua.js` | Script histórico usado solo en la primera BD de pruebas (ya tenía campos Integer viejos que no se podían migrar a Float sin borrar). No sirve para una BD nueva — usa `replicar_configuracion.js`. |
| `snapshots/` | Estados capturados antes de aplicar cambios, para poder revertir a mano si algo sale mal. |
| `config.example.js` | Plantilla de configuración. Las credenciales reales (`config.local.js`, `config.local2.js`, `config.produccion.js`) están gitignored, nunca se suben. |

## Uso

```bash
# 1) Copia la plantilla y pon tus credenciales reales (no se sube a git)
cp config.example.js config.miambiente.js

# 2) Diagnóstico de solo lectura antes de tocar nada
node diagnostico.js config.miambiente

# 3) Replicar toda la configuración (idempotente, se puede correr varias veces)
node replicar_configuracion.js config.miambiente

# 4) Revisar que todo quedó sano
node revision_salud.js config.miambiente
```

Las credenciales de Odoo son `url`, `db`, `username` y `apiKey` (Ajustes de la cuenta →
Seguridad → Claves API, dentro de la instancia de Odoo). Si `common.authenticate` falla
con una API key válida (pasó en producción, ver handoff §11), agrega también `uid` a la
config para saltarte ese paso.

## Versionado

Cada avance real queda etiquetado en git como punto de retorno — así se puede comparar
o revertir sin miedo a perder lo que ya funcionaba:

| Tag | Qué marca |
|---|---|
| `v0.1-diseno-antiguedad-continua` | Solo diseño del algoritmo, nada aplicado aún. |
| `v0.2-snapshot-antes-de-cambios` | Snapshot del estado previo en la 1ª BD de pruebas. |
| `v0.3-antiguedad-continua-en-pruebas` | Antigüedad continua aplicada y verificada en la 1ª BD de pruebas. |
| `v0.4-revision-completa` | Revisión de salud completa, todo en orden. |
| `v0.5-replicacion-completa-validada` | Script de replicación completo, validado sin errores en una 2ª BD de pruebas limpia. |
| `v0.6-produccion` | Implementado y verificado en producción (`erp.rehedmas.com`). |

## Seguridad

Ningún archivo con credenciales reales (`config.local*.js`, `config.produccion.js`) se
sube a este repo — están en `.gitignore`. Solo se versiona `config.example.js` como
plantilla.
