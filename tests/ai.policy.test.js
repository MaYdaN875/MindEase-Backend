const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AISafetyService } = require('../src/ai/services/aiSafetyService');
const { MockAIProvider } = require('../src/ai/providers/mockAIProvider');
const { aiOrientationResultSchema } = require('../src/ai/schemas/aiOrientationSchema');

test('safety: detect EMERGENCY risk level for explicit self-harm / suicidal intent', () => {
  const severeCases = [
    'Me quiero suicidar',
    'No quiero vivir más, pienso en quitarme la vida',
    'Voy a cortarme las venas hoy en la noche',
    'Voy a matar a alguien',
  ];

  for (const text of severeCases) {
    const evaluation = AISafetyService.evaluateUserInput(text);
    assert.equal(evaluation.riskLevel, 'EMERGENCY', `Failed for text: ${text}`);
    assert.equal(evaluation.requiresImmediateHelp, true);
    assert.ok(evaluation.flags.includes('EMERGENCY_RISK_DETECTED'));
    assert.ok(evaluation.emergencyMessage && evaluation.emergencyMessage.length > 0);
  }
});

test('safety: detect HIGH risk level for passive ideation or severe distress', () => {
  const highRiskCases = [
    'Ojalá me muriera para ya no sentir este dolor',
    'Desearía no despertar mañana por la mañana',
    'A veces me corto la piel cuando me desespero',
  ];

  for (const text of highRiskCases) {
    const evaluation = AISafetyService.evaluateUserInput(text);
    assert.equal(evaluation.riskLevel, 'HIGH', `Failed for text: ${text}`);
    assert.equal(evaluation.requiresImmediateHelp, true);
    assert.ok(evaluation.flags.includes('HIGH_RISK_DETECTED'));
  }
});

test('safety: detect MODERATE and LOW risk for normal emotional distress', () => {
  const moderate = AISafetyService.evaluateUserInput('Tengo un ataque de pánico horrible y me falta el aire');
  assert.equal(moderate.riskLevel, 'MODERATE');
  assert.equal(moderate.requiresImmediateHelp, false);

  const low = AISafetyService.evaluateUserInput('Últimamente no puedo dormir bien por estrés del trabajo');
  assert.equal(low.riskLevel, 'LOW');
  assert.equal(low.requiresImmediateHelp, false);
});

test('safety: sanitize prohibiting clinical diagnostic statements in assistant output', () => {
  const invalidOutput = 'Según lo que me cuentas, tienes depresión severa y te diagnostico con trastorno bipolar.';
  const { safeText, hasViolations } = AISafetyService.sanitizeAndValidateAssistantOutput(invalidOutput);

  assert.equal(hasViolations, true);
  assert.equal(safeText.includes('tienes depresión'), false);
  assert.equal(safeText.includes('te diagnostico con'), false);
  assert.ok(safeText.includes('podría ser beneficioso consultar con un profesional'));
});

test('mock provider: returns valid structured output schema', async () => {
  const provider = new MockAIProvider();
  const context = {
    sessionId: 'session-test-1',
    userId: 'user-test-1',
    history: [],
    userMessage: 'Me siento muy estresado por el trabajo y no puedo dormir',
    availableSpecialties: ['Manejo del Estrés', 'Psicología Clínica', 'Terapia Cognitivo-Conductual'],
  };

  const result = await provider.generateOrientation(context);

  // Validate with Zod schema
  const parsed = aiOrientationResultSchema.safeParse(result);
  assert.equal(parsed.success, true);

  // Verify non-empty assistant message
  assert.ok(result.assistantMessage.length > 0);

  // Verify suggested specialties match
  assert.ok(result.needsProfile.suggestedSpecialties.length > 0);
  assert.ok(result.needsProfile.suggestedSpecialties.some(s => s.name === 'Manejo del Estrés'));

  // Risk should be LOW
  assert.equal(result.safety.riskLevel, 'LOW');
  assert.equal(result.safety.requiresImmediateHelp, false);
});

test('safety: replaces the whole unsafe output including repeated and formatted assertions', () => {
  for (const output of ['Tienes depresión. Tienes depresión.', 'Tienes **depresión**. Más texto inseguro.',
    'El usuario tiene depresión.', 'Debes tomar sertralina.', 'Toma 50 mg por la noche.']) {
    const result = AISafetyService.sanitizeAndValidateAssistantOutput(output);
    assert.equal(result.hasViolations, true);
    assert.equal(result.safeText, AISafetyService.SAFE_REPLY);
  }
  const safe = 'Un profesional puede evaluar tus necesidades. Esta orientación no establece diagnósticos.';
  assert.equal(AISafetyService.sanitizeAndValidateAssistantOutput(safe).safeText, safe);
});

test('safety: checks all generated fields and never clears model risk flags', async () => {
  const base = await new MockAIProvider().generateOrientation({ history: [], userMessage: 'Hola', availableSpecialties: [] });
  const changes = [
    value => { value.conversation.summary = 'El usuario tiene depresión.'; },
    value => { value.needsProfile.primaryConcern = 'Tienes depresión'; },
    value => { value.needsProfile.topics = ['Tienes depresión']; },
    value => { value.needsProfile.suggestedSpecialties = [{ name: 'Clínica', reason: 'Tienes depresión' }]; },
    value => { value.needsProfile.suggestedSpecialties = [{ name: 'Tienes depresión', reason: 'General' }]; },
  ];
  for (const alter of changes) {
    const value = structuredClone(base);
    value.safety = { riskLevel: 'HIGH', requiresImmediateHelp: true, flags: ['MODEL_RISK'] };
    alter(value);
    const sanitized = AISafetyService.sanitizeOrientationResult(value);
    assert.equal(sanitized.assistantMessage, AISafetyService.SAFE_REPLY);
    assert.equal(sanitized.conversation.isComplete, false);
    assert.deepEqual(sanitized.needsProfile.suggestedSpecialties, []);
    assert.deepEqual(sanitized.safety, value.safety);
    assert.equal(aiOrientationResultSchema.safeParse(sanitized).success, true);
  }
});

test('safety: retains context from users only and combines split risk expressions', () => {
  assert.equal(AISafetyService.evaluateConversation('la vida', [{ role: 'USER', content: 'Quiero quitarme' }]).riskLevel, 'EMERGENCY');
  assert.equal(AISafetyService.evaluateConversation('Hola', [{ role: 'USER', content: 'No quiero vivir' }]).riskLevel, 'EMERGENCY');
  assert.equal(AISafetyService.evaluateConversation('Hola', [{ role: 'ASSISTANT', content: 'No quiero vivir' }]).riskLevel, 'LOW');
  assert.equal(AISafetyService.evaluateConversation('Hola', [], 'MODERATE').riskLevel, 'MODERATE');
});

test('mock provider: crisis message triggers emergency risk and immediate help flag', async () => {
  const provider = new MockAIProvider();
  const context = {
    sessionId: 'session-crisis-1',
    userId: 'user-crisis-1',
    history: [],
    userMessage: 'Ya no aguanto, me quiero matar',
    availableSpecialties: ['Psicología Clínica'],
  };

  const result = await provider.generateOrientation(context);
  assert.equal(result.safety.riskLevel, 'EMERGENCY');
  assert.equal(result.safety.requiresImmediateHelp, true);
  assert.equal(result.conversation.shouldContinue, false);
});
