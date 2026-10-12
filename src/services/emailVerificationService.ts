import crypto from 'crypto';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';
import { sendEmail } from './emailService';

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

const hashCode = (userId: string, code: string): string =>
  crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

export const sendVerificationCode = async (user: { id: string; email: string }): Promise<void> => {
  const last = await prisma.emailVerificationCode.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last.createdAt.getTime())) / 1000);
    throw new AppError(`Espera ${wait} segundos antes de solicitar otro código.`, 429, 'EMAIL_CODE_COOLDOWN', true, wait);
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  // Invalidate previous codes so only the newest one works.
  await prisma.emailVerificationCode.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  await prisma.emailVerificationCode.create({
    data: { userId: user.id, codeHash: hashCode(user.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });

  await sendEmail({
    to: user.email,
    subject: 'Tu código de verificación de MindEase',
    text: `Tu código de verificación es ${code}. Vence en 15 minutos. Si no creaste una cuenta en MindEase, ignora este mensaje.`,
  });
};

export const verifyCode = async (userId: string, code: string): Promise<void> => {
  const record = await prisma.emailVerificationCode.findFirst({
    where: { userId, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record || record.expiresAt < new Date()) {
    throw new AppError('El código es inválido o ha vencido. Solicita uno nuevo.', 400, 'EMAIL_CODE_INVALID');
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    throw new AppError('Demasiados intentos. Solicita un código nuevo.', 429, 'EMAIL_CODE_LOCKED');
  }

  const expected = Buffer.from(record.codeHash, 'hex');
  const actual = Buffer.from(hashCode(userId, code), 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) {
    await prisma.emailVerificationCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw new AppError('El código es incorrecto.', 400, 'EMAIL_CODE_INVALID');
  }

  await prisma.$transaction([
    prisma.emailVerificationCode.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
};
