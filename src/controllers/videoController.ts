import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { serializable, requireProfessional } from '../services/clinicalPolicy';
import { requirePaid } from '../services/paymentWorkflow';
import { createJaasSession } from '../services/jaasService';

export async function getVideoSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!z.string().uuid().safeParse(req.params.appointmentId).success) throw new AppError('Cita inválida', 400);
    const session = await serializable(async tx => {
      const a = await tx.appointment.findUnique({ where: { id: req.params.appointmentId }, include: { psychologist: true, consultation: { select: { status: true } } } });
      if (!a) throw new AppError('Consulta no encontrada', 404);
      const professional = a.psychologist.userId === req.user!.userId;
      if (!professional && a.userId !== req.user!.userId) throw new AppError('Solo los participantes de la cita pueden acceder', 403);
      await requireProfessional(tx, a.psychologistId);
      await requirePaid(tx, a);
      if (a.status !== 'CONFIRMED' || a.consultation?.status !== 'IN_PROGRESS') throw new AppError('El profesional debe iniciar una consulta confirmada antes de entrar', 409);
      if (Date.now() < a.startAt.getTime() - (professional ? 15 : 10) * 60000 || Date.now() >= a.endAt.getTime()) throw new AppError('Fuera del horario permitido para la videollamada', 409);
      return createJaasSession(a.id, req.user!.userId, professional, a.endAt);
    });
    res.json({ status: 'success', data: { session } });
  } catch (error) { next(error); }
}
