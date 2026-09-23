import { Response, NextFunction } from 'express';
import { PaymentStatus, PayoutStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { paymentProvider } from '../services/stripeGateway';

const currency = z.string().regex(/^[A-Z]{3}$/).default('MXN');
const filters = z.object({
  currency, page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(), search: z.string().trim().max(150).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
}).strict().refine(q => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), 'Rango de fechas inválido');
const person = { select: { id: true, name: true } } as const;
const professional = { select: { id: true, user: person } } as const;
const paymentSelect = {
  id: true, appointmentId: true, amount: true, currency: true, platformFee: true, netAmount: true,
  status: true, paymentMethod: true, cardLast4: true, cardBrand: true, createdAt: true,
  updatedAt: true, refundedAt: true, refundAttempts: true, patient: person, psychologist: professional,
  appointment: { select: { status: true, startAt: true, endAt: true } },
} satisfies Prisma.PaymentSelect;
const payoutSelect = {
  id: true, amount: true, currency: true, status: true, requestedAt: true, processedAt: true,
  bankName: true, accountClabe: true, psychologist: professional,
} satisfies Prisma.PayoutRequestSelect;
// Never return full bank details, free-text clinical information or provider secrets.
const mask = (value: string) => value.length >= 4 ? '**************' + value.slice(-4) : '******************';

export async function financeSummary(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const parsed = z.object({ currency }).strict().safeParse(req.query);
    if (!parsed.success) throw new AppError('Moneda inválida', 400);
    const c = parsed.data.currency;
    const data = await prisma.$transaction(async tx => {
      const sum = (where: Prisma.PaymentWhereInput) => tx.payment.aggregate({ where: { currency: c, ...where }, _sum: { amount: true, platformFee: true, netAmount: true }, _count: true });
      const completed = await sum({ status: 'SUCCEEDED', appointment: { status: 'COMPLETED' } });
      const held = await sum({ status: 'SUCCEEDED', appointment: { status: { in: ['PENDING', 'CONFIRMED'] } } });
      const review = await sum({ status: 'SUCCEEDED', appointment: { status: { in: ['CANCELLED', 'NO_SHOW'] } } });
      const refunds = await sum({ status: 'REFUNDED' });
      const pendingRefunds = await sum({ status: 'REFUND_PENDING' });
      const partial = await sum({ status: 'PARTIALLY_REFUNDED' });
      const payouts = await tx.payoutRequest.groupBy({ by: ['status'], where: { currency: c }, _sum: { amount: true }, _count: true });
      const statuses = await tx.payment.groupBy({ by: ['status'], where: { currency: c }, _sum: { amount: true }, _count: true });
      const payoutAmount = (states: PayoutStatus[]) => payouts.filter(p => states.includes(p.status)).reduce((sum, p) => sum.plus(p._sum.amount ?? 0), new Prisma.Decimal(0));
      const reserved = payoutAmount(['REQUESTED', 'PROCESSING']);
      const withdrawn = payoutAmount(['COMPLETED']);
      return {
        currency: c, completedGross: completed._sum.amount ?? '0.00', earnedFees: completed._sum.platformFee ?? '0.00',
        availableBalance: new Prisma.Decimal(completed._sum.netAmount ?? 0).minus(reserved).minus(withdrawn).toFixed(2),
        heldBalance: held._sum.netAmount ?? '0.00', reviewBalance: review._sum.netAmount ?? '0.00',
        pendingPayoutBalance: reserved.toFixed(2), totalWithdrawn: withdrawn.toFixed(2),
        refundedAmount: refunds._sum.amount ?? '0.00', pendingRefundAmount: pendingRefunds._sum.amount ?? '0.00',
        partialRefundCount: partial._count,
        paymentsByStatus: statuses.map(s => ({ status: s.status, count: s._count, amount: s._sum.amount })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    res.json({ status: 'success', data: { ...data, provider: paymentProvider(), readOnly: true, asOf: new Date().toISOString() } });
  } catch (error) { next(error); }
}

export async function financeList(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const resource = req.params.resource;
    if (!['payments', 'refunds', 'payouts'].includes(resource)) throw new AppError('Recurso no encontrado', 404);
    const parsed = filters.safeParse(req.query);
    if (!parsed.success) throw new AppError('Filtros financieros inválidos', 400);
    const q = parsed.data;
    const date = q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined;
    const search = q.search ? { contains: q.search, mode: Prisma.QueryMode.insensitive } : undefined;
    const paging = { skip: (q.page - 1) * q.limit, take: q.limit };
    const data = await prisma.$transaction(async tx => {
      if (resource === 'payouts') {
        if (q.status && !z.nativeEnum(PayoutStatus).safeParse(q.status).success) throw new AppError('Estado de retiro inválido', 400);
        const where: Prisma.PayoutRequestWhereInput = { currency: q.currency, status: q.status as PayoutStatus | undefined, requestedAt: date,
          ...(search ? { OR: [{ id: search }, { psychologist: { user: { name: search } } }] } : {}) };
        const total = await tx.payoutRequest.count({ where });
        const rows = await tx.payoutRequest.findMany({ where, ...paging, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: payoutSelect });
        return { total, items: rows.map(p => ({ ...p, accountClabe: mask(p.accountClabe) })) };
      }
      const refundStates: PaymentStatus[] = ['REFUNDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED'];
      if (q.status && (!z.nativeEnum(PaymentStatus).safeParse(q.status).success || (resource === 'refunds' && !refundStates.includes(q.status as PaymentStatus)))) throw new AppError('Estado de pago inválido', 400);
      const where: Prisma.PaymentWhereInput = { currency: q.currency, createdAt: date,
        status: q.status ? q.status as PaymentStatus : resource === 'refunds' ? { in: refundStates } : undefined,
        ...(search ? { OR: [{ id: search }, { appointmentId: search }, { patient: { name: search } }, { psychologist: { user: { name: search } } }] } : {}) };
      const total = await tx.payment.count({ where });
      const items = await tx.payment.findMany({ where, ...paging, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: paymentSelect });
      return { total, items };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    res.json({ status: 'success', data: { ...data, page: q.page, limit: q.limit, hasMore: q.page * q.limit < data.total } });
  } catch (error) { next(error); }
}

export async function financePaymentDetail(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new AppError('Identificador inválido', 400);
    const payment = await prisma.payment.findUnique({ where: { id: req.params.id }, select: {
      ...paymentSelect, transactionId: true, refundId: true,
      attempts: { orderBy: { createdAt: 'desc' }, select: { id: true, provider: true, status: true, createdAt: true, updatedAt: true } },
    } });
    if (!payment) throw new AppError('Pago no encontrado', 404);
    res.json({ status: 'success', data: payment });
  } catch (error) { next(error); }
}
