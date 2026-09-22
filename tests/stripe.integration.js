// Real Express + isolated PostgreSQL schema; Stripe SDK transport is replaced in memory.
// No external payment requests, real credentials, or public tables are used.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

async function main() {
  const source = process.env.TEST_DATABASE_URL;
  if (!source || !['localhost', '127.0.0.1'].includes(new URL(source).hostname)) throw Error('Local TEST_DATABASE_URL required');
  const schema = 'mindease_stripe_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(source); url.searchParams.set('schema', schema);
  Object.assign(process.env, { DATABASE_URL: url.toString(), NODE_ENV: 'test', PAYMENT_PROVIDER: 'STRIPE',
    JWT_SECRET: randomUUID(), STRIPE_SECRET_KEY: 'sk_test_fake_local_only',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fake_local_only', STRIPE_WEBHOOK_SECRET: 'whsec_fake_local_only', PLATFORM_FEE_PERCENT: '15' });
  const control = new PrismaClient({ datasources: { db: { url: source } } });
  let db, server, checks = 0;
  const check = (name, value) => { assert.ok(value, name); console.log('PASS ' + name); checks++; };
  try {
    await control.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
    db = require('../src/config/db').default;
    const { stripeClient, StripePaymentGateway } = require('../src/services/stripeGateway');
    const stripe = stripeClient();
    const intents = new Map(), keys = new Map(), refunds = new Map();
    let creates = 0, refundCreates = 0;
    stripe.paymentIntents.create = async (params, opts) => {
      if (keys.has(opts.idempotencyKey)) return intents.get(keys.get(opts.idempotencyKey));
      creates++;
      const i = { ...params, id: 'pi_' + randomUUID(), object: 'payment_intent', livemode: false,
        amount_received: 0, status: 'requires_payment_method', client_secret: 'pi_fake_secret_local', latest_charge: null };
      intents.set(i.id, i); keys.set(opts.idempotencyKey, i.id); return i;
    };
    stripe.paymentIntents.retrieve = async id => { assert.ok(intents.has(id)); return intents.get(id); };
    stripe.paymentIntents.cancel = async id => { const i = intents.get(id); i.status = 'canceled'; return i; };
    stripe.refunds.list = async p => ({ data: [...refunds.values()].filter(r => r.payment_intent === p.payment_intent) });
    stripe.refunds.create = async p => { refundCreates++; const r = { ...p, id: 're_' + randomUUID(), status: 'pending', currency: 'mxn' }; refunds.set(r.id, r); return r; };
    stripe.refunds.retrieve = async id => { assert.ok(refunds.has(id)); return refunds.get(id); };
    const app = require('../src/app').default;
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    async function user(role) {
      const u = await db.user.create({ data: { name: role, email: randomUUID() + '@example.test', passwordHash: 'unused',
        userRoles: { create: { role: { connectOrCreate: { where: { name: role }, create: { name: role } } } } } } });
      return { ...u, token: jwt.sign({ userId: u.id, roles: [role] }, process.env.JWT_SECRET) };
    }
    const patient = await user('USER'), other = await user('USER'), doctor = await user('PSYCHOLOGIST_VERIFIED');
    const profile = await db.psychologistProfile.create({ data: { userId: doctor.id, status: 'VERIFICADO', consultationPrice: 600 } });
    const appointment = () => db.appointment.create({ data: { userId: patient.id, psychologistId: profile.id, price: 600,
      startAt: new Date(Date.now() + 3600000), endAt: new Date(Date.now() + 7200000), consultation: { create: {} } } });
    async function api(route, body, u = patient, method = 'POST') {
      const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + u.token }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json() };
    }
    async function webhook(type, object, id = 'evt_' + randomUUID(), valid = true) {
      const payload = JSON.stringify({ id, object: 'event', type, livemode: false, data: { object } });
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: valid ? process.env.STRIPE_WEBHOOK_SECRET : 'wrong' });
      return fetch(base + '/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
    }
    const a = await appointment(), body = { appointmentId: a.id, idempotencyKey: randomUUID() };
    check('public key only in config', (await api('/payments/config', null, patient, 'GET')).body.data.publishableKey.startsWith('pk_test_'));
    check('raw card endpoint disabled', (await api('/payments/checkout', {})).status === 409);
    check('client amount manipulation rejected', (await api('/payments/intent', { ...body, amount: 1 })).status === 400);
    const first = await api('/payments/intent', body);
    check('intent created for server price', first.status === 200 && first.body.data.payment.amount === 600 && creates === 1);
    await api('/payments/intent', body);
    check('same key reuses intent', creates === 1);
    check('foreign replay denied', (await api('/payments/intent', body, other)).status === 403);
    check('new key cannot duplicate active payment', (await api('/payments/intent', { ...body, idempotencyKey: randomUUID() })).status === 409);
    const attempt = await db.paymentAttempt.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
    const intent = intents.get(attempt.providerIntentId);
    check('invalid signature rejected', (await webhook('payment_intent.succeeded', intent, undefined, false)).status === 400);
    await webhook('payment_intent.payment_failed', intent);
    check('decline does not close reusable intent', (await db.paymentAttempt.findUnique({ where: { id: attempt.id } })).status === 'PROCESSING');
    intent.status = 'succeeded'; intent.amount_received = 60000;
    const evt = 'evt_' + randomUUID();
    check('signed webhook accepted', (await webhook('payment_intent.succeeded', intent, evt)).status === 200);
    await webhook('payment_intent.succeeded', intent, evt);
    check('event recorded once', await db.stripeWebhookEvent.count({ where: { id: evt } }) === 1);
    check('notifications emitted once', await db.notification.count({ where: { referenceId: a.id } }) === 2);
    check('payment does not confirm appointment', (await db.appointment.findUnique({ where: { id: a.id } })).status === 'PENDING');
    await webhook('payment_intent.payment_failed', intent);
    check('out of order failure cannot undo success', (await db.payment.findUnique({ where: { appointmentId: a.id } })).status === 'SUCCEEDED');
    await db.appointment.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
    const { maintainFinance } = require('../src/services/financeMaintenance');
    await maintainFinance();
    check('pending refund not shown completed', (await db.payment.findUnique({ where: { appointmentId: a.id } })).status === 'REFUND_PENDING');
    await maintainFinance(); check('refund reused while pending', refundCreates === 1);
    const refund = [...refunds.values()][0]; refund.status = 'succeeded';
    await webhook('refund.updated', refund);
    check('confirmed refund recorded', (await db.payment.findUnique({ where: { appointmentId: a.id } })).status === 'REFUNDED');
    const b = await appointment(), bBody = { appointmentId: b.id, idempotencyKey: randomUUID() };
    await api('/payments/intent', bBody);
    const bAttempt = await db.paymentAttempt.findUnique({ where: { idempotencyKey: bBody.idempotencyKey } });
    await db.paymentAttempt.update({ where: { id: bAttempt.id }, data: { createdAt: new Date(Date.now() - 2 * 60000) } });
    await require('../src/services/paymentWorkflow').recoverPayments();
    check('Stripe not failed by mock one minute timeout', (await db.paymentAttempt.findUnique({ where: { id: bAttempt.id } })).status === 'PROCESSING');
    intents.get(bAttempt.providerIntentId).amount = 1;
    await assert.rejects(new StripePaymentGateway().lookupCharge(bBody.idempotencyKey)); checks++;
    intents.get(bAttempt.providerIntentId).amount = 60000;
    await db.paymentAttempt.update({ where: { id: bAttempt.id }, data: { createdAt: new Date(Date.now() - 16 * 60000) } });
    await require('../src/services/paymentWorkflow').recoverPayments();
    check('expired intent canceled at provider before marking failed', intents.get(bAttempt.providerIntentId).status === 'canceled' && (await db.paymentAttempt.findUnique({ where: { id: bAttempt.id } })).status === 'FAILED');
    check('payouts blocked until Connect', (await api('/psychologists/me/payouts', {}, doctor)).status === 503);
    const race = await appointment(), raceBody = { appointmentId: race.id, idempotencyKey: randomUUID() };
    await api('/payments/intent', raceBody);
    const raceAttempt = await db.paymentAttempt.findUnique({ where: { idempotencyKey: raceBody.idempotencyKey } });
    const raceIntent = intents.get(raceAttempt.providerIntentId);
    raceIntent.status = 'succeeded'; raceIntent.amount_received = 60000;
    raceIntent.latest_charge = { refunded: true, amount_refunded: 60000 };
    await webhook('payment_intent.succeeded', raceIntent);
    check('refund preceding payment event cannot credit earnings', (await db.payment.findUnique({ where: { appointmentId: race.id } })).status === 'REFUND_PENDING');
    process.env.STRIPE_SECRET_KEY = 'sk_live_not_allowed';
    check('live key blocked', (await api('/payments/config', null, patient, 'GET')).status === 503);
    console.log('STRIPE: ' + checks + ' checks passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.$disconnect();
    if (!/^mindease_stripe_test_[a-f0-9]{32}$/.test(schema)) throw Error('Unsafe cleanup target');
    await control.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await control.$disconnect();
  }
}
main().catch(() => { console.error('Stripe integration test failed; inspect assertions with a debugger.'); process.exitCode = 1; });
