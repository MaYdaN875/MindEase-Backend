# MindEase Backend - Node.js + Express + Prisma + PostgreSQL

Este es el backend de la aplicación **MindEase**, diseñado para gestionar la autenticación de usuarios y profesionales (psicólogos), control de sesiones y perfiles.

---

## 🛠️ Tecnologías Utilizadas

- **Runtime**: Node.js (v20+)
- **Lenguaje**: TypeScript
- **Framework**: Express.js
- **ORM**: Prisma ORM
- **Base de Datos**: PostgreSQL
- **Seguridad**: JSON Web Tokens (JWT) & BcryptJS (Hashing de contraseñas)
- **Validación de Datos**: Zod

---

## ⚙️ Requisitos Previos

Asegúrate de tener instalado:
- [Node.js](https://nodejs.org/) (versión 18 o superior)
- [Docker](https://www.docker.com/) (opcional, si deseas ejecutar PostgreSQL mediante contenedores)
- Un cliente de base de datos PostgreSQL activo (si prefieres ejecutarlo localmente sin Docker)

---

## 🚀 Inicialización y Configuración

Sigue estos pasos para arrancar el backend en tu entorno local.

### Paso 1: Configurar Variables de Entorno

Crea un archivo llamado `.env` en la raíz de la carpeta `MindEase-back/`. Puedes basarte en el archivo `.env.example` provisto:

```env
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mindease?schema=public"
JWT_SECRET="tu-clave-secreta-de-seguridad-cambiar-en-produccion"
JWT_EXPIRES_IN="7d"
```

> 💡 **Nota**: Si vas a ejecutar la base de datos dentro de Docker, mantén la configuración por defecto de `DATABASE_URL`.

---

### Opción A: Inicializar con Docker (Recomendado)

Docker Compose levantará automáticamente tanto la base de datos PostgreSQL como la aplicación Express ya compilada, configurando la red interna entre ambos.

1. **Construir y arrancar contenedores**:
   ```bash
   docker-compose up --build
   ```
2. **Ejecutar migraciones en la base de datos** (Solo la primera vez):
   Abre otra pestaña de la terminal y ejecuta:
   ```bash
   npx prisma migrate dev --name init
   ```

La aplicación estará activa en `http://localhost:3000`.

---

### Opción B: Inicializar Localmente (Desarrollo)

Si prefieres ejecutar el servidor Node directamente en tu sistema host:

1. **Instalar las dependencias**:
   ```bash
   npm install
   ```
2. **Levantar tu servidor de PostgreSQL** y verificar que la URL de conexión en tu `.env` sea correcta.
3. **Ejecutar las migraciones iniciales de base de datos**:
   ```bash
   npx prisma migrate dev --name init
   ```
4. **Iniciar el servidor en modo desarrollo** (con recarga en vivo):
   ```bash
   npm run dev
   ```

El servidor estará escuchando en `http://localhost:3000`.

---

## 📂 Estructura del Código

```text
MindEase-back/
├── prisma/
│   └── schema.prisma      # Esquema de base de datos (Prisma Schema)
├── src/
│   ├── config/            # Configuraciones (Ej: cliente de Prisma)
│   ├── controllers/       # Lógica de controladores (Auth, User)
│   ├── middlewares/       # Filtros y validaciones (JWT Auth, Error handler)
│   ├── routes/            # Definición de rutas del API
│   ├── utils/             # Funciones utilitarias (Tokens, Hashing)
│   ├── app.ts             # Configuración de Middlewares globales de Express
│   └── server.ts          # Punto de entrada y arranque del servidor
├── .env.example           # Plantilla de variables de entorno
├── docker-compose.yml     # Orquestación de servicios PostgreSQL y Node
└── Dockerfile             # Configuración de empaquetado Docker
```

---

## 📡 Endpoints del API

### Rutas de Autenticación (`/api/auth`)

| Método | Endpoint | Descripción | Cuerpo de la Petición (JSON) |
| :--- | :--- | :--- | :--- |
| **POST** | `/api/auth/register` | Registra un usuario o psicólogo. | `{ "name": "Nombre", "email": "email@test.com", "password": "123456", "role": "USER" / "PSYCHOLOGIST" }` |
| **POST** | `/api/auth/login` | Inicia sesión y devuelve un token JWT. | `{ "email": "email@test.com", "password": "123456" }` |
| **POST** | `/api/auth/forgot-password` | Genera un token de recuperación. | `{ "email": "email@test.com" }` |
| **POST** | `/api/auth/reset-password` | Restablece contraseña usando el token. | `{ "token": "hash-recuperado", "password": "nueva-contrasena" }` |

### Rutas de Usuario (`/api/users`) - *Requieren cabecera `Authorization: Bearer <JWT>`*

| Método | Endpoint | Descripción | Cabecera Requerida |
| :--- | :--- | :--- | :--- |
| **GET** | `/api/users/profile` | Obtiene el perfil del usuario autenticado. | `Authorization: Bearer <TOKEN>` |
| **PUT** | `/api/users/profile` | Actualiza datos de perfil (nombre/email). | `Authorization: Bearer <TOKEN>` |

---

## 🧪 Pruebas de Integración

Hemos creado un script Node automatizado para verificar que todas las llamadas del API funcionen.
Con el servidor corriendo en el puerto `3000`, puedes ejecutar en tu terminal:

```bash
node path/to/test_api.js
```
*(Puedes encontrar la ruta del script de pruebas en las notificaciones del chat del asistente de Gemini).*
