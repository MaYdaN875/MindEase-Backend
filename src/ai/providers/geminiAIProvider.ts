import { IAIProvider } from './aiProvider.interface';
import { AIConversationContext, AIOrientationResult } from '../types/ai.types';
import { buildSystemPrompt } from '../prompts/orientationPrompt';
import { aiOrientationResultSchema } from '../schemas/aiOrientationSchema';
import { AppError } from '../../middlewares/errorMiddleware';

export class GeminiAIProvider implements IAIProvider {
  readonly providerName = 'GEMINI';

  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;

  constructor(apiKey?: string, modelName?: string, timeoutMs?: number) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || '';
    this.modelName = modelName || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    this.timeoutMs = timeoutMs || parseInt(process.env.AI_TIMEOUT_MS || '15000', 10);
  }

  async generateOrientation(context: AIConversationContext): Promise<AIOrientationResult> {
    if (!this.apiKey) {
      throw new AppError(
        'La clave de API de IA no está configurada en el servidor. Contacte a soporte.',
        500
      );
    }

    const systemPrompt = buildSystemPrompt(context.availableSpecialties);

    // Formatear mensajes previos
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of context.history) {
      contents.push({
        role: msg.role === 'USER' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }

    // Agregar el mensaje actual del usuario
    contents.push({
      role: 'user',
      parts: [{ text: context.userMessage }],
    });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents,
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Gemini API returned status ${response.status}`);
      }

      const jsonResponse: any = await response.json();
      const rawText =
        jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

      if (!rawText) {
        throw new Error('Respuesta vacía del proveedor de IA');
      }

      const parsedJson = JSON.parse(rawText);
      const validated = aiOrientationResultSchema.safeParse(parsedJson);

      if (!validated.success) {
        // Fallback resiliente si falta algún campo opcional
        return {
          assistantMessage:
            parsedJson.assistantMessage ||
            'Comprendo lo que estás sintiendo. Para poder orientarte mejor, ¿desde hace cuánto tiempo notas esto?',
          needsProfile: {
            primaryConcern: parsedJson.needsProfile?.primaryConcern || null,
            topics: parsedJson.needsProfile?.topics || ['bienestar_general'],
            suggestedSpecialties: parsedJson.needsProfile?.suggestedSpecialties || [
              {
                name: 'Psicología Clínica',
                reason: 'Acompañamiento profesional personalizado.',
              },
            ],
            preferences: {
              modality: parsedJson.needsProfile?.preferences?.modality || null,
              preferredTime: null,
              maxBudget: null,
            },
          },
          safety: {
            riskLevel: parsedJson.safety?.riskLevel || 'LOW',
            requiresImmediateHelp: false,
            flags: [],
          },
          conversation: {
            shouldContinue: true,
            isComplete: parsedJson.conversation?.isComplete || false,
            summary: parsedJson.conversation?.summary,
          },
        };
      }

      return validated.data as AIOrientationResult;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new AppError(
          'El servicio de orientación tardó más de lo esperado en responder. Por favor reintenta.',
          504
        );
      }
      throw new AppError(
        'No se pudo conectar con el proveedor de orientación en este momento.',
        503
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
