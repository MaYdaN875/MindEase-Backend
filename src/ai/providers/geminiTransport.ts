import { setTimeout as wait } from 'node:timers/promises';
import { AppError } from '../../middlewares/errorMiddleware';

function retryDelay(response: Response, body: any): number | undefined {
  const header = response.headers?.get?.('retry-after');
  if (header) {
    const seconds = /^\d+(\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  }
  const details = body?.error?.details;
  if (!Array.isArray(details)) return undefined;
  const delay = details.find((d: any) => typeof d?.retryDelay === 'string')?.retryDelay;
  if (typeof delay === 'string' && /^\d+(\.\d+)?s$/.test(delay)) return Math.max(1, Math.ceil(Number(delay.slice(0, -1))));
  return undefined;
}

export async function fetchGemini(endpoint: string, options: RequestInit, budgetMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const deadline = Date.now() + budgetMs;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let failure: AppError;
      try {
        const response = await fetch(endpoint, { ...options, signal: controller.signal });
        if (response.ok) {
          try { return await response.json(); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            throw new AppError('El proveedor devolvió una respuesta inválida. No se descontó ningún mensaje.', 502, 'AI_RESPONSE_INVALID');
          }
        }
        // Only inspect machine-readable retry/quota metadata; never expose the upstream message.
        const body: any = response.status === 429 ? await response.json().catch(() => null) : null;
        const delay = retryDelay(response, body);
        const dailyQuota = Array.isArray(body?.error?.details) && body.error.details.some((d: any) =>
          Array.isArray(d?.violations) && d.violations.some((v: any) => /perday|per_day|daily/i.test(String(v?.quotaId || ''))));
        if (response.status === 429) {
          failure = new AppError('Google alcanzó un límite de solicitudes o cuota. Tu mensaje sigue disponible para reintentar.',
            429, 'AI_PROVIDER_QUOTA', !dailyQuota && delay !== undefined, delay, 429);
        } else if (response.status === 503 || response.status === 502 || response.status === 500 || response.status === 504) {
          failure = new AppError('Google no puede responder temporalmente. Conservamos tu mensaje.',
            503, 'AI_PROVIDER_BUSY', true, delay, response.status);
        } else if (response.status === 408) {
          failure = new AppError('El proveedor agotó el tiempo de respuesta. Puedes reintentar.', 504, 'AI_PROVIDER_TIMEOUT', true, delay, 408);
        } else {
          failure = new AppError('No se pudo completar la solicitud al proveedor. Requiere revisión de configuración.',
            502, response.status === 401 || response.status === 403 ? 'AI_PROVIDER_AUTH' : 'AI_PROVIDER_REQUEST_REJECTED', false, undefined, response.status);
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (controller.signal.aborted) throw error;
        failure = new AppError('No fue posible conectar con Google. Conservamos tu mensaje.', 503, 'AI_PROVIDER_NETWORK', true);
      }
      const delayMs = failure.retryAfterSeconds !== undefined ? failure.retryAfterSeconds * 1000
        : 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      if (!failure.retryable || attempt === 2 || Date.now() + delayMs >= deadline) throw failure;
      await wait(delayMs, undefined, { signal: controller.signal });
    }
    throw new AppError('El proveedor no está disponible.', 503, 'AI_PROVIDER_BUSY', true);
  } catch (error) {
    if (controller.signal.aborted) throw new AppError('La respuesta tardó demasiado. Tu mensaje no se perdió; puedes reintentar.', 504, 'AI_PROVIDER_TIMEOUT', true);
    if (error instanceof AppError) throw error;
    throw new AppError('No fue posible conectar con Google.', 503, 'AI_PROVIDER_NETWORK', true);
  } finally { clearTimeout(timer); }
}
