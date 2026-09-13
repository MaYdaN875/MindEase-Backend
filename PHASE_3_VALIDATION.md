# Validación de fases 1–3

Revisión y correcciones: 12 de septiembre de 2026.

## Reglas implementadas

- Cada petición autenticada consulta el estado de cuenta y roles actuales. Una cuenta no activa no inicia sesión ni utiliza un JWT anterior.
- Activar o suspender una cuenta solo cambia `User.status`. No aprueba acreditaciones ni asigna roles profesionales. Consultar el perfil tampoco restituye roles retirados.
- Publicar disponibilidad, aparecer en el directorio y recibir reservas requiere cuenta `ACTIVE`, perfil `VERIFICADO` y rol `PSYCHOLOGIST_VERIFIED`.
- La aprobación requiere identificación, título y cédula aprobados y vigentes, además de cédula y semblanza en el perfil. Solicitud, dictamen, rol, historial y notificación se actualizan atómicamente. Una solicitud resuelta no se resuelve de nuevo.
- Los documentos no pueden sustituirse o eliminarse mientras están en revisión o después de la acreditación. La carga comprueba extensión, firma inicial de PDF/imagen y límite de 5 MB; esto no equivale a un análisis antivirus.
- Las notas clínicas solo se serializan para el profesional tratante, tanto en consultas como en listas y detalles de citas. ADMIN y SUPERADMIN reciben información administrativa sin notas.
- La creación de citas comprueba un slot exacto publicado y colisiones del paciente y profesional dentro de una transacción SERIALIZABLE, con hasta tres intentos ante conflictos de serialización.
- `PENDING` y `CONFIRMED` ocupan horario. El paciente solo cancela; el profesional confirma solicitudes. No se reabren estados terminales. `NO_SHOW` exige cita confirmada cuyo horario ya terminó.
- El inicio de consulta exige cita confirmada y consulta programada, desde 15 minutos antes del inicio y antes de la hora de fin. Solo el profesional tratante inicia y finaliza. La finalización exige consulta en curso y actualiza cita y consulta en la misma transacción.
- No se cancela una consulta en curso desde el endpoint de citas. Las notas pueden guardarse durante la consulta o después de completarla; la auditoría registra la operación sin copiar su contenido.

## Zona horaria

`SCHEDULE_TIME_ZONE` configura la zona IANA de las jornadas semanales; valor predeterminado: `America/Mexico_City`. No depende de la zona del sistema operativo del servidor. Las citas se guardan como instantes UTC y Flutter muestra horas locales; el editor indica la zona de la agenda.

Los valores semanales HH:mm existentes se interpretan ahora en esa zona. Las citas ya almacenadas conservan sus instantes UTC: no se desplazan automáticamente. Revisar manualmente cualquier cita creada con la interpretación anterior antes de una demostración.

## Pruebas reproducibles

Desde `MindEase-back`, con dependencias instaladas:

```powershell
npm test
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/mindease?schema=public'
npm run test:integration
npm run build
```

El ejemplo apunta a PostgreSQL local de Docker. Para otro entorno, usar una base exclusiva de pruebas con permisos de crear esquemas. La prueba genera un esquema `mindease_test_<uuid>`, aplica el esquema Prisma, inicia Express en un puerto libre y elimina solo ese esquema al finalizar. No usa los usuarios, documentos ni citas del esquema de la aplicación. Sale con código distinto de cero ante fallos.

Cobertura: privacidad por endpoint, transiciones, fechas y horarios, doble reserva concurrente, aprobación concurrente, documentación vencida, activación sin acreditación, retirada de roles, suspensión con token anterior y flujo de consulta completo.

Desde la raíz Flutter:

```powershell
flutter pub get
flutter test --no-pub
flutter analyze --no-pub
```

Las pruebas de Flutter comprueban carga y guardado de notas, bloqueo del editor ante errores de carga y conservación del texto cuando falla el guardado.

## Ejecución local y despliegue

`JWT_SECRET` es obligatorio. No hay clave de firma de respaldo. `npm start` inicia el servidor y ya no ejecuta `db push --accept-data-loss`. Docker tampoco modifica el esquema automáticamente. Este conjunto de correcciones no añade columnas.

Para actualizar el backend local ya configurado:

```powershell
docker compose up -d --build --no-deps app
```

Para una instalación nueva, inicializar explícitamente el esquema mediante `npx prisma db push` en desarrollo, después de revisar el destino; en producción preparar migraciones revisadas. Nunca usar una sincronización destructiva al iniciar el servicio.

## Alcance y pendientes separados

Flutter incorpora edición de notas privadas y apertura de enlaces HTTPS de sesión suministrados por el profesional. El enlace se proporciona al iniciar. No se ha integrado un proveedor de videollamadas ni grabación. La interfaz puede iniciar un acto clínico sin enlace si la atención se realiza por otra vía.

Pagos, Community como canales, IA de orientación, push, expiración automática de solicitudes y reportes de moderación reales son módulos posteriores. Las maquetas de esas áreas no acreditan funcionalidad. No se han cambiado ni migrado automáticamente perfiles históricos con estados profesionales `SUSPENDIDO`/`INACTIVO`: requieren una revisión administrativa explícita; activar su cuenta no les devuelve acreditación.

Las pruebas de integración verifican el backend en proceso con PostgreSQL real. Las pruebas de widgets usan respuestas HTTP simuladas; no constituyen una prueba de videollamada en un teléfono físico.
