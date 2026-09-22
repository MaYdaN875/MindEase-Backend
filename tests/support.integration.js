// Support & moderation integration tests (not Phase 6 Communication).
// Runs in an isolated PostgreSQL schema.
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

  const schema = 'mindease_support_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(source);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = randomUUID();
  process.env.NODE_ENV = 'test';

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
    const roles = ['USER', 'PSYCHOLOGIST_VERIFIED', 'SUPPORT', 'MODERATOR', 'ADMIN'];
    for (const name of roles) {
      await db.role.create({ data: { name } });
    }

    // Start Express app
    const app = require('../src/app').default;
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/support';

    // Helper: Create user with role and token
    async function createUser(name, role) {
      const u = await db.user.create({
        data: {
          name,
          email: `${name}-${randomUUID().slice(0, 6)}@example.test`,
          passwordHash: 'test-hash',
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
        ...(body && { body: JSON.stringify(body) }),
      });
      const data = await res.json();
      return { status: res.status, body: data };
    }

    // Create actors
    const patient1 = await createUser('patient1', 'USER');
    const patient2 = await createUser('patient2', 'USER');
    const psychologist = await createUser('psychologist', 'PSYCHOLOGIST_VERIFIED');
    const supportAgent = await createUser('supportAgent', 'SUPPORT');
    const admin = await createUser('admin', 'ADMIN');

    console.log('--- BLOCK 6.2: User Support Tickets Lifecycle ---');

    // Test 1: User creates ticket
    const ticketRes = await api('POST', '/tickets', patient1, {
      subject: 'Problema con cobro de cita duplicado',
      category: 'PAYMENT',
      priority: 'HIGH',
      content: 'Buenas tardes, noto un cobro duplicado en mi tarjeta tras agendar una cita.',
      attachments: [],
    });
    check('user can create support ticket (201)', ticketRes.status === 201 && ticketRes.body.data.ticket.subject.includes('cobro'));
    const ticket1 = ticketRes.body.data.ticket;
    check('initial ticket status is OPEN and source is USER', ticket1.status === 'OPEN' && ticket1.source === 'USER');
    check('ticket has sequential ticketNumber', typeof ticket1.ticketNumber === 'number');
    check('first message created with the ticket', ticket1.messages.length === 1);

    // Test 2: User queries their tickets
    const myTickets = await api('GET', '/tickets', patient1);
    check('patient1 gets their tickets list (1 item)', myTickets.status === 200 && myTickets.body.data.items.length === 1);

    const otherTickets = await api('GET', '/tickets', patient2);
    check('patient2 sees 0 tickets (strict ownership isolation)', otherTickets.body.data.items.length === 0);

    // Test 3: Unauthorized user access to ticket detail blocked
    const failDetail = await api('GET', `/tickets/${ticket1.id}`, patient2);
    check('foreign user cannot view ticket detail (403)', failDetail.status === 403);

    const ownerDetail = await api('GET', `/tickets/${ticket1.id}`, patient1);
    check('owner can view ticket detail (200)', ownerDetail.status === 200 && ownerDetail.body.data.ticket.id === ticket1.id);

    // Test 4: User adds a message
    const msgRes = await api('POST', `/tickets/${ticket1.id}/messages`, patient1, {
      content: 'Adjunto también el extracto de cuenta bancario.',
    });
    check('owner can add reply message (201)', msgRes.status === 201);

    console.log('--- BLOCK 6.3: Support Agent Console, Assignment & Internal Notes ---');

    // Test 5: Normal user blocked from agent console (403)
    const failAgent = await api('GET', '/agent/tickets', patient1);
    check('patient blocked from agent console (403)', failAgent.status === 403);

    // Test 6: Support agent can list all tickets
    const agentTickets = await api('GET', '/agent/tickets', supportAgent);
    check('support agent can list tickets (200)', agentTickets.status === 200 && agentTickets.body.data.items.length === 1);

    // Test 7: Agent assigns ticket to themselves
    const assignRes = await api('PUT', `/agent/tickets/${ticket1.id}/assign`, supportAgent, {
      agentId: 'me',
    });
    check('support agent assigns ticket (status transitions OPEN -> IN_PROGRESS)', assignRes.status === 200 && assignRes.body.data.ticket.status === 'IN_PROGRESS' && assignRes.body.data.ticket.assignedTo.id === supportAgent.id);

    // Test 8: Agent adds internal note (isInternalNote: true)
    const noteRes = await api('POST', `/agent/tickets/${ticket1.id}/messages`, supportAgent, {
      content: 'Verificando con pasarela de pagos. Parece un hold temporal de preautorización.',
      isInternalNote: true,
    });
    check('agent can add internal note (201)', noteRes.status === 201 && noteRes.body.data.message.isInternalNote === true);

    // Verify isolation: Patient DOES NOT see the internal note
    const patientViewAfterNote = await api('GET', `/tickets/${ticket1.id}`, patient1);
    const hasInternalNoteForPatient = patientViewAfterNote.body.data.ticket.messages.some(m => m.isInternalNote === true);
    check('internal note is completely hidden from the patient', hasInternalNoteForPatient === false);

    // Verify agent DOES see the internal note
    const agentViewAfterNote = await api('GET', `/tickets/${ticket1.id}`, supportAgent);
    const hasInternalNoteForAgent = agentViewAfterNote.body.data.ticket.messages.some(m => m.isInternalNote === true);
    check('internal note is visible to support staff', hasInternalNoteForAgent === true);

    // Test 9: Agent sends public response (transitions status to WAITING_USER and records firstResponseAt)
    const pubReply = await api('POST', `/agent/tickets/${ticket1.id}/messages`, supportAgent, {
      content: 'Hola, hemos revisado tu estado de cuenta. La segunda retención expirará en 24 horas.',
      isInternalNote: false,
    });
    check('agent public reply sent (201)', pubReply.status === 201);
    check('ticket status transitioned to WAITING_USER', pubReply.body.data.ticketStatus === 'WAITING_USER');

    const detailWithSLA = await api('GET', `/tickets/${ticket1.id}`, supportAgent);
    check('firstResponseAt timestamp was registered for SLA', detailWithSLA.body.data.ticket.firstResponseAt != null);

    // Test 10: Automatic transition when user responds in WAITING_USER
    const userFollowUp = await api('POST', `/tickets/${ticket1.id}/messages`, patient1, {
      content: 'Muchas gracias por la aclaración, esperaré las 24 horas.',
    });
    check('user follow-up transitions status back to IN_PROGRESS', userFollowUp.body.data.ticketStatus === 'IN_PROGRESS');

    // Test 11: Agent updates status to RESOLVED
    const resolveRes = await api('PUT', `/agent/tickets/${ticket1.id}/status`, supportAgent, {
      status: 'RESOLVED',
    });
    check('agent resolves ticket (status RESOLVED)', resolveRes.status === 200 && resolveRes.body.data.ticket.status === 'RESOLVED' && resolveRes.body.data.ticket.resolvedAt != null);

    // Test 12: User closes ticket
    const closeRes = await api('PUT', `/tickets/${ticket1.id}/close`, patient1);
    check('user can close ticket (status CLOSED)', closeRes.status === 200 && closeRes.body.data.ticket.status === 'CLOSED');

    // Test 13: Replying to closed ticket is blocked
    const failReplyClosed = await api('POST', `/tickets/${ticket1.id}/messages`, patient1, {
      content: 'Quiero seguir comentando aquí',
    });
    check('sending message to CLOSED ticket is blocked (400)', failReplyClosed.status === 400);

    // Test 14: Support metrics endpoint
    const metricsRes = await api('GET', '/agent/metrics', supportAgent);
    check('support metrics return counts and avgFirstResponseMinutes', metricsRes.status === 200 && metricsRes.body.data.totalTickets === 1 && metricsRes.body.data.closedCount === 1 && typeof metricsRes.body.data.avgFirstResponseMinutes === 'number');

    console.log('--- BLOCK 6.4: Interpersonal Conduct Reports & Escalation ---');

    // Test 15: Patient reports psychologist for unprofessional conduct
    const reportRes = await api('POST', '/user-reports', patient1, {
      reportedUserId: psychologist.id,
      reason: 'UNPROFESSIONAL_CONDUCT',
      description: 'El profesional canceló la sesión 5 minutos antes sin justificación previa.',
    });
    check('user can report another user conduct (201)', reportRes.status === 201 && reportRes.body.data.report.status === 'PENDING');
    const userReportId = reportRes.body.data.report.id;

    // Test 16: Reporting self is blocked (400)
    const failSelfReport = await api('POST', '/user-reports', patient1, {
      reportedUserId: patient1.id,
      reason: 'OTHER',
      description: 'Reportándome a mí mismo',
    });
    check('reporting oneself is blocked (400)', failSelfReport.status === 400);

    // Test 17: Duplicate pending report blocked (400)
    const failDupReport = await api('POST', '/user-reports', patient1, {
      reportedUserId: psychologist.id,
      reason: 'HARASSMENT',
      description: 'Segundo reporte simultáneo',
    });
    check('duplicate pending report for same user is blocked (400)', failDupReport.status === 400);

    // Test 18: Staff lists user reports
    const reportsList = await api('GET', '/user-reports', supportAgent);
    check('staff can list user reports (200)', reportsList.status === 200 && reportsList.body.data.items.length === 1);

    // Test 19: Staff investigates and escalates report to a SupportTicket
    const escalateRes = await api('PUT', `/user-reports/${userReportId}/investigate`, supportAgent, {
      status: 'INVESTIGATING',
      moderatorNotes: 'Se abre investigación formal con el profesional.',
      escalateToTicket: true,
    });
    check('staff can escalate report to a SupportTicket (200)', escalateRes.status === 200 && escalateRes.body.data.ticket != null && escalateRes.body.data.ticket.source === 'USER_REPORT' && escalateRes.body.data.ticket.category === 'REPORT');

    console.log(`\n========================================`);
    checks += await require('./media.checks')({ base, db, owner: patient2, stranger: patient1, agent: supportAgent });
    console.log(`SUPPORT MODULE: All ${checks} checks passed successfully!`);
    console.log(`========================================\n`);

  } finally {
    if (server) await new Promise(r => server.close(r));
    if (db) await db.$disconnect();
    // Drop test schema
    await control.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await control.$disconnect();
  }
}

main().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
