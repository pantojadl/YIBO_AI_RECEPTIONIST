# Configuración y capacidades actuales del agente

> Referencia de capacidades del registro local; sus valores de proveedor fueron
> documentados el 10 de septiembre de 2026, no revalidados externamente en DOC-003.
> La configuración operativa actual se describe en [CONFIGURATION_CATALOG.md](CONFIGURATION_CATALOG.md);
> las capacidades planeadas se encuentran en `PROJECT_STATUS.md`.

## Construcción de una sesión

```mermaid
flowchart LR
  UI["Dashboard"] --> API["/api/configuration"]
  API --> CFG["AgentConfigurationService"]
  CFG --> DB[("agent_configurations")]
  CALL["CallOrchestrator"] --> DEF["AgentDefinitionService"]
  DB --> DEF
  DEF --> CONV["ConversationService"]
  CONV --> RT["OpenAIRealtimeAdapter"]
  RT --> MODEL["Realtime model"]
  MODEL -->|"function call"| EXEC["ToolExecutor"]
  EXEC --> DOMAIN["Customers / Scheduling / Appointments / Transfer"]
```

El dashboard configura modelo, voz, locale, esfuerzo de razonamiento, límite de
salida, VAD, instrucciones y herramientas. La configuración se valida, persiste
por tenant y aplica a la próxima conversación.

`locale` no cambia por sí solo la voz incorporada del proveedor. El compilador
lo convierte en reglas inmutables de idioma, pronunciación, vocabulario y ritmo;
para `es-MX` exige español de México con acento mexicano neutral. Los saludos
automáticos nuevos también se crean en el idioma seleccionado.

## Registro de capacidades por modelo

`RealtimeModelCapabilityRegistry` es la única fuente soportada de modelos,
voces, límites, controles y tarifas estimativas versionadas. `GET /api/configuration` publica una copia de ese
registro; el panel construye sus opciones desde la respuesta y vuelve a validar
la combinación antes de enviarla. `AgentConfigurationService` aplica la misma
validación en backend, por lo que un cliente modificado no puede guardar un
modelo, voz, esfuerzo o límite fuera del registro.

| Modelo habilitado | Contexto del modelo | Salida máxima del modelo | Límite explícito por respuesta |
|---|---:|---:|---:|
| `gpt-realtime-2.1` | 128 000 | 32 000 | 1–4096 |
| `gpt-realtime-2.1-mini` | 128 000 | 32 000 | 1–4096 |

La separación entre “salida máxima del modelo” y “límite explícito por
respuesta” es intencional. La ficha del modelo declara la primera capacidad,
mientras que el contrato Realtime acepta un entero de 1 a 4096 (o `inf`) para
`max_output_tokens`. YIBO usa siempre el entero acotado y mantiene 64 como el
mínimo práctico del slider, sin relajar la validación de API.

El registro también declara soporte del proveedor para razonamiento,
`tool_choice`, llamadas paralelas, tracing y truncación. Los controles de
`AGENT-004` usan uniones discriminadas y validación por modelo, nunca JSON libre.
Los campos que sólo corresponden a un modo de detección de turno no pueden
aparecer en otro.

Fuentes normativas consultadas:

- [GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [GPT-Realtime-2.1 Mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
- [Accept call — Realtime API](https://developers.openai.com/api/reference/cli/resources/realtime/subresources/calls/methods/accept)
- [Voice activity detection (VAD)](https://developers.openai.com/api/docs/guides/realtime-vad)

El registro backend de herramientas también es la fuente de los títulos,
descripciones, iconos, clasificación y ruta segura mostrados por el dashboard.
Así una herramienta nueva puede mostrarse con fallback sin romper el panel.

Los valores recomendados se construyen en una única fábrica versionada del
módulo Agents. Bootstrap y el panel consumen esa fábrica; el adaptador Realtime
usa siempre la definición ya resuelta y no sustituye modelo, voz o tokens.

El documento canónico incluye `schemaVersion: 4` y separa `identity`,
`conversation`, `audio`, `behavior`, `toolPolicies` y `enabledTools`. Las
configuraciones históricas sin versión, v1, v2 o v3 se actualizan en memoria y
SQLite, preservando sus valores y completando sólo campos ausentes. SQLite
guarda la forma canónica al primer acceso y una versión futura desconocida se
rechaza.

## Controles Realtime editables

El checkpoint [Model Configuration Pipeline](MODEL_CONFIGURATION_PIPELINE.md)
añade `behavior.allowPriceDisclosure` (default `true`) y overrides opcionales
por sucursal dentro del documento de negocio existente. Incluye tabla de campos,
defaults, valores válidos, precedencia, controles UI y consumidores efectivos.
Las restricciones de acciones se aplican en el ejecutor; los precios estructurados
se filtran antes de entregar resultados al modelo. El contexto confiable selecciona
la sucursal. No se usa un segundo almacén ni preferencias de perfiles de clientes.

| Sección | Controles | Default conservador |
|---|---|---|
| `identity` | instrucciones y locale | locale del tenant |
| `conversation` | modelo, razonamiento y límite de salida | registro/modelo recomendado |
| `conversation.tracing` | deshabilitado o `auto` | deshabilitado por privacidad |
| `conversation.truncation` | `auto`, deshabilitada o retention ratio | `auto` |
| `audio` | voz y reducción de ruido deshabilitada/near/far field | `near_field` |
| `audio.turnDetection` | `server_vad`, `semantic_vad` o manual | `server_vad` |
| `server_vad` | threshold, padding, silencio e inactividad | VAD histórico, 6 s inactivo |
| `semantic_vad` | eagerness | `auto` |
| ambos VAD | respuesta e interrupción automáticas | activadas |

`behavior` estructura decisiones que antes estaban duplicadas en prompts:
saludo automático o espera del caller; brevedad, tono y ritmo; mensaje y máximo
de repreguntas por silencio; número y estrategia de horarios ofrecidos; y orden
de nombre, teléfono y servicio. `AgentPromptCompiler` transforma esos campos en
instrucciones después de la guía editable, y el adaptador Realtime consume sólo
el prompt compilado. El runtime inicia el saludo únicamente cuando se configuró
como automático y cancela respuestas de silencio que excedan el límite. Los
defaults v2→v3 conservan el comportamiento anterior y localizan el mensaje de
silencio para español.

El mensaje y su límite sólo producen respuestas automáticas cuando se usa
`server_vad` con `createResponse` activado e `idleTimeoutMs` configurado. En los
demás modos no se simula un timeout local ni se cancela una respuesta posterior.

El modo manual se representa y se envía como `turn_detection: null`; sólo debe
activarse en un canal que tenga un gesto explícito para cerrar el turno. La
telefonía continua no proporciona ese gesto: una definición de llamada con modo
manual se rechaza de forma segura, mientras Voice Lab sí puede usarlo.

El texto que edita un administrador es guía, no el prompt completo.
`AgentPromptCompiler` lo delimita y compone después el contexto confiable de la
sucursal y reglas que no son editables: el modelo no elige tenant, sucursal,
cliente ni destino; no inventa estado externo y sólo confirma mutaciones después
de un resultado exitoso de la herramienta. El compilador describe por separado
cada capacidad realmente habilitada —informar servicios/precios, consultar,
crear, cancelar, reprogramar, guardar contacto y transferir— y niega autoridad
sobre las deshabilitadas. También incorpora la lista efectiva de mutaciones con
confirmación obligatoria y el protocolo de dos turnos; el texto editable no
puede omitirlo ni relajarlo.

PCM16 little-endian mono a 24 kHz es una invariante del transporte, no una
preferencia administrativa. Una sola constante compartida define codec, tasa,
canales y el formato enviado a Realtime. `AgentDefinitionService` deriva el canal
desde contexto confiable y tanto `phone` como `voice_lab` producen sesiones de
audio. El fallback de texto del adaptador queda únicamente para pruebas directas
sin canal y está marcado como obsoleto; ninguna configuración persistida puede
cambiar modalidad, codec, tasa o canales.

`tool_choice` y la ejecución paralela ya se configuran por canal. Esta última se
acepta sólo cuando todas las herramientas efectivas son consultas. El panel
consume `modelCapabilities` y genera desde ese registro las opciones de modelo,
voz, razonamiento, límite de salida, reducción de ruido y detección de turno.
Oculta el turno manual en el editor telefónico, muestra sólo opciones compatibles
y valida rangos por campo antes de guardar. `server_vad` muestra únicamente
threshold/padding/silencio; `semantic_vad` sustituye esos controles por eagerness.
Los controles de política y comportamiento restantes corresponden a `UI-003`.

La frontera con OpenAI no arma objetos `session.update` de forma ad hoc. El
constructor puro `buildRealtimeSessionUpdate` recibe únicamente la definición
resuelta, vuelve a validarla contra `RealtimeModelCapabilityRegistry` y devuelve
el contrato tipado del SDK. Una opción incompatible falla antes de abrir el
WebSocket. Los payloads completos de `gpt-realtime-2.1` y
`gpt-realtime-2.1-mini` están fijados por pruebas de contrato.

## Políticas de herramientas

`toolPolicies` limita por separado telefonía y Voice Lab. Cada canal tiene una
lista que debe ser subconjunto de `enabledTools` y un `toolChoice` enumerado
(`auto`, `required` o `none`). La definición del agente resuelve el canal desde
contexto del servidor; el modelo no puede aportarlo ni cambiarlo. Con `none`,
las herramientas tampoco se anuncian en la sesión ni en el prompt compilado.

Un ejecutor efímero por llamada aplica el máximo total y los máximos por
herramienta. Sólo repite resultados que el dominio marcó `retryable`, entre una
y tres tentativas totales y conservando el mismo tool-call/idempotency key. La
transferencia automática puede activarse ante límite o fallo reintentable; usa
`HumanTransferPort` y el destino configurado de la sucursal, nunca argumentos
del modelo. Los defaults de la migración v3→v4 dejan un límite total de 20, una
sola tentativa y transferencia automática desactivada.

Los máximos globales y por tool cuentan ejecuciones autorizadas de la llamada;
los intentos detenidos por confirmación quedan fuera del contador. Un exceso
devuelve `TOOL_CALL_LIMIT_REACHED` no reintentable y, si la política lo ordena,
intenta transferencia por el destino confiable. Cualquier excepción inesperada
del dominio o de la propia transferencia se convierte en
`TOOL_EXECUTION_FAILED` genérico: el mensaje técnico original nunca llega al
modelo.

El panel expone estas políticas en secciones separadas: personalidad; turno y
audio; saludo y silencio; tools; canales y confirmaciones; límites, reintentos y
escalamiento; e instrucciones. Al deshabilitar una tool la elimina de ambos
canales, límites particulares y confirmaciones. Al habilitar una mutación o
acción externa desactiva paralelismo en ambos canales. La transferencia
automática permanece deshabilitada en UI mientras `transfer_to_human` no esté
presente en todos los canales activos; el backend vuelve a validar todo al
guardar.

El paralelismo también es una opción por canal, desactivada por default. La API
rechaza activarlo si cualquier herramienta seleccionada es `mutate` o
`external`, usando la clasificación del registro backend. Voice Lab incluye
tools de prueba mutables, por lo que no admite paralelismo mientras estén
disponibles. La definición vuelve a evaluar las tools efectivas y el adaptador
sólo entonces envía `parallel_tool_calls: true`.

`toolPolicies.confirmations.requiredFor` permite seleccionar tools mutables que
deben atravesar `ConfirmationGateToolExecutor`; una consulta o tool deshabilitada
se rechaza en configuración. El default es vacío para conservar el comportamiento
existente. En el primer intento el gate no ejecuta: devuelve un token opaco ligado
a llamada, acción, argumentos canónicos y secuencia confiable del turno. Voice y
texto reciben esa secuencia desde `ConversationService`, nunca desde argumentos
del modelo. La aceptación tras un turno nuevo, expiración a dos minutos y consumo
único ya se aplican en backend. El token se elimina antes de delegar, de modo que
ni un éxito ni un fallo del dominio permiten repetir la mutación; para intentar
otra vez es necesario iniciar una confirmación nueva.

## Herramientas implementadas

| Tool | Acción | Protección principal |
|---|---|---|
| `get_service_information` | Consulta servicios, descripción, duración, precio y sucursales | Sólo nombres públicos; omite IDs y ofertas inactivas |
| `list_customer_appointments` | Lista citas futuras confirmadas del caller | Tenant, cliente y sucursal proceden de la llamada; usa referencias opacas |
| `check_availability` | Consulta slots reales o una hora exacta | Servicio/empleado y zona se resuelven en backend |
| `update_customer` | Guarda nombre completo y teléfono | Cliente procede de la llamada |
| `create_appointment` | Crea y confirma una cita | Requiere slot consultado, ownership e idempotencia |
| `cancel_appointment` | Cancela cita y evento | Exige referencia listada en la misma llamada y verifica ownership |
| `reschedule_appointment` | Valida nuevo slot y sustituye evento | Exige referencia listada, verifica cliente y compensa fallo externo |
| `transfer_to_human` | Solicita destino configurado | El modelo no proporciona el destino |
| `enable_developer_test_mode` | Activa fixtures aislados | Sólo sesión local autorizada |
| `delete_test_appointments` | Limpia citas de esa prueba | Sólo citas de la sesión de prueba |

`tenantId`, `callId`, `customerId` e idempotencia son contexto confiable y se
rechazan si aparecen en argumentos del modelo. Deshabilitar una herramienta
impide que sea registrada en la sesión.

Las mutaciones entregan proyecciones públicas, no entidades persistidas.
`create_appointment` devuelve únicamente confirmación, servicio, inicio/fin,
sucursal/zona y el precio histórico localizado; nunca serializa IDs de cita,
tenant, sucursal, cliente, servicio, profesional, evento externo ni la llave de
idempotencia. Cancelación y reprogramación responden de la misma forma segura a
partir de una referencia opaca creada durante la llamada.

`get_service_information` consulta el catálogo completo del tenant usando el
tenant confiable de la llamada. Devuelve únicamente servicios y ofertas activas:
nombre y descripción del servicio, duración, nombre público de sucursal y precio
en unidades menores, moneda ISO y texto localizado. No serializa IDs de servicio,
sucursal o profesional. Al actualizar instalaciones existentes, la tool se
habilita sólo en canales donde ya estaba habilitada `check_availability`.

Las dos tools de Developer Test Mode pertenecen al registro interno, no al
catálogo público administrable. Una única clasificación compartida las excluye
de defaults, API y validación de configuración. Sólo una definición Voice Lab
creada con autorización local confiable puede anunciarlas; el constructor del
payload Realtime vuelve a rechazar cualquier intento de incluirlas en telefonía
o en un contexto sin canal. El ejecutor exige además esa autorización antes de
activar o limpiar. Sus citas, busy intervals y eventos viven en repositorio,
agenda y calendario en memoria separados: las pruebas verifican que reservar un
slot de laboratorio no crea citas ni ocupación en los adaptadores normales.

`list_customer_appointments` consulta únicamente citas `CONFIRMED` cuyo inicio
no ha pasado, ordenadas cronológicamente y limitadas al tenant, cliente y
sucursal confiables. La respuesta conserva el snapshot histórico de servicio y
precio, añade zona y nombres públicos, y reemplaza el ID persistido por una
referencia efímera `upcoming-N` ligada a la llamada. Ese mapa queda sólo en
memoria y es la única entrada aceptada por cancelación y reprogramación. Ambas
operaciones resuelven el ID internamente y vuelven a comprobar tenant, sucursal
y ownership; un ID persistido, una referencia inventada o una emitida en otra
llamada se rechazan. Sus resultados tampoco devuelven el ID interno.

## Calendario y citas

Availability cruza horarios, duración/buffer, empleados elegibles, ocupación
local y Google FreeBusy. Create vuelve a validar antes de escribir. Google OAuth
se guarda cifrado por tenant y el modelo nunca recibe tokens, otros eventos ni
el motivo por el que una franja está ocupada.

## Datos y privacidad

- No se persisten audio ni transcripciones.
- El consumo guarda tokens, milisegundos de audio y conteos de tools.
- La API key sólo procede del entorno y el panel muestra únicamente su estado.
- OBS-001 implementa correlación hash tenant/sucursal/llamada y allowlist sin PII;
  ver [OBSERVABILITY.md](OBSERVABILITY.md). Loggers diagnósticos inyectados tienen
  su propia responsabilidad de privacidad.
