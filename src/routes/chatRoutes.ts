import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { serializable } from '../services/clinicalPolicy';
import { mountMessages } from './messageRoutes';
import { cents } from '../services/money';

const router = Router();
router.use(authMiddleware);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const id = z.string().uuid();
const relation = { payment: { select: { status: true, amount: true, currency: true } }, user: { select: { id: true, name: true, status: true } }, psychologist: { select: {
  id: true, status: true, user: { select: { id: true, name: true, status: true, userRoles: { select: { role: { select: { name: true } } } } } },
} } } satisfies Prisma.AppointmentInclude;
type ChatAppointment = Prisma.AppointmentGetPayload<{ include: typeof relation }>;
function canWrite(a: ChatAppointment) {
  return a.status === 'CONFIRMED' &&
    (a.price === 0 || (a.payment?.status === 'SUCCEEDED' && cents(a.payment.amount) === cents(a.price) && a.payment.currency === a.currency)) &&
    Date.now() <= a.endAt.getTime() &&
    a.user.status === 'ACTIVE' && a.psychologist.user.status === 'ACTIVE' &&
    a.psychologist.status === 'VERIFICADO' &&
    a.psychologist.user.userRoles.some(r => r.role.name === 'PSYCHOLOGIST_VERIFIED');
}
async function access(tx: Prisma.TransactionClient, appointmentId: string, userId: string) {
  const a = await tx.appointment.findUnique({ where: { id: appointmentId }, include: relation });
  if (!a || (a.userId !== userId && a.psychologist.user.id !== userId)) throw new AppError('Conversación no disponible', 404);
  // Pending/cancelled reservations do not grant access to a new conversation.
  if (!['CONFIRMED', 'COMPLETED'].includes(a.status) &&
      !await tx.privateMessage.findFirst({ where: { appointmentId }, select: { id: true } }))
    throw new AppError('El chat se habilita al confirmar la cita', 409);
  return a;
}
function info(a: ChatAppointment, userId: string) {
  return { appointmentId: a.id, startAt: a.startAt, status: a.status,
    peerName: a.userId === userId ? a.psychologist.user.name : a.user.name,
    viewerId: userId, canSend: canWrite(a) };
}
function handler(fn: (req: AuthenticatedRequest, res: Response) => Promise<void>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    fn(req, res).catch(error => next(error instanceof AppError ? error :
      new AppError(error instanceof z.ZodError ? 'Datos del chat inválidos' : 'Chat no disponible temporalmente', error instanceof z.ZodError ? 400 : 500)));
  };
}
router.get('/', handler(async (req, res) => {
  const { before } = z.object({ before: id.optional() }).parse(req.query);
  const userId = req.user!.userId;
  const result = await serializable(async tx => {
    const participantWhere = { OR: [{ userId }, { psychologist: { userId } }] };
    const cursor = before ? await tx.appointment.findFirst({ where: { id: before, ...participantWhere }, select: { id: true, startAt: true } }) : null;
    if (before && !cursor) throw new AppError('Página no disponible', 404);
    const rows = await tx.appointment.findMany({ where: {
      AND: [
        participantWhere,
        { OR: [{ status: { in: ['CONFIRMED', 'COMPLETED'] } }, { privateMessages: { some: {} } }] },
        ...(cursor ? [{ OR: [{ startAt: { lt: cursor.startAt } }, { startAt: cursor.startAt, id: { lt: cursor.id } }] }] : []),
      ],
    }, orderBy: [{ startAt: 'desc' }, { id: 'desc' }], take: 31, include: { ...relation,
      _count: { select: { privateMessages: { where: { senderId: { not: userId }, readAt: null } } } },
    } });
    return { chats: rows.slice(0, 30).map(a => ({ ...info(a, userId), unreadCount: a._count.privateMessages })),
      nextBefore: rows.length > 30 ? rows[29].id : null };
  });
  res.json({ status: 'success', data: result });
}));
mountMessages(router, async (tx, appointmentId, userId) => {
  const a = await access(tx, appointmentId, userId);
  return { filter: { appointmentId }, metadata: { ...info(a, userId), type: 'CONSULTATION' },
    canSend: canWrite(a), recipientId: a.userId === userId ? a.psychologist.user.id : a.userId };
}, 'PRIVATE_MESSAGE');
export default router;
