import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { serializable } from '../services/clinicalPolicy';
import { requirePaid } from '../services/paymentWorkflow';
import { cents } from '../services/money';

const router = Router();
router.use(authMiddleware);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const id = z.string().uuid();
const page = z.object({ before: z.coerce.number().int().positive().optional() });
const messageInput = z.object({ clientId: id, content: z.string().trim().min(1).max(4000) }).strict();
const projection = { id: true, sequence: true, senderId: true, clientId: true, content: true, createdAt: true, readAt: true } as const;
const relation = { payment: { select: { status: true, amount: true, currency: true } }, user: { select: { id: true, name: true, status: true } }, psychologist: { select: {
  id: true, status: true, user: { select: { id: true, name: true, status: true, userRoles: { select: { role: { select: { name: true } } } } } },
} } } satisfies Prisma.AppointmentInclude;
type ChatAppointment = Prisma.AppointmentGetPayload<{ include: typeof relation }>;
function canWrite(a: ChatAppointment) {
  return ['CONFIRMED', 'COMPLETED'].includes(a.status) &&
    (a.price === 0 || (a.payment?.status === 'SUCCEEDED' && cents(a.payment.amount) === cents(a.price) && a.payment.currency === a.currency)) &&
    Date.now() <= a.endAt.getTime() + 7 * 86400000 &&
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
router.get('/:id/messages', handler(async (req, res) => {
  const appointmentId = id.parse(req.params.id), { before } = page.parse(req.query), userId = req.user!.userId;
  const data = await serializable(async tx => {
    const a = await access(tx, appointmentId, userId);
    const rows = await tx.privateMessage.findMany({ where: { appointmentId, ...(before ? { sequence: { lt: before } } : {}) },
      orderBy: { sequence: 'desc' }, take: 51, select: projection });
    return { ...info(a, userId), messages: rows.slice(0, 50).reverse(), nextBefore: rows.length > 50 ? rows[49].sequence : null };
  });
  res.json({ status: 'success', data });
}));
router.post('/:id/messages', handler(async (req, res) => {
  const appointmentId = id.parse(req.params.id), input = messageInput.parse(req.body), userId = req.user!.userId;
  const data = await serializable(async tx => {
    const a = await access(tx, appointmentId, userId);
    const existing = await tx.privateMessage.findUnique({ where: { appointmentId_senderId_clientId: { appointmentId, senderId: userId, clientId: input.clientId } }, select: projection });
    if (existing) {
      if (existing.content !== input.content) throw new AppError('El identificador ya pertenece a otro mensaje', 409);
      return existing;
    }
    if (!canWrite(a)) throw new AppError('Conversación en modo lectura', 409);
    await requirePaid(tx, a);
    const recent = await tx.privateMessage.count({ where: { senderId: userId, createdAt: { gte: new Date(Date.now() - 60000) } } });
    if (recent >= 20) throw new AppError('Espera un minuto antes de enviar más mensajes', 429);
    const saved = await tx.privateMessage.create({ data: { appointmentId, senderId: userId, ...input }, select: projection });
    const recipient = a.userId === userId ? a.psychologist.user.id : a.userId;
    // One generic unread notification per recipient/conversation, no message text.
    if (!await tx.notification.findFirst({ where: { userId: recipient, type: 'PRIVATE_MESSAGE', referenceId: appointmentId, isRead: false } })) {
      await tx.notification.create({ data: { userId: recipient, type: 'PRIVATE_MESSAGE', referenceId: appointmentId,
        title: 'Nuevo mensaje privado', content: 'Tienes mensajes sin leer en una conversación de MindEase.' } });
    }
    return saved;
  });
  res.json({ status: 'success', data: { message: data } });
}));
router.post('/:id/read', handler(async (req, res) => {
  const appointmentId = id.parse(req.params.id), userId = req.user!.userId;
  const { through } = z.object({ through: z.number().int().positive() }).strict().parse(req.body);
  await serializable(async tx => {
    await access(tx, appointmentId, userId);
    if (!await tx.privateMessage.findFirst({ where: { appointmentId, sequence: through } })) throw new AppError('Mensaje no disponible', 404);
    await tx.privateMessage.updateMany({ where: { appointmentId, senderId: { not: userId }, sequence: { lte: through }, readAt: null }, data: { readAt: new Date() } });
    if (!await tx.privateMessage.count({ where: { appointmentId, senderId: { not: userId }, readAt: null } }))
      await tx.notification.updateMany({ where: { userId, type: 'PRIVATE_MESSAGE', referenceId: appointmentId, isRead: false }, data: { isRead: true } });
  });
  res.json({ status: 'success' });
}));
export default router;
