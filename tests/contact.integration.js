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
  const schema = 'mindease_contact_test_' + randomUUID().replaceAll('-', '');
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
    const base = `http://127.0.0.1:${server.address().port}/api/conversations`;
    async function user(name, role = 'USER') {
      const r = await db.role.upsert({ where: { name: role }, create: { name: role }, update: {} });
      const u = await db.user.create({ data: { email: `${name}@example.test`, name, passwordHash: 'unused', status: 'ACTIVE', userRoles: { create: { roleId: r.id } } } });
      return { ...u, token: jwt.sign({ userId: u.id, roles: [role] }, process.env.JWT_SECRET) };
    }
    const p = await user('patient'), d = await user('doctor', 'PSYCHOLOGIST_VERIFIED'), other = await user('stranger'), admin = await user('admin', 'ADMIN');
    const profile = await db.psychologistProfile.create({ data: { userId: d.id, status: 'VERIFICADO' } });
    const a = await db.appointment.create({ data: { userId: p.id, psychologistId: profile.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), price: 0, status: 'CONFIRMED', consultation: { create: { clinicalNotes: 'CLINICAL_SECRET' } } } });
    await db.$executeRawUnsafe('INSERT INTO "PrivateMessage" ("id","appointmentId","senderId","clientId","content") VALUES ($1,$2,$3,$4,$5)', randomUUID(), a.id, p.id, randomUUID(), 'LEGACY SESSION');
    await db.$executeRawUnsafe('DROP TABLE "Conversation"');
    const contactMigration = readFileSync(path.join(__dirname, '../prisma/migrations/20260925000000_contact_conversations/migration.sql'), 'utf8');
    for (const sql of contactMigration.split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(sql);
    check('migration preserves legacy session messages', (await db.privateMessage.findFirst()).content === 'LEGACY SESSION');
    check('legacy context remains appointment only', (await db.privateMessage.findFirst()).conversationId === null);
    async function api(u, path, body) {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(u ? { Authorization: 'Bearer ' + u.token } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, ...(await res.json()) };
    }
    // Preserve HTTP status separately from the JSON status field.
    async function call(u, path, body) {
      const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(u ? { Authorization: 'Bearer ' + u.token } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { code: res.status, json: await res.json() };
    }

    const endpoint = '/pre-booking/' + profile.id;
    check('anonymous cannot create', (await call(null, endpoint, {})).code === 401);
    check('self contact forbidden', (await call(d, endpoint, {})).code === 404);
    const initialCount = await db.appointment.count();
    const pair = await Promise.all([call(p, endpoint, {}), call(p, endpoint, {})]);
    check('concurrent open returns same conversation', pair.every(x => x.code === 200) && pair[0].json.data.conversationId === pair[1].json.data.conversationId);
    const c = pair[0].json.data.conversationId;
    check('creation does not book', await db.appointment.count() === initialCount);
    check('type explicit', pair[0].json.data.type === 'PRE_BOOKING');
    for (const u of [other, admin]) {
      check(u.name + ' cannot read contact', (await call(u, '/' + c + '/messages')).code === 404);
      check(u.name + ' cannot block contact', (await call(u, '/' + c + '/block', { blocked: true })).code === 404);
    }
    const message = { clientId: randomUUID(), content: '¿Ofreces sesiones en línea?' };
    const sent = await call(p, '/' + c + '/messages', message);
    check('send without payment or booking', sent.code === 200);
    const duplicate = await call(p, '/' + c + '/messages', message);
    check('message retry safe', duplicate.json.data.message.id === sent.json.data.message.id);
    check('nonce conflict blocked', (await call(p, '/' + c + '/messages', {...message, content: 'Different'})).code === 409);
    check('no attachments accepted', (await call(p, '/' + c + '/messages', {...message, file: 'bad'})).code === 400);
    const list = (await call(d, '')).json.data.chats;
    check('professional inbox unread', list[0].unreadCount === 1 && list[0].peerName === p.name);
    check('generic notification', (await db.notification.findFirst({where:{type:'PRE_BOOKING_MESSAGE'}})).content.indexOf(message.content) === -1);
    check('read marker', (await call(d, '/' + c + '/read', { through: sent.json.data.message.sequence })).code === 200);
    check('receipt persisted', (await call(p, '/' + c + '/messages')).json.data.messages[0].readAt !== null);
    await db.privateMessage.create({data:{appointmentId:a.id,senderId:p.id,clientId:randomUUID(),content:'SESSION ONLY'}});
    check('session messages isolated', !(await call(p, '/' + c + '/messages')).json.data.messages.some(m=>m.content==='SESSION ONLY'));
    const sessionResponse = await fetch(base.replace('/api/conversations','/api/chats') + '/' + a.id + '/messages',{headers:{Authorization:'Bearer '+p.token}});
    check('contact messages absent from session', !(await sessionResponse.json()).data.messages.some(m=>m.content===message.content));
    await call(d, '/' + c + '/block', {blocked:true});
    check('block stops patient', (await call(p, '/' + c + '/messages', {clientId:randomUUID(),content:'blocked'})).code === 409);
    check('block stops professional', (await call(d, '/' + c + '/messages', {clientId:randomUUID(),content:'blocked'})).code === 409);
    check('blocked history preserved', (await call(p, '/' + c + '/messages')).json.data.messages.length === 1);
    await call(p, '/' + c + '/block', {blocked:false});
    check('cannot undo other participant block', (await call(p, '/' + c + '/messages')).json.data.canSend === false);
    check('reopening does not bypass block', (await call(p, endpoint, {})).json.data.canSend === false);
    await call(d, '/' + c + '/block', {blocked:false});
    check('unblock restores sending', (await call(p, '/' + c + '/messages')).json.data.canSend === true);
    check('can report even without booking', (await call(p, '/' + c + '/report', {description:'Mensajes inapropiados en este contacto.'})).code === 200);
    check('report recipient authoritative', (await db.userReport.findFirst()).reportedUserId === d.id);
    check('stranger cannot report contact', (await call(other, '/' + c + '/report', {description:'Mensaje inapropiado'})).code === 404);
    await db.appointment.update({where:{id:a.id},data:{status:'COMPLETED'}});
    const closed = await fetch(base.replace('/api/conversations','/api/chats') + '/' + a.id + '/messages',{headers:{Authorization:'Bearer '+p.token}});
    check('session completed immediately read only', (await closed.json()).data.canSend === false);
    check('session completion does not close contact', (await call(p, '/' + c + '/messages')).json.data.canSend === true);
    await db.psychologistProfile.update({where:{id:profile.id},data:{status:'SUSPENDIDO'}});
    check('suspended professional cannot receive messages', (await call(p, '/' + c + '/messages')).json.data.canSend === false);
    check('suspended professional cannot be opened anew', (await call(other, endpoint, {})).code === 404);
    check('suspended profile history still readable', (await call(p, '/' + c + '/messages')).code === 200);
    await db.user.update({where:{id:p.id},data:{status:'SUSPENDED'}});
    check('suspended account cannot read', (await call(p, '/' + c + '/messages')).code === 403);
    console.log(`ALL ${checks} CONTACT CHECKS PASSED`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.$disconnect();
    if (!/^mindease_contact_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe cleanup target');
    await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await control.$disconnect();
  }
}
main().catch(error => { console.error('Contact checks failed:', error.code || error.name, error instanceof assert.AssertionError ? error.message : 'Check local test database/configuration. No production schema was modified.'); process.exitCode = 1; });
