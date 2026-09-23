import { Response, NextFunction } from 'express';
import { AppointmentStatus, ConsultationStatus, PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';

const filters = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(150).optional(),
  status: z.nativeEnum(AppointmentStatus).optional(),
  consultationStatus: z.union([z.nativeEnum(ConsultationStatus), z.literal('NONE')]).optional(),
  paymentStatus: z.union([z.nativeEnum(PaymentStatus), z.literal('NONE')]).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
}).strict().refine(q => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), 'Rango inválido');

// Explicit allowlist: never include clinicalNotes, meetingUrl or free-text cancellation reasons.
const selection = {
  id: true, status: true, startAt: true, endAt: true, createdAt: true, updatedAt: true,
  user: { select: { id: true, name: true } },
  psychologist: { select: { id: true, user: { select: { id: true, name: true } } } },
  consultation: { select: { id: true, status: true, startedAt: true, endedAt: true } },
  payment: { select: { id: true, status: true } },
} satisfies Prisma.AppointmentSelect;

export async function listAdminAppointments(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const parsed = filters.safeParse(req.query);
    if (!parsed.success) throw new AppError('Filtros de citas inválidos', 400);
    const q = parsed.data;
    const contains = q.search ? { contains: q.search, mode: Prisma.QueryMode.insensitive } : undefined;
    const where: Prisma.AppointmentWhereInput = {
      status: q.status,
      startAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
      consultation: q.consultationStatus === 'NONE' ? { is: null } : q.consultationStatus ? { is: { status: q.consultationStatus } } : undefined,
      payment: q.paymentStatus === 'NONE' ? { is: null } : q.paymentStatus ? { is: { status: q.paymentStatus } } : undefined,
      ...(contains ? { OR: [{ id: contains }, { user: { name: contains } }, { psychologist: { user: { name: contains } } }] } : {}),
    };
    const data = await prisma.$transaction(async tx => {
      const total = await tx.appointment.count({ where });
      const items = await tx.appointment.findMany({ where, select: selection, orderBy: [{ startAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit });
      const counts = await tx.appointment.groupBy({ by: ['status'], where, _count: true });
      return { items, total, page: q.page, hasMore: q.page * q.limit < total, counts: counts.map(s => ({ status: s.status, count: s._count })) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    res.json({ status: 'success', data });
  } catch (error) { next(error); }
}

export async function getAdminAppointment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError('Identificador inválido', 400);
    const item = await prisma.appointment.findUnique({ where: { id: req.params.id }, select: selection });
    if (!item) throw new AppError('Cita no encontrada', 404);
    res.json({ status: 'success', data: item });
  } catch (error) { next(error); }
}
