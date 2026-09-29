// AI Orientation Module Integration Tests
// Runs in an isolated PostgreSQL schema
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

async function main() {
  const source = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mindease?schema=public';
  if (!['localhost', '127.0.0.1'].includes(new URL(source).hostname)) {
    throw new Error('TEST_DATABASE_URL must point to a local test database');
  }

  const schema = 'mindease_ai_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(source);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = randomUUID();
  process.env.NODE_ENV = 'test';
  process.env.AI_PROVIDER = 'mock';
  process.env.AI_RATE_LIMIT_PER_MINUTE = '1000';
  process.env.AI_MAX_MESSAGES_PER_SESSION = '20';

  const control = new PrismaClient({ datasources: { db: { url: source } } });
  let db, server, checks = 0;
  let schemaFixture;
  const check = (name, condition) => {
    assert.ok(condition, name);
    console.log('PASS: ' + name);
    checks++;
  };

  try {
    // 1. Setup isolated database schema
    await control.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    const prismaCli = require.resolve('prisma/build/index.js');
    const fullSchema = path.join(__dirname, '../prisma/schema.prisma');
    if (process.env.AI_TEST_REPLAY_MIGRATIONS === 'true') {
      // Explicit full-history audit. Historical baseline gaps must not be hidden.
      execFileSync(process.execPath, [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      path.join(__dirname, '../prisma/schema.prisma')
      ], { env: process.env, stdio: 'pipe' });
    } else {
      // Build the pre-AI schema in an isolated namespace, then execute the REAL additive SQL.
      // The old migration chain is incomplete (PaymentStatus is missing after the initial migration).
      const beforeAI = fs.readFileSync(fullSchema, 'utf8')
        .replace(/^(?:model|enum) AI\w+\s*\{[^}]*\}\s*/gm, '')
        .replace(/^.*\b(?:AIOrientationSession|AIRecommendation)\[\].*\r?\n/gm, '');
      schemaFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mindease-ai-schema-'));
      const fixturePath = path.join(schemaFixture, 'schema.prisma');
      fs.writeFileSync(fixturePath, beforeAI);
      execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', fixturePath], { env: process.env, stdio: 'pipe' });
      execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--schema', fixturePath,
        '--file', path.join(__dirname, '../prisma/migrations/20260927000000_ai_orientation/migration.sql')], { env: process.env, stdio: 'pipe' });
      execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--schema', fixturePath,
        '--file', path.join(__dirname, '../prisma/migrations/20260928000000_ai_message_requests/migration.sql')], { env: process.env, stdio: 'pipe' });
      execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--schema', fixturePath,
        '--file', path.join(__dirname, '../prisma/migrations/20260929000000_ai_provider_gate/migration.sql')], { env: process.env, stdio: 'pipe' });
      execFileSync(process.execPath, [prismaCli, 'migrate', 'diff', '--from-schema-datasource', fullSchema,
        '--to-schema-datamodel', fullSchema, '--exit-code'], { env: process.env, stdio: 'pipe' });
      check('AI migration produces exact Prisma schema', true);
    }

    db = require('../src/config/db').default;

    const { geminiAdmission } = require('../src/ai/providers/geminiAdmission');
    process.env.AI_GEMINI_REQUESTS_PER_MINUTE = '4';
    const admissions = await Promise.allSettled(Array.from({ length: 8 }, () => geminiAdmission.acquire()));
    check('global provider gate admits only one concurrent request', admissions.filter(r => r.status === 'fulfilled').length === 1);
    check('other requests receive a local wait without a provider call', admissions.filter(r => r.status === 'rejected').every(r => r.reason.code === 'AI_PROVIDER_RATE_LIMIT' && r.reason.retryAfterSeconds > 0));
    await geminiAdmission.pause(86400, 'AI_PROVIDER_DAILY_QUOTA');
    await geminiAdmission.pause(30, 'AI_PROVIDER_BUSY');
    await assert.rejects(geminiAdmission.acquire(), e => e.code === 'AI_PROVIDER_DAILY_QUOTA' && !e.retryable && e.retryAfterSeconds === undefined);
    check('shorter pause cannot overwrite daily provider hold', true);
    await db.$executeRaw`UPDATE "AIProviderGate" SET "nextAllowedAt" = clock_timestamp() - interval '1 second'`;
    await geminiAdmission.acquire();
    check('provider gate recovers when hold expires', true);

    // Seed roles
    const roles = ['USER', 'PSYCHOLOGIST_VERIFIED', 'PSYCHOLOGIST_APPLICANT', 'ADMIN'];
    for (const name of roles) {
      await db.role.create({ data: { name } });
    }

    // Seed specialties
    const specStress = await db.specialty.create({ data: { name: 'Manejo del Estrés' } });
    const specClinical = await db.specialty.create({ data: { name: 'Psicología Clínica' } });
    const specCBT = await db.specialty.create({ data: { name: 'Terapia Cognitivo-Conductual' } });

    // Seed Crisis Resources
    await db.aICrisisResource.create({
      data: {
        countryCode: 'MX',
        name: 'Línea de la Vida',
        phone: '800 911 2000',
        type: 'SUICIDE_PREVENTION',
        description: 'Atención 24/7',
      },
    });

    // Start Express app
    const app = require('../src/app').default;
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/ai';

    // Helper: Create user with role and token
    async function createUser(name, role, status = 'ACTIVE') {
      const u = await db.user.create({
        data: {
          name,
          email: `${name}-${randomUUID().slice(0, 6)}@example.test`,
          passwordHash: 'test-hash',
          status,
          userRoles: { create: { role: { connect: { name: role } } } },
        },
      });
      return { ...u, token: jwt.sign({ userId: u.id, roles: [role] }, process.env.JWT_SECRET) };
    }

    // API fetch wrapper
    async function api(method, route, user, body) {
      if (method === 'POST' && route.endsWith('/messages') && body) body = { requestKey: randomUUID(), ...body };
      const headers = { 'Content-Type': 'application/json' };
      if (user && user.token) headers['Authorization'] = `Bearer ${user.token}`;
      const res = await fetch(base + route, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    }

    // Seed psychologists:
    // 1. Verified & Active psychologist
    const userVerified = await createUser('Dr. Maria Perez', 'PSYCHOLOGIST_VERIFIED', 'ACTIVE');
    const psychVerified = await db.psychologistProfile.create({
      data: {
        userId: userVerified.id,
        status: 'VERIFICADO',
        consultationPrice: 500,
        academicBackground: 'Dra. en Psicología Clínica UNAM',
        specialties: {
          create: [{ specialtyId: specStress.id }, { specialtyId: specClinical.id }],
        },
        availabilities: {
          create: [{ dayOfWeek: 'MONDAY', startTime: '09:00', endTime: '14:00', slotDuration: 50, isActive: true }],
        },
      },
    });

    // 2. Unverified psychologist (applicant)
    const userApplicant = await createUser('Lic. Juan Perez', 'PSYCHOLOGIST_APPLICANT', 'ACTIVE');
    await db.psychologistProfile.create({
      data: {
        userId: userApplicant.id,
        status: 'PENDIENTE_REVISION',
        consultationPrice: 300,
        specialties: { create: [{ specialtyId: specStress.id }] },
      },
    });

    // 3. Inactive user psychologist
    const userInactive = await createUser('Dr. Carlos Inactivo', 'PSYCHOLOGIST_VERIFIED', 'INACTIVE');
    await db.psychologistProfile.create({
      data: {
        userId: userInactive.id,
        status: 'VERIFICADO',
        consultationPrice: 400,
        specialties: { create: [{ specialtyId: specStress.id }] },
      },
    });

    // Patients
    const patientA = await createUser('Paciente A', 'USER');
    const patientB = await createUser('Paciente B', 'USER');

    // TEST 1: Unauthenticated request rejected
    {
      const res = await api('POST', '/orientation/sessions', null, {});
      check('1. Unauthenticated request returns 401', res.status === 401);
    }

    // TEST 2: Request without consent returns 403
    {
      const res = await api('POST', '/orientation/sessions', patientA, {});
      check('2. Create session without consent returns 403', res.status === 403);
    }

    // TEST 3: Register consent
    {
      const resCheck = await api('GET', '/orientation/consent', patientA);
      check('3a. Initial consent status is false', resCheck.status === 200 && resCheck.data.data.hasConsent === false);

      const resConsent = await api('POST', '/orientation/consent', patientA, { version: resCheck.data.data.version, adultConfirmed: true });
      check('3b. Consent registration returns 201', resConsent.status === 201);

      const resCheck2 = await api('GET', '/orientation/consent', patientA);
      check('3c. Consent status now true', resCheck2.status === 200 && resCheck2.data.data.hasConsent === true);
    }

    // TEST 4: Create session successfully
    let sessionId;
    {
      const res = await api('POST', '/orientation/sessions', patientA, {});
      check('4. Create session returns 201 with initial assistant greeting', res.status === 201);
      sessionId = res.data.data.session.id;
      check('4b. Session has ID and 1 initial assistant message', sessionId && res.data.data.session.messages.length === 1);
    }

    // TEST 5: Another user cannot read this session (403)
    {
      const res = await api('GET', `/orientation/sessions/${sessionId}`, patientB);
      check('5. Cross-user session access returns 403', res.status === 403);
    }

    // TEST 6: Normal message exchange
    {
      const res = await api('POST', `/orientation/sessions/${sessionId}/messages`, patientA, {
        message: 'No puedo dormir bien y me siento bajo mucho estrés laboral',
      });
      check('6a. User sends normal message -> 200', res.status === 200);
      check('6b. Assistant responded with orientation', res.data.data.assistantMessage && res.data.data.assistantMessage.content.length > 0);
      check('6c. Risk level is LOW', res.data.data.riskLevel === 'LOW');
    }

    // TEST 7: Message too long (> 2000 chars) returns 400
    {
      const longMsg = 'x'.repeat(2500);
      const res = await api('POST', `/orientation/sessions/${sessionId}/messages`, patientA, { message: longMsg });
      check('7. Exceeding max message length returns 400', res.status === 400);
    }

    // TEST 8: Critical Crisis Escalation
    {
      // Create new session for crisis test
      const notice = await api('GET', '/orientation/consent', patientB);
      await api('POST', '/orientation/consent', patientB, { version: notice.data.data.version, adultConfirmed: true });
      const resSessB = await api('POST', '/orientation/sessions', patientB, {});
      const sessionBId = resSessB.data.data.session.id;

      const resCrisis = await api('POST', `/orientation/sessions/${sessionBId}/messages`, patientB, {
        message: 'Ya no aguanto más, me quiero suicidar y quitarme la vida',
      });

      check('8a. Crisis message returns 200 with safety escalation', resCrisis.status === 200);
      check('8b. Risk level is EMERGENCY', resCrisis.data.data.riskLevel === 'EMERGENCY');
      check('8c. Emergency crisis resources returned', Array.isArray(resCrisis.data.data.crisisResources) && resCrisis.data.data.crisisResources.length > 0);
      check('8d. Crisis phone number includes Línea de la Vida', resCrisis.data.data.crisisResources.some(r => r.name.includes('Línea de la Vida')));

      // Check session status in DB is ESCALATED
      const dbSession = await db.aIOrientationSession.findUnique({ where: { id: sessionBId } });
      check('8e. Session in DB is ESCALATED', dbSession.status === 'ESCALATED');
      check('8f. Escalated session cannot complete', (await api('POST', `/orientation/sessions/${sessionBId}/complete`, patientB, {})).status === 409);
      check('8g. Escalated session cannot recommend', (await api('GET', `/orientation/sessions/${sessionBId}/recommendations`, patientB)).status === 409);
      check('8h. Escalated session cannot resume ordinary messages', (await api('POST', `/orientation/sessions/${sessionBId}/messages`, patientB, { message: 'Hola' })).status === 409);
      const resumed = await api('POST', '/orientation/sessions', patientB, {});
      check('8i. Reopening retains escalation and resources', resumed.data.data.session.id === sessionBId && resumed.data.data.session.crisisResources.length > 0);
    }

    // TEST 9: Complete session and get recommendations
    {
      const resComplete = await api('POST', `/orientation/sessions/${sessionId}/complete`, patientA, {});
      check('9a. Complete session returns 200', resComplete.status === 200);
      check('9b. Suggested specialties resolved in DB', Array.isArray(resComplete.data.data.suggestedSpecialties) && resComplete.data.data.suggestedSpecialties.length > 0);

      const psychologists = resComplete.data.data.recommendedPsychologists;
      check('9c. Recommended psychologists returned', Array.isArray(psychologists) && psychologists.length > 0);

      // Verify unverified and inactive psychologists are NEVER recommended
      const hasVerified = psychologists.some(p => p.id === psychVerified.id);
      const hasUnverified = psychologists.some(p => p.name === 'Lic. Juan Perez');
      const hasInactive = psychologists.some(p => p.name === 'Dr. Carlos Inactivo');

      check('9d. Verified psychologist IS included', hasVerified);
      check('9e. Unverified applicant psychologist is NEVER included', !hasUnverified);
      check('9f. Inactive user psychologist is NEVER included', !hasInactive);
    }

    const { AIProviderFactory } = require('../src/ai/providers/aiProviderFactory');
    const { MockAIProvider } = require('../src/ai/providers/mockAIProvider');
    const fixture = await new MockAIProvider().generateOrientation({ history: [], userMessage: 'Hola', availableSpecialties: [] });
    for (const safety of [
      { riskLevel: 'HIGH', requiresImmediateHelp: false, flags: [] },
      { riskLevel: 'EMERGENCY', requiresImmediateHelp: true, flags: [] },
      { riskLevel: 'LOW', requiresImmediateHelp: true, flags: [] },
    ]) {
      AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => ({ ...fixture, safety }) });
      const session = await db.aIOrientationSession.create({ data: { userId: patientA.id } });
      const result = await api('POST', `/orientation/sessions/${session.id}/messages`, patientA, { message: 'Necesito orientación' });
      check(`model safety ${safety.riskLevel}/${safety.requiresImmediateHelp} escalates`, result.status === 200 && result.data.data.status === 'ESCALATED' && result.data.data.crisisResources.length > 0);
      check('model escalation cannot recommend', (await api('GET', `/orientation/sessions/${session.id}/recommendations`, patientA)).status === 409);
    }
    const quotaSession = await db.aIOrientationSession.create({ data: { userId: patientA.id,
      messages: { create: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'ASSISTANT' : 'USER', content: 'synthetic', createdAt: new Date(Date.now() - 1000 + i) })) } } });
    const quotaCrisis = await api('POST', `/orientation/sessions/${quotaSession.id}/messages`, patientA, { message: 'No quiero vivir' });
    check('safety takes precedence over message quota', quotaCrisis.status === 200 && quotaCrisis.data.data.status === 'ESCALATED');

    const raceSession = await db.aIOrientationSession.create({ data: { userId: patientA.id } });
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => {
      await db.aIOrientationSession.update({ where: { id: raceSession.id }, data: { status: 'ESCALATED', riskLevel: 'EMERGENCY' } });
      return fixture;
    } });
    const race = await api('POST', `/orientation/sessions/${raceSession.id}/messages`, patientA, { message: 'Hola' });
    check('in-flight ordinary result cannot overwrite escalation', race.status === 409 && (await db.aIOrientationSession.findUnique({ where: { id: raceSession.id } })).riskLevel === 'EMERGENCY');

    const stableSession = await db.aIOrientationSession.create({ data: { userId: patientA.id } });
    const { AppError } = require('../src/middlewares/errorMiddleware');
    const stableKey = randomUUID();
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => { throw new AppError('Synthetic unavailable', 503, 'AI_PROVIDER_BUSY', true); } });
    const failed = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Hola', requestKey: stableKey });
    check('provider code and retryability reach client', failed.status === 503 && failed.data.code === 'AI_PROVIDER_BUSY' && failed.data.retryable);
    check('failed attempt stores no conversation messages', await db.aIMessage.count({ where: { sessionId: stableSession.id } }) === 0);
    let providerCalls = 0;
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => { providerCalls++; return fixture; } });
    const success = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Hola', requestKey: stableKey });
    const replay = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Hola', requestKey: stableKey });
    check('retry succeeds once and counts one answered turn', success.status === 200 && success.data.data.quota.used === 1 && await db.aIMessage.count({ where: { sessionId: stableSession.id } }) === 2);
    check('lost response replay never invokes provider twice', replay.status === 200 && providerCalls === 1 && replay.data.data.userMessage.id === success.data.data.userMessage.id);
    const conflict = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Different content', requestKey: stableKey });
    check('same key different content conflicts', conflict.status === 409 && conflict.data.code === 'AI_IDEMPOTENCY_CONFLICT');
    check('receipt cannot be read by another user', (await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientB, { message: 'Hola', requestKey: stableKey })).status === 403);

    process.env.AI_MAX_MESSAGES_PER_SESSION = '1';
    const capped = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Otra pregunta' });
    check('configurable answered-turn limit enforced', capped.status === 409 && capped.data.code === 'AI_SESSION_LIMIT');
    process.env.AI_MAX_MESSAGES_PER_SESSION = '20';

    let release, notify;
    const entered = new Promise(r => { notify = r; });
    const gate = new Promise(r => { release = r; });
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => { notify(); await gate; return fixture; } });
    const parallelKey = randomUUID();
    const first = api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Concurrent', requestKey: parallelKey });
    await entered;
    try {
      const duplicate = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Concurrent', requestKey: parallelKey });
      const other = await api('POST', `/orientation/sessions/${stableSession.id}/messages`, patientA, { message: 'Another message' });
      check('parallel duplicate and different request are blocked', duplicate.data.code === 'AI_REQUEST_IN_PROGRESS' && other.data.code === 'AI_REQUEST_IN_PROGRESS');
      check('cannot complete during inference', (await api('POST', `/orientation/sessions/${stableSession.id}/complete`, patientA, {})).data.code === 'AI_REQUEST_IN_PROGRESS');
    } finally { release(); }
    check('first parallel request completes normally', (await first).status === 200);

    const recoverySession = await db.aIOrientationSession.create({ data: { userId: patientA.id } });
    const recoveryKey = randomUUID();
    await db.aIMessageRequest.create({ data: { sessionId: recoverySession.id, requestKey: recoveryKey,
      contentHash: require('node:crypto').createHash('sha256').update('Recover').digest('hex'),
      claimToken: randomUUID(), leaseUntil: new Date(Date.now() - 1000) } });
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => fixture });
    const recovered = await api('POST', `/orientation/sessions/${recoverySession.id}/messages`, patientA, { message: 'Recover', requestKey: recoveryKey });
    check('expired claim recovers after a process interruption', recovered.status === 200 && await db.aIMessage.count({ where: { sessionId: recoverySession.id } }) === 2);

    const fencedKey = randomUUID();
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => {
      await db.aIMessageRequest.update({ where: { sessionId_requestKey: { sessionId: recoverySession.id, requestKey: fencedKey } },
        data: { claimToken: randomUUID() } });
      return fixture;
    } });
    const fenced = await api('POST', `/orientation/sessions/${recoverySession.id}/messages`, patientA, { message: 'Obsolete worker', requestKey: fencedKey });
    check('superseded worker cannot persist another response', fenced.status === 409 && await db.aIMessage.count({ where: { sessionId: recoverySession.id } }) === 2);

    const newPatient = await createUser('Concurrent sessions', 'USER');
    const newNotice = await api('GET', '/orientation/consent', newPatient);
    await api('POST', '/orientation/consent', newPatient, { version: newNotice.data.data.version, adultConfirmed: true });
    const sessions = await Promise.all([api('POST', '/orientation/sessions', newPatient, {}), api('POST', '/orientation/sessions', newPatient, {})]);
    check('concurrent session creation returns the same session', sessions[0].status === 201 && sessions[1].status === 201 && sessions[0].data.data.session.id === sessions[1].data.data.session.id);

    const terminalSession = await db.aIOrientationSession.create({ data: { userId: patientA.id } });
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => ({ ...fixture, conversation: { ...fixture.conversation, isComplete: true } }) });
    const terminalKey = randomUUID();
    await api('POST', `/orientation/sessions/${terminalSession.id}/messages`, patientA, { message: 'Final', requestKey: terminalKey });
    const terminalReplay = await api('POST', `/orientation/sessions/${terminalSession.id}/messages`, patientA, { message: 'Final', requestKey: terminalKey });
    check('completed session replays successful receipt', terminalReplay.status === 200 && terminalReplay.data.data.status === 'COMPLETED');

    const unsafeSession = await db.aIOrientationSession.create({ data: { userId: patientA.id } });
    const unsafeKey = randomUUID();
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => ({
      ...fixture, assistantMessage: 'Texto aparentemente correcto.',
      needsProfile: { ...fixture.needsProfile, suggestedSpecialties: [{ name: 'Psicología Clínica', reason: 'Tienes depresión. Tienes depresión.' }] },
      conversation: { shouldContinue: false, isComplete: true, summary: 'El usuario tiene depresión.' },
    }) });
    const sanitized = await api('POST', `/orientation/sessions/${unsafeSession.id}/messages`, patientA, { message: 'Hola', requestKey: unsafeKey });
    const { AISafetyService } = require('../src/ai/services/aiSafetyService');
    check('unsafe summary/reason replaces whole reply and prevents automatic completion', sanitized.status === 200 && sanitized.data.data.assistantMessage.content === AISafetyService.SAFE_REPLY && sanitized.data.data.status === 'ACTIVE');
    const storedSafe = await db.aIOrientationSession.findUnique({ where: { id: unsafeSession.id } });
    check('unsafe generated profile is not persisted', storedSafe.summary === AISafetyService.SAFE_SUMMARY && storedSafe.needsProfile.suggestedSpecialties.length === 0);
    const replaySafe = await api('POST', `/orientation/sessions/${unsafeSession.id}/messages`, patientA, { message: 'Hola', requestKey: unsafeKey });
    check('safe replacement survives idempotent replay', replaySafe.data.data.assistantMessage.content === AISafetyService.SAFE_REPLY);

    const legacySession = await db.aIOrientationSession.create({ data: { userId: patientA.id, status: 'COMPLETED',
      summary: 'Tienes depresión.', needsProfile: { ...fixture.needsProfile, primaryConcern: 'Tienes depresión.' },
      messages: { create: [{ role: 'USER', content: 'Tienes depresión.' }, { role: 'ASSISTANT', content: 'Tienes depresión. Tienes depresión.' }] } } });
    const legacyRead = await api('GET', `/orientation/sessions/${legacySession.id}`, patientA);
    check('legacy assistant and summary are filtered without rewriting user text', legacyRead.data.data.session.summary === AISafetyService.SAFE_SUMMARY &&
      legacyRead.data.data.session.messages.find(m => m.role === 'ASSISTANT').content === AISafetyService.SAFE_REPLY &&
      legacyRead.data.data.session.messages.find(m => m.role === 'USER').content === 'Tienes depresión.');
    const legacyRecommendations = await api('GET', `/orientation/sessions/${legacySession.id}/recommendations`, patientA);
    check('recommendation endpoint never exposes legacy diagnostic summary', legacyRecommendations.status === 200 && legacyRecommendations.data.data.summary === AISafetyService.SAFE_SUMMARY);

    const contextualSession = await db.aIOrientationSession.create({ data: { userId: patientA.id,
      messages: { create: { role: 'USER', content: 'Quiero quitarme' } } } });
    let contextualProviderCalls = 0;
    AIProviderFactory.setProvider({ providerName: 'TEST', generateOrientation: async () => { contextualProviderCalls++; return fixture; } });
    const contextual = await api('POST', `/orientation/sessions/${contextualSession.id}/messages`, patientA, { message: 'la vida' });
    check('split risk expression escalates using prior user context before provider call', contextual.status === 200 && contextual.data.data.status === 'ESCALATED' && contextualProviderCalls === 0);

    const expired = await db.aIOrientationSession.create({ data: { userId: patientA.id,
      createdAt: new Date(Date.now() - 366 * 86400000), messages: { create: { role: 'USER', content: 'synthetic expired' } } } });
    await require('../src/ai/services/aiPrivacyService').purgeExpiredAIData();
    check('retention removes expired session and messages', !(await db.aIOrientationSession.findUnique({ where: { id: expired.id } })) && await db.aIMessage.count({ where: { sessionId: expired.id } }) === 0);
    const otherCount = await db.aIOrientationSession.count({ where: { userId: patientB.id } });
    const deleted = await api('DELETE', '/orientation/history', patientA);
    check('owner can remove all own AI history', deleted.status === 200 && await db.aIOrientationSession.count({ where: { userId: patientA.id } }) === 0);
    check('deletion leaves other users untouched', await db.aIOrientationSession.count({ where: { userId: patientB.id } }) === otherCount);
    check('deletion revokes consent', (await api('POST', '/orientation/sessions', patientA, {})).status === 403);
    check('legacy consent rejected', (await api('POST', '/orientation/consent', patientA, {})).status === 400);
    console.log(`\nALL ${checks} INTEGRATION CHECKS PASSED SUCCESSFULLY!`);
  } finally {
    if (server) await new Promise(r => server.close(r));
    if (db) await db.$disconnect();
    if (control) {
      await control.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE').catch(() => undefined);
      await control.$disconnect();
    }
    if (schemaFixture) {
      // Only remove the one fixture created by this run, not a directory tree.
      fs.unlinkSync(path.join(schemaFixture, 'schema.prisma'));
      fs.rmdirSync(schemaFixture);
    }
  }
}

main().catch(err => {
  console.error('INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
