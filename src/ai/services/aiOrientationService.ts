import prisma from '../../config/db';
import { AppError } from '../../middlewares/errorMiddleware';
import { AIProviderFactory } from '../providers/aiProviderFactory';
import { AISafetyService } from './aiSafetyService';
import { AIRecommendationService } from './aiRecommendationService';
import { PROMPT_VERSION } from '../prompts/orientationPrompt';
import { aiOrientationResultSchema } from '../schemas/aiOrientationSchema';
import { assertCanRecommend, requiresCrisisSupport } from './aiSessionPolicy';
import { assertAIConsent } from './aiPrivacyService';
import { AIChatMessage, NeedsProfile } from '../types/ai.types';

const messages = { messages: { orderBy: { createdAt: 'asc' as const } } };
const crisisText = 'Tu seguridad es prioritaria. Esta orientación automática se ha detenido. Busca apoyo humano y comunícate con los recursos de ayuda que aparecen aquí; ante peligro inmediato, contacta a emergencias.';

export class AIOrientationService {
  private static async withResources(session: any) {
    return session && requiresCrisisSupport(session)
      ? { ...session, crisisResources: await AISafetyService.getCrisisResources('MX') } : session;
  }

  static async createOrGetSession(userId: string): Promise<any> {
    await assertAIConsent(userId);
    const existing = await this.getActiveSession(userId);
    if (existing) return existing;
    return prisma.aIOrientationSession.create({ data: {
      userId, status: 'ACTIVE', riskLevel: 'LOW', promptVersion: PROMPT_VERSION,
      provider: AIProviderFactory.getProvider().providerName,
      messages: { create: { role: 'ASSISTANT', content: 'Hola. Soy el asistente de orientación inicial de MindEase. No sustituyo a un profesional. ¿Qué tipo de apoyo te gustaría encontrar?' } },
    }, include: messages });
  }

  static async getActiveSession(userId: string): Promise<any> {
    // An escalation is not silently replaced with a new ordinary conversation.
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

  private static async escalate(userId: string, sessionId: string, savedUserMsg: any, risk: 'HIGH' | 'EMERGENCY') {
    const crisisResources = await AISafetyService.getCrisisResources('MX');
    const result = await prisma.$transaction(async tx => {
      await assertAIConsent(userId, tx);
      // A concurrent lower-risk result must never downgrade EMERGENCY.
      await tx.aIOrientationSession.updateMany({
        where: { id: sessionId, userId, ...(risk === 'HIGH' ? { riskLevel: { not: 'EMERGENCY' as const } } : {}) },
        data: { status: 'ESCALATED', riskLevel: risk, summary: 'Orientación detenida: requiere apoyo humano.', completedAt: null },
      });
      const session = await tx.aIOrientationSession.findUniqueOrThrow({ where: { id: sessionId } });
      const assistantMessage = await tx.aIMessage.create({ data: { sessionId, role: 'ASSISTANT', content: crisisText } });
      return { assistantMessage, riskLevel: session.riskLevel };
    });
    return { userMessage: savedUserMsg, ...result, status: 'ESCALATED', isComplete: true, crisisResources };
  }

  static async processMessage(userId: string, sessionId: string, text: string): Promise<any> {
    await assertAIConsent(userId);
    const session = await this.getSessionById(userId, sessionId);
    if (session.status !== 'ACTIVE' || requiresCrisisSupport(session)) {
      throw new AppError('Esta sesión no admite más mensajes de orientación automática.', 409);
    }
    const preSafety = AISafetyService.evaluateUserInput(text);
    // Safety runs before the ordinary conversation quota.
    if (!requiresCrisisSupport(preSafety) && session.messages.length >= 20) {
      throw new AppError('Has alcanzado el límite de esta orientación. Puedes finalizarla.', 400);
    }
    const userMessage = await prisma.aIMessage.create({ data: { sessionId, role: 'USER', content: text.trim() } });
    if (requiresCrisisSupport(preSafety)) {
      return this.escalate(userId, sessionId, userMessage, preSafety.riskLevel === 'EMERGENCY' ? 'EMERGENCY' : 'HIGH');
    }
    const history: AIChatMessage[] = session.messages.slice(-6).map((m: any) => ({ role: m.role, content: m.content }));
    const specialties = await prisma.specialty.findMany({ select: { name: true } });
    let raw: unknown;
    try {
      raw = await AIProviderFactory.getProvider().generateOrientation({
        userId, sessionId, history, userMessage: text, availableSpecialties: specialties.map(s => s.name),
      });
    } catch {
      throw new AppError('La orientación no está disponible temporalmente. Inténtalo más tarde.', 503);
    }
    // Validate every adapter at the service boundary, not only Gemini.
    const parsed = aiOrientationResultSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('No se pudo validar la respuesta de orientación.', 502);
    const result = parsed.data;
    if (requiresCrisisSupport(result.safety)) {
      return this.escalate(userId, sessionId, userMessage, result.safety.riskLevel === 'EMERGENCY' ? 'EMERGENCY' : 'HIGH');
    }
    const { safeText } = AISafetyService.sanitizeAndValidateAssistantOutput(result.assistantMessage);
    const riskLevel = [session.riskLevel, preSafety.riskLevel, result.safety.riskLevel].includes('MODERATE') ? 'MODERATE' : 'LOW';
    const status = result.conversation.isComplete ? 'COMPLETED' : 'ACTIVE';
    const assistantMessage = await prisma.$transaction(async tx => {
      await assertAIConsent(userId, tx);
      const update = await tx.aIOrientationSession.updateMany({
        where: { id: sessionId, userId, status: 'ACTIVE', riskLevel: { in: ['LOW', 'MODERATE'] } },
        data: { status, riskLevel, summary: result.conversation.summary || null,
          needsProfile: result.needsProfile, completedAt: status === 'COMPLETED' ? new Date() : null },
      });
      if (update.count !== 1) throw new AppError('La sesión cambió de estado. Vuelve a cargarla.', 409);
      return tx.aIMessage.create({ data: { sessionId, role: 'ASSISTANT', content: safeText } });
    });
    return { userMessage, assistantMessage, status, riskLevel, isComplete: status === 'COMPLETED' };
  }

  static async completeSession(userId: string, sessionId: string) {
    await assertAIConsent(userId);
    const session = await this.getSessionById(userId, sessionId);
    assertCanRecommend(session);
    if (session.status === 'ACTIVE') {
      const update = await prisma.aIOrientationSession.updateMany({
        where: { id: sessionId, userId, status: 'ACTIVE', riskLevel: { in: ['LOW', 'MODERATE'] } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (update.count !== 1) throw new AppError('La sesión cambió de estado. Vuelve a cargarla.', 409);
    }
    return this.getRecommendations(userId, sessionId);
  }

  static async getRecommendations(userId: string, sessionId: string) {
    await assertAIConsent(userId);
    const session = await this.getSessionById(userId, sessionId);
    assertCanRecommend(session);
    if (session.status !== 'COMPLETED') throw new AppError('Primero debes finalizar la orientación.', 409);
    const needs: NeedsProfile = session.needsProfile || {
      primaryConcern: null, topics: [], suggestedSpecialties: [],
      preferences: { modality: null, preferredTime: null, maxBudget: null },
    };
    return AIRecommendationService.generateRecommendations(sessionId, needs);
  }
}
