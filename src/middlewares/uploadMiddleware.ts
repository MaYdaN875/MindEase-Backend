import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Request } from 'express';
import { AppError } from './errorMiddleware';

// Private documents storage (psychologist credentials, etc.)
const uploadDir = path.join(process.cwd(), 'storage', 'private_documents');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const privateStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

const privateFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['.pdf', '.jpg', '.jpeg', '.png'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new AppError('Only PDFs and images (JPG, PNG) are allowed', 400) as any, false);
  }
};

export const upload = multer({
  storage: privateStorage,
  fileFilter: privateFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});
export { uploadDir };

// Public community uploads storage (images, educational PDFs)
const communityUploadDir = path.join(process.cwd(), 'uploads', 'community');
if (!fs.existsSync(communityUploadDir)) {
  fs.mkdirSync(communityUploadDir, { recursive: true });
}

const communityStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, communityUploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${crypto.randomUUID()}${ext}`;
    cb(null, uniqueName);
  },
});

const ALLOWED_COMMUNITY_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
];

const communityFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_COMMUNITY_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('Tipo de archivo no permitido. Solo se aceptan imágenes (JPG, PNG, WEBP, GIF) y documentos PDF.', 400));
  }
};

export const communityUpload = multer({
  storage: communityStorage,
  fileFilter: communityFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});
export { communityUploadDir };

// Support tickets attachments storage (screenshots, receipts, logs)
const supportUploadDir = path.join(process.cwd(), 'uploads', 'support');
if (!fs.existsSync(supportUploadDir)) {
  fs.mkdirSync(supportUploadDir, { recursive: true });
}

const supportStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, supportUploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${crypto.randomUUID()}${ext}`;
    cb(null, uniqueName);
  },
});

const ALLOWED_SUPPORT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
];

const supportFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_SUPPORT_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('Tipo de archivo no permitido. Solo se aceptan imágenes (JPG, PNG, WEBP, GIF) y documentos PDF.', 400));
  }
};

export const supportUpload = multer({
  storage: supportStorage,
  fileFilter: supportFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit per attachment
  },
});
export { supportUploadDir };

