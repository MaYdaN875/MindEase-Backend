import prisma from '../config/db';
import { Prisma } from '@prisma/client';
import { AppError } from '../middlewares/errorMiddleware';
import { serializable, requireProfessional, eligibleProfessionalWhere } from './clinicalPolicy';
import { calculateFees } from './feePolicy';
import { PaymentGatewayChargeResult } from './paymentGateway';
import { cents } from './money';

export async function requirePaid(tx: Prisma.TransactionClient, appointment: { id: string; price: number; currency: string }) {
  if (appointment.price === 0) return;
  const payment = await tx.payment.findUnique({ where: { appointmentId: appointment.id } });
  if (!payment || payment.status !== 'SUCCEEDED' || cents(payment.amount) !== cents(appointment.price) || payment.currency !== appointment.currency) {
    throw new AppError('La cita requiere un pago completado antes de confirmarse o realizarse', 409);
  }
}

export async function reservePayment(userId: string, appointmentId: string, key: string, provider = 'MOCK') {
  return serializable(async tx => {
    const existing = await tx.paymentAttempt.findUnique({ where: { idempotencyKey: key }, include: { payment: true } });
    if (existing) {
      if (existing.provider !== provider) throw new AppError('Proveedor del intento incompatible', 409);
      if (existing.payment.patientId !== userId) throw new AppError('Acceso denegado', 403);
      if (existing.payment.appointmentId !== appointmentId) throw new AppError('La llave pertenece a otra cita', 409);
      return existing;
    }
    const legacy = await tx.payment.findUnique({ where: { idempotencyKey: key } });
    if (legacy) throw new AppError('Llave ya utilizada; consulta el historial de pagos', 409);
    const appointment = await tx.appointment.findUnique({ where: { id: appointmentId }, include: { payment: true } });
    if (!appointment) throw new AppError('Cita no encontrada', 404);
    if (appointment.userId !== userId) throw new AppError('Acceso denegado', 403);
    if (appointment.status !== 'PENDING' || appointment.startAt.getTime() <= Date.now()) throw new AppError('La reserva ya no admite pagos', 409);
    await requireProfessional(tx, appointment.psychologistId);
    if (appointment.payment && appointment.payment.status !== 'FAILED') throw new AppError('Esta cita ya tiene un pago o un intento pendiente', 409);
    if (appointment.price <= 0 || appointment.currency !== 'MXN') throw new AppError('Importe o moneda no admitidos', 400);
    const fees = calculateFees(appointment.price);
    const data = { amount: fees.grossAmount, platformFee: fees.platformFee, netAmount: fees.netAmount, status: 'PROCESSING' as const, idempotencyKey: key };
    const payment = await tx.payment.upsert({ where: { appointmentId },
      create: { ...data, appointmentId, patientId: userId, psychologistId: appointment.psychologistId, currency: appointment.currency },
      update: data,
    });
    return tx.paymentAttempt.create({ data: { paymentId: payment.id, idempotencyKey: key, provider }, include: { payment: true } });
  });
}

export async function finalizePayment(attemptId: string, result: PaymentGatewayChargeResult) {
  return serializable(async tx => {
    const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { payment: { include: { appointment: true } } } });
    if (attempt.status !== 'PROCESSING') return attempt.payment;
    const payment = attempt.payment;
    if (payment.idempotencyKey !== attempt.idempotencyKey || payment.status !== 'PROCESSING') throw new AppError('El intento no corresponde al pago activo', 409);
    // Never reopen a cancelled appointment, even if cancellation raced the gateway.
    const eligible = await tx.psychologistProfile.findFirst({ where: { id: payment.psychologistId, ...eligibleProfessionalWhere }, select: { id: true } });
    const mustRefund = !!result.refundDetected || !['PENDING', 'CONFIRMED'].includes(payment.appointment.status) || !eligible || payment.appointment.startAt.getTime() <= Date.now();
    if (result.success && mustRefund && ['PENDING', 'CONFIRMED'].includes(payment.appointment.status)) {
      await tx.appointment.update({ where: { id: payment.appointmentId }, data: { status: 'CANCELLED', cancellationReason: 'La reserva dejó de ser elegible durante el pago' } });
      await tx.consultation.updateMany({ where: { appointmentId: payment.appointmentId }, data: { status: 'CANCELLED' } });
    }
    const status = result.success ? (mustRefund ? 'REFUND_PENDING' : 'SUCCEEDED') : 'FAILED';
    const saved = await tx.payment.update({ where: { id: payment.id }, data: {
      status, transactionId: result.transactionId || null, cardBrand: result.cardBrand, cardLast4: result.cardLast4,
      ...(mustRefund && result.success ? { refundReason: 'La cita se cerró durante el pago' } : {}),
    } });
    await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: result.status } });
    if (result.success && !mustRefund) {
      const psychologist = await tx.psychologistProfile.findUniqueOrThrow({ where: { id: payment.psychologistId } });
      for (const userId of [payment.patientId, psychologist.userId]) {
        await tx.notification.create({ data: { userId, title: 'Solicitud de cita pagada (pruebas)', content: 'El pago de prueba se registro. La cita espera aprobacion del profesional.', type: 'APPOINTMENT_REQUEST', referenceId: payment.appointmentId } });
      }
    }
    return saved;
  });
}

export async function recoverPayments() {
  const attempts = await prisma.paymentAttempt.findMany({ where: { status: 'PROCESSING' }, orderBy: { createdAt: 'asc' }, take: 100 });
  for (const attempt of attempts) {
    if (attempt.provider === 'STRIPE') {
      try {
        const { StripePaymentGateway } = await import('./stripeGateway');
        const result = await new StripePaymentGateway().lookupCharge(attempt.idempotencyKey);
        if (result) await finalizePayment(attempt.id, result);
      } catch { console.error('Stripe reconciliation pending', attempt.id); }
      continue;
    }
    const { MockPaymentGateway } = await import('./paymentGateway');
    const result = await new MockPaymentGateway().lookupCharge(attempt.idempotencyKey);
    if (result) {
      await finalizePayment(attempt.id, result);
    } else if (attempt.createdAt.getTime() < Date.now() - 60000) {
      // MOCK ONLY: absence of the durable operation proves no simulated charge occurred.
      // This predicate serializes against MockPaymentGateway.charge's operation insertion.
      // A real provider must reconcile externally; it must NEVER use this absence rule.
      await serializable(async tx => {
        const operation = await tx.mockGatewayOperation.findUnique({ where: { key: `charge:${attempt.idempotencyKey}` } });
        if (operation) return;
        const current = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        if (current.status !== 'PROCESSING') return;
        await tx.paymentAttempt.update({ where: { id: current.id }, data: { status: 'FAILED' } });
        await tx.payment.updateMany({ where: { id: current.paymentId, status: 'PROCESSING', idempotencyKey: current.idempotencyKey }, data: { status: 'FAILED' } });
      });
    }
  }
}
