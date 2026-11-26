import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError } from '../middlewares/errorMiddleware';

function encryptionKey(): Buffer {
  const configured = (process.env.INITIAL_INTERVIEW_ENCRYPTION_KEY || '').trim();
  const key = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    throw new AppError('La entrevista no está disponible: falta configurar una clave de cifrado clínica de 32 bytes.', 503, 'INTERVIEW_ENCRYPTION_UNAVAILABLE');
  }
  return key;
}

export function encryptClinicalData(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${ciphertext.toString('hex')}`;
}

export function decryptClinicalData<T>(value: string): T {
  const [version, ivHex, tagHex, ciphertextHex] = value.split('.');
  if (version !== 'v1' || !ivHex || !tagHex || !ciphertextHex) {
    throw new AppError('No fue posible leer el expediente protegido.', 500, 'CLINICAL_DATA_INVALID');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('No fue posible leer el expediente protegido.', 500, 'CLINICAL_DATA_INVALID');
  }
}

export function assertInitialInterviewEncryptionConfigured(): void {
  encryptionKey();
}
