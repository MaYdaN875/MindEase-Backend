// Integration test: only the dedicated local disposable database is accepted.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const jwt = require('jsonwebtoken');

async function main() {
  const source = process.env.TEST_DATABASE_URL;
  if (!source) throw new Error('TEST_DATABASE_URL is required');
  const url = new URL(source);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55439' || url.pathname !== '/mindease_test') {
    throw new Error('Use only the dedicated local isolated test database');
  }
  url.searchParams.set('schema', 'interview_test_' + randomUUID().replaceAll('-', ''));
  process.env.DATABASE_URL = url.toString();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = randomUUID();
  process.env.INITIAL_INTERVIEW_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.INITIAL_INTERVIEW_ALLOW_DEV_REPORT = 'true';
  process.env.INITIAL_INTERVIEW_DEMO_ENABLED = 'true';
  process.env.INITIAL_INTERVIEW_DEMO_USER_IDS = '';
  process.env.AI_RATE_LIMIT_PER_MINUTE = '1000';
  process.env.FCM_ENABLED = 'false';
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.INITIAL_INTERVIEW_GEMINI_DATA_POLICY_CONFIRMED;
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
  const db = require('../src/config/db').default;
  const app = require('../src/app').default;
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const role = await db.role.create({ data: { name: 'USER' } });
    async function makePatient(name, verified = true) {
      const user = await db.user.create({ data: { name, email: `${name}@example.test`, passwordHash: 'unused', status: 'ACTIVE', emailVerifiedAt: verified ? new Date() : null, userRoles: { create: { roleId: role.id } } } });
      return { user, token: jwt.sign({ userId: user.id, roles: ['USER'] }, process.env.JWT_SECRET) };
    }
    async function call(method, path, token, body) {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { code: response.status, body: await response.json() };
    }
    const patient = await makePatient('patient');
    const unverified = await makePatient('unverified', false);
    assert.equal((await call('GET', '/interview/status', patient.token)).body.data.status, 'UNAVAILABLE');
    assert.equal((await call('GET', '/interview/progress', patient.token)).code, 404);
    process.env.INITIAL_INTERVIEW_DEMO_USER_IDS = patient.user.id;
    process.env.INITIAL_INTERVIEW_DEMO_ENABLED = 'false';
    assert.equal((await call('GET', '/interview/status', patient.token)).body.data.status, 'UNAVAILABLE');
    assert.equal((await call('GET', '/interview/progress', patient.token)).code, 404);
    process.env.INITIAL_INTERVIEW_DEMO_ENABLED = 'true';
    assert.equal((await call('GET', '/interview/status')).code, 401);
    assert.equal((await call('GET', '/interview/status', unverified.token)).code, 403);
    let status = await call('GET', '/interview/status', patient.token);
    assert.equal(status.body.data.status, 'PENDING');
    const version = status.body.data.privacyNotice.version;
    assert.equal((await call('POST', '/interview/start', patient.token, { consentVersion: version, adultConfirmed: false })).code, 400);
    assert.equal((await call('POST', '/interview/start', patient.token, { consentVersion: 'invalid', adultConfirmed: true })).code, 400);
    let result = await call('POST', '/interview/start', patient.token, { consentVersion: version, adultConfirmed: true });
    assert.equal(result.code, 200);
    assert.equal((await db.userConsent.count({ where: { userId: patient.user.id, legalCode: 'INITIAL_INTERVIEW' } })), 1);
    assert.equal((await call('POST', '/notifications/device-token', patient.token, { token: 'isolated-test-token-1234567890', platform: 'android' })).code, 200);
    assert.equal(await db.deviceToken.count({ where: { userId: patient.user.id } }), 1);
    let count = 0;
    while (result.body.data.question) {
      const q = result.body.data.question;
      const answer = q.answerType === 'text' ? 'Busco apoyo por estrés laboral' : q.answerType === 'date' ? '1990-01-01' : (q.options.includes('No') ? 'No' : q.options[0]);
      result = await call('POST', '/interview/answer', patient.token, { questionId: q.id, answer });
      assert.equal(result.code, 200, `answer ${q.id}: ${JSON.stringify(result.body)}`);
      assert.ok(++count < 60);
      if (count === 1) {
        const progress = await call('GET', '/interview/progress', patient.token);
        assert.equal(progress.body.data.question.id, result.body.data.question.id);
      }
    }
    assert.ok(count >= 25);
    assert.equal((await call('GET', '/interview/review', patient.token)).code, 200);
    result = await call('POST', '/interview/complete', patient.token, { confirmed: true });
    assert.equal(result.code, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, 'COMPLETED');
    const stored = await db.initialInterview.findUnique({ where: { patientId: patient.user.id } });
    assert.ok(stored.answersCiphertext.startsWith('v1.'));
    assert.ok(stored.reportCiphertext.startsWith('v1.'));
    assert.ok(!stored.answersCiphertext.includes('estrés laboral'));
    const professionalRole = await db.role.create({ data: { name: 'PSYCHOLOGIST_VERIFIED' } });
    const professional = await db.user.create({ data: { name: 'Professional', email: 'professional@example.test', passwordHash: 'unused', status: 'ACTIVE', emailVerifiedAt: new Date(), userRoles: { create: { roleId: professionalRole.id } }, psychologistProfile: { create: { status: 'VERIFICADO' } } }, include: { psychologistProfile: true } });
    const professionalToken = jwt.sign({ userId: professional.id, roles: ['PSYCHOLOGIST_VERIFIED'] }, process.env.JWT_SECRET);
    const appointment = await db.appointment.create({ data: { userId: patient.user.id, psychologistId: professional.psychologistProfile.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), status: 'CONFIRMED', price: 300 } });
    const reportPath = `/interview/professional/patients/${patient.user.id}/initial-report?appointmentId=${appointment.id}`;
    assert.equal((await call('GET', reportPath, professionalToken)).code, 403);
    await db.payment.create({ data: { appointmentId: appointment.id, patientId: patient.user.id, psychologistId: professional.psychologistProfile.id, amount: 300, platformFee: 30, netAmount: 270, status: 'SUCCEEDED', currency: 'MXN' } });
    const professionalReport = await call('GET', reportPath, professionalToken);
    assert.equal(professionalReport.code, 200);
    assert.ok(professionalReport.body.data.report);
    assert.equal((await call('GET', reportPath, patient.token)).code, 403);
    const pdf = await fetch(`${base}/interview/professional/patients/${patient.user.id}/initial-report.pdf?appointmentId=${appointment.id}`, { headers: { Authorization: `Bearer ${professionalToken}` } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal(await db.initialInterviewAccessLog.count({ where: { interviewId: stored.id } }), 2);
    const crisisPatient = await makePatient('crisis');
    process.env.INITIAL_INTERVIEW_DEMO_USER_IDS += ',' + crisisPatient.user.id;
    status = await call('GET', '/interview/status', crisisPatient.token);
    result = await call('POST', '/interview/start', crisisPatient.token, { consentVersion: status.body.data.privacyNotice.version, adultConfirmed: true });
    result = await call('POST', '/interview/answer', crisisPatient.token, { questionId: result.body.data.question.id, answer: 'Necesito un consejo, estoy pensando en quitarme la vida' });
    assert.equal(result.code, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, 'ESCALATED');
    assert.equal(result.body.data.needsImmediateHelp, true);
    assert.equal(await db.crisisEvent.count({ where: { userId: crisisPatient.user.id, source: 'INITIAL_INTERVIEW' } }), 1);
    assert.equal((await call('POST', '/interview/complete', crisisPatient.token, { confirmed: true })).code, 409);
    assert.equal((await call('POST', `/interview/professional/patients/${crisisPatient.user.id}/resume?appointmentId=${randomUUID()}`, patient.token, {})).code, 503);
    console.log(`PASS isolated interview flow: ${count} answers, consent, encryption and crisis escalation`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
