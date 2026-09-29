# IA: seguridad, consentimiento y despliegue

## Configuración requerida (no contiene credenciales)

```dotenv
AI_PROVIDER=gemini
GEMINI_MODEL=<modelo habilitado y probado en tu cuenta>
AI_TIMEOUT_MS=20000
AI_CONVERSATION_RETENTION_DAYS=30
AI_RETENTION_ENABLED=true
AI_GEMINI_DATA_POLICY_CONFIRMED=true
```

`GEMINI_API_KEY` permanece exclusivamente en el backend. No copiarla a Flutter.
El adaptador requiere un modelo explícito; ya no cambia modelos automáticamente ni presenta
respuestas de Mock como respuestas de Gemini. Una salida truncada, bloqueada o inválida produce
un error controlado, sin registrar ni devolver el contenido del proveedor.

**No establecer AI_GEMINI_DATA_POLICY_CONFIRMED=true sin revisión previa.** La variable es una
declaración del operador, no una comprobación automática de facturación ni de cumplimiento.
Verificar servicio de pago/política de datos aplicable, términos vigentes, restricciones de menores,
alcance no clínico, tratamiento por terceros y aviso de privacidad antes de habilitar usuarios reales.
Referencias oficiales: https://ai.google.dev/gemini-api/terms y https://ai.google.dev/gemini-api/docs/structured-output
No usar la cuota gratuita con conversaciones sensibles. La configuración no equivale a certificación clínica/legal.

## Consentimiento y eliminación

GET `/api/ai/orientation/consent` devuelve texto, versión (hash), proveedor y plazo.
POST requiere `{ "version": "<versión recibida>", "adultConfirmed": true }`.
La versión se registra en `UserConsent.consentType`; las aceptaciones antiguas no habilitan el módulo.
Un cambio de texto, proveedor o plazo exige nueva aceptación. Actualizar Flutter junto al backend.

DELETE `/api/ai/orientation/history` requiere autenticación y elimina solo sesiones, mensajes,
recomendaciones y consentimientos IA del usuario. No elimina citas, notas clínicas ni chats profesionales.
Flutter pide confirmación. No promete borrar copias de Google ni respaldos externos.

La retención es por fecha de creación de sesión (no por última actividad). Al habilitarse, corre al
arranque y diariamente, y elimina también perfiles/resúmenes por cascada. Activarla en un entorno
con datos antiguos implica eliminación irreversible de esos historiales; revisar plazo y respaldos antes.
En producción las nuevas operaciones de orientación se bloquean si la retención no está habilitada.
Los registros de consentimiento no se purgan con el historial vencido; la revocación sí los elimina.

## Migración sin pérdida de datos

Nueva migración: `20260927000000_ai_orientation` (transaccional y aditiva).
No usa reset ni borra tablas existentes. Respaldo y ensayo en una copia antes de desplegar.

1. Comprobar `prisma migrate status` y si ya existen las cuatro tablas y tres enums IA.
2. Si no existen y el historial anterior está reconciliado: `npx prisma migrate deploy`.
3. Si existen por un `db push` anterior: NO ejecutar deploy a ciegas, NO borrar tablas y NO marcar
   aplicada sin comparar estructura, defaults, índices y claves foráneas contra el SQL nuevo.
   Reconciliar solo tras comprobar equivalencia en una copia respaldada.
4. No modificar checksums de migraciones históricas ya aplicadas.

**Bloqueo histórico detectado:** desde cero, `20260912235900_payment_states` falla porque la inicial
solo crea User/Role y no crea PaymentStatus. Esta corrección no reescribe esa historia ni asegura que
todo el proyecto pueda instalarse desde cero. Requiere una reconciliación/baseline independiente.

## Verificación

`npm run test:ai:unit`: filtros existentes más regresiones de esquema, bloqueo de crisis, errores
de Gemini y versión/configuración de privacidad; proveedor HTTP simulado, sin enviar datos externos.

`npm run test:ai`: solo PostgreSQL local, esquema aleatorio y limpieza al terminar. Construye el esquema
pre-IA, aplica el SQL real de IA y compara la estructura final con Prisma antes de probar endpoints.
`AI_TEST_REPLAY_MIGRATIONS=true` activa además el ensayo del historial completo; actualmente falla por
el bloqueo histórico indicado. No confundir estas dos verificaciones.

Pruebas manuales pendientes: aceptación/revocación en ambos temas y texto grande, reentrada a sesión
escalada, configuración y respuesta real de Gemini en un entorno de pruebas con datos sintéticos.
Los regex y criterios de derivación aún requieren revisión por un profesional; no son diagnóstico.

## Estabilidad de envíos (segunda entrega)

Migración nueva: `20260928000000_ai_message_requests`. Aplicarla con `prisma migrate deploy` en el
historial ya reconciliado, antes de iniciar el backend actualizado. No usar `resolve --applied` para
esta tabla nueva ni modificar la migración de IA anterior. Actualizar Flutter junto con el backend:
POST messages ahora requiere `requestKey` UUID. Regenerar Prisma y compilar durante el build.

`AI_MAX_MESSAGES_PER_SESSION=20` cuenta intervenciones del usuario respondidas, NO la bienvenida
ni respuestas de la IA. Se aceptan enteros de 1 a 100; los fallos no crean mensajes ni gastan cuota.
La respuesta y las sesiones incluyen `quota: { limit, used, remaining }`. La evaluación local de
crisis se ejecuta antes de aplicar el límite conversacional. El límite antiabuso por minuto permanece
independiente y sí cuenta peticiones fallidas para evitar abuso.

Cada envío conserva un recibo con hash del contenido, UUID, respuesta y estado en PostgreSQL.
La pareja de mensajes y el recibo se confirman en una sola transacción. Los recibos se eliminan
por cascada con el historial o la retención, y tienen la misma sensibilidad que los mensajes.
El mismo UUID y texto recupera el resultado sin volver a llamar a Google; un texto distinto con el
mismo UUID produce conflicto. Los fallos permiten reintentar con el mismo UUID. Un lease de 90 segundos
permite recuperar un proceso caído; un token de propietario evita commits de workers reemplazados.
Las llamadas externas no mantienen transacciones abiertas. Se serializa la creación de sesiones y
el envío por sesión entre réplicas. No se promete que Google facture solo una llamada tras una caída
de proceso: la garantía de idempotencia cubre el historial de MindEase.

El adaptador realiza como máximo 3 intentos, con espera exponencial y jitter, dentro del presupuesto
TOTAL `AI_TIMEOUT_MS` (máximo 60000). Respeta Retry-After; no reintenta autenticación, entrada inválida,
respuesta bloqueada o inválida. Un 429 solo se reintenta automáticamente si incluye espera y no indica
cuota diaria. No cambia el modelo configurado. Flutter espera hasta 75 segundos para un envío y 20
para otras operaciones; una pérdida de respuesta se resuelve reutilizando el UUID, no reenviando uno nuevo.

Errores públicos: `AI_PROVIDER_QUOTA`, `AI_PROVIDER_BUSY`, `AI_PROVIDER_TIMEOUT`,
`AI_PROVIDER_NETWORK`, `AI_PROVIDER_AUTH`, `AI_PROVIDER_REQUEST_REJECTED`, `AI_RESPONSE_INVALID`,
`AI_RESPONSE_BLOCKED`, `AI_SESSION_LIMIT`, `AI_REQUEST_IN_PROGRESS`, `AI_IDEMPOTENCY_CONFLICT`,
`AI_RATE_LIMIT`. Incluyen `retryable` y, cuando aplica, `retryAfterSeconds`/cabecera Retry-After.
Los logs conservan códigos/HTTP, nunca cuerpo, prompts, claves ni URLs del proveedor.

Los borradores pendientes y sus UUID se conservan en memoria durante la ejecución de Flutter,
se limpian cuando cambia la autenticación o se elimina el historial y no se escriben en preferencias.
No se garantiza recuperación del borrador tras cerrar el proceso del teléfono.

## Defensa de contenido y recursos de ayuda (tercera entrega)

Se inspeccionan mensaje del asistente, resumen, motivo principal, temas, nombres sugeridos y razones.
Ante una infracción detectada se sustituye la respuesta completa por texto controlado, se descarta
el perfil generado y se evita la finalización automática. Se conservan las señales de riesgo del
modelo para no impedir una escalación. El texto se normaliza para detectar acentos, saltos de línea
y formato simple; no se hacen sustituciones parciales que dejen una segunda afirmación peligrosa.

La lectura del historial y los recibos de idempotencia también filtran contenido anterior. No se
reescribe ni se oculta el texto del usuario, y esta protección de lectura no borra registros originales.
El endpoint de recomendaciones filtra perfiles/resúmenes guardados antes de devolver resultados.

La evaluación previa considera los últimos 12 mensajes del usuario y el actual, sin usar mensajes
del asistente como afirmaciones del paciente. Conserva el mayor riesgo encontrado y el estado previo;
también reconoce expresiones divididas entre mensajes. Son reglas conservadoras y limitadas: pueden
producir falsos positivos (negaciones, citas, hechos históricos) o no detectar alusiones indirectas.
No constituyen evaluación clínica ni una garantía frente a todas las respuestas dañinas. Los criterios
deben revisarse con un profesional antes de atender conversaciones reales sensibles.

Los contactos de México abren `tel:` solo cuando el usuario pulsa el botón; no inician llamadas
automáticamente. Se rechazan esquemas arbitrarios y secuencias USSD. Si el dispositivo no puede abrir
el marcador, se mantiene el número y un aviso para marcarlo manualmente. No se afirma que todos los
recursos sean gratuitos o estén disponibles 24/7. Esta entrega no cambia los números del catálogo.

No requiere otra migración de base de datos. Sí requiere desplegar el backend y actualizar Flutter.
