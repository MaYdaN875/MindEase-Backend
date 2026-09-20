import { serializable } from './clinicalPolicy';
import { recoverPayments } from './paymentWorkflow';
import { processPendingRefunds } from './refundPolicy';

export async function maintainFinance() {
  await recoverPayments();
  await serializable(async tx => {
    // A closed app cannot reliably cancel a reservation; expire only unpaid, idle bookings.
    const stale = await tx.appointment.findMany({ where: {
      status: 'PENDING', price: { gt: 0 }, createdAt: { lt: new Date(Date.now() - 15 * 60000) },
      OR: [{ payment: null }, { payment: { status: 'FAILED' } }],
    }, select: { id: true }, take: 100 });
    const ids = stale.map(a => a.id);
    await tx.appointment.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', cancellationReason: 'Reserva sin pago expirada' } });
    await tx.consultation.updateMany({ where: { appointmentId: { in: ids } }, data: { status: 'CANCELLED' } });
    // Recover legacy cancellations whose refund failed before durable queuing existed.
    await tx.payment.updateMany({ where: { status: 'SUCCEEDED', appointment: { status: 'CANCELLED' } }, data: { status: 'REFUND_PENDING', refundReason: 'Cancelación pendiente de reembolso' } });
  });
  await processPendingRefunds();
}

export function startFinanceMaintenance() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await maintainFinance(); } catch { console.error('Finance maintenance failed; pending operations will be retried'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
