# Fase 4: correcciones previas a Stripe

Verificación: 13 de septiembre de 2026. Stripe NO está integrado y no se realizan cobros ni transferencias reales.

## Cambios

- Cada intento tiene una llave UUID obligatoria, vinculada al paciente y la cita antes de llamar al simulador. Los rechazos quedan en `PaymentAttempt`; una nueva llave no puede saltarse un intento pendiente ni un pago exitoso.
- El simulador guarda resultados idempotentes en `MockGatewayOperation`, sin PAN ni CVC. Solo admite tarjetas de prueba y está deshabilitado con `NODE_ENV=production`.
- Un fallo después de ejecutar el simulador deja un intento recuperable. El mantenimiento consulta su resultado y finaliza el registro sin volver a cobrar. Solo para este simulador, la ausencia comprobada de una operación durante 60 segundos permite cerrar el intento sin ejecución. Esta regla NO debe reutilizarse con Stripe.
- Las citas de pago permanecen pendientes de aprobación manual, incluso si el perfil conserva la antigua opción de confirmación automática. Confirmar, iniciar y completar exigen un pago exitoso por el importe y moneda de la cita. Las citas gratuitas siguen admitidas.
- Cancelar registra `REFUND_PENDING` de forma atómica. El trabajo externo ocurre después, usa una llave estable y guarda referencia, errores sanitizados e intentos. Los reintentos no duplican el reembolso ni su notificación. Una cancelación concurrente con el cobro nunca reabre la cita.
- `Payment` y `PayoutRequest` usan `Decimal(12,2)`. Las comisiones se calculan en centavos. `PLATFORM_FEE_PERCENT=15` significa 15%; `1` significa 1%; `.15` significa 0.15%, NO 15%.
- Los saldos se consultan en una transacción coherente. Solo las consultas completadas liberan ingresos; el mes se obtiene de su finalización. Los saldos negativos no se ocultan. `NO_SHOW` queda en `REVIEW`, sin liberar ni reembolsar automáticamente: necesita una política de negocio explícita.
- Los retiros siguen siendo solicitudes SIMULADAS, requieren profesional elegible, idempotencia, centavos válidos y dígito de control CLABE. Las solicitudes nuevas conservan únicamente CLABE enmascarada, no información bancaria utilizable. Los registros anteriores no se alteran automáticamente.
- Flutter persiste la llave del intento; solo la renueva ante rechazo definitivo. No permite introducir tarjetas no incluidas en la lista de pruebas. Conserva el estado de confirmación de la respuesta y distingue reembolsos pendientes. Las reservas impagadas inactivas expiran en el servidor después de 15 minutos.

## Verificación ejecutada

- `node --test -r ts-node/register tests/policy.test.js`: 18/18.
- `node -r ts-node/register tests/integration.js`: 71 comprobaciones de fase 3 con PostgreSQL.
- `node -r ts-node/register tests/payments.integration.js`: 40 comprobaciones financieras, incluida migración desde el esquema anterior, concurrencia, autorización, recuperación, reembolsos, suspensión profesional durante el cobro y retiros.
- `node node_modules/typescript/bin/tsc --noEmit`: correcto.
- Flutter: 8/8 pruebas; análisis de los archivos modificados sin incidencias.

Las pruebas de integración exigen `TEST_DATABASE_URL` local. Crean un esquema temporal identificado con UUID y eliminan únicamente ese esquema. No modifican tablas públicas. El antiguo script scratch de fase 4 ahora delega en esta prueba segura.

## Aplicación a una instalación existente

La base y el contenedor actuales NO se actualizaron durante esta corrección. Se regeneró el cliente Prisma local para las pruebas. No arranques el código nuevo contra una base sin actualizar.

1. Respalda la base y pausa las escrituras del backend.
2. Verifica que el esquema existente corresponde al esquema anterior guardado en `tests/fixtures/pre-finance.prisma`. Revisa valores fuera del rango `Decimal(12,2)` o con más de dos decimales: la conversión redondea estos últimos.
3. Ejecuta por separado, contra la base explícitamente seleccionada:

   ```powershell
   node node_modules/prisma/build/index.js db execute --file prisma/migrations/20260912235900_payment_states/migration.sql --schema prisma/schema.prisma
   node node_modules/prisma/build/index.js db execute --file prisma/migrations/20260913000000_payment_integrity/migration.sql --schema prisma/schema.prisma
   node node_modules/prisma/build/index.js generate
   node node_modules/typescript/bin/tsc
   ```

4. Reinicia o reconstruye el backend y despliega Flutter actualizado. La conciliación se ejecuta al arrancar y cada 30 segundos.

Advertencia heredada: el repositorio solo tenía una migración inicial de usuarios; los módulos posteriores no están representados en el historial. Por eso `prisma migrate deploy` desde una base vacía NO es un procedimiento válido todavía. Los dos SQL nuevos son incrementos probados sobre el esquema existente, no una reconstrucción completa del historial. `db execute` tampoco marca migraciones como aplicadas: antes de adoptar `migrate deploy`, hay que establecer un baseline coherente. No usar `migrate reset` ni aceptar pérdida de datos para resolver esa discrepancia.

## Pendiente de Stripe

Captura/tokenización mediante interfaz Stripe, estados asíncronos, webhooks firmados, conciliación externa, Connect/onboarding, transferencias y retiros reales. Las claves privadas nunca deben llegar a Flutter. El saldo retenido del simulador no constituye un servicio escrow. Ninguna autorización real se obtiene por cambiar únicamente el adaptador.
