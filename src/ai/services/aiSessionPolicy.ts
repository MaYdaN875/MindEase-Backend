import { AppError } from '../../middlewares/errorMiddleware';

export function requiresCrisisSupport(session: { status?: string; riskLevel: string; requiresImmediateHelp?: boolean }): boolean {
  return session.status === 'ESCALATED' || session.riskLevel === 'HIGH' ||
    session.riskLevel === 'EMERGENCY' || session.requiresImmediateHelp === true;
}

export function assertCanRecommend(session: { status: string; riskLevel: string }): void {
  if (requiresCrisisSupport(session) || session.status === 'CANCELLED') {
    throw new AppError('Esta sesión requiere apoyo humano; no permite recomendaciones automáticas.', 409);
  }
}
