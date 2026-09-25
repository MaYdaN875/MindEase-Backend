const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
require('dotenv').config();

async function main() {
  const source = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const url = new URL(source);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Only local test databases allowed');
  const schema = 'mindease_chat_test_' + randomUUID().replaceAll('-', '');
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = randomUUID();
  process.env.NODE_ENV = 'test';
  const control = new PrismaClient({ datasources: { db: { url: source } } });
  let db, server, checks = 0;
  function check(name, ok) { assert.ok(ok, name); checks++; console.log('PASS ' + name); }
  try {
    await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    // db push is scoped ONLY to the newly created disposable schema.
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
    db = require('../src/config/db').default;
    // Validate the actual additive SQL against existing tables in this empty,
    // disposable test schema, not just Prisma's generated schema.
    await db.$executeRawUnsafe('DROP TABLE "PrivateMessage"');
    const migration = readFileSync(path.join(__dirname, '../prisma/migrations/20260924000000_private_chat/migration.sql'), 'utf8');
    for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(sql);
    check('additive migration applies', await db.privateMessage.count() === 0);
    const app = require('../src/app').default;
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/chats`;
    async function user(name, role = 'USER') {
      const r = await db.role.upsert({ where: { name: role }, create: { name: role }, update: {} });
      const u = await db.user.create({ data: { email: `${name}@example.test`, name, passwordHash: 'unused', status: 'ACTIVE', userRoles: { create: { roleId: r.id } } } });
      return { ...u, token: jwt.sign({ userId: u.id, roles: [role] }, process.env.JWT_SECRET) };
    }
    const p = await user('patient'), d = await user('doctor', 'PSYCHOLOGIST_VERIFIED'), other = await user('stranger'), admin = await user('admin', 'ADMIN');
    const profile = await db.psychologistProfile.create({ data: { userId: d.id, status: 'VERIFICADO' } });
    const a = await db.appointment.create({ data: { userId: p.id, psychologistId: profile.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), price: 0, status: 'CONFIRMED', consultation: { create: { clinicalNotes: 'CLINICAL_SECRET' } } } });
    async function api(u, path, body) {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(u ? { Authorization: 'Bearer ' + u.token } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, ...(await res.json()) };
    }
    // Preserve HTTP status separately from the JSON status field.
    async function call(u, path, body) {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(u ? { Authorization: 'Bearer ' + u.token } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { code: res.status, json: await res.json() };
    }
    check('anonymous rejected', (await call(null, '')).code === 401);
    for (const u of [other, admin]) {
      check(`${u.name} cannot read`, (await call(u, `/${a.id}/messages`)).code === 404);
      check(`${u.name} cannot send`, (await call(u, `/${a.id}/messages`, { clientId: randomUUID(), content: 'forbidden' })).code === 404);
    }
    const input = { clientId: randomUUID(), content: 'Private hello' };
    const first = await call(p, `/${a.id}/messages`, input);
    check('patient sends', first.code === 200);
    const again = await call(p, `/${a.id}/messages`, input);
    check('retry idempotent', again.json.data.message.id === first.json.data.message.id && await db.privateMessage.count() === 1);
    check('nonce cannot change content', (await call(p, `/${a.id}/messages`, { ...input, content: 'changed' })).code === 409);
    check('blank rejected', (await call(p, `/${a.id}/messages`, { clientId: randomUUID(), content: '  ' })).code === 400);
    check('long rejected', (await call(p, `/${a.id}/messages`, { clientId: randomUUID(), content: 'x'.repeat(4001) })).code === 400);
    const inbox = await api(d, '');
    check('unread count', inbox.data.chats[0].unreadCount === 1);
    check('no clinical notes in chat', !JSON.stringify(await api(d, `/${a.id}/messages`)).includes('CLINICAL_SECRET'));
    const notification = await db.notification.findFirst({ where: { type: 'PRIVATE_MESSAGE' } });
    check('notification has no text', !notification.content.includes(input.content));
    await call(d, `/${a.id}/read`, { through: first.json.data.message.sequence });
    check('read receipt recorded', (await db.privateMessage.findFirst()).readAt !== null);
    check('unread reset', (await api(d, '')).data.chats[0].unreadCount === 0);
    check('unknown watermark rejected', (await call(d, `/${a.id}/read`, { through: 999999 })).code === 404);
    await db.privateMessage.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ appointmentId: a.id, senderId: p.id, clientId: randomUUID(), content: `Fixture ${i}` })) });
    const latest = (await api(d, `/${a.id}/messages`)).data;
    const older = (await api(d, `/${a.id}/messages?before=${latest.nextBefore}`)).data;
    check('pagination without duplicates', latest.messages.length === 50 && older.messages.length === 11 && older.messages.at(-1).sequence < latest.messages[0].sequence);
    check('rate limit', (await call(p, `/${a.id}/messages`, { clientId: randomUUID(), content: 'rate limited' })).code === 429);
    await db.appointment.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
    check('cancelled history readable', (await call(d, `/${a.id}/messages`)).code === 200);
    check('cancelled cannot send', (await call(d, `/${a.id}/messages`, { clientId: randomUUID(), content: 'blocked' })).code === 409);
    await db.appointment.update({ where: { id: a.id }, data: { status: 'COMPLETED', endAt: new Date(Date.now() - 8 * 86400000) } });
    check('expired followup read only', (await api(d, `/${a.id}/messages`)).data.canSend === false);
    await db.appointment.update({ where: { id: a.id }, data: { status: 'CONFIRMED', endAt: new Date(), price: 100 } });
    check('unpaid cannot send', (await call(d, `/${a.id}/messages`, { clientId: randomUUID(), content: 'blocked' })).code === 409);
    check('unpaid shown read only', (await api(d, `/${a.id}/messages`)).data.canSend === false);
    const second = await db.appointment.create({ data: { userId: p.id, psychologistId: profile.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), price: 0, status: 'CONFIRMED' } });
    const concurrentInput = { clientId: randomUUID(), content: 'Concurrent retry' };
    const concurrent = await Promise.all([call(d, `/${second.id}/messages`, concurrentInput), call(d, `/${second.id}/messages`, concurrentInput)]);
    check('concurrent retry accepted once', concurrent.every(r => r.code === 200) && await db.privateMessage.count({ where: { appointmentId: second.id } }) === 1);
    await db.psychologistProfile.update({ where: { id: profile.id }, data: { status: 'SUSPENDIDO' } });
    check('professional suspension blocks sending', (await call(d, `/${second.id}/messages`, { clientId: randomUUID(), content: 'blocked' })).code === 409);
    const pending = await db.appointment.create({ data: { userId: p.id, psychologistId: profile.id, startAt: new Date(), endAt: new Date(), price: 0, status: 'PENDING' } });
    check('pending reservation cannot open chat', (await call(p, `/${pending.id}/messages`)).code === 409);
    check('foreign message cannot mark read', (await call(p, `/${second.id}/read`, { through: first.json.data.message.sequence })).code === 404);
    await db.user.update({ where: { id: p.id }, data: { status: 'SUSPENDED' } });
    check('suspended cannot read', (await call(p, `/${a.id}/messages`)).code === 403);
    console.log(`ALL ${checks} CHAT CHECKS PASSED`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.$disconnect();
    if (!/^mindease_chat_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe cleanup target');
    await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await control.$disconnect();
  }
}
main().catch(error => { console.error('Chat checks failed:', error.code || error.name, error instanceof assert.AssertionError ? error.message : 'Check local test database/configuration. No production schema was modified.'); process.exitCode = 1; });
