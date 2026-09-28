const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GeminiAIProvider } = require('../src/ai/providers/geminiAIProvider');
const { MockAIProvider } = require('../src/ai/providers/mockAIProvider');
const { aiOrientationResultSchema } = require('../src/ai/schemas/aiOrientationSchema');
const { assertCanRecommend, requiresCrisisSupport } = require('../src/ai/services/aiSessionPolicy');
const { aiPrivacyNotice, assertAIDataConfiguration } = require('../src/ai/services/aiPrivacyService');
const context = { userId: 'synthetic', sessionId: 'synthetic', history: [], userMessage: 'Prueba de orientación', availableSpecialties: [] };

test('crisis states and flags cannot authorize recommendations', () => {
  for (const state of [
    { status: 'ESCALATED', riskLevel: 'LOW' },
    { status: 'COMPLETED', riskLevel: 'HIGH' },
    { status: 'COMPLETED', riskLevel: 'EMERGENCY' },
    { status: 'CANCELLED', riskLevel: 'LOW' },
  ]) assert.throws(() => assertCanRecommend(state), e => e.statusCode === 409);
  assert.equal(requiresCrisisSupport({ riskLevel: 'LOW', requiresImmediateHelp: true }), true);
});

test('missing safety fields and string booleans are invalid', async () => {
  const valid = await new MockAIProvider().generateOrientation(context);
  for (const altered of [
    { ...valid, safety: {} }, { ...valid, assistantMessage: {} },
    { ...valid, conversation: { ...valid.conversation, isComplete: 'false' } },
  ]) assert.equal(aiOrientationResultSchema.safeParse(altered).success, false);
});

test('Gemini validates output, finish reason, privacy and transport failures without mock fallback', async t => {
  const valid = await new MockAIProvider().generateOrientation(context);
  const originalFetch = global.fetch;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { global.fetch = originalFetch; console.error = originalError; });
  const provider = new GeminiAIProvider('synthetic-key', 'synthetic-model', 1000);
  let request;
  const respond = (text, finishReason = 'STOP', extra = {}) => {
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }], ...extra }) };
    };
  };
  respond(JSON.stringify(valid));
  assert.deepEqual(await provider.generateOrientation(context), valid);
  assert.ok(JSON.parse(request.options.body).generationConfig.responseSchema);
  assert.equal(request.url.includes('synthetic-key'), false);
  for (const [text, reason, extra] of [
    ['SENSITIVE_SENTINEL {', 'STOP', {}],
    [JSON.stringify({ ...valid, assistantMessage: {}, safety: { riskLevel: 'HIGH', requiresImmediateHelp: true } }), 'STOP', {}],
    [JSON.stringify(valid), 'MAX_TOKENS', {}],
    [JSON.stringify(valid), 'STOP', { promptFeedback: { blockReason: 'SAFETY' } }],
  ]) {
    respond(text, reason, extra);
    await assert.rejects(provider.generateOrientation(context));
  }
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(provider.generateOrientation(context), e => e.statusCode === 429 && e.code === 'AI_PROVIDER_QUOTA');
  global.fetch = async () => { throw new Error('SENSITIVE_SENTINEL'); };
  await assert.rejects(provider.generateOrientation(context), e => !e.message.includes('SENSITIVE_SENTINEL'));
  assert.deepEqual(errors, []);
});

test('privacy version changes with retention and Gemini requires operator confirmation', t => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  process.env.AI_PROVIDER = 'gemini';
  delete process.env.AI_GEMINI_DATA_POLICY_CONFIRMED;
  assert.throws(assertAIDataConfiguration, e => e.statusCode === 503);
  process.env.AI_CONVERSATION_RETENTION_DAYS = '30';
  const first = aiPrivacyNotice();
  process.env.AI_CONVERSATION_RETENTION_DAYS = '15';
  assert.notEqual(first.version, aiPrivacyNotice().version);
  process.env.AI_CONVERSATION_RETENTION_DAYS = '-1';
  assert.throws(aiPrivacyNotice);
});

test('quota counts answered user turns only, including legacy failed messages', t => {
  const { orientationQuota } = require('../src/ai/services/aiQuota');
  const old = process.env.AI_MAX_MESSAGES_PER_SESSION;
  t.after(() => { if (old === undefined) delete process.env.AI_MAX_MESSAGES_PER_SESSION; else process.env.AI_MAX_MESSAGES_PER_SESSION = old; });
  process.env.AI_MAX_MESSAGES_PER_SESSION = '2';
  const messages = ['ASSISTANT', 'USER', 'USER', 'ASSISTANT', 'USER'].map(role => ({ role }));
  assert.deepEqual(orientationQuota(messages), { limit: 2, used: 1, remaining: 1 });
  process.env.AI_MAX_MESSAGES_PER_SESSION = '0';
  assert.throws(() => orientationQuota([]), e => e.code === 'AI_CONFIGURATION_ERROR');
});

test('transport retries transient errors only, respects deadlines and Retry-After', async t => {
  const { fetchGemini } = require('../src/ai/providers/geminiTransport');
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let calls = 0;
  global.fetch = async () => ++calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ recovered: true }) };
  assert.deepEqual(await fetchGemini('https://example.test', {}, 2500), { recovered: true });
  assert.equal(calls, 2);
  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 403 }; };
  await assert.rejects(fetchGemini('https://example.test', {}, 1000), e => e.code === 'AI_PROVIDER_AUTH');
  assert.equal(calls, 1);
  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({}) }; };
  await assert.rejects(fetchGemini('https://example.test', {}, 1000), e => e.code === 'AI_PROVIDER_QUOTA' && e.retryAfterSeconds === 60);
  assert.equal(calls, 1);
  global.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
  await assert.rejects(fetchGemini('https://example.test', {}, 100), e => e.code === 'AI_PROVIDER_TIMEOUT');
});
