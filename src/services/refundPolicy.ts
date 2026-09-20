import { Prisma } from '@prisma/client';
import prisma from '../config/db';
import { getPaymentGateway } from './paymentGateway';
import { serializable } from './clinicalPolicy';

// Only durable work is queued in the caller's transaction, never external requests.
export async function processAppointmentRefund(tx: Prisma.TransactionClient, appointmentId: string, reason?: string): Promise<boolean> {
  const result = await tx.payment.updateMany({ where: { appointmentId, status: 'SUCCEEDED' }, data: { status: 'REFUND_PENDING', refundReason: reason || 'Cancelación de cita' } });
  return result.count > 0;
}

export async function processPendingRefunds(paymentId?: string) {
  const payments = await prisma.payment.findMany({ where: { status: 'REFUND_PENDING', ...(paymentId ? { id: paymentId } : {}) }, orderBy: { updatedAt: 'asc' }, take: 100 });
  for (const payment of payments) {
    try {
      if (!payment.transactionId) throw new Error('Missing charge reference');
      const result = await getPaymentGateway().refund({ transactionId: payment.transactionId, amount: Number(payment.amount), reason: payment.refundReason || 'Cancelación', idempotencyKey: `refund:${payment.id}:full` });
      if (!result.success) throw new Error('Refund not confirmed');
      await serializable(async tx => {
        const updated = await tx.payment.updateMany({ where: { id: payment.id, status: 'REFUND_PENDING' }, data: { status: 'REFUNDED', refundId: result.refundId, refundedAt: new Date(), refundError: null, refundAttempts: { increment: 1 } } });
        if (updated.count) await tx.notification.create({ data: { userId: payment.patientId, title: 'Reembolso de prueba procesado', content: 'El reembolso completo ha sido confirmado por el simulador.', type: 'SYSTEM', referenceId: payment.appointmentId } });
      });
    } catch {
      await prisma.payment.updateMany({ where: { id: payment.id, status: 'REFUND_PENDING' }, data: { refundAttempts: { increment: 1 }, refundError: 'Pendiente de conciliación; se reintentará automáticamente' } });
    }
  }
}
