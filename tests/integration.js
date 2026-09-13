// Uses real Express + Prisma + PostgreSQL in a unique temporary schema.
// TEST_DATABASE_URL must name a disposable/local database with schema-creation permissions.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Define TEST_DATABASE_URL para una base de pruebas local');
  const schema = 'mindease_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = randomUUID();
  process.env.SCHEDULE_TIME_ZONE = 'America/Mexico_City';
  const control = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  let db, server;
  let checks = 0;
  try {
    await control.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(__dirname, '../prisma/schema.prisma')], {
      env: { ...process.env }, stdio: 'pipe',
    });
    db = require('../src/config/db').default;
    const roles = ['USER', 'PSYCHOLOGIST_APPLICANT', 'PSYCHOLOGIST_VERIFIED', 'ADMIN', 'SUPERADMIN', 'REVISOR'];
    for (const name of roles) await db.role.create({ data: { name } });
    const app = require('../src/app').default;
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    async function api(method, route, token, body, expected = 200) {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      const result = await response.json();
      assert.equal(response.status, expected, method + ' ' + route + ': ' + JSON.stringify(result));
      checks++;
      return result.data;
    }
    async function register(name, role = 'USER') {
      return api('POST', '/auth/register', null, { name, email: name + '@example.test', password: 'test-password-123', acceptedPrivacy: true, role }, 201);
    }
    const admin = await register('admin');
    const adminRole = await db.role.findUnique({ where: { name: 'SUPERADMIN' } });
    await db.userRole.create({ data: { userId: admin.user.id, roleId: adminRole.id } });
    // The original token must acquire updated roles without a new login.
    await api('GET', '/admin/users', admin.token);
    const doctor = await register('doctor', 'PSYCHOLOGIST');
    const patient = await register('patient');
    const patient2 = await register('patient2');
    const applicantProfile = await db.psychologistProfile.findUnique({ where: { userId: doctor.user.id } });
    const profileId = applicantProfile.id;
    await api('PUT', '/admin/users/' + doctor.user.id + '/status', admin.token, { status: 'ACTIVE' });
    assert.equal((await db.psychologistProfile.findUnique({ where: { id: profileId } })).status, 'REGISTRO_INCOMPLETO');
    await api('PUT', '/admin/users/' + doctor.user.id + '/roles', admin.token, { roles: ['PSYCHOLOGIST_VERIFIED'] }, 400);
    await api('PUT', '/psychologists/me/availability', doctor.token, { availabilities: [] }, 403);
    await api('PUT', '/psychologists/me/profile', doctor.token, { description: 'Perfil de pruebas', licenseNumber: 'TEST-123' });
    await api('POST', '/psychologists/me/submit-review', doctor.token, {}, 400);
    for (const documentType of ['ID', 'DEGREE', 'LICENSE']) await db.professionalDocument.create({ data: { psychologistId: profileId, documentType, storageKey: 'test-only', originalFilename: 'test.pdf', mimeType: 'application/pdf', fileSize: 1 } });
    await api('POST', '/psychologists/me/submit-review', doctor.token, {});
    await api('POST', '/psychologists/me/submit-review', doctor.token, {}, 409);
    const request = await db.verificationRequest.findFirst({ where: { psychologistId: profileId } });
    await api('POST', '/admin/psychologist-applications/' + request.id + '/approve', admin.token, {}, 400);
    assert.equal((await db.psychologistProfile.findUnique({ where: { id: profileId } })).status, 'PENDIENTE_REVISION');
    const docs = await db.professionalDocument.findMany({ where: { psychologistId: profileId } });
    for (const doc of docs) await api('PUT', '/admin/documents/' + doc.id + '/status', admin.token, { status: 'APPROVED', expiresAt: '2099-01-01T00:00:00Z' });
    await db.professionalDocument.update({ where: { id: docs[0].id }, data: { expiresAt: new Date(0) } });
    await api('POST', '/admin/psychologist-applications/' + request.id + '/approve', admin.token, {}, 400);
    await db.professionalDocument.update({ where: { id: docs[0].id }, data: { expiresAt: new Date('2099-01-01') } });
    await api('POST', '/admin/psychologist-applications/' + request.id + '/assign', admin.token, {});
    const approvals = await Promise.all([1, 2].map(() => fetch(base + '/admin/psychologist-applications/' + request.id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin.token }, body: '{}' })));
    assert.deepEqual(approvals.map(r => r.status).sort(), [200, 409]); checks++;
    await api('POST', '/admin/psychologist-applications/' + request.id + '/approve', admin.token, {}, 409);
    assert.equal(await db.verificationReview.count({ where: { requestId: request.id, decision: 'APPROVE' } }), 1);
    await api('DELETE', '/psychologists/me/documents/' + docs[0].id, doctor.token, undefined, 409);
    await api('PUT', '/psychologists/me/profile', doctor.token, { licenseNumber: 'CHANGED' }, 409);
    await api('PUT', '/admin/documents/' + docs[0].id + '/status', admin.token, { status: 'APPROVED', expiresAt: 'invalid' }, 400);
    const schedules = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map(dayOfWeek => ({ dayOfWeek, startTime: '09:00', endTime: '12:00', slotDuration: 50, isActive: true }));
    await api('PUT', '/psychologists/me/availability', doctor.token, { availabilities: [{ ...schedules[0], slotDuration: -1 }] }, 400);
    await api('PUT', '/psychologists/me/availability', doctor.token, { availabilities: [schedules[0], schedules[0]] }, 400);
    await api('PUT', '/psychologists/me/availability', doctor.token, { availabilities: schedules });
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const { slots } = await api('GET', '/psychologists/' + profileId + '/available-slots?date=' + date);
    assert.equal(slots.length, 3);
    assert.ok(slots[0].startAt.endsWith('15:00:00.000Z'));
    const booking = { psychologistId: profileId, startAt: slots[0].startAt, endAt: slots[0].endAt };
    await api('POST', '/appointments', patient.token, { ...booking, endAt: new Date(Date.parse(booking.endAt) + 60000).toISOString() }, 400);
    const simultaneous = await Promise.all([patient.token, patient2.token].map(token => fetch(base + '/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(booking) })));
    assert.deepEqual(simultaneous.map(r => r.status).sort(), [201, 409]); checks++;
    const winner = simultaneous[0].status === 201 ? patient : patient2;
    const loser = winner === patient ? patient2 : patient;
    const booked = await simultaneous.find(r => r.status === 201).json();
    const id = booked.data.appointment.id;
    assert.equal(booked.data.appointment.status, 'PENDING');
    await api('GET', '/appointments/' + id, loser.token, undefined, 403);
    await api('PATCH', '/appointments/' + id + '/status', winner.token, { status: 'CONFIRMED' }, 403);
    await api('PATCH', '/appointments/' + id + '/status', winner.token, { status: 'COMPLETED' }, 403);
    await api('POST', '/consultations/' + id + '/start', doctor.token, {}, 409);
    await api('PATCH', '/appointments/' + id + '/status', doctor.token, { status: 'CONFIRMED' });
    await api('POST', '/consultations/' + id + '/start', doctor.token, {}, 409);
    await api('POST', '/consultations/' + id + '/complete', doctor.token, {}, 409);
    // Move only this isolated fixture to the current session window.
    await db.appointment.update({ where: { id }, data: { startAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 49 * 60000) } });
    await api('POST', '/consultations/' + id + '/start', winner.token, {}, 403);
    await api('POST', '/consultations/' + id + '/start', doctor.token, { meetingUrl: 'javascript:alert(1)' }, 400);
    await api('POST', '/consultations/' + id + '/start', doctor.token, { meetingUrl: 'https://example.org/session' });
    await api('POST', '/consultations/' + id + '/start', doctor.token, {}, 409);
    await api('PATCH', '/appointments/' + id + '/status', winner.token, { status: 'CANCELLED' }, 409);
    await api('PATCH', '/consultations/' + id + '/notes', winner.token, { clinicalNotes: 'blocked' }, 403);
    await api('PATCH', '/consultations/' + id + '/notes', doctor.token, { clinicalNotes: 'CONFIDENTIAL_TEST' });
    for (const route of ['/appointments', '/appointments/' + id, '/consultations/' + id]) {
      const data = await api('GET', route, winner.token);
      assert.equal(JSON.stringify(data).includes('CONFIDENTIAL_TEST'), false);
      assert.equal(JSON.stringify(data).includes('clinicalNotes'), false);
    }
    assert.equal((await api('GET', '/consultations/' + id, doctor.token)).consultation.clinicalNotes, 'CONFIDENTIAL_TEST');
    assert.equal(Object.hasOwn((await api('GET', '/consultations/' + id, admin.token)).consultation, 'clinicalNotes'), false);
    await api('POST', '/consultations/' + id + '/complete', doctor.token, {});
    await api('POST', '/consultations/' + id + '/complete', doctor.token, {}, 409);
    await api('POST', '/consultations/' + id + '/start', doctor.token, {}, 409);
    await api('PATCH', '/appointments/' + id + '/status', doctor.token, { status: 'CONFIRMED' }, 409);
    assert.equal((await db.appointment.findUnique({ where: { id } })).status, 'COMPLETED');
    await api('PUT', '/psychologists/me/profile', doctor.token, { autoConfirmAppointments: true });
    const auto = await api('POST', '/appointments', winner.token, { psychologistId: profileId, startAt: slots[1].startAt, endAt: slots[1].endAt }, 201);
    assert.equal(auto.appointment.status, 'CONFIRMED');
    await api('PATCH', '/appointments/' + auto.appointment.id + '/status', winner.token, { status: 'CANCELLED' });
    await api('PATCH', '/appointments/' + auto.appointment.id + '/status', doctor.token, { status: 'CONFIRMED' }, 409);
    // Cancellation frees the slot, while closed appointments cannot resurrect.
    await api('POST', '/appointments', winner.token, { psychologistId: profileId, startAt: slots[1].startAt, endAt: slots[1].endAt }, 201);
    await api('PUT', '/admin/users/' + doctor.user.id + '/status', admin.token, { status: 'SUSPENDED' });
    await api('GET', '/appointments?as=psychologist', doctor.token, undefined, 403);
    await api('POST', '/auth/login', null, { email: 'doctor@example.test', password: 'test-password-123' }, 403);
    await api('GET', '/psychologists/' + profileId + '/public', null, undefined, 404);
    assert.equal((await db.psychologistProfile.findUnique({ where: { id: profileId } })).status, 'VERIFICADO');
    await api('PUT', '/admin/users/' + doctor.user.id + '/status', admin.token, { status: 'ACTIVE' });
    await api('GET', '/appointments?as=psychologist', doctor.token);
    await api('PUT', '/admin/users/' + doctor.user.id + '/roles', admin.token, { roles: ['USER'] });
    const currentProfile = await api('GET', '/users/profile', doctor.token);
    assert.equal(currentProfile.user.roles.includes('PSYCHOLOGIST_VERIFIED'), false);
    await api('PUT', '/psychologists/me/availability', doctor.token, { availabilities: [] }, 403);
    await api('POST', '/appointments', winner.token, booking, 403);
    await api('GET', '/psychologists/' + profileId + '/public', null, undefined, 404);
    await api('PUT', '/admin/users/' + winner.user.id + '/status', admin.token, { status: 'INACTIVE' });
    assert.equal((await db.user.findUnique({ where: { id: winner.user.id } })).status, 'INACTIVE');
    const inactiveUsers = await api('GET', '/admin/users?status=INACTIVE', admin.token);
    assert.ok(inactiveUsers.users.some(u => u.id === winner.user.id));
    await api('GET', '/appointments', winner.token, undefined, 403);
    console.log('PASS: ' + checks + ' comprobaciones HTTP/concurrencia con PostgreSQL real.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.$disconnect();
    // Exact generated test schema only. Never drop public or a user-provided schema.
    if (!/^mindease_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Nombre de esquema inseguro');
    await control.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await control.$disconnect();
    console.log('Esquema temporal de pruebas eliminado; datos de la aplicación conservados.');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
