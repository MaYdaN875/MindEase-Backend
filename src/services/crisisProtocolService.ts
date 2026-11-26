import { AIRiskLevel, Prisma } from '@prisma/client';
import { AppError } from '../middlewares/errorMiddleware';
import { AISafetyService } from '../ai/services/aiSafetyService';

export type CrisisSource = 'AI_ORIENTATION' | 'INITIAL_INTERVIEW' | 'PRIVATE_CHAT' | 'CONTACT_CHAT';

/** Shared operational policy. It is intentionally not a diagnostic or monitoring service. */
export class CrisisProtocolService {
  static readonly version = '2026-10-18';
  static readonly publicNotice = 'MindEase no es un servicio de emergencias ni monitorea conversaciones en tiempo real.';

  static assess(text: string) {
    const safety = AISafetyService.evaluateUserInput(text);
    return { ...safety, requiresImmediateHelp: safety.riskLevel === 'HIGH' || safety.riskLevel === 'EMERGENCY' };
  }

  static async record(tx: Prisma.TransactionClient, input: { userId: string; source: CrisisSource; sourceId?: string; severity: AIRiskLevel }) {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const previous = await tx.crisisEvent.findFirst({ where: {
      userId: input.userId, source: input.source, sourceId: input.sourceId,
      severity: input.severity, detectedAt: { gte: since },
    } });
    if (previous) return previous;
    return tx.crisisEvent.create({ data: { ...input, policyVersion: this.version } });
  }

  static async guardChatMessage(tx: Prisma.TransactionClient, input: { userId: string; source: CrisisSource; sourceId: string; content: string }) {
    const assessment = this.assess(input.content);
    if (!assessment.requiresImmediateHelp) return assessment;
    await this.record(tx, { userId: input.userId, source: input.source, sourceId: input.sourceId, severity: assessment.riskLevel });
    throw new AppError('Este chat no es atención de emergencias. Busca apoyo humano inmediato con los recursos de ayuda.', 409, 'CRISIS_SUPPORT_REQUIRED');
  }
}
