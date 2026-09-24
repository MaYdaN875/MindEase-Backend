// AI Orientation Module Integration Tests
// Runs in an isolated PostgreSQL schema
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
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

  const control = new PrismaClient({ datasources: { db: { url: source } } });
  let db, server, checks = 0;
  const check = (name, condition) => {
    assert.ok(condition, name);
    console.log('PASS: ' + name);
    checks++;
  };

  try {
    // 1. Setup isolated database schema
    await control.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    execFileSync(process.execPath, [
      require.resolve('prisma/build/index.js'),
      'db',
      'push',
      '--skip-generate',
      '--schema',
      path.join(__dirname, '../prisma/schema.prisma')
    ], { env: process.env, stdio: 'pipe' });

    db = require('../src/config/db').default;

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

      const resConsent = await api('POST', '/orientation/consent', patientA);
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
      await api('POST', '/orientation/consent', patientB);
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

    console.log(`\nALL ${checks} INTEGRATION CHECKS PASSED SUCCESSFULLY!`);
  } finally {
    if (server) await new Promise(r => server.close(r));
    if (control) {
      await control.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE').catch(() => undefined);
      await control.$disconnect();
    }
  }
}

main().catch(err => {
  console.error('INTEGRATION TEST FAILED:', err);
  process.exit(1);
});
