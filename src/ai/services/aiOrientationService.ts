import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../config/db';
import { AppError } from '../../middlewares/errorMiddleware';
import { AIProviderFactory } from '../providers/aiProviderFactory';
import { AISafetyService } from './aiSafetyService';
import { AIRecommendationService } from './aiRecommendationService';
import { PROMPT_VERSION } from '../prompts/orientationPrompt';
import { aiOrientationResultSchema } from '../schemas/aiOrientationSchema';
import { assertCanRecommend, requiresCrisisSupport } from './aiSessionPolicy';
import { assertAIConsent } from './aiPrivacyService';
import { orientationQuota } from './aiQuota';
import { AIChatMessage, NeedsProfile } from '../types/ai.types';

const messages = { messages: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] } };
const crisisText = 'Tu seguridad es prioritaria. Esta orientación automática se ha detenido. Busca apoyo humano y comunícate con los recursos de ayuda que aparecen aquí; ante peligro inmediato, contacta a emergencias.';
const busy = () => new AppError('Ya se está procesando un mensaje. Espera un momento y reintenta.', 409, 'AI_REQUEST_IN_PROGRESS', true, 2);

export class AIOrientationService {
  private static async withResources(session: any) {
    if (!session) return session;
    return { ...session,
      summary: AISafetyService.sanitizeSummary(session.summary),
      needsProfile: session.needsProfile ? AISafetyService.sanitizeNeedsProfile(session.needsProfile) : null,
      messages: session.messages.map((m: any) => m.role === 'ASSISTANT'
        ? { ...m, content: AISafetyService.sanitizeAndValidateAssistantOutput(m.content).safeText } : m),
      quota: orientationQuota(session.messages),
      ...(requiresCrisisSupport(session) ? { crisisResources: await AISafetyService.getCrisisResources('MX') } : {}) };
  }

  static async createOrGetSession(userId: string): Promise<any> {
    await assertAIConsent(userId);
    const session = await prisma.$transaction(async tx => {
      // Serialize creation across replicas without keeping a transaction open during Gemini calls.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      await assertAIConsent(userId, tx);
      const existing = await tx.aIOrientationSession.findFirst({
        where: { userId, status: 'ESCALATED' }, orderBy: { createdAt: 'desc' }, include: messages,
      }) || await tx.aIOrientationSession.findFirst({
        where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, include: messages,
      });
      if (existing) return existing;
      return tx.aIOrientationSession.create({ data: {
        userId, status: 'ACTIVE', riskLevel: 'LOW', promptVersion: PROMPT_VERSION,
        provider: AIProviderFactory.getProvider().providerName,
        messages: { create: { role: 'ASSISTANT', content: 'Hola. Soy el asistente de orientación inicial de MindEase. No sustituyo a un profesional. ¿Qué tipo de apoyo te gustaría encontrar?' } },
      }, include: messages });
    });
    return this.withResources(session);
  }

  static async getActiveSession(userId: string): Promise<any> {
    const escalated = await prisma.aIOrientationSession.findFirst({
      where: { userId, status: 'ESCALATED' }, orderBy: { createdAt: 'desc' }, include: messages,
    });
    return this.withResources(escalated || await prisma.aIOrientationSession.findFirst({
      where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, include: messages,
    }));
  }

  static async getSessionById(userId: string, sessionId: string): Promise<any> {
    const session = await prisma.aIOrientationSession.findUnique({ where: { id: sessionId }, include: messages });
    if (!session) throw new AppError('Sesión de orientación no encontrada', 404);
    if (session.userId !== userId) throw new AppError('No tienes permiso para acceder a esta sesión', 403);
    return this.withResources(session);
  }

  private static async lockSession(tx: Prisma.TransactionClient, userId: string, sessionId: string) {
    await tx.$queryRaw`SELECT "id" FROM "AIOrientationSession" WHERE "id" = ${sessionId} AND "userId" = ${userId} FOR UPDATE`;
    const session = await tx.aIOrientationSession.findUnique({ where: { id: sessionId }, include: messages });
    if (!session) throw new AppError('Sesión de orientación no encontrada', 404);
    if (session.userId !== userId) throw new AppError('No tienes permiso para acceder a esta sesión', 403);
    return session;
  }

  static async processMessage(userId: string, sessionId: string, text: string, requestKey: string): Promise<any> {
    await assertAIConsent(userId);
    text = text.trim();
    const contentHash = createHash('sha256').update(text).digest('hex');
    const claimToken = randomUUID();
    let preSafety = AISafetyService.evaluateUserInput(text);
    let urgent = requiresCrisisSupport(preSafety);
    const claimed = await prisma.$transaction(async tx => {
      const session = await this.lockSession(tx, userId, sessionId);
      await assertAIConsent(userId, tx);
      const previous = await tx.aIMessageRequest.findUnique({ where: { sessionId_requestKey: { sessionId, requestKey } } });
      if (previous && previous.contentHash !== contentHash) throw new AppError('La identificación del envío ya fue usada para otro mensaje.', 409, 'AI_IDEMPOTENCY_CONFLICT');
      // A lost HTTP response is replayable even when the successful turn closed/escalated the session.
      if (previous?.status === 'SUCCEEDED') return { replay: previous.response, session };
      if (session.status !== 'ACTIVE' || requiresCrisisSupport(session)) {
        throw new AppError('Esta sesión no admite más mensajes de orientación automática.', 409, 'AI_SESSION_CLOSED');
      }
      preSafety = AISafetyService.evaluateConversation(text, session.messages, session.riskLevel);
      urgent = requiresCrisisSupport(preSafety);
      const now = new Date();
      const active = await tx.aIMessageRequest.findFirst({ where: { sessionId, status: 'PROCESSING', leaseUntil: { gt: now } } });
      if (active && (!urgent || active.requestKey === requestKey)) throw busy();
      // A local crisis can preempt ordinary inference. The old worker cannot commit without its token.
      await tx.aIMessageRequest.updateMany({ where: { sessionId, status: 'PROCESSING', ...(urgent ? {} : { leaseUntil: { lte: now } }) }, data: { status: 'FAILED' } });
      if (!urgent && orientationQuota(session.messages).remaining === 0) {
        throw new AppError('Alcanzaste el límite de mensajes respondidos. Puedes finalizar para ver tus resultados.', 409, 'AI_SESSION_LIMIT');
      }
      await tx.aIMessageRequest.upsert({
        where: { sessionId_requestKey: { sessionId, requestKey } },
        create: { sessionId, requestKey, contentHash, claimToken, leaseUntil: new Date(now.getTime() + 90000) },
        update: { claimToken, status: 'PROCESSING', leaseUntil: new Date(now.getTime() + 90000), response: Prisma.DbNull },
      });
      return { session, replay: null };
    });
    if (claimed.replay) {
      const current = await this.withResources(claimed.session);
      const receipt = claimed.replay as any;
      return { ...receipt,
        assistantMessage: { ...receipt.assistantMessage, content: AISafetyService.sanitizeAndValidateAssistantOutput(receipt.assistantMessage.content).safeText },
        status: current.status, riskLevel: current.riskLevel,
        isComplete: current.status !== 'ACTIVE', quota: current.quota, crisisResources: current.crisisResources };
    }

    try {
      let result: any;
      if (!urgent) {
        const history: AIChatMessage[] = claimed.session.messages.slice(-6).map(m => ({ role: m.role,
          content: m.role === 'ASSISTANT' ? AISafetyService.sanitizeAndValidateAssistantOutput(m.content).safeText : m.content }));
        const specialties = await prisma.specialty.findMany({ select: { name: true } });
        const raw = await AIProviderFactory.getProvider().generateOrientation({ userId, sessionId, history,
          userMessage: text, availableSpecialties: specialties.map(s => s.name) });
        const parsed = aiOrientationResultSchema.safeParse(raw);
        if (!parsed.success) throw new AppError('No se pudo validar la respuesta de orientación.', 502, 'AI_RESPONSE_INVALID');
        result = AISafetyService.sanitizeOrientationResult(parsed.data);
      }
      const escalated = urgent || requiresCrisisSupport(result.safety);
      const crisisResources = escalated ? await AISafetyService.getCrisisResources('MX') : undefined;
      return await prisma.$transaction(async tx => {
        const session = await this.lockSession(tx, userId, sessionId);
        await assertAIConsent(userId, tx);
        const request = await tx.aIMessageRequest.findUniqueOrThrow({ where: { sessionId_requestKey: { sessionId, requestKey } } });
        if (request.claimToken !== claimToken || request.status !== 'PROCESSING' || request.leaseUntil <= new Date()) throw busy();
        if (session.status !== 'ACTIVE' || requiresCrisisSupport(session)) {
          throw new AppError('La sesión cambió de estado. Vuelve a cargarla.', 409, 'AI_SESSION_CLOSED');
        }
        const riskLevel = escalated ? ([preSafety.riskLevel, result?.safety.riskLevel].includes('EMERGENCY') ? 'EMERGENCY' : 'HIGH')
          : [session.riskLevel, preSafety.riskLevel, result.safety.riskLevel].includes('MODERATE') ? 'MODERATE' : 'LOW';
        const status = escalated ? 'ESCALATED' : result.conversation.isComplete ? 'COMPLETED' : 'ACTIVE';
        const content = escalated ? crisisText : AISafetyService.sanitizeAndValidateAssistantOutput(result.assistantMessage).safeText;
        await tx.aIOrientationSession.update({ where: { id: sessionId }, data: {
          status, riskLevel, summary: escalated ? 'Orientación detenida: requiere apoyo humano.' : result.conversation.summary || null,
          ...(!escalated ? { needsProfile: result.needsProfile } : {}), completedAt: status === 'COMPLETED' ? new Date() : null,
        } });
        // Persist the pair and receipt atomically. Failed attempts never become conversation messages.
        const now = new Date();
        const userMessage = await tx.aIMessage.create({ data: { sessionId, role: 'USER', content: text, createdAt: now } });
        const assistantMessage = await tx.aIMessage.create({ data: { sessionId, role: 'ASSISTANT', content, createdAt: new Date(now.getTime() + 1) } });
        const response = JSON.parse(JSON.stringify({ userMessage, assistantMessage, status, riskLevel,
          isComplete: status !== 'ACTIVE', crisisResources,
          quota: orientationQuota([...session.messages, userMessage, assistantMessage]) }));
        await tx.aIMessageRequest.update({ where: { id: request.id }, data: { status: 'SUCCEEDED', response } });
        return response;
      });
    } catch (error) {
      await prisma.aIMessageRequest.updateMany({ where: { sessionId, requestKey, claimToken, status: 'PROCESSING' }, data: { status: 'FAILED' } }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError('No se pudo completar el envío. Puedes reintentar sin duplicarlo.', 503, 'AI_REQUEST_FAILED', true);
    }
  }

  static async completeSession(userId: string, sessionId: string) {
    await assertAIConsent(userId);
    await prisma.$transaction(async tx => {
      const session = await this.lockSession(tx, userId, sessionId);
      assertCanRecommend(session);
      if (await tx.aIMessageRequest.findFirst({ where: { sessionId, status: 'PROCESSING', leaseUntil: { gt: new Date() } } })) throw busy();
      if (session.status === 'ACTIVE') await tx.aIOrientationSession.update({ where: { id: sessionId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    });
    return this.getRecommendations(userId, sessionId);
  }

  static async getRecommendations(userId: string, sessionId: string) {
    await assertAIConsent(userId);
    const session = await this.getSessionById(userId, sessionId);
    assertCanRecommend(session);
    if (session.status !== 'COMPLETED') throw new AppError('Primero debes finalizar la orientación.', 409);
    const needs: NeedsProfile = session.needsProfile || { primaryConcern: null, topics: [], suggestedSpecialties: [],
      preferences: { modality: null, preferredTime: null, maxBudget: null } };
    return AIRecommendationService.generateRecommendations(sessionId, needs);
  }
}
