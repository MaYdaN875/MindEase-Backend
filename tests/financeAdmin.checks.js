const { randomUUID } = require('node:crypto');

module.exports = async function financeChecks({ db, api, actors, profile, check }) {
  for (const role of ['ADMIN', 'SUPERADMIN', 'REVISOR', 'MODERATOR', 'SUPPORT', 'USER', 'PSYCHOLOGIST_VERIFIED', undefined]) {
    const expected = !role ? 401 : ['ADMIN', 'SUPERADMIN'].includes(role) ? 200 : 403;
    for (const resource of ['summary', 'payments', 'refunds', 'payouts']) check(`${role || 'anonymous'} finance ${resource} permission`, (await api('GET', '/api/admin/finance/' + resource, role)).status === expected);
  }
  async function payment(status, appointmentStatus, amount, currency = 'MXN') {
    const appointment = await db.appointment.create({ data: { userId: actors.USER.id, psychologistId: profile.id, startAt: new Date('2026-01-01T09:00Z'), endAt: new Date('2026-01-01T10:00Z'), price: amount, currency, status: appointmentStatus,
      consultation: { create: { clinicalNotes: 'PRIVATE_CLINICAL_SENTINEL' } } } });
    return db.payment.create({ data: { appointmentId: appointment.id, patientId: actors.USER.id, psychologistId: profile.id, amount, currency, platformFee: amount * .15, netAmount: amount * .85, status, refundError: 'PRIVATE_PROVIDER_SENTINEL', idempotencyKey: randomUUID(), createdAt: new Date('2026-01-02T00:00Z') } });
  }
  const completed = await payment('SUCCEEDED', 'COMPLETED', 100);
  await payment('SUCCEEDED', 'CONFIRMED', 200);
  await payment('SUCCEEDED', 'PENDING', 100);
  await payment('SUCCEEDED', 'NO_SHOW', 100);
  await payment('REFUNDED', 'CANCELLED', 100);
  await payment('REFUND_PENDING', 'CANCELLED', 100);
  await payment('PARTIALLY_REFUNDED', 'COMPLETED', 100);
  await payment('FAILED', 'PENDING', 100);
  await payment('SUCCEEDED', 'COMPLETED', 1000, 'USD');
  for (const [status, amount] of [['REQUESTED', 10], ['PROCESSING', 5], ['COMPLETED', 20], ['REJECTED', 99]]) await db.payoutRequest.create({ data: { psychologistId: profile.id, amount, currency: 'MXN', status, bankName: 'Banco prueba', accountClabe: '032180000118359719', notes: 'PRIVATE_PAYOUT_SENTINEL' } });
  await db.paymentAttempt.create({ data: { paymentId: completed.id, idempotencyKey: randomUUID(), provider: 'MOCK', status: 'SUCCEEDED' } });
  const summary = (await api('GET', '/api/admin/finance/summary', 'ADMIN')).body.data;
  check('only completed payments release net funds; reservations deducted once', Number(summary.availableBalance) === 50);
  check('pending and confirmed payments held', Number(summary.heldBalance) === 255);
  check('no-show requires review', Number(summary.reviewBalance) === 85);
  check('earned fees exclude pending and refund payments', Number(summary.earnedFees) === 15);
  check('payout states separated', Number(summary.pendingPayoutBalance) === 15 && Number(summary.totalWithdrawn) === 20);
  check('refund totals and partial warning', Number(summary.refundedAmount) === 100 && Number(summary.pendingRefundAmount) === 100 && summary.partialRefundCount === 1);
  check('currency isolation', Number((await api('GET', '/api/admin/finance/summary?currency=USD', 'ADMIN')).body.data.availableBalance) === 850);
  check('empty currency yields zero balances', Number((await api('GET', '/api/admin/finance/summary?currency=EUR', 'ADMIN')).body.data.availableBalance) === 0);
  const first = (await api('GET', '/api/admin/finance/payments?limit=2', 'ADMIN')).body.data;
  const second = (await api('GET', '/api/admin/finance/payments?limit=2&page=2', 'ADMIN')).body.data;
  check('deterministic pagination and exact count', first.total === 8 && first.hasMore && second.items.every(p => !first.items.some(q => p.id === q.id)));
  check('status filter', (await api('GET', '/api/admin/finance/payments?status=FAILED', 'ADMIN')).body.data.total === 1);
  check('refund queue excludes other states', (await api('GET', '/api/admin/finance/refunds', 'ADMIN')).body.data.total === 3);
  check('search by payment id', (await api('GET', '/api/admin/finance/payments?search=' + completed.id, 'ADMIN')).body.data.total === 1);
  check('date filter', (await api('GET', '/api/admin/finance/payments?from=2026-02-01T00:00:00.000Z', 'ADMIN')).body.data.total === 0);
  const detail = await api('GET', '/api/admin/finance/payments/' + completed.id, 'ADMIN');
  check('payment detail exposes attempt history', detail.status === 200 && detail.body.data.attempts.length === 1);
  const serialized = JSON.stringify(detail.body);
  check('payment detail excludes clinical and secret data', !serialized.includes('PRIVATE_') && !serialized.includes('idempotencyKey') && !serialized.includes('passwordHash'));
  const payouts = (await api('GET', '/api/admin/finance/payouts', 'ADMIN')).body;
  check('CLABE masked and free text withheld', !JSON.stringify(payouts).includes('032180000118359719') && !JSON.stringify(payouts).includes('PRIVATE_') && payouts.data.items.every(p => p.accountClabe === '**************9719'));
  for (const query of ['limit=0', 'page=-1', 'currency=mxn', 'status=INVALID', 'from=bad', 'from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z']) check('invalid filter rejected: ' + query, (await api('GET', '/api/admin/finance/payments?' + query, 'ADMIN')).status === 400);
  check('refund filter rejects succeeded', (await api('GET', '/api/admin/finance/refunds?status=SUCCEEDED', 'ADMIN')).status === 400);
  check('payout filter rejects payment state', (await api('GET', '/api/admin/finance/payouts?status=SUCCEEDED', 'ADMIN')).status === 400);
  check('unknown payment is 404', (await api('GET', '/api/admin/finance/payments/' + randomUUID(), 'ADMIN')).status === 404);
  check('detail blocked for support', (await api('GET', '/api/admin/finance/payments/' + completed.id, 'SUPPORT')).status === 403);
  await db.user.update({ where: { id: actors.ADMIN.id }, data: { status: 'INACTIVE' } });
  check('inactive admin rejected', [401, 403].includes((await api('GET', '/api/admin/finance/summary', 'ADMIN')).status));
  await db.user.update({ where: { id: actors.ADMIN.id }, data: { status: 'ACTIVE' } });
};
