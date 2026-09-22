import multer from 'multer';
import path from 'path';
import fs from 'fs';
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

// Validate actual bytes before persisting community/support uploads.
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, parts: 12 },
});
export const communityUpload = mediaUpload;
export const supportUpload = mediaUpload;
