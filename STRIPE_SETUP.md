# Stripe: integracion de pruebas

Esta entrega conecta Stripe Payments con PaymentSheet en Android/iOS. No habilita dinero real, Stripe Connect ni retiros bancarios. El servidor rechaza claves `sk_live_`. No basta con cambiar claves para habilitar produccion en esta entrega: falta la revision operativa, disputas y Connect.

## Configuracion local

En `MindEase-back/.env` (excluido de Git):

```dotenv
PAYMENT_PROVIDER=STRIPE
STRIPE_SECRET_KEY=sk_test_REEMPLAZAR
STRIPE_PUBLISHABLE_KEY=pk_test_REEMPLAZAR
STRIPE_WEBHOOK_SECRET=whsec_REEMPLAZAR
```

Las claves publica y secreta deben pertenecer a la misma cuenta/sandbox. Flutter obtiene solo la clave publica del backend autenticado. Ningun numero de tarjeta ni CVC pasa por el backend. No se almacenan client secrets, payloads completos de eventos ni informacion clinica en Stripe metadata.

`PAYMENT_PROVIDER=MOCK` conserva el simulador para pruebas backend; la nueva pantalla movil usa Stripe. Sin variable, se usa Stripe si existe clave secreta y NODE_ENV no es test.

1. Generar cliente: `npx prisma generate`.
2. Para la base local existente, `node tests/apply-stripe-local.js` aplica solo la migracion aditiva de Stripe y comprueba que no este parcialmente aplicada. No ejecuta reset/db push. Revisar y respaldar la base antes de cambios de despliegue. El historial anterior aun requiere baseline para instalaciones desde cero; no ejecutar migrate deploy a ciegas.
3. `docker compose up -d --build app`. Compose carga `.env`; DATABASE_URL dentro de Docker sigue apuntando al servicio db. `.env` no se copia a la imagen.
4. Mantener `stripe listen --forward-to localhost:3000/api/payments/webhook` abierto y usar el `whsec_` correspondiente al listener. Tras cambiar `.env`, recrear el contenedor con `docker compose up -d --force-recreate app`.
5. Recompilar Flutter completamente (no basta hot reload). Windows puede requerir Modo de desarrollador por los enlaces de plugins. Android usa FlutterFragmentActivity/AppCompat y retorno `mindease://stripe-redirect`. iOS requiere compilacion/validacion en macOS; no se verifico en este entorno.

## Endpoints

- GET `/api/payments/config`: autenticado; proveedor y clave publica.
- POST `/api/payments/intent`: autenticado; exclusivamente appointmentId + idempotencyKey. Crea o recupera el intento y consulta su estado real. El importe procede del snapshot de la cita en centavos.
- POST `/api/payments/webhook`: cuerpo raw, firma Stripe, sin JWT. Eventos no soportados se ignoran. Marcador durable por event.id; efectos idempotentes y conciliacion ante eventos desordenados.

Eventos: payment_intent.succeeded, payment_intent.payment_failed, payment_intent.processing, payment_intent.canceled, refund.created, refund.updated, refund.failed.

Un pago exitoso mantiene la cita PENDING. Solo el profesional puede confirmarla. Si la cita se cancela durante el pago, el exito tardio se reembolsa sin reabrirla. Un decline no cierra un PaymentIntent reutilizable. El cierre de PaymentSheet tampoco demuestra que no se cobro.

El worker reconcilia cada 30 segundos. A los 15 minutos intenta cancelar intentos no confirmados antes de liberar la reserva. Nunca aplica a Stripe la regla de ausencia del simulador. Si el servidor pierde el ID del intento, recupera usando la misma llave; despues de 23 horas exige revision manual para no reutilizar una llave posiblemente expirada en Stripe. Reembolsos pendientes no se marcan completados. Reembolsos parciales/fallidos requieren revision; no se crean reembolsos nuevos indiscriminadamente.

## Validacion y limites

Validado en esta entrega: 23 casos Stripe con transporte sustituido, 40 casos de regresion financiera, 18 pruebas de politicas; compilacion TypeScript y APK Android debug correctas. Analisis estatico del servicio, pantalla y tests nuevos sin incidencias. Suite Flutter ampliada con cuatro casos del contrato Stripe. Webhook del contenedor local: firma valida HTTP 200 y sin firma HTTP 400. No se ha probado PaymentSheet con una tarjeta en dispositivo ni contactado Stripe para ejecutar un cobro.

Se aplicaron las dos migraciones financieras anteriores que faltaban y la migracion Stripe en PostgreSQL local. Respaldo previo: `storage/mindease-before-stripe-20260921.dump` (contiene datos privados, no subir a Git). La inspeccion final encontro pendiente `STRIPE_PUBLISHABLE_KEY` en `.env`.

La dependencia nativa instalada exige iOS 15; el proyecto usa Swift Package Manager. En Android se alinea el target Kotlin del subproyecto stripe_android a Java 17 por incompatibilidad con AGP 9. No se modifico la cache del paquete. Persisten avisos de migracion futura de Kotlin/AGP y vulnerabilidades de dependencias npm que deben revisarse antes de produccion.

`TEST_DATABASE_URL` debe apuntar a PostgreSQL local. `npm run test:stripe` usa Express/PostgreSQL reales en un esquema temporal y SDK Stripe con respuestas sustituidas en memoria, sin contactar Stripe. La regresion financiera prueba tambien las migraciones incrementales. `flutter test --no-pub` incluye contratos del servicio de Stripe; no sustituye una prueba nativa de PaymentSheet.

Pendiente de QA manual en Android/iOS: pago de prueba exitoso, tarjeta declinada, autenticacion 3DS, cierre/reapertura de app y devolucion tras rechazo profesional. No se hicieron cobros reales. Verificar que la CLI muestre HTTP 200 para eventos firmados y que el historial refleje el pago sin confirmar automaticamente la cita.

Antes de produccion: Connect/onboarding y transferencias, contracargos, politica sobre comision Stripe, conciliacion operativa de excepciones, monitoreo, gestion de claves, migraciones completas, pruebas nativas y HTTPS. Los saldos internos no son escrow ni garantizan fondos disponibles en Stripe.

Referencias: https://docs.stripe.com/webhooks ; https://docs.stripe.com/api/payment_intents ; https://github.com/flutter-stripe/flutter_stripe
