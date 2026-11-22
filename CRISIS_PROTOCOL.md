# Límites de atención y protocolo de crisis

MindEase facilita orientación inicial, contacto con profesionales y sesiones programadas. No sustituye la atención clínica, los servicios de emergencia, ni ofrece monitoreo de conversaciones en tiempo real.

## Casos fuera del alcance inmediato

Ante riesgo inminente de autolesión, suicidio, violencia hacia terceros, abuso en curso o una emergencia médica/psiquiátrica, la plataforma detiene la automatización en orientación y bloquea el envío de ese contenido en los chats privados. La persona recibe recursos de ayuda y debe contactar emergencias locales o apoyo humano inmediato.

No se generan notificaciones automáticas a psicólogos, administradores ni contactos: eso podría crear una falsa expectativa de vigilancia o respuesta inmediata. Los recursos sólo abren el marcador cuando la persona decide hacerlo.

## Tratamiento mínimo de datos

Cuando se detecta riesgo alto o de emergencia se conserva únicamente un evento operativo: usuario, origen, nivel, versión de política y fecha. No se guarda el texto detectado en ese evento. Los mensajes de alto riesgo bloqueados no se entregan a la otra persona.

## Alcance técnico actual

- Orientación IA: finaliza la sesión en estado `ESCALATED` y presenta recursos.
- Chats de sesión y de contacto: bloquean contenido de riesgo alto/emergencia y presentan ayuda urgente.
- Recursos: endpoint público `GET /api/crisis/resources`, para que sigan disponibles con una sesión vencida.

Este protocolo debe ser revisado y aprobado por profesionales clínicos y asesoría legal antes de producción pública. También deben definirse recursos por país antes de habilitar mercados fuera de México.
