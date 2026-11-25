# Entrevista inicial de MindEase

## Arquitectura integrada

- Flutter reutiliza `AuthService`, el tema `AppTheme` y la navegación de `AppRoot`. La entrevista solo se activa para pacientes con correo verificado y estado pendiente/en curso.
- Express reutiliza JWT, verificación de correo, límite de solicitudes de IA, Prisma/PostgreSQL, `CrisisProtocolService`, `AISafetyService` y el workflow Stripe existente.
- El backend es la autoridad para consentimiento, preguntas activas, progreso, riesgo, finalización y permisos. Las respuestas y el informe se cifran con AES-256-GCM antes de guardarse.
- OpenAI genera únicamente el informe final. No recibe nombre preferido, fecha de nacimiento, ocupación, escolaridad, residencia ni identificadores. Se envían las respuestas clínicas necesarias para el informe, con `store: false`.
- El PDF cifrado se guarda en PostgreSQL. Se descifra y sirve bajo demanda, nunca desde almacenamiento público.
- La lectura/descarga profesional requiere el ID de la cita, cita asociada al paciente y al perfil del profesional autenticado, cuenta y acreditación vigentes, cita no cancelada y pago `SUCCEEDED` que corresponde a ambas partes. Cada lectura y descarga registra actor, cita, informe, acción y hora. No existe permiso administrativo para este informe.

## Configuración

1. Define `OPENAI_API_KEY` en el gestor de secretos del backend.
2. Genera una clave independiente de 32 bytes y guárdala en el gestor de secretos:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. Configura esa salida como `INITIAL_INTERVIEW_ENCRYPTION_KEY`. No la guardes en Git; sin la clave original no es posible recuperar respuestas o informes ya cifrados.
4. Después de revisar las condiciones de tratamiento de OpenAI, el aviso de privacidad y el consentimiento aplicables, configura `OPENAI_DATA_POLICY_CONFIRMED=true`. La variable no verifica una aprobación legal; es un bloqueo operativo que requiere revisión del responsable de privacidad.
5. Revisa y publica el aviso de privacidad con el plazo de conservación y el canal de ejercicio de derechos aplicables antes de habilitar la función en producción. Esta implementación no purga automáticamente expedientes: la legislación y el plazo aplicables deben definirse para el responsable y el profesional de salud.
6. Despliega la migración y el cliente Prisma antes de desplegar Flutter:

   ```powershell
   npx prisma migrate deploy
   npx prisma generate
   npm run build
   ```

   La configuración local puede aplicarse con `npm run prisma:migrate`.

## Endpoints

- `GET /api/interview/status`: estado y aviso de privacidad; no devuelve contenido clínico.
- `GET /api/interview/progress`: pregunta activa para el propio paciente.
- `POST /api/interview/start`: aceptación versionada del aviso y confirmación de mayoría de edad.
- `POST /api/interview/answer`: responde exclusivamente a la pregunta activa; respuestas ajenas a la evaluación reciben un límite fijo del servidor.
- `GET /api/interview/review` y `PUT /api/interview/review`: revisión/corrección de las respuestas propias antes de finalizar.
- `POST /api/interview/complete`: valida que todos los módulos estén respondidos, genera el informe y el PDF.
- `GET /api/interview/professional/patients/:patientId/initial-report?appointmentId=...`: informe y respuestas originales para el profesional autorizado.
- `GET /api/interview/professional/patients/:patientId/initial-report.pdf?appointmentId=...`: PDF privado con la misma autorización.

Todas las rutas requieren JWT y correo verificado. La entrevista de IA se limita a adultos según el flujo de consentimiento vigente; la pantalla de seguridad muestra recursos de México y aclara que MindEase no es un servicio de emergencias.

## Pruebas

Desde el backend: `npm test` y `npm run build`.

Desde Flutter: `flutter test` y `flutter analyze`.

Los tests de integración existentes requieren una base PostgreSQL configurada. La generación real de informes requiere credenciales y consentimiento de datos configurados; no se envían respuestas reales durante las pruebas unitarias.
