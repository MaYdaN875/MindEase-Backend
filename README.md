# ⚙️ MindEase Backend API

API REST y motor central de servicios para la plataforma **MindEase**, desarrollada con **Node.js**, **Express**, **TypeScript**, **Prisma ORM** y base de datos **PostgreSQL**.

---

## 🛠️ Stack Tecnológico

* **Entorno de Ejecución:** Node.js (v20+ LTS)
* **Lenguaje:** TypeScript (v5.4+)
* **Framework Web:** Express.js (v4.19+)
* **ORM:** Prisma (v5.12+)
* **Base de Datos:** PostgreSQL (v15+)
* **Autenticación y Seguridad:** JSON Web Tokens (JWT) & bcryptjs
* **Almacenamiento de Archivos:** Multer con almacenamiento persistente local
* **Contenedores:** Docker & Docker Compose

---

## 📋 Requisitos Previos

* **[Node.js](https://nodejs.org/)** (v20.x o superior) y **npm** (v10+)
* **[Docker Desktop](https://www.docker.com/)** con **Docker Compose** *(Recomendado para base de datos y despliegue rápido)*
* O **[PostgreSQL](https://www.postgresql.org/)** instalado localmente si no deseas usar Docker.

---

## 📁 Estructura del Repositorio

```text
MindEase-back/
├── prisma/
│   └── schema.prisma         # Modelos de datos PostgreSQL (User, PsychologistProfile, ProfessionalDocument, etc.)
├── src/
│   ├── controllers/          # Lógica de negocio (adminController, authController, etc.)
│   ├── middlewares/          # Autenticación JWT, RBAC (roles) y manejo de errores
│   ├── routes/               # Enrutadores Express (adminRoutes, authRoutes, etc.)
│   ├── services/             # Servicios de utilidad (token, auditLogger)
│   ├── types/                # Definiciones de tipos e interfaces TypeScript
│   └── server.ts             # Punto de entrada de la aplicación Express
├── storage/                  # Carpeta de almacenamiento físico persistente para PDFs y documentos
├── docker-compose.yml        # Orquestación de backend (app) y PostgreSQL (db)
├── Dockerfile                # Imagen multi-stage optimizada para producción
├── package.json              # Dependencias y scripts del proyecto
└── tsconfig.json             # Configuración del compilador TypeScript
```

---

## 🚀 Guía de Instalación y Compilación

### Opción 1: Ejecución con Docker Compose (Recomendada)

Docker levantará automáticamente la base de datos PostgreSQL (`mindease-db`) en el puerto `5432` y la API (`mindease-app`) en el puerto `3000`, aplicando las migraciones de Prisma al iniciar.

1. Abre tu terminal en este directorio (`MindEase-back`):
   ```bash
   cd MindEase-back
   ```

2. Construye e inicia los contenedores en segundo plano:
   ```bash
   docker compose up -d --build
   ```

3. Verifica el estado de los contenedores:
   ```bash
   docker compose ps
   ```

4. Para ver los registros y logs en tiempo real:
   ```bash
   docker compose logs -f app
   ```

5. Para detener los contenedores:
   ```bash
   docker compose down
   ```

---

### Opción 2: Ejecución Local en tu Sistema Operativo

Si prefieres ejecutar el servidor Node.js directamente en tu máquina:

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Configurar variables de entorno:**
   Crea un archivo `.env` en la raíz de `MindEase-back/` con el siguiente contenido:
   ```env
   PORT=3000
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mindease?schema=public"
   JWT_SECRET="super-secret-mindease-jwt-key-change-in-production"
   JWT_EXPIRES_IN="7d"
   ```

3. **Sincronizar base de datos con Prisma:**
   ```bash
   # Genera el cliente tipado de Prisma
   npx prisma generate

   # Aplica el esquema a PostgreSQL
   npx prisma db push
   ```

4. **Compilar e Iniciar:**
   ```bash
   # Modo desarrollo (con recarga en vivo)
   npm run dev

   # Compilar para producción (TypeScript -> JavaScript en /dist)
   npm run build

   # Iniciar el servidor compilado
   npm start
   ```

---

## 📡 Catálogo de Endpoints Principales

Todos los endpoints tienen como base: `http://localhost:3000/api`

### 🔑 Autenticación (`/api/auth`)
* `POST /auth/register` - Registro de nuevos usuarios o psicólogos.
* `POST /auth/login` - Inicio de sesión y emisión de JWT.

### 🛡️ Panel Administrativo y Revisión Clínica (`/api/admin`) *(Requiere JWT)*
* `GET /admin/dashboard/stats` - Métricas de usuarios, tasa de aprobación y top de especialidades.
* `GET /admin/psychologist-applications` - Listado de solicitudes de verificación.
* `GET /admin/psychologist-applications/:id` - Expediente clínico completo (Dossier).
* `POST /admin/psychologist-applications/:id/approve` - Aprobar expediente clínico.
* `POST /admin/psychologist-applications/:id/request-changes` - Solicitar correcciones con observaciones.
* `POST /admin/psychologist-applications/:id/reject` - Rechazar solicitud de verificación.
* `GET /admin/documents/:id/download` - Descarga segura de PDFs/imágenes del storage.
* `PUT /admin/documents/:id/status` - Validación individual de documento (`APPROVED`, `REJECTED`, `PENDING`) y asignación de `expiresAt`.

### 👥 Gestión de Usuarios y Roles (`/api/admin`)
* `GET /admin/users` - Lista de usuarios con roles, perfil clínico y consentimientos.
* `GET /admin/roles` - Lista de roles del sistema (`ADMIN`, `REVISOR`, `USER`, `PSYCHOLOGIST`, `SUPERADMIN`).
* `PUT /admin/users/:userId/roles` - Asignación dinámica de roles en vivo.
* `PUT /admin/users/:userId/status` - Suspensión y reactivación de cuentas.

### 🏷️ Catálogo Dinámico de Especialidades (`/api/admin/specialties`)
* `GET /admin/specialties` - Lista de especialidades con recuento de psicólogos asociados.
* `POST /admin/specialties` - Crear nueva especialidad.
* `PUT /admin/specialties/:id` - Actualizar nombre de especialidad.
* `DELETE /admin/specialties/:id` - Eliminar especialidad (con protección de integridad).

### 🔒 Seguridad, Auditoría y Cumplimiento (`/api/admin`)
* `GET /admin/audit-logs` - Registro forense de acciones administrativas con filtros.
* `GET /admin/audit-logs/export-csv` - Descarga de reporte `.csv` para cumplimiento normativo (ISO/HIPAA/GDPR).

### 🔔 Notificaciones y Avisos (`/api/admin/notifications`)
* `GET /admin/notifications` - Lista de notificaciones recibidas y conteo no leído.
* `PUT /admin/notifications/:id/read` - Marcar notificación como leída.
* `PUT /admin/notifications/mark-all-read` - Marcar todas como leídas.
* `POST /admin/notifications/broadcast` - Emitir comunicado general a todos los usuarios.

---

## 🧰 Comandos de Mantenimiento

| Comando | Descripción |
| :--- | :--- |
| `npm run prisma:studio` | Abre la interfaz visual de base de datos de Prisma en `http://localhost:5555`. |
| `npx tsc --noEmit` | Valida errores de tipos TypeScript sin generar archivos. |
| `npm run build` | Compila todo el código TypeScript a la carpeta `dist/`. |
| `docker compose logs -f app` | Monitorea los logs del backend en tiempo real. |

---

## 🔒 Persistencia de Archivos

Los documentos privados subidos por los profesionales (cédulas, títulos, identificaciones) se almacenan físicamente en:
`MindEase-back/storage/private_documents/`

El archivo `docker-compose.yml` mapea este directorio mediante un volumen persistente (`./storage:/usr/src/app/storage`), garantizando que ningún archivo se pierda al reiniciar o reconstruir los contenedores.
