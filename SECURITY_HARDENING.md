# Archivos privados y moderación — 22 septiembre 2026

## Cambios implementados

- `/uploads` deja de ser un directorio público estático. Cada descarga verifica la autorización.
- Soporte: acceso del propietario, personal de soporte y destinatario de respuestas públicas del ticket. Las notas internas no conceden acceso al paciente.
- Community: adjuntos públicos solo cuando están referenciados por publicaciones publicadas en canales activos o portadas de canales activos. Los borradores requieren autorización.
- `POST /api/media/access` devuelve un enlace de descarga de 60 segundos limitado al archivo. No es un token de sesión; se revalida el estado de la cuenta al descargar. Es un enlace portador: quien lo reciba puede usarlo mientras siga vigente. Usar HTTPS y evitar registrar su query string en proxies.
- Se comprueba coincidencia entre firma básica del contenido, extensión y MIME; máximo 10 MB. Esto NO sustituye un antivirus ni una decodificación completa del archivo.
- Los autores no pueden reactivar publicaciones ocultadas por moderación, ni pasándolas por borrador. Se revalida acreditación profesional al publicar o editar.
- Nuevos archivos en `storage/media`; los volúmenes de Docker conservan su contenido. No hay eliminación automática de archivos huérfanos.
- Flutter obtiene enlaces autorizados para imágenes y documentos administrados. Los enlaces externos no reciben credenciales.

## Activación pendiente en la base local

La migración aditiva `20260922000000_private_media` crea `MediaAsset` y sus índices. El cliente Prisma local ya fue regenerado, pero la migración NO se aplicó a la base de la aplicación y el contenedor NO se reconstruyó durante este bloque.

La consulta de estado encontró cinco migraciones anteriores pendientes además de esta, aunque las tablas Payment, CommunityPost y SupportTicket ya existen. No ejecutar `migrate deploy` o `db push` indiscriminadamente: primero comparar el esquema real y el historial, hacer respaldo y reconciliar únicamente migraciones comprobadas. No usar reset.

Antes de recrear el contenedor se copiaron sus uploads existentes a `storage/legacy_uploads`, sin borrar originales. El compose prepara un montaje de solo lectura para conservar las URLs antiguas. Los archivos antiguos sin propietario registrado solo se autorizan por sus referencias existentes; para reutilizarlos en contenido distinto puede ser necesario volver a subirlos. Si hubo nuevas cargas desde el respaldo, deben preservarse también antes del reinicio.

Después de reconciliar y aplicar la migración, reconstruir el backend y probar una carga/descarga autenticada en Flutter. El cambio de código no protege el contenedor antiguo hasta desplegarlo.

## Fuera de este bloque

Integraciones pendientes del panel administrativo, recuperación de contraseña por correo, chat privado y Jitsi. La fase 6 del proyecto es Comunicación, no soporte/tickets. Tampoco se certifica con estas pruebas un pago Stripe nativo extremo a extremo.
