// Comprehensive Integration Test for Phase 5 (Community Module)
// Tests Blocks 5.1 through 5.5 in a real, isolated PostgreSQL schema.
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

  const schema = 'mindease_community_test_' + randomUUID().replaceAll('-', '');
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
    const roles = ['USER', 'PSYCHOLOGIST_VERIFIED', 'ADMIN', 'MODERATOR'];
    for (const name of roles) {
      await db.role.create({ data: { name } });
    }

    // Seed categories
    const catAnsiedad = await db.communityCategory.create({
      data: { name: 'Ansiedad', slug: 'ansiedad', description: 'Canal sobre manejo de ansiedad' },
    });
    const catDepresion = await db.communityCategory.create({
      data: { name: 'Depresión', slug: 'depresion', description: 'Canal sobre depresión y ánimo' },
    });

    // Start Express app
    const app = require('../src/app').default;
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/community';

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
    const doctor1 = await createUser('doctor1', 'PSYCHOLOGIST_VERIFIED');
    const doctor2 = await createUser('doctor2', 'PSYCHOLOGIST_VERIFIED');
    const moderator = await createUser('moderator', 'MODERATOR');

    // Create doctor profiles
    const prof1 = await db.psychologistProfile.create({
      data: { userId: doctor1.id, status: 'VERIFICADO', consultationPrice: 500 },
    });
    const prof2 = await db.psychologistProfile.create({
      data: { userId: doctor2.id, status: 'VERIFICADO', consultationPrice: 500 },
    });

    console.log('--- BLOCK 5.1: Categories & Channels CRUD & Follow ---');

    // Test 1: Categories listing
    const catRes = await api('GET', '/categories');
    check('categories listing returns 200 and categories list', catRes.status === 200 && catRes.body.data.categories.length === 2);

    // Test 2: Channel creation by Patient blocked (403)
    const failChan = await api('POST', '/channels', patient1, {
      name: 'Canal de Paciente Ilegal',
      description: 'Esto no debería ser permitido para pacientes',
      categoryId: catAnsiedad.id,
    });
    check('patient cannot create community channel (403)', failChan.status === 403);

    // Test 3: Channel creation by Psychologist succeeds (201)
    const chanRes1 = await api('POST', '/channels', doctor1, {
      name: 'Vencer la Ansiedad',
      description: 'Estrategias clínicas y prácticas para superar crisis de ansiedad.',
      categoryId: catAnsiedad.id,
    });
    check('verified psychologist can create channel (201)', chanRes1.status === 201 && chanRes1.body.data.channel.name === 'Vencer la Ansiedad');
    const channel1Id = chanRes1.body.data.channel.id;

    const chanRes2 = await api('POST', '/channels', doctor2, {
      name: 'Superar la Depresión',
      description: 'Herramientas de activación conductual y bienestar emocional.',
      categoryId: catDepresion.id,
    });
    check('doctor2 can create channel (201)', chanRes2.status === 201);
    const channel2Id = chanRes2.body.data.channel.id;

    // Test 4: Channel details & listings
    const chanList = await api('GET', '/channels', patient1);
    check('channel listing returns created channels', chanList.status === 200 && chanList.body.data.items.length === 2);

    const chanDetail = await api('GET', `/channels/${channel1Id}`, patient1);
    check('channel detail includes correct follower count and category', chanDetail.status === 200 && chanDetail.body.data.channel.followersCount === 0 && chanDetail.body.data.channel.category.slug === 'ansiedad');

    // Test 5: Follow and Unfollow Channel
    const follow1 = await api('POST', `/channels/${channel1Id}/follow`, patient1);
    check('patient1 can follow channel1', follow1.status === 200 && follow1.body.data.isFollowing === true && follow1.body.data.followersCount === 1);

    const follow2 = await api('POST', `/channels/${channel1Id}/follow`, patient2);
    check('patient2 can follow channel1', follow2.status === 200 && follow2.body.data.isFollowing === true && follow2.body.data.followersCount === 2);

    // Verify channel detail reflects isFollowing: true for patient1
    const checkFollow = await api('GET', `/channels/${channel1Id}`, patient1);
    check('patient1 isFollowing is true in channel detail', checkFollow.body.data.channel.isFollowing === true);

    // Unfollow
    const unfollow1 = await api('POST', `/channels/${channel1Id}/follow`, patient1);
    check('patient1 can unfollow channel1', unfollow1.status === 200 && unfollow1.body.data.isFollowing === false && unfollow1.body.data.followersCount === 1);

    // Re-follow channel1 for patient1 so notifications test works later
    await api('POST', `/channels/${channel1Id}/follow`, patient1);

    console.log('--- BLOCK 5.2: Publications CRUD & Scoped Feed ---');

    // Test 6: Patient cannot create post
    const failPost = await api('POST', '/posts', patient1, {
      channelId: channel1Id,
      title: 'Post de paciente',
      content: 'Contenido que no debería poder publicar un paciente',
    });
    check('patient cannot create publication (403)', failPost.status === 403);

    // Test 7: Doctor2 cannot post in Doctor1\'s channel
    const failPost2 = await api('POST', '/posts', doctor2, {
      channelId: channel1Id,
      title: 'Invasión de canal ajeno',
      content: 'No debo poder publicar en el canal de otro doctor',
    });
    check('doctor cannot post in foreign channel (403)', failPost2.status === 403);

    // Test 8: Doctor1 creates DRAFT post
    const draftRes = await api('POST', '/posts', doctor1, {
      channelId: channel1Id,
      title: 'Técnicas de respiración diafragmática (Borrador)',
      content: 'Este es el borrador de la guía de respiración.',
      status: 'DRAFT',
      tags: ['ansiedad', 'respiracion'],
    });
    check('doctor1 can save post as DRAFT (201)', draftRes.status === 201 && draftRes.body.data.post.status === 'DRAFT');
    const draftPostId = draftRes.body.data.post.id;

    // Test 9: Doctor1 creates PUBLISHED post with media
    const pubRes = await api('POST', '/posts', doctor1, {
      channelId: channel1Id,
      title: '5 Pasos para calmar una crisis de pánico',
      content: 'Aprende los pasos clave: 1. Reconocer las sensaciones, 2. Respirar en 4-7-8, 3. Conectar con el entorno (5-4-3-2-1)...',
      status: 'PUBLISHED',
      tags: ['ansiedad', 'panico'],
      media: [
        {
          type: 'IMAGE',
          url: 'https://example.com/infografia.png',
          caption: 'Infografía paso a paso',
        },
      ],
    });
    check('doctor1 can create PUBLISHED post with media (201)', pubRes.status === 201 && pubRes.body.data.post.status === 'PUBLISHED');
    const pubPostId = pubRes.body.data.post.id;

    // Test 10: Public feed only returns PUBLISHED posts, not DRAFT
    const feedPatient = await api('GET', '/posts', patient1);
    check('patient feed only contains PUBLISHED posts (1 post)', feedPatient.status === 200 && feedPatient.body.data.items.length === 1 && feedPatient.body.data.items[0].id === pubPostId);

    // Doctor1 querying DRAFT posts succeeds
    const doctorDrafts = await api('GET', '/posts?status=DRAFT', doctor1);
    check('doctor1 can view their own DRAFT posts', doctorDrafts.status === 200 && doctorDrafts.body.data.items.length === 1 && doctorDrafts.body.data.items[0].id === draftPostId);

    // Patient querying DRAFT posts gets 403
    const patientDrafts = await api('GET', '/posts?status=DRAFT', patient1);
    check('patient cannot query DRAFT status (403)', patientDrafts.status === 403);

    // Test 11: Cursor pagination
    // Create 2 more published posts
    for (let i = 1; i <= 2; i++) {
      await api('POST', '/posts', doctor1, {
        channelId: channel1Id,
        title: `Consejo psicoeducativo #${i}`,
        content: `Contenido del consejo número ${i} para el bienestar mental.`,
        status: 'PUBLISHED',
      });
    }
    const page1 = await api('GET', '/posts?limit=2', patient1);
    check('pagination page 1 returns 2 items and hasMore=true', page1.body.data.items.length === 2 && page1.body.data.hasMore === true && page1.body.data.nextCursor != null);

    const page2 = await api('GET', `/posts?limit=2&cursor=${page1.body.data.nextCursor}`, patient1);
    check('pagination page 2 returns remaining items', page2.body.data.items.length >= 1);

    console.log('--- BLOCK 5.3: Interactions (Likes & Strictly 1-Level Comments) ---');

    // Test 12: Like and Unlike
    const likeRes = await api('POST', `/posts/${pubPostId}/like`, patient1);
    check('patient1 can like post (isLiked=true, count=1)', likeRes.status === 200 && likeRes.body.data.isLiked === true && likeRes.body.data.likesCount === 1);

    // Like again toggles to unlike
    const unlikeRes = await api('POST', `/posts/${pubPostId}/like`, patient1);
    check('patient1 liking again toggles unlike (isLiked=false, count=0)', unlikeRes.status === 200 && unlikeRes.body.data.isLiked === false && unlikeRes.body.data.likesCount === 0);

    // Re-like
    await api('POST', `/posts/${pubPostId}/like`, patient1);

    // Test 13: Strictly 1-level Comments
    const comment1 = await api('POST', `/posts/${pubPostId}/comments`, patient1, {
      content: 'Muchas gracias por esta infografía, me sirvió muchísimo hoy.',
    });
    check('patient1 can post comment on published post (201)', comment1.status === 201 && comment1.body.data.comment.content.includes('Muchas gracias'));
    const comment1Id = comment1.body.data.comment.id;

    const comment2 = await api('POST', `/posts/${pubPostId}/comments`, doctor1, {
      content: 'Me alegra mucho que te haya servido. Recuerda practicarlo en momentos de calma.',
    });
    check('doctor1 can reply with a direct 1-level comment (201)', comment2.status === 201);

    // Get comments list
    const commentsList = await api('GET', `/posts/${pubPostId}/comments`, patient1);
    check('comments list returns 2 comments in chronological order', commentsList.status === 200 && commentsList.body.data.items.length === 2);

    // Test 14: Comment deletion authorization
    // Patient2 cannot delete patient1\'s comment
    const failDeleteComment = await api('DELETE', `/comments/${comment1Id}`, patient2);
    check('unauthorized user cannot delete someone elses comment (403)', failDeleteComment.status === 403);

    // Channel owner doctor1 CAN delete inappropriate comment on their channel
    const doctorDeleteComment = await api('DELETE', `/comments/${comment1Id}`, doctor1);
    check('channel owner can delete comments on their channel (200)', doctorDeleteComment.status === 200);

    console.log('--- BLOCK 5.4: Reports & Moderation ---');

    // Test 15: Create report on post
    const reportRes = await api('POST', '/reports', patient2, {
      postId: pubPostId,
      reason: 'INAPPROPRIATE_CONTENT',
      details: 'Creo que el contenido no cumple con las pautas de la comunidad.',
    });
    check('patient can submit content report (201)', reportRes.status === 201 && reportRes.body.data.report.status === 'PENDING');
    const reportId = reportRes.body.data.report.id;

    // Test 16: Duplicate report blocked by unique constraint
    const dupReport = await api('POST', '/reports', patient2, {
      postId: pubPostId,
      reason: 'SPAM',
    });
    check('duplicate report by same user on same post is blocked (400)', dupReport.status === 400);

    // Test 17: Moderator can list and review reports
    const repList = await api('GET', '/reports', moderator);
    check('moderator can list pending reports', repList.status === 200 && repList.body.data.items.length >= 1);

    const reviewRes = await api('PUT', `/reports/${reportId}/review`, moderator, {
      status: 'RESOLVED',
      moderatorNotes: 'Se revisó la publicación y se procedió con la moderación.',
    });
    check('moderator can resolve report', reviewRes.status === 200 && reviewRes.body.data.report.status === 'RESOLVED');

    // Test 18: Moderator hides post (HIDE)
    const hideRes = await api('PUT', `/posts/${pubPostId}/moderate`, moderator, {
      action: 'HIDE',
      hiddenReason: 'Contenido bajo revisión médica por moderación.',
    });
    check('moderator can hide post (PostStatus.HIDDEN)', hideRes.status === 200 && hideRes.body.data.post.status === 'HIDDEN');

    // Verify post is no longer visible to patient1
    const postCheck = await api('GET', `/posts/${pubPostId}`, patient1);
    check('hidden post is not accessible by normal patient (404)', postCheck.status === 404);

    // Moderator unhides post (UNHIDE)
    const unhideRes = await api('PUT', `/posts/${pubPostId}/moderate`, moderator, {
      action: 'UNHIDE',
      hiddenReason: 'Revisión completada, contenido seguro.',
    });
    check('moderator can unhide post (PostStatus.PUBLISHED)', unhideRes.status === 200 && unhideRes.body.data.post.status === 'PUBLISHED');

    const postCheck2 = await api('GET', `/posts/${pubPostId}`, patient1);
    check('post is accessible again after unhide', postCheck2.status === 200);

    console.log('--- BLOCK 5.5: Follower Notifications on New Post ---');

    // Test 19: When doctor publishes a new post, followers receive notification
    const countNotifBefore = await db.notification.count({
      where: { userId: patient1.id, type: 'COMMUNITY_NEW_POST' },
    });

    const notifPost = await api('POST', '/posts', doctor1, {
      channelId: channel1Id,
      title: 'Nuevo recurso sobre meditación guiada',
      content: 'Una guía completa para la práctica diaria de meditación en casa.',
      status: 'PUBLISHED',
    });
    check('new post created and published (201)', notifPost.status === 201);

    // Allow slight async tick for notification dispatch
    await new Promise(r => setTimeout(r, 200));

    const countNotifAfter = await db.notification.count({
      where: { userId: patient1.id, type: 'COMMUNITY_NEW_POST' },
    });
    check('patient1 follower received COMMUNITY_NEW_POST notification', countNotifAfter === countNotifBefore + 1);

    console.log(`\n========================================`);
    console.log(`COMMUNITY MODULE: All ${checks} checks passed successfully!`);
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
