const { randomUUID } = require('node:crypto');
module.exports = async ({ db, api, actors, profile, check }) => {
  const appointment = await db.appointment.create({ data: { userId: actors.USER.id, psychologistId: profile.id, startAt: new Date('2027-01-01T09:00Z'), endAt: new Date('2027-01-01T10:00Z'), price: 100, status: 'CONFIRMED', cancellationReason: 'PRIVATE_CANCELLATION', consultation: { create: { status: 'IN_PROGRESS', startedAt: new Date('2027-01-01T09:00Z'), clinicalNotes: 'PRIVATE_NOTES', meetingUrl: 'https://private.invalid/secret' } } } });
  const noSession = await db.appointment.create({ data: { userId: actors.USER.id, psychologistId: profile.id, startAt: new Date('2027-01-01T09:00Z'), endAt: new Date('2027-01-01T10:00Z'), price: 100 } });
  for (const role of ['ADMIN', 'SUPERADMIN', 'SUPPORT', 'REVISOR', 'MODERATOR', 'USER', 'PSYCHOLOGIST_VERIFIED', undefined]) {
    const expected = !role ? 401 : ['ADMIN', 'SUPERADMIN'].includes(role) ? 200 : 403;
    for (const route of ['/api/admin/appointments', '/api/admin/appointments/' + appointment.id]) check(`${role || 'anonymous'} appointments authorization ${route}`, (await api('GET', route, role)).status === expected);
  }
  const all = (await api('GET', '/api/admin/appointments?limit=100', 'ADMIN')).body.data;
  check('filtered status counters cover all matching appointments', all.counts.reduce((n, c) => n + c.count, 0) === all.total);
  const serialized = JSON.stringify(all);
  check('listing never exposes clinical fields or private reasons', !/clinicalNotes|meetingUrl|cancellationReason|passwordHash|PRIVATE_|private.invalid/.test(serialized));
  const detail = (await api('GET', '/api/admin/appointments/' + appointment.id, 'ADMIN')).body.data;
  check('detail operational fields only and independent states', detail.status === 'CONFIRMED' && detail.consultation.status === 'IN_PROGRESS' && detail.payment === null && !/clinicalNotes|meetingUrl|cancellationReason|PRIVATE_|private.invalid/.test(JSON.stringify(detail)));
  check('consultation state filter', (await api('GET', '/api/admin/appointments?consultationStatus=IN_PROGRESS', 'ADMIN')).body.data.items.every(a => a.consultation.status === 'IN_PROGRESS'));
  const absent = (await api('GET', '/api/admin/appointments?consultationStatus=NONE', 'ADMIN')).body.data;
  check('missing consultation filter', absent.items.some(a => a.id === noSession.id) && absent.items.every(a => a.consultation === null));
  const noPay = (await api('GET', '/api/admin/appointments?paymentStatus=NONE', 'ADMIN')).body.data;
  check('missing payment filter', noPay.total === 2 && noPay.items.every(a => a.payment === null));
  check('payment status filter', (await api('GET', '/api/admin/appointments?paymentStatus=FAILED', 'ADMIN')).body.data.total === 1);
  check('appointment status filter', (await api('GET', '/api/admin/appointments?status=CONFIRMED', 'ADMIN')).body.data.items.every(a => a.status === 'CONFIRMED'));
  check('date range filters scheduled start', (await api('GET', '/api/admin/appointments?from=2027-01-01T00:00:00Z&to=2027-01-02T00:00:00Z', 'ADMIN')).body.data.total === 2);
  check('search by appointment ID', (await api('GET', '/api/admin/appointments?search=' + appointment.id, 'ADMIN')).body.data.total === 1);
  check('empty result', (await api('GET', '/api/admin/appointments?search=nonexistentxyz', 'ADMIN')).body.data.total === 0);
  const first = (await api('GET', '/api/admin/appointments?limit=1', 'ADMIN')).body.data;
  const second = (await api('GET', '/api/admin/appointments?limit=1&page=2', 'ADMIN')).body.data;
  check('stable pagination for matching scheduled times', first.hasMore && first.items[0].id !== second.items[0].id);
  for (const query of ['page=0', 'limit=101', 'status=WRONG', 'consultationStatus=WRONG', 'paymentStatus=WRONG', 'from=wrong', 'from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z']) check('invalid appointment query rejected ' + query, (await api('GET', '/api/admin/appointments?' + query, 'ADMIN')).status === 400);
  check('invalid appointment ID', (await api('GET', '/api/admin/appointments/not-uuid', 'ADMIN')).status === 400);
  check('missing appointment ID', (await api('GET', '/api/admin/appointments/' + randomUUID(), 'ADMIN')).status === 404);
  await db.user.update({ where: { id: actors.ADMIN.id }, data: { status: 'INACTIVE' } });
  check('inactive admin cannot supervise appointments', (await api('GET', '/api/admin/appointments', 'ADMIN')).status === 403);
  await db.user.update({ where: { id: actors.ADMIN.id }, data: { status: 'ACTIVE' } });
};
