import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { eligibleProfessionalWhere, serializable } from '../services/clinicalPolicy';
import { chatHandler as handler, mountMessages } from './messageRoutes';

const router = Router();
router.use(authMiddleware);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const id = z.string().uuid();
const include = { patient: { select: { id: true, name: true, status: true } }, psychologist: { select: {
  id: true, photoUrl: true, status: true, user: { select: { id: true, name: true, status: true,
    userRoles: { select: { role: { select: { name: true } } } } } },
} } } satisfies Prisma.ConversationInclude;
type Contact = Prisma.ConversationGetPayload<{ include: typeof include }>;
async function access(tx: Prisma.TransactionClient, conversationId: string, userId: string) {
  const c = await tx.conversation.findUnique({ where: { id: conversationId }, include });
  if (!c || (c.patientId !== userId && c.psychologist.user.id !== userId)) throw new AppError('Conversación no disponible', 404);
  return c;
}
function info(c: Contact, userId: string) {
  const patient = c.patientId === userId;
  const canSend = !c.patientBlocked && !c.psychologistBlocked && c.patient.status === 'ACTIVE' &&
    c.psychologist.status === 'VERIFICADO' && c.psychologist.user.status === 'ACTIVE' &&
    c.psychologist.user.userRoles.some(r => r.role.name === 'PSYCHOLOGIST_VERIFIED');
  return { conversationId: c.id, type: 'PRE_BOOKING', status: canSend ? 'ACTIVE' : 'READ_ONLY', canSend,
    blockedByMe: patient ? c.patientBlocked : c.psychologistBlocked,
    peerName: patient ? c.psychologist.user.name : c.patient.name,
    peerPhotoUrl: patient ? c.psychologist.photoUrl : null, viewerId: userId,
    createdAt: c.createdAt };
}
router.post('/pre-booking/:psychologistId', handler(async (req, res) => {
  const psychologistId = id.parse(req.params.psychologistId), patientId = req.user!.userId;
  const data = await serializable(async tx => {
    const profile = await tx.psychologistProfile.findFirst({ where: { id: psychologistId, ...eligibleProfessionalWhere }, select: { userId: true } });
    if (!profile || profile.userId === patientId) throw new AppError('Profesional no disponible para contacto', 404);
    const existing = await tx.conversation.findUnique({ where: { patientId_psychologistId: { patientId, psychologistId } }, include });
    if (existing) return info(existing, patientId);
    if (await tx.conversation.count({ where: { patientId, createdAt: { gte: new Date(Date.now() - 86400000) } } }) >= 10)
      throw new AppError('Has alcanzado el límite diario de nuevas conversaciones', 429);
    return info(await tx.conversation.create({ data: { patientId, psychologistId }, include }), patientId);
  });
  res.json({ status: 'success', data });
}));
router.get('/', handler(async (req, res) => {
  const { before } = z.object({ before: id.optional() }).parse(req.query), userId = req.user!.userId;
  const data = await serializable(async tx => {
    const where = { OR: [{ patientId: userId }, { psychologist: { userId } }] };
    const cursor = before ? await tx.conversation.findFirst({ where: { ...where, id: before } }) : null;
    if (before && !cursor) throw new AppError('Página no disponible', 404);
    const rows = await tx.conversation.findMany({ where: { AND: [where, ...(cursor ? [{ OR: [
      { createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ] }] : [])] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 31, include: { ...include,
      _count: { select: { messages: { where: { senderId: { not: userId }, readAt: null } } } } } });
    return { chats: rows.slice(0, 30).map(c => ({ ...info(c, userId), unreadCount: c._count.messages })), nextBefore: rows.length > 30 ? rows[29].id : null };
  });
  res.json({ status: 'success', data });
}));
router.post('/:id/block', handler(async (req, res) => {
  const conversationId = id.parse(req.params.id), userId = req.user!.userId;
  const { blocked } = z.object({ blocked: z.boolean() }).strict().parse(req.body);
  await serializable(async tx => {
    const c = await access(tx, conversationId, userId);
    await tx.conversation.update({ where: { id: conversationId }, data: c.patientId === userId ? { patientBlocked: blocked } : { psychologistBlocked: blocked } });
  });
  res.json({ status: 'success', data: {} });
}));
router.post('/:id/report', handler(async (req, res) => {
  const conversationId = id.parse(req.params.id), reporterId = req.user!.userId;
  const { description } = z.object({ description: z.string().trim().min(10).max(2000) }).strict().parse(req.body);
  await serializable(async tx => {
    const c = await access(tx, conversationId, reporterId);
    const reportedUserId = c.patientId === reporterId ? c.psychologist.user.id : c.patientId;
    if (await tx.userReport.count({ where: { reporterId, createdAt: { gte: new Date(Date.now() - 86400000) } } }) >= 5)
      throw new AppError('Límite diario de reportes alcanzado', 429);
    await tx.userReport.create({ data: { reporterId, reportedUserId, reason: 'OTHER',
      description: `Contacto previo ${conversationId}\n${description}` } });
  });
  res.json({ status: 'success', data: {} });
}));
mountMessages(router, async (tx, conversationId, userId) => {
  const c = await access(tx, conversationId, userId), metadata = info(c, userId);
  return { filter: { conversationId }, metadata, canSend: metadata.canSend,
    recipientId: c.patientId === userId ? c.psychologist.user.id : c.patientId };
}, 'PRE_BOOKING_MESSAGE');
export default router;
