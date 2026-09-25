import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { serializable } from '../services/clinicalPolicy';

export function chatHandler(fn: (req: AuthenticatedRequest, res: Response) => Promise<void>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    fn(req, res).catch(e => next(e instanceof AppError ? e : new AppError(
      e instanceof z.ZodError ? 'Datos del chat inválidos' : 'Chat no disponible temporalmente', e instanceof z.ZodError ? 400 : 500)));
  };
}
type Context = {
  filter: { appointmentId: string; conversationId?: never } | { conversationId: string; appointmentId?: never };
  metadata: Record<string, unknown>;
  recipientId: string;
  canSend: boolean;
};
type Resolve = (tx: Prisma.TransactionClient, id: string, userId: string) => Promise<Context>;
const projection = { id: true, sequence: true, senderId: true, clientId: true, content: true, createdAt: true, readAt: true } as const;
export function mountMessages(router: Router, resolve: Resolve, notificationType: string) {
  router.get('/:id/messages', chatHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id), userId = req.user!.userId;
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(req.query);
    const data = await serializable(async tx => {
      const c = await resolve(tx, id, userId);
      const rows = await tx.privateMessage.findMany({ where: { ...c.filter, ...(before ? { sequence: { lt: before } } : {}) },
        orderBy: { sequence: 'desc' }, take: 51, select: projection });
      return { ...c.metadata, canSend: c.canSend, messages: rows.slice(0, 50).reverse(), nextBefore: rows.length > 50 ? rows[49].sequence : null };
    });
    res.json({ status: 'success', data });
  }));
  router.post('/:id/messages', chatHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id), userId = req.user!.userId;
    const input = z.object({ clientId: z.string().uuid(), content: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
    const message = await serializable(async tx => {
      const c = await resolve(tx, id, userId);
      const previous = await tx.privateMessage.findFirst({ where: { ...c.filter, senderId: userId, clientId: input.clientId }, select: projection });
      if (previous) {
        if (previous.content !== input.content) throw new AppError('Identificador usado por otro mensaje', 409);
        return previous;
      }
      if (!c.canSend) throw new AppError('Conversación en modo lectura', 409);
      if (await tx.privateMessage.count({ where: { senderId: userId, createdAt: { gte: new Date(Date.now() - 60000) } } }) >= 20)
        throw new AppError('Espera un minuto antes de enviar más mensajes', 429);
      const saved = await tx.privateMessage.create({ data: { ...c.filter, senderId: userId, ...input }, select: projection });
      if (!await tx.notification.findFirst({ where: { userId: c.recipientId, type: notificationType, referenceId: id, isRead: false } }))
        await tx.notification.create({ data: { userId: c.recipientId, type: notificationType, referenceId: id,
          title: 'Nuevo mensaje privado', content: 'Tienes mensajes sin leer en MindEase.' } });
      return saved;
    });
    res.json({ status: 'success', data: { message } });
  }));
  router.post('/:id/read', chatHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id), userId = req.user!.userId;
    const { through } = z.object({ through: z.number().int().positive() }).strict().parse(req.body);
    await serializable(async tx => {
      const c = await resolve(tx, id, userId);
      if (!await tx.privateMessage.findFirst({ where: { ...c.filter, sequence: through } })) throw new AppError('Mensaje no disponible', 404);
      await tx.privateMessage.updateMany({ where: { ...c.filter, senderId: { not: userId }, sequence: { lte: through }, readAt: null }, data: { readAt: new Date() } });
      if (!await tx.privateMessage.count({ where: { ...c.filter, senderId: { not: userId }, readAt: null } }))
        await tx.notification.updateMany({ where: { userId, type: notificationType, referenceId: id, isRead: false }, data: { isRead: true } });
    });
    res.json({ status: 'success', data: {} });
  }));
}
