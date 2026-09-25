import { IAIProvider } from './aiProvider.interface';
import { AIConversationContext, AIOrientationResult } from '../types/ai.types';
import { buildSystemPrompt } from '../prompts/orientationPrompt';
import { aiOrientationResultSchema } from '../schemas/aiOrientationSchema';
import { AppError } from '../../middlewares/errorMiddleware';

export class GeminiAIProvider implements IAIProvider {
  readonly providerName = 'GEMINI';

  private static cachedWorkingModel: string | null = null;
  private readonly apiKey: string;
  private readonly configuredModel: string;
  private readonly timeoutMs: number;

  constructor(apiKey?: string, modelName?: string, timeoutMs?: number) {
    this.apiKey = (apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    this.configuredModel = (modelName || process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
    this.timeoutMs = timeoutMs || parseInt(process.env.AI_TIMEOUT_MS || '20000', 10);
  }

  /**
   * Consulta ModelService.ListModels de Google Gemini para seleccionar
   * dinámicamente un modelo disponible y compatible con generateContent.
   */
  private async discoverModelFromApi(): Promise<string> {
    try {
      const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`;
      const res = await fetch(listUrl);
      if (res.ok) {
        const data: any = await res.json();
        const models: any[] = data?.models || [];
        const supported = models.filter((m: any) =>
          m.supportedGenerationMethods?.includes('generateContent')
        );

        if (supported.length > 0) {
          // Priorizar modelos modernos según recomendación de Google
          const preferred =
            supported.find((m: any) => m.name.includes('3.8-flash')) ||
            supported.find((m: any) => m.name.includes('3.8')) ||
            supported.find((m: any) => m.name.includes('2.0-flash')) ||
            supported.find((m: any) => m.name.includes('1.5-flash-latest')) ||
            supported.find((m: any) => m.name.includes('flash')) ||
            supported.find((m: any) => m.name.includes('gemini-pro')) ||
            supported[0];

          const cleanName = preferred.name.replace(/^models\//, '');
          console.log(`[Gemini Dynamic Model Discovery] Selected working model: ${cleanName}`);
          GeminiAIProvider.cachedWorkingModel = cleanName;
          return cleanName;
        }
      }
    } catch (err) {
      console.error('[Gemini Model Discovery Error]', err);
    }

    return 'gemini-3.8-flash';
  }

  private async getInitialModel(): Promise<string> {
    if (GeminiAIProvider.cachedWorkingModel) {
      return GeminiAIProvider.cachedWorkingModel;
    }
    return this.configuredModel.replace(/^models\//, '');
  }

  async generateOrientation(context: AIConversationContext): Promise<AIOrientationResult> {
    if (!this.apiKey) {
      throw new AppError(
        'La clave de API de Gemini (GEMINI_API_KEY) no está configurada en las variables de entorno.',
        500
      );
    }

    const systemPrompt = buildSystemPrompt(context.availableSpecialties);

    // Formatear historial cumpliendo las reglas de Gemini:
    // 1. La secuencia debe comenzar SIEMPRE con el rol 'user'
    // 2. Los roles deben alternar estrictamente entre 'user' y 'model'
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    const firstUserIndex = context.history.findIndex(m => m.role === 'USER');
    const validHistory = firstUserIndex >= 0 ? context.history.slice(firstUserIndex) : [];

    for (const msg of validHistory) {
      const geminiRole = msg.role === 'USER' ? 'user' : 'model';
      if (contents.length > 0 && contents[contents.length - 1].role === geminiRole) {
        contents[contents.length - 1].parts[0].text += `\n${msg.content}`;
      } else {
        contents.push({
          role: geminiRole,
          parts: [{ text: msg.content }],
        });
      }
    }

    // Agregar el mensaje actual del usuario
    if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
      contents[contents.length - 1].parts[0].text += `\n${context.userMessage}`;
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: context.userMessage }],
      });
    }

    let activeModel = await this.getInitialModel();
    const requestPayload = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    };

    const executeRequest = async (model: string, apiVersion: string = 'v1beta') => {
      const endpoint = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${this.apiKey}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(requestPayload),
        });
        return res;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      let response = await executeRequest(activeModel, 'v1beta');

      // Si da 404, verificar si el mensaje sugiere un modelo específico o usar descubrimiento
      if (response.status === 404) {
        const errorText = await response.text();
        console.warn(`[Gemini] Model ${activeModel} returned 404. Response:`, errorText);

        // Si Google indica explícitamente qué modelo usar: "Please update your code to use models/gemini-3.8-flash"
        const suggestedMatch = errorText.match(/models\/([a-zA-Z0-9.-]+)/);
        if (suggestedMatch && suggestedMatch[1] && suggestedMatch[1] !== activeModel) {
          activeModel = suggestedMatch[1];
          console.log(`[Gemini] Google explicitly suggested model: ${activeModel}. Retrying...`);
          response = await executeRequest(activeModel, 'v1beta');
        } else {
          const discovered = await this.discoverModelFromApi();
          if (discovered !== activeModel) {
            activeModel = discovered;
            response = await executeRequest(activeModel, 'v1beta');
          }
        }

        // Si todavía da 404 en v1beta, intentar en v1
        if (response.status === 404) {
          console.warn(`[Gemini] Retrying model ${activeModel} on v1 endpoint...`);
          response = await executeRequest(activeModel, 'v1');
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Gemini API Error HTTP ${response.status}]:`, errorText);
        let errorDetail = `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed?.error?.message) {
            errorDetail = parsed.error.message;
          }
        } catch (_) {}
        throw new AppError(`Error en el proveedor de IA: ${errorDetail}`, 502);
      }

      // Guardar el modelo que funcionó para futuras peticiones
      GeminiAIProvider.cachedWorkingModel = activeModel;

      const jsonResponse: any = await response.json();
      const rawText =
        jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

      if (!rawText) {
        throw new AppError('El proveedor de IA no devolvió contenido para este mensaje.', 502);
      }

      let parsedJson: any;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (parseError) {
        console.error('[Gemini JSON Parse Error] Raw text was:', rawText);
        throw new AppError('El proveedor de IA devolvió una estructura JSON no interpretable.', 502);
      }

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
      if (err instanceof AppError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AppError(
          'El servicio de orientación tardó más de lo esperado en responder. Por favor reintenta.',
          504
        );
      }
      console.error('[Gemini Request Exception]:', err);
      throw new AppError(
        err.message || 'No se pudo conectar con el proveedor de orientación en este momento.',
        503
      );
    }
  }
}
