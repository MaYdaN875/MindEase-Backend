import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { authMiddleware, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { eligibleProfessionalWhere, serializable } from '../services/clinicalPolicy';

const router = Router();
const id = z.string().uuid();
const input = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() }).strict();
const ownFields = { id: true, rating: true, comment: true, status: true, createdAt: true } as const;
function handler(fn: (req: AuthenticatedRequest, res: Response) => Promise<void>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    fn(req, res).catch(error => next(error instanceof AppError ? error : new AppError(
      error instanceof z.ZodError ? 'Datos de reseña inválidos' : 'Reseñas no disponibles temporalmente',
      error instanceof z.ZodError ? 400 : 500)));
  };
}

// Never publish patient identifiers, appointment dates, or clinical information.
router.get('/psychologists/:id', handler(async (req, res) => {
  const psychologistId = id.parse(req.params.id);
  const { page } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(req.query);
  const professional = await prisma.psychologistProfile.findFirst({ where: { id: psychologistId, ...eligibleProfessionalWhere }, select: { id: true } });
  if (!professional) throw new AppError('Profesional no disponible', 404);
  const where = { appointment: { psychologistId, status: 'COMPLETED' as const, consultation: { status: 'COMPLETED' as const } } };
  // All genuine ratings contribute, regardless of whether their text can be published.
  const [summary, reviews] = await prisma.$transaction([
    prisma.patientReview.aggregate({ where, _avg: { rating: true }, _count: true }),
    prisma.patientReview.findMany({ where: { ...where, status: 'APPROVED', comment: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 21,
      select: { id: true, rating: true, comment: true } }),
  ]);
  res.json({ status: 'success', data: { rating: summary._avg.rating, reviewsCount: summary._count,
    reviews: reviews.slice(0, 20), hasMore: reviews.length > 20 } });
}));
router.use(authMiddleware);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/appointments/:id', handler(async (req, res) => {
  const appointment = await prisma.appointment.findFirst({ where: { id: id.parse(req.params.id), userId: req.user!.userId },
    select: { status: true, psychologist: { select: { userId: true } }, consultation: { select: { status: true } }, patientReview: { select: ownFields } } });
  if (!appointment) throw new AppError('Consulta no disponible', 404);
  res.json({ status: 'success', data: { review: appointment.patientReview,
    canReview: appointment.status === 'COMPLETED' && appointment.consultation?.status === 'COMPLETED' && appointment.psychologist.userId !== req.user!.userId && !appointment.patientReview } });
}));
router.post('/appointments/:id', handler(async (req, res) => {
  const appointmentId = id.parse(req.params.id);
  const { rating, comment } = input.parse(req.body);
  const text = comment || null;
  const review = await serializable(async tx => {
    const a = await tx.appointment.findFirst({ where: { id: appointmentId, userId: req.user!.userId },
      include: { consultation: true, psychologist: { select: { userId: true } }, patientReview: true } });
    if (!a) throw new AppError('Consulta no disponible', 404);
    if (a.status !== 'COMPLETED' || a.consultation?.status !== 'COMPLETED' || a.psychologist.userId === req.user!.userId)
      throw new AppError('Solo puedes calificar consultas completadas con otro profesional', 409);
    if (a.patientReview) {
      if (a.patientReview.rating !== rating || a.patientReview.comment !== text) throw new AppError('Ya calificaste esta consulta', 409);
      return tx.patientReview.findUnique({ where: { appointmentId }, select: ownFields });
    }
    return tx.patientReview.create({ data: { appointmentId, rating, comment: text }, select: ownFields });
  });
  res.json({ status: 'success', data: { review } });
}));
router.use((req: AuthenticatedRequest, _res, next) => {
  if (!req.user!.roles.some(role => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(role))) return next(new AppError('No autorizado', 403));
  next();
});
router.get('/moderation', handler(async (req, res) => {
  const { page, status } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') }).parse(req.query);
  const reviews = await prisma.patientReview.findMany({ where: { status, comment: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 21, skip: (page - 1) * 20,
    select: { ...ownFields, moderationReason: true } });
  res.json({ status: 'success', data: { reviews: reviews.slice(0, 20), hasMore: reviews.length > 20 } });
}));
router.post('/moderation/:id', handler(async (req, res) => {
  const reviewId = id.parse(req.params.id);
  const { status, reason } = z.object({ status: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
  const result = await prisma.patientReview.updateMany({ where: { id: reviewId, comment: { not: null } },
    data: { status, moderationReason: reason, moderatorId: req.user!.userId, moderatedAt: new Date() } });
  if (!result.count) throw new AppError('Reseña no disponible', 404);
  res.json({ status: 'success', data: {} });
}));
export default router;
