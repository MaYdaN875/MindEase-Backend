const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// Called with the support suite's isolated database and disposable actors.
module.exports = async function mediaChecks({ base, db, owner, stranger, agent }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindease-media-test-'));
  const previousRoot = process.env.MEDIA_STORAGE_ROOT;
  process.env.MEDIA_STORAGE_ROOT = root;
  const origin = new URL(base).origin;
  let checks = 0;
  function check(name, value) { assert.ok(value, name); console.log('PASS: ' + name); checks++; }
  async function request(route, user, body) {
    return fetch(origin + route, { method: body ? 'POST' : 'GET', headers: {
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  async function upload(user, bytes = png, name = 'image.png', type = 'image/png') {
    const form = new FormData(); form.append('file', new Blob([bytes], { type }), name);
    return fetch(base + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
  }
  try {
    check('rejects HTML disguised as PNG', (await upload(owner, Buffer.from('<html>unsafe</html>'))).status === 400);
    check('rejects misleading extension', (await upload(owner, png, 'image.html')).status === 400);
    check('rejects MIME mismatch', (await upload(owner, png, 'image.png', 'application/pdf')).status === 400);
    const uploaded = await upload(owner);
    check('accepts matching PNG upload', uploaded.status === 200);
    const url = (await uploaded.json()).data.url;
    check('private upload denies anonymous access', (await request(url)).status === 404);
    check('private upload denies foreign account', (await request(url, stranger)).status === 404);
    const own = await request(url, owner);
    check('uploader can preview private file', own.status === 200);
    check('download sets nosniff and no-store', own.headers.get('x-content-type-options') === 'nosniff' && own.headers.get('cache-control').includes('no-store'));
    check('support agent can read support file', (await request(url, agent)).status === 200);
    const ticketBody = { subject: 'Media privacy test', category: 'TECHNICAL', content: 'Validating private attachments.', attachments: [url] };
    check('foreign attachment cannot be reused', (await request('/api/support/tickets', stranger, ticketBody)).status === 403);
    const createdTicket = await request('/api/support/tickets', owner, ticketBody);
    check('owner can attach own uploaded file to ticket', createdTicket.status === 201);
    const ticketId = (await createdTicket.json()).data.ticket.id;
    const internalUrl = (await (await upload(agent)).json()).data.url;
    const internal = await request(`/api/support/agent/tickets/${ticketId}/messages`, agent, { content: 'Private investigation', isInternalNote: true, attachments: [internalUrl] });
    check('agent can attach file to internal note', internal.status === 201);
    check('ticket owner cannot read internal-note attachment', (await request(internalUrl, owner)).status === 404);
    const publicUrl = (await (await upload(agent)).json()).data.url;
    const reply = await request(`/api/support/agent/tickets/${ticketId}/messages`, agent, { content: 'Public answer', isInternalNote: false, attachments: [publicUrl] });
    check('agent can attach file to public reply', reply.status === 201);
    check('ticket owner can read public-reply attachment', (await request(publicUrl, owner)).status === 200);
    check('foreign user cannot read public-reply attachment', (await request(publicUrl, stranger)).status === 404);
    const access = await request('/api/media/access', owner, { url });
    check('owner can request short-lived download', access.status === 200);
    const signedUrl = (await access.json()).data.url;
    check('signed download works without session header', (await request(signedUrl)).status === 200);
    const ticket = new URL(origin + signedUrl).searchParams.get('access');
    check('download ticket is not a login token', (await request('/api/support/tickets', { token: ticket })).status === 401);
    const otherUpload = await upload(stranger);
    const otherUrl = (await otherUpload.json()).data.url;
    check('download ticket is scoped to one file', (await request(otherUrl + '?access=' + ticket)).status === 404);
    const expired = jwt.sign({ media: url }, process.env.JWT_SECRET, { subject: owner.id, audience: 'media-download', expiresIn: -1 });
    check('expired download ticket is denied', (await request(url + '?access=' + expired)).status === 404);
    await db.user.update({ where: { id: owner.id }, data: { status: 'SUSPENDED' } });
    check('suspension revokes download ticket immediately', (await request(signedUrl)).status === 404);
    await db.user.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } });

    const { saveMedia, canReadMedia, validateMediaReferences } = require('../src/services/mediaPolicy');
    const moderatorContext = { userId: stranger.id, roles: ['MODERATOR'] };
    check('moderator cannot read unrelated support uploads', !await canReadMedia(url, moderatorContext));
    await db.userReport.create({ data: { reporterId: owner.id, reportedUserId: agent.id, reason: 'OTHER', description: 'Evidence privacy test', evidenceUrls: [url] } });
    check('moderator can inspect conduct-report evidence', await canReadMedia(url, moderatorContext));
    check('moderator cannot inspect unrelated internal-note attachment', !await canReadMedia(internalUrl, moderatorContext));
    const mediaUrl = await saveMedia({ buffer: png, originalname: 'image.png', mimetype: 'image/png', size: png.length }, owner.id, 'community');
    check('unpublished Community media is not public', !await canReadMedia(mediaUrl));
    check('Community uploader can access own draft media', await canReadMedia(mediaUrl, { userId: owner.id, roles: ['USER'] }));
    await assert.rejects(validateMediaReferences([url], owner.id, 'community'));
    check('support files cannot be published as Community media', true);
    await assert.rejects(validateMediaReferences([mediaUrl], stranger.id, 'community'));
    check('foreign draft media cannot be published', true);
    const profile = await db.psychologistProfile.create({ data: { userId: owner.id, status: 'VERIFICADO' } });
    const category = await db.communityCategory.create({ data: { name: 'Media test', slug: 'media-test' } });
    const channel = await db.communityChannel.create({ data: { psychologistId: profile.id, categoryId: category.id, name: 'Media tests', description: 'Test channel' } });
    const post = await db.communityPost.create({ data: { channelId: channel.id, authorId: owner.id, title: 'Test media', content: 'Test publication', status: 'DRAFT', media: { create: { type: 'IMAGE', url: mediaUrl } } } });
    check('draft attachment remains private', !await canReadMedia(mediaUrl));
    await db.communityPost.update({ where: { id: post.id }, data: { status: 'PUBLISHED' } });
    check('published attachment becomes public', await canReadMedia(mediaUrl));
    await db.communityPost.update({ where: { id: post.id }, data: { status: 'HIDDEN' } });
    check('moderation hides attachment from anonymous visitors', !await canReadMedia(mediaUrl));
    return checks;
  } finally {
    if (previousRoot === undefined) delete process.env.MEDIA_STORAGE_ROOT;
    else process.env.MEDIA_STORAGE_ROOT = previousRoot;
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('mindease-media-test-')) throw new Error('Unsafe cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  }
};
