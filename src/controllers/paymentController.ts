import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { calculateFees } from '../services/feePolicy';
import { getPaymentGateway } from '../services/paymentGateway';
import { serializable } from '../services/clinicalPolicy';
import { sendNotification } from '../services/notificationService';

const checkoutSchema = z.object({
  appointmentId: z.string().uuid('ID de cita inválido'),
  paymentMethod: z.enum(['CREDIT_CARD', 'DEBIT_CARD', 'TRANSFER', 'WALLET']).default('CREDIT_CARD'),
  card: z.object({
    number: z.string().min(12).max(19),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2023).max(2100),
    cvc: z.string().min(3).max(4),
    holderName: z.string().min(2).max(100),
  }),
  idempotencyKey: z.string().uuid().optional(),
});

export const checkout = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const headerKey = req.header('idempotency-key') || req.header('Idempotency-Key');
    const bodyKey = req.body?.idempotencyKey;
    const idempotencyKey = headerKey || bodyKey;

    // Check for existing transaction if idempotency key provided
    if (idempotencyKey) {
      const existingPayment = await prisma.payment.findUnique({
        where: { idempotencyKey },
        include: {
          appointment: {
            select: {
              id: true,
              startAt: true,
              endAt: true,
              status: true,
              psychologist: {
                select: {
                  user: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      if (existingPayment) {
        res.status(200).json({
          status: 'success',
          message: 'Transacción ya procesada previamente (idempotente)',
          data: { payment: existingPayment },
        });
        return;
      }
    }

    const parsed = checkoutSchema.safeParse({
      ...req.body,
      idempotencyKey: idempotencyKey || undefined,
    });

    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { appointmentId, paymentMethod, card } = parsed.data;
    const finalIdempotencyKey = idempotencyKey || undefined;
    const userId = req.user!.userId;

    // Verify appointment exists and belongs to patient
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        psychologist: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        user: { select: { id: true, name: true, email: true } },
        payment: true,
      },
    });

    if (!appointment) {
      throw new AppError('Cita no encontrada', 404);
    }

    if (appointment.userId !== userId) {
      throw new AppError('No tienes permiso para pagar esta cita', 403);
    }

    if (!['PENDING', 'CONFIRMED'].includes(appointment.status)) {
      throw new AppError(`No es posible pagar una cita con estado ${appointment.status}`, 409);
    }

    if (appointment.payment && appointment.payment.status === 'SUCCEEDED') {
      throw new AppError('Esta cita ya cuenta con un pago completado', 409);
    }

    // Freeze server-side price from Appointment snapshot
    const grossPrice = appointment.price;
    if (grossPrice <= 0) {
      throw new AppError('El precio de la consulta debe ser mayor a 0 para procesar el pago', 400);
    }

    const { grossAmount, platformFee, netAmount } = calculateFees(grossPrice);
    const currency = appointment.currency || 'MXN';

    // Invoke payment gateway
    const gateway = getPaymentGateway();
    const gatewayResult = await gateway.charge({
      amount: grossAmount,
      currency,
      card,
      customer: {
        id: appointment.user.id,
        email: appointment.user.email,
        name: appointment.user.name,
      },
      description: `Consulta psicológica con ${appointment.psychologist.user.name}`,
      idempotencyKey: finalIdempotencyKey,
    });

    if (!gatewayResult.success) {
      // Record failed transaction attempt for audit if desired
      await prisma.payment.upsert({
        where: { appointmentId },
        update: {
          status: 'FAILED',
          amount: grossAmount,
          platformFee,
          netAmount,
          currency,
          cardLast4: gatewayResult.cardLast4,
          cardBrand: gatewayResult.cardBrand,
          transactionId: gatewayResult.transactionId,
        },
        create: {
          appointmentId,
          patientId: userId,
          psychologistId: appointment.psychologistId,
          amount: grossAmount,
          platformFee,
          netAmount,
          currency,
          status: 'FAILED',
          paymentMethod,
          cardLast4: gatewayResult.cardLast4,
          cardBrand: gatewayResult.cardBrand,
          transactionId: gatewayResult.transactionId,
        },
      });

      throw new AppError(gatewayResult.errorMessage || 'El pago fue declinado por el emisor', 402);
    }

    // Persist successful payment and confirm appointment inside transaction
    const savedPayment = await serializable(async tx => {
      // Double check collision
      const checkCurrent = await tx.payment.findUnique({ where: { appointmentId } });
      if (checkCurrent && checkCurrent.status === 'SUCCEEDED') {
        throw new AppError('Esta cita ya fue pagada', 409);
      }

      const payment = await tx.payment.upsert({
        where: { appointmentId },
        update: {
          status: 'SUCCEEDED',
          amount: grossAmount,
          platformFee,
          netAmount,
          currency,
          paymentMethod,
          cardLast4: gatewayResult.cardLast4,
          cardBrand: gatewayResult.cardBrand,
          transactionId: gatewayResult.transactionId,
          idempotencyKey: finalIdempotencyKey || null,
        },
        create: {
          appointmentId,
          patientId: userId,
          psychologistId: appointment.psychologistId,
          amount: grossAmount,
          platformFee,
          netAmount,
          currency,
          status: 'SUCCEEDED',
          paymentMethod,
          cardLast4: gatewayResult.cardLast4,
          cardBrand: gatewayResult.cardBrand,
          transactionId: gatewayResult.transactionId,
          idempotencyKey: finalIdempotencyKey || null,
        },
      });

      // Only auto-confirm if the psychologist configured autoConfirmAppointments to true
      const autoConfirm = appointment.psychologist.autoConfirmAppointments === true;
      if (autoConfirm && appointment.status === 'PENDING') {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'CONFIRMED' },
        });
      }

      return payment;
    });

    const autoConfirm = appointment.psychologist.autoConfirmAppointments === true;
    const formatted = appointment.startAt.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

    // Send notifications according to workflow
    if (autoConfirm) {
      await Promise.all([
        sendNotification({
          userId,
          title: 'Cita y pago confirmados',
          content: `Tu pago de $${grossAmount.toFixed(2)} ${currency} para tu cita con ${appointment.psychologist.user.name} ha sido confirmado exitosamente.`,
          type: 'APPOINTMENT_CONFIRMED',
          referenceId: appointmentId,
        }),
        sendNotification({
          userId: appointment.psychologist.user.id,
          title: 'Nueva cita confirmada y pagada',
          content: `${appointment.user.name} ha reservado y pagado su consulta para el ${formatted} ($${grossAmount.toFixed(2)} ${currency}).`,
          type: 'APPOINTMENT_CONFIRMED',
          referenceId: appointmentId,
        }),
      ]);
    } else {
      await Promise.all([
        sendNotification({
          userId,
          title: 'Solicitud y pago en custodia',
          content: `Tu pago de $${grossAmount.toFixed(2)} ${currency} está en custodia y tu solicitud fue enviada a ${appointment.psychologist.user.name} para su aprobación.`,
          type: 'APPOINTMENT_REQUEST',
          referenceId: appointmentId,
        }),
        sendNotification({
          userId: appointment.psychologist.user.id,
          title: 'Nueva solicitud de consulta pagada',
          content: `${appointment.user.name} ha solicitado una cita para el ${formatted} con pago garantizado en custodia ($${grossAmount.toFixed(2)} ${currency}). Ingresa a tu panel para aceptarla o rechazarla.`,
          type: 'APPOINTMENT_REQUEST',
          referenceId: appointmentId,
        }),
      ]);
    }

    res.status(201).json({
      status: 'success',
      message: autoConfirm
        ? 'Pago completado y cita confirmada exitosamente'
        : 'Pago recibido en custodia. Solicitud enviada al psicólogo para su aprobación.',
      data: {
        payment: {
          ...savedPayment,
          receiptUrl: `/api/payments/${savedPayment.id}/receipt`,
        },
        autoConfirmed: autoConfirm,
        appointmentStatus: autoConfirm ? 'CONFIRMED' : 'PENDING',
      },
    });
  } catch (error) {
    next(error);
  }
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
          amount: p.amount,
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
          amount: payment.amount,
          currency: payment.currency,
          platformFee: payment.platformFee,
          netAmount: payment.netAmount,
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
