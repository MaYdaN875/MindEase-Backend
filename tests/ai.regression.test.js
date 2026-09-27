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
  global.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(provider.generateOrientation(context), e => e.statusCode === 503);
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
