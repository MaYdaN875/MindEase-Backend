import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/db';
import { AuthenticatedRequest } from '../../middlewares/authMiddleware';
import { AppError } from '../../middlewares/errorMiddleware';
import { AIOrientationService } from '../services/aiOrientationService';
import { aiPrivacyNotice, assertAIDataConfiguration } from '../services/aiPrivacyService';

type Handler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
const handle = (action: (req: AuthenticatedRequest, res: Response) => Promise<void>): Handler =>
  async (req, res, next) => { try { await action(req, res); } catch (error) { next(error); } };

export const getConsentStatus = handle(async (req, res) => {
  const notice = aiPrivacyNotice();
  const consent = await prisma.userConsent.findFirst({ where: {
    userId: req.user!.userId, consentType: `AI_ORIENTATION_${notice.version}`,
  } });
  res.json({ status: 'success', data: { hasConsent: !!consent, acceptedAt: consent?.acceptedAt || null, ...notice } });
});

export const registerConsent = handle(async (req, res) => {
  assertAIDataConfiguration();
  const notice = aiPrivacyNotice();
  const parsed = z.object({ version: z.literal(notice.version), adultConfirmed: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) throw new AppError('Acepta el aviso vigente y confirma que eres mayor de 18 años.', 400);
  const where = { userId: req.user!.userId, consentType: `AI_ORIENTATION_${notice.version}` };
  const existing = await prisma.userConsent.findFirst({ where });
  const consent = existing || await prisma.userConsent.create({ data: where });
  res.status(existing ? 200 : 201).json({ status: 'success', data: { consent } });
});

export const deleteHistoryAndConsent = handle(async (req, res) => {
  const userId = req.user!.userId;
  await prisma.$transaction(async tx => {
    await tx.aIOrientationSession.deleteMany({ where: { userId } });
    await tx.userConsent.deleteMany({ where: { userId, consentType: { startsWith: 'AI_ORIENTATION_' } } });
  });
  res.json({ status: 'success', message: 'Historial de orientación eliminado y consentimiento retirado.' });
});

export const createSession = handle(async (req, res) => {
  const session = await AIOrientationService.createOrGetSession(req.user!.userId);
  res.status(201).json({ status: 'success', data: { session } });
});

export const getActiveSession = handle(async (req, res) => {
  const session = await AIOrientationService.getActiveSession(req.user!.userId);
  res.json({ status: 'success', data: { session: session || null } });
});

export const getSessionById = handle(async (req, res) => {
  const session = await AIOrientationService.getSessionById(req.user!.userId, req.params.id);
  res.json({ status: 'success', data: { session } });
});

export const sendMessage = handle(async (req, res) => {
  const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) throw new AppError('El mensaje debe contener entre 1 y 2000 caracteres.', 400);
  const data = await AIOrientationService.processMessage(req.user!.userId, req.params.id, parsed.data.message);
  res.json({ status: 'success', data });
});

export const completeSession = handle(async (req, res) => {
  const data = await AIOrientationService.completeSession(req.user!.userId, req.params.id);
  res.json({ status: 'success', data });
});

export const getRecommendations = handle(async (req, res) => {
  const data = await AIOrientationService.getRecommendations(req.user!.userId, req.params.id);
  res.json({ status: 'success', data });
});
