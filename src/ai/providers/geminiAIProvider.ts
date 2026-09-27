import { IAIProvider } from './aiProvider.interface';
import { AIConversationContext, AIOrientationResult } from '../types/ai.types';
import { buildSystemPrompt } from '../prompts/orientationPrompt';
import { aiOrientationResultSchema } from '../schemas/aiOrientationSchema';
import { AppError } from '../../middlewares/errorMiddleware';

// Use the same required fields as the application validator. Never infer missing safety fields.
export const orientationResponseSchema = {
  type: 'OBJECT', required: ['assistantMessage', 'needsProfile', 'safety', 'conversation'],
  properties: {
    assistantMessage: { type: 'STRING' },
    needsProfile: {
      type: 'OBJECT', required: ['primaryConcern', 'topics', 'suggestedSpecialties', 'preferences'],
      properties: {
        primaryConcern: { type: 'STRING', nullable: true },
        topics: { type: 'ARRAY', items: { type: 'STRING' } },
        suggestedSpecialties: { type: 'ARRAY', items: {
          type: 'OBJECT', required: ['name', 'reason'],
          properties: { name: { type: 'STRING' }, reason: { type: 'STRING' } },
        } },
        preferences: { type: 'OBJECT', required: ['modality', 'preferredTime', 'maxBudget'], properties: {
          modality: { type: 'STRING', enum: ['ONLINE', 'IN_PERSON', 'ANY'], nullable: true },
          preferredTime: { type: 'STRING', enum: ['MORNING', 'AFTERNOON', 'EVENING', 'WEEKEND', 'ANY'], nullable: true },
          maxBudget: { type: 'NUMBER', nullable: true },
        } },
      },
    },
    safety: { type: 'OBJECT', required: ['riskLevel', 'requiresImmediateHelp', 'flags'], properties: {
      riskLevel: { type: 'STRING', enum: ['LOW', 'MODERATE', 'HIGH', 'EMERGENCY'] },
      requiresImmediateHelp: { type: 'BOOLEAN' },
      flags: { type: 'ARRAY', items: { type: 'STRING' } },
    } },
    conversation: { type: 'OBJECT', required: ['shouldContinue', 'isComplete', 'summary'], properties: {
      shouldContinue: { type: 'BOOLEAN' }, isComplete: { type: 'BOOLEAN' }, summary: { type: 'STRING' },
    } },
  },
};

export class GeminiAIProvider implements IAIProvider {
  readonly providerName = 'GEMINI';
  constructor(
    private readonly apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
    private readonly model = (process.env.GEMINI_MODEL || '').trim(),
    private readonly timeoutMs = Number(process.env.AI_TIMEOUT_MS || 20000),
  ) {}

  async generateOrientation(context: AIConversationContext): Promise<AIOrientationResult> {
    if (!this.apiKey || !/^(models\/)?[a-zA-Z0-9.-]+$/.test(this.model) ||
        !Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60000) {
      throw new AppError('El servicio de orientación no está configurado correctamente.', 503);
    }
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    const firstUser = context.history.findIndex(m => m.role === 'USER');
    for (const message of [...(firstUser < 0 ? [] : context.history.slice(firstUser)),
      { role: 'USER', content: context.userMessage }]) {
      const role = message.role === 'USER' ? 'user' : 'model';
      const last = contents[contents.length - 1];
      if (last?.role === role) last.parts.push({ text: message.content });
      else contents.push({ role, parts: [{ text: message.content }] });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model.replace(/^models\//, '')}:generateContent`,
        {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: buildSystemPrompt(context.availableSpecialties) }] },
            contents,
            generationConfig: { temperature: 0.3, maxOutputTokens: 2048,
              responseMimeType: 'application/json', responseSchema: orientationResponseSchema },
          }),
        },
      );
      if (!response.ok) throw new AppError('El proveedor de orientación no está disponible. Inténtalo más tarde.', 503);
      const body: any = await response.json();
      const candidate = body?.candidates?.[0];
      if (body?.promptFeedback?.blockReason || candidate?.finishReason !== 'STOP') {
        throw new AppError('No se pudo generar una respuesta de orientación segura y completa.', 502);
      }
      const raw = candidate?.content?.parts?.filter((p: any) => !p.thought && typeof p.text === 'string')
        .map((p: any) => p.text).join('');
      if (!raw || raw.length > 20000) throw new AppError('Respuesta de orientación inválida.', 502);
      const parsed = aiOrientationResultSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new AppError('Respuesta de orientación inválida.', 502);
      return parsed.data;
    } catch (error) {
      // Do not log raw prompts, responses, SDK errors, URLs, or credentials.
      if (error instanceof AppError) throw error;
      throw new AppError('No se pudo obtener una respuesta de orientación válida. Inténtalo más tarde.', 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}
