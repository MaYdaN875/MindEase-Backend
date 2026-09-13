import { Prisma } from '@prisma/client';
import { getPaymentGateway } from './paymentGateway';
import { sendNotification } from './notificationService';

export async function processAppointmentRefund(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  reason?: string
): Promise<boolean> {
  const payment = await tx.payment.findUnique({
    where: { appointmentId },
  });

  if (!payment || payment.status !== 'SUCCEEDED') {
    return false; // No paid transaction to refund
  }

  const gateway = getPaymentGateway();
  const refundResult = await gateway.refund({
    transactionId: payment.transactionId || `ch_unknown_${payment.id}`,
    amount: payment.amount,
    reason: reason || 'Cancelación de cita',
  });

  if (refundResult.success) {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
        refundReason: reason || 'Cancelación de cita',
        refundedAt: new Date(),
      },
    });

    await sendNotification({
      userId: payment.patientId,
      title: 'Reembolso procesado',
      content: `Se ha emitido el reembolso de $${payment.amount.toFixed(2)} ${payment.currency} por la cancelación de tu consulta.`,
      type: 'SYSTEM',
      referenceId: appointmentId,
    });

    return true;
  }

  return false;
}
