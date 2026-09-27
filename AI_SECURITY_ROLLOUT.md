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
