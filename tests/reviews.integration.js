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
  const schema = 'mindease_review_test_' + randomUUID().replaceAll('-', '');
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
    await db.$executeRawUnsafe('DROP TABLE "PatientReview"');
    await db.$executeRawUnsafe('DROP TYPE "PatientReviewStatus"');
    const migration = readFileSync(path.join(__dirname, '../prisma/migrations/20260924010000_patient_reviews/migration.sql'), 'utf8');
    for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(sql);
    check('additive migration applies', await db.patientReview.count() === 0);
    const app = require('../src/app').default;
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/reviews`;
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

    const endpoint = '/appointments/' + a.id;
    const reviewInput = { rating: 4, comment: 'Atención respetuosa.' };
    check('anonymous rejected', (await call(null, endpoint, reviewInput)).code === 401);
    check('unfinished cannot review', (await call(p, endpoint, reviewInput)).code === 409);
    await db.appointment.update({ where: { id: a.id }, data: { status: 'COMPLETED' } });
    check('clinical completion required', (await call(p, endpoint, reviewInput)).code === 409);
    await db.consultation.update({ where: { appointmentId: a.id }, data: { status: 'COMPLETED', endedAt: new Date() } });
    for (const u of [other, d, admin]) {
      check(u.name + ' cannot submit', (await call(u, endpoint, reviewInput)).code === 404);
      check(u.name + ' cannot read private review', (await call(u, endpoint)).code === 404);
    }
    for (const rating of [0, 6, 2.5, '5']) check('invalid rating ' + rating, (await call(p, endpoint, {rating})).code === 400);
    check('long comment blocked', (await call(p, endpoint, {rating: 3, comment: 'a'.repeat(1001)})).code === 400);
    const concurrent = await Promise.all([call(p, endpoint, reviewInput), call(p, endpoint, reviewInput)]);
    check('concurrent retry creates one review', concurrent.every(r => r.code === 200) && await db.patientReview.count() === 1);
    const reviewId = concurrent[0].json.data.review.id;
    check('pending moderation', concurrent[0].json.data.review.status === 'PENDING');
    check('changed duplicate blocked', (await call(p, endpoint, { rating: 5 })).code === 409);
    check('owner sees saved review', (await call(p, endpoint)).json.data.canReview === false);
    const publicPath = '/psychologists/' + profile.id;
    let published = (await call(null, publicPath)).json.data;
    check('rating counted but text private', published.rating === 4 && published.reviewsCount === 1 && published.reviews.length === 0);
    check('patient cannot moderate', (await call(p, '/moderation/' + reviewId, { status: 'APPROVED', reason: 'Adecuada' })).code === 403);
    check('professional cannot moderate', (await call(d, '/moderation')).code === 403);
    check('admin sees pending text', (await call(admin, '/moderation')).json.data.reviews[0].comment === reviewInput.comment);
    check('reason required', (await call(admin, '/moderation/' + reviewId, { status: 'APPROVED' })).code === 400);
    check('admin approves', (await call(admin, '/moderation/' + reviewId, { status: 'APPROVED', reason: 'Sin datos sensibles' })).code === 200);
    published = (await call(null, publicPath)).json.data;
    check('approved public text', published.reviews[0].comment === reviewInput.comment);
    check('public identity protected', Object.keys(published.reviews[0]).sort().join(',') === 'comment,id,rating');
    check('no clinical notes or patient identity', !JSON.stringify(published).includes('CLINICAL_SECRET') && !JSON.stringify(published).includes(p.id));
    await call(admin, '/moderation/' + reviewId, { status: 'REJECTED', reason: 'Retirado por datos personales' });
    published = (await call(null, publicPath)).json.data;
    check('withdrawal preserves unbiased aggregate', published.reviews.length === 0 && published.rating === 4);
    await db.psychologistProfile.update({ where: { id: profile.id }, data: { status: 'SUSPENDIDO' } });
    check('ineligible profile hidden', (await call(null, publicPath)).code === 404);
    await db.user.update({ where: { id: p.id }, data: { status: 'SUSPENDED' } });
    check('suspended patient blocked', (await call(p, endpoint)).code === 403);
    console.log(`ALL ${checks} REVIEW CHECKS PASSED`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.$disconnect();
    if (!/^mindease_review_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe cleanup target');
    await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await control.$disconnect();
  }
}
main().catch(error => { console.error('Review checks failed:', error.code || error.name, error instanceof assert.AssertionError ? error.message : 'Check local test database/configuration. No production schema was modified.'); process.exitCode = 1; });
