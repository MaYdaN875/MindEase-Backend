import { LegalAudience, Prisma } from '@prisma/client';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';

export type RegistrationRole = 'USER' | 'PSYCHOLOGIST';
export const registrationLegalTexts = (role: RegistrationRole, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.legalText.findMany({ where: { isActive: true, audience: role === 'PSYCHOLOGIST' ? { in: [LegalAudience.ALL, LegalAudience.PSYCHOLOGIST] } : LegalAudience.ALL }, orderBy: [{ audience: 'asc' }, { title: 'asc' }] });

export async function assertRegistrationLegalAcceptances(role: RegistrationRole, acceptances: Array<{ id: string; version: string }>, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const texts = await registrationLegalTexts(role, db);
  if (!texts.length) throw new AppError('No hay textos legales publicados para completar el registro.', 503, 'LEGAL_TEXTS_UNAVAILABLE');
  const accepted = new Map(acceptances.map(item => [item.id, item.version]));
  const missing = texts.find(text => accepted.get(text.id) !== text.version);
  if (missing) throw new AppError(`Debes aceptar la versión vigente de: ${missing.title}.`, 400, 'LEGAL_ACCEPTANCE_REQUIRED');
  return texts;
}
