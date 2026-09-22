import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { paymentView } from '../services/money';
import { reservePayment, finalizePayment } from '../services/paymentWorkflow';
import { getPaymentGateway } from '../services/paymentGateway';
import { paymentProvider } from '../services/stripeGateway';

const checkoutSchema = z.object({
  appointmentId: z.string().uuid(), idempotencyKey: z.string().uuid(),
  paymentMethod: z.literal('CREDIT_CARD').default('CREDIT_CARD'),
  card: z.object({
    number: z.string().min(13).max(19), expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2023).max(2100), cvc: z.string().regex(/^\d{3,4}$/),
    holderName: z.string().trim().min(2).max(100),
  }),
});

export const checkout = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (paymentProvider() !== 'MOCK') throw new AppError('Utiliza el flujo de Stripe PaymentSheet', 409);
    const headerKey = req.header('idempotency-key');
    if (headerKey && req.body?.idempotencyKey && headerKey !== req.body.idempotencyKey) throw new AppError('Llaves de idempotencia inconsistentes', 400);
    const parsed = checkoutSchema.safeParse({ ...req.body, idempotencyKey: headerKey || req.body?.idempotencyKey });
    if (!parsed.success) throw new AppError('Datos de pago o llave de idempotencia inválidos', 400);
    const { appointmentId, idempotencyKey, card } = parsed.data;
    const gateway = getPaymentGateway();
    const attempt = await reservePayment(req.user!.userId, appointmentId, idempotencyKey);
    if (attempt.status === 'FAILED') {
      res.status(402).json({ status: 'error', definitiveFailure: true, message: 'Intento rechazado. Usa una nueva llave para corregir la tarjeta.' });
      return;
    }
    let payment = attempt.payment;
    if (attempt.status === 'PROCESSING') {
      try {
        const patient = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.userId }, select: { id: true, name: true, email: true } });
        const result = await gateway.charge({ amount: Number(payment.amount), currency: payment.currency, card, customer: patient, idempotencyKey });
        payment = await finalizePayment(attempt.id, result);
        if (!result.success) {
          res.status(402).json({ status: 'error', definitiveFailure: true, message: result.errorMessage || 'Pago rechazado' });
          return;
        }
      } catch {
        res.status(202).json({ status: 'pending', message: 'Pago pendiente de conciliación. Reintenta con la misma llave.', appointmentId });
        return;
      }
    }
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    res.status(payment.status === 'SUCCEEDED' ? 200 : 409).json({
      status: payment.status === 'SUCCEEDED' ? 'success' : 'error',
      message: payment.status === 'SUCCEEDED' ? 'Pago de prueba recibido; consulta el estado de tu cita.' : 'La cita fue cancelada o el pago está en reembolso.',
      data: { payment: paymentView(payment), autoConfirmed: false, appointmentStatus: appointment.status },
    });
  } catch (error) { next(error); }
};

export const getPatientHistory = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const payments = await prisma.payment.findMany({
      where: { patientId: userId },
      include: {
        appointment: {
          select: {
            id: true,
            startAt: true,
            endAt: true,
            status: true,
            psychologist: {
              select: {
                id: true,
                user: { select: { name: true } },
                specialties: { include: { specialty: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        payments: payments.map(p => ({
          id: p.id,
          appointmentId: p.appointmentId,
          amount: Number(p.amount),
          currency: p.currency,
          status: p.status,
          paymentMethod: p.paymentMethod,
          cardLast4: p.cardLast4,
          cardBrand: p.cardBrand,
          transactionId: p.transactionId,
          createdAt: p.createdAt,
          receiptUrl: `/api/payments/${p.id}/receipt`,
          psychologistName: p.appointment.psychologist.user.name,
          appointmentDate: p.appointment.startAt,
          appointmentStatus: p.appointment.status,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getReceipt = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const paymentId = req.params.id;
    const userId = req.user!.userId;
    const isAdmin = req.user!.roles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r));

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        appointment: {
          include: {
            psychologist: {
              include: {
                user: { select: { name: true, email: true } },
              },
            },
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    if (!payment) {
      throw new AppError('Recibo no encontrado', 404);
    }

    if (payment.patientId !== userId && payment.appointment.psychologist.userId !== userId && !isAdmin) {
      throw new AppError('No tienes permiso para ver este recibo', 403);
    }

    res.status(200).json({
      status: 'success',
      data: {
        receipt: {
          receiptNumber: `REC-${payment.id.slice(0, 8).toUpperCase()}`,
          date: payment.createdAt,
          transactionId: payment.transactionId,
          amount: Number(payment.amount),
          currency: payment.currency,
          platformFee: Number(payment.platformFee),
          netAmount: Number(payment.netAmount),
          status: payment.status,
          paymentMethod: payment.paymentMethod,
          cardLast4: payment.cardLast4,
          cardBrand: payment.cardBrand,
          patient: {
            name: payment.appointment.user.name,
            email: payment.appointment.user.email,
          },
          psychologist: {
            name: payment.appointment.psychologist.user.name,
          },
          appointment: {
            id: payment.appointment.id,
            startAt: payment.appointment.startAt,
            endAt: payment.appointment.endAt,
            status: payment.appointment.status,
          },
        },
      },
    });
  } catch (error) {
    next(error);
  }
};
