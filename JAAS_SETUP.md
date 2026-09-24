# Fase 6: JaaS, primera integración

Panel React y Flutter acceden a la API; solo el backend accede a PostgreSQL y firma JWT. JaaS transporta audio/video, no Railway. No almacenar la clave RSA privada en Flutter, React, Git ni documentos.

## Activación (pendiente en Railway)

1. En JaaS desactivar **Allow meeting participants to join unauthenticated**. La variable siguiente es una confirmación operativa, no comprueba ni cambia esa configuración externa.
2. En el servicio BACKEND configurar JAAS_APP_ID, JAAS_KEY_ID y JAAS_PRIVATE_KEY con los valores de la cuenta y la clave PEM correspondiente a la clave pública cargada en JaaS. Se admiten saltos de línea reales o secuencias literales \n.
3. Configurar JAAS_AUTH_REQUIRED_CONFIRMED=true y JAAS_ENABLED=true después del paso 1. No habilitar sin esa protección.
4. Subir/desplegar el código nuevo del backend. No se requiere migración.
5. Compilar Flutter con el SDK nuevo e iniciar sesión. iOS requiere macOS, Xcode y resolución de dependencias nativas; el target se elevó a 15.1. Android requiere API 26 (Android 8.0) según el manifest nativo de Jitsi 13.1.1, aunque el README del plugin aún indica 24. Flutter Web/escritorio no están cubiertos por este SDK y muestran aviso.

## Flujo y autorización

El profesional inicia la consulta explícitamente (reglas existentes: confirmada, pagada y desde 15 minutos antes). Cuando JaaS está habilitado, iniciar también valida su configuración y rechaza enlaces manuales externos.

POST /api/consultations/:appointmentId/video-session requiere sesión activa. Únicamente paciente y profesional tratante pueden obtener acceso; ADMIN/SUPERADMIN no tienen acceso por su rol. Revalida acreditación, rol y cuenta del profesional, cita CONFIRMED, consulta IN_PROGRESS y pago SUCCEEDED por el monto/moneda reservados (se mantiene la excepción existente para citas gratuitas). Paciente puede entrar desde 10 minutos antes, profesional desde 15; ambos solo antes del fin programado.

JWT RS256 con kid, aud=jitsi, iss=chat y sub=AppID. Sala específica sin wildcard ni regex; identificador seudónimo del participante. Nombres genéricos Paciente/Profesional, sin correo ni notas clínicas. Psicólogo moderador, paciente no moderador. Grabación, streaming, transcripción y llamadas telefónicas deshabilitados en claims. TTL máximo 5 minutos y nunca posterior al fin de cita. Cache-Control: no-store. No se persisten ni registran JWT.

Flutter solicita el token por HTTPS y lo pasa en memoria al SDK, nunca como enlace copiable. Cámara y micrófono inicialmente desactivados; el usuario concede los permisos del dispositivo. Puede reabrir desde detalles mientras la consulta esté en curso.

Salir de la llamada NO completa la consulta ni libera fondos. El profesional debe finalizar desde el flujo clínico existente. No se implementó el chat privado persistente: es un bloque separado de fase 6.

## Límites que requieren validación real

- Expiración del JWT limita nuevas entradas, no garantiza expulsar conexiones existentes. Cerrar clínicamente la consulta bloquea emitir nuevos tokens, pero uno ya emitido puede usarse hasta caducar. No se implementó expulsión remota ni sincronización con webhooks JaaS.
- Evitar compartir tokens: son credenciales bearer. No se garantiza exclusividad física del dispositivo. Las opciones del proveedor no impiden grabaciones externas del dispositivo.
- No se realizó una llamada real ni verificación de la clave de la cuenta. Probar con dos dispositivos, uno por participante: entrada, rechazo de terceros, cámara/micrófono, reconexión y cierre explícito. Configurar consentimiento/información de uso del proveedor antes de sesiones con pacientes reales.
- No se desplegó automáticamente este código ni se cambiaron variables de Railway/JaaS.

## Verificación local

Compatibilidad Android: ajuste limitado al módulo jitsi_meet_flutter_sdk para compileSdk 35 (sus dependencias Media3 lo exigen). No se modificó la caché del paquete. Persisten advertencias de migración futura de Kotlin/AGP en el proyecto existente.

Integración administrativa ampliada: 159 comprobaciones, incluidas 18 para JaaS usando claves RSA temporales y esquema de prueba aislado. Dart: análisis de archivos modificados sin incidencias y 6 pruebas de configuración/validación aprobadas. La prueba de una llamada real queda pendiente.

APK Android debug compilado correctamente: build/app/outputs/flutter-apk/app-debug.apk. iOS no compilado desde este entorno Windows.

Referencias: https://developer.8x8.com/jaas/docs/api-keys-jwt/ y https://pub.dev/packages/jitsi_meet_flutter_sdk
