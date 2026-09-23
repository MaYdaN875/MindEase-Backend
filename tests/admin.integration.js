const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

async function main() {
  const source = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mindease?schema=public';
  if (!['localhost', '127.0.0.1'].includes(new URL(source).hostname)) throw new Error('Local test database required');
  const schema = 'mindease_admin_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(source); url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString(); process.env.JWT_SECRET = randomUUID(); process.env.NODE_ENV = 'test'; process.env.PAYMENT_PROVIDER = 'MOCK';
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mindease-admin-test-'));
  process.env.MEDIA_STORAGE_ROOT = mediaRoot;
  const control = new PrismaClient({ datasources: { db: { url: source } } });
  let db, server, checks = 0;
  const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS ' + name); };
  try {
    await control.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
    db = require('../src/config/db').default;
    const actors = {};
    for (const role of ['ADMIN', 'SUPERADMIN', 'REVISOR', 'MODERATOR', 'SUPPORT', 'USER', 'PSYCHOLOGIST_VERIFIED']) {
      await db.role.create({ data: { name: role } });
      const user = await db.user.create({ data: { name: 'Prueba ' + role, email: role.toLowerCase() + '@example.test', passwordHash: 'not-a-login-password', userRoles: { create: { role: { connect: { name: role } } } } } });
      actors[role] = { ...user, token: jwt.sign({ userId: user.id, roles: [role] }, process.env.JWT_SECRET) };
    }
    const category = await db.communityCategory.create({ data: { name: 'Bienestar de prueba', slug: 'bienestar-prueba' } });
    const profile = await db.psychologistProfile.create({ data: { userId: actors.PSYCHOLOGIST_VERIFIED.id, status: 'VERIFICADO' } });
    const channel = await db.communityChannel.create({ data: { psychologistId: profile.id, categoryId: category.id, name: 'Canal de prueba', description: 'Contenido educativo de prueba' } });
    const post = await db.communityPost.create({ data: { channelId: channel.id, authorId: actors.PSYCHOLOGIST_VERIFIED.id, title: 'Publicación de prueba', content: 'Contenido sintético para verificar moderación.', status: 'PUBLISHED' } });
    const draft = await db.communityPost.create({ data: { channelId: channel.id, authorId: actors.PSYCHOLOGIST_VERIFIED.id, title: 'Borrador privado', content: 'Este contenido no está publicado.', status: 'DRAFT' } });
    const comment = await db.postComment.create({ data: { postId: post.id, userId: actors.USER.id, content: 'Comentario de prueba' } });
    const ticket = await db.supportTicket.create({ data: { userId: actors.USER.id, subject: 'Ticket de prueba de adjuntos', category: 'TECHNICAL', priority: 'HIGH', messages: { create: { senderId: actors.USER.id, content: 'Solicitud de ayuda sintética' } } } });
    const { saveMedia } = require('../src/services/mediaPolicy');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const file = { buffer: png, originalname: 'fixture.png', mimetype: 'image/png', size: png.length };
    const evidence = await saveMedia(file, actors.USER.id, 'support');
    const internal = await saveMedia(file, actors.SUPPORT.id, 'support');
    await db.ticketMessage.create({ data: { ticketId: ticket.id, senderId: actors.SUPPORT.id, content: 'Nota interna de prueba', isInternalNote: true, attachments: [internal] } });
    await db.ticketMessage.create({ data: { ticketId: ticket.id, senderId: actors.USER.id, content: 'Evidencia adjunta de prueba', attachments: [evidence] } });
    const report = await db.userReport.create({ data: { reporterId: actors.USER.id, reportedUserId: actors.PSYCHOLOGIST_VERIFIED.id, reason: 'OTHER', description: 'Reporte sintético con evidencia', evidenceUrls: [evidence] } });

    const app = require('../src/app').default;
    const express = require('express'); const host = express();
    host.use((req, res, next) => req.path.startsWith('/api/') || req.path.startsWith('/uploads/') ? app(req, res, next) : next());
    // Browser fixtures are loopback-only, use a disposable database, and are never part of production.
    host.get('/test/role/:role', (req, res) => {
      const actor = actors[req.params.role]; if (!actor) return res.sendStatus(404);
      res.type('html').send(`<script>localStorage.setItem('admin_token', ${JSON.stringify(actor.token)});location.replace('/')</script>`);
    });
    host.get('/test', (_req, res) => res.type('html').send(Object.keys(actors).map(role => `<p><a href="/test/role/${role}">${role}</a></p>`).join('') + `<p><a href="${evidence}">Evidencia sin autorización</a></p>`));
    host.use(express.static(path.resolve('../MindEase-Admin/dist')));
    const keep = process.argv.includes('--browser');
    server = await new Promise(resolve => { const current = host.listen(keep ? 4318 : 0, '127.0.0.1', () => resolve(current)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    async function api(method, route, role, body) {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: 'Bearer ' + actors[role].token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    }
    for (const role of ['ADMIN', 'SUPERADMIN', 'REVISOR', 'MODERATOR', 'SUPPORT']) {
      const session = await api('GET', '/api/users/profile', role); check(role + ' authenticated role is current', session.status === 200 && session.body.data.user.roles.includes(role));
      check(role + ' Community permission', (await api('GET', '/api/admin/community/channels', role)).status === (['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(role) ? 200 : 403));
      check(role + ' support permission', (await api('GET', '/api/support/agent/agents', role)).status === (['ADMIN', 'SUPERADMIN', 'SUPPORT'].includes(role) ? 200 : 403));
    }
    check('anonymous administration denied', (await api('GET', '/api/admin/community/categories')).status === 401);
    check('patient administration denied', (await api('GET', '/api/admin/community/posts', 'USER')).status === 403);
    check('moderator cannot create category', (await api('POST', '/api/admin/community/categories', 'MODERATOR', { name: 'No autorizado', slug: 'no-autorizado' })).status === 403);
    const created = await api('POST', '/api/admin/community/categories', 'ADMIN', { name: 'Categoría nueva', slug: 'categoria-nueva' });
    check('administrator creates category', created.status === 201);
    check('duplicate category slug rejected', (await api('POST', '/api/admin/community/categories', 'ADMIN', { name: 'Duplicada', slug: 'categoria-nueva' })).status === 409);
    check('invalid slug rejected', (await api('POST', '/api/admin/community/categories', 'ADMIN', { name: 'Inválida', slug: 'with spaces' })).status === 400);
    check('category can be deactivated', (await api('PATCH', '/api/admin/community/categories/' + created.body.data.category.id, 'SUPERADMIN', { isActive: false })).status === 200);
    const inactive = await api('GET', '/api/admin/community/categories?active=false', 'MODERATOR');
    check('administration includes inactive categories', inactive.body.data.items.some(item => item.id === created.body.data.category.id));
    const publicCategories = await api('GET', '/api/community/categories');
    check('public categories exclude inactive entries', !publicCategories.body.data.categories.some(item => item.id === created.body.data.category.id));
    check('invalid pagination rejected', (await api('GET', '/api/admin/community/posts?limit=0', 'ADMIN')).status === 400);
    const first = await api('GET', '/api/admin/community/posts?limit=1', 'MODERATOR');
    const second = await api('GET', '/api/admin/community/posts?limit=1&cursor=' + first.body.data.nextCursor, 'MODERATOR');
    check('post pagination does not repeat rows', first.body.data.hasMore && first.body.data.items[0].id !== second.body.data.items[0].id);
    check('post state filter works', (await api('GET', '/api/admin/community/posts?status=DRAFT', 'MODERATOR')).body.data.items.every(item => item.status === 'DRAFT'));
    check('moderation cannot publish draft', (await api('PUT', `/api/community/posts/${draft.id}/moderate`, 'MODERATOR', { action: 'UNHIDE', hiddenReason: 'Prueba de seguridad' })).status === 409);
    check('moderator deactivates channel', (await api('PATCH', `/api/admin/community/channels/${channel.id}/status`, 'MODERATOR', { isActive: false, reason: 'Prueba de moderación' })).status === 200);
    check('author cannot reactivate disabled channel', (await api('PUT', `/api/community/channels/${channel.id}`, 'PSYCHOLOGIST_VERIFIED', { isActive: true })).status === 409);
    check('channel filter includes inactive', (await api('GET', '/api/admin/community/channels?active=false', 'MODERATOR')).body.data.items.length === 1);
    await api('PATCH', `/api/admin/community/channels/${channel.id}/status`, 'MODERATOR', { isActive: true, reason: 'Revisión finalizada' });
    check('moderator hides post', (await api('PUT', `/api/community/posts/${post.id}/moderate`, 'MODERATOR', { action: 'HIDE', hiddenReason: 'Prueba de moderación' })).status === 200);
    check('moderator hides comment', (await api('PUT', `/api/community/comments/${comment.id}/moderate`, 'MODERATOR', { action: 'HIDE', hiddenReason: 'Prueba de moderación' })).status === 200);
    check('hidden comments can be inspected', (await api('GET', '/api/admin/community/comments?active=false', 'MODERATOR')).body.data.items.length === 1);
    const history = await api('GET', '/api/admin/community/history', 'MODERATOR');
    check('moderation actions record actor and reason', history.body.data.items.some(item => item.action === 'COMMUNITY_POST_MODERATE' && item.user.id === actors.MODERATOR.id && item.details.reason));
    const agents = await api('GET', '/api/support/agent/agents', 'SUPPORT');
    check('agent directory excludes patients and unnecessary private fields', agents.body.data.agents.length === 3 && agents.body.data.agents.every(agent => !('email' in agent) && !('passwordHash' in agent)));
    check('assign another agent', (await api('PUT', `/api/support/agent/tickets/${ticket.id}/assign`, 'SUPPORT', { agentId: actors.ADMIN.id })).status === 200);
    check('filter by agent category priority', (await api('GET', `/api/support/agent/tickets?assigned=${actors.ADMIN.id}&category=TECHNICAL&priority=HIGH`, 'SUPPORT')).body.data.items.length === 1);
    await db.user.update({ where: { id: actors.ADMIN.id }, data: { status: 'SUSPENDED' } });
    check('cannot assign suspended agent', (await api('PUT', `/api/support/agent/tickets/${ticket.id}/assign`, 'SUPPORT', { agentId: actors.ADMIN.id })).status === 404);
    await db.user.update({ where: { id: actors.ADMIN.id }, data: { status: 'ACTIVE' } });
    check('response metric reports sample size', 'responseSampleSize' in (await api('GET', '/api/support/agent/metrics', 'SUPPORT')).body.data);
    const escalated = await api('PUT', `/api/support/user-reports/${report.id}/investigate`, 'SUPPORT', { status: 'INVESTIGATING', escalateToTicket: true });
    check('escalated report exposes ticket for navigation', escalated.status === 200 && !!escalated.body.data.ticket.id);
    check('patient does not receive internal notes', !(await api('GET', `/api/support/tickets/${ticket.id}`, 'USER')).body.data.ticket.messages.some(item => item.isInternalNote));
    check('patient cannot download internal attachment', (await fetch(base + internal, { headers: { Authorization: 'Bearer ' + actors.USER.token } })).status === 404);
    check('moderator opens evidence only via authorized media', (await api('POST', '/api/media/access', 'MODERATOR', { url: evidence })).status === 200);
    console.log(`ADMIN: ${checks} checks passed`);
    if (keep) {
      console.log('Browser fixture ready at http://127.0.0.1:4318/test (disposable data only)');
      await new Promise(resolve => { host.post('/test/finish', (_req, res) => { res.json({ stopped: true }); resolve(); }); process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (db) await db.$disconnect();
    if (!/^mindease_admin_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe cleanup schema');
    await control.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); await control.$disconnect();
    if (path.dirname(mediaRoot) !== os.tmpdir() || !path.basename(mediaRoot).startsWith('mindease-admin-test-')) throw new Error('Unsafe media cleanup');
    await fs.rm(mediaRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
