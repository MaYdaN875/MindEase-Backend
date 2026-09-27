import { createHash } from 'crypto';
import prisma from '../../config/db';
import { AppError } from '../../middlewares/errorMiddleware';

export function aiPrivacyNotice() {
  const days = Number(process.env.AI_CONVERSATION_RETENTION_DAYS || 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid AI retention configuration');
  const gemini = (process.env.AI_PROVIDER || 'mock').toLowerCase() === 'gemini';
  const text = [
    'Solo para mayores de 18 años. Confirma tu mayoría de edad al aceptar.',
    'Esta herramienta ofrece orientación general, no diagnóstico, tratamiento, atención de crisis ni sustitución de un profesional.',
    gemini ? 'Tus mensajes y el contexto reciente se envían a Google Gemini para generar respuestas. No incluyas nombres completos, direcciones, identificaciones ni datos de terceros.'
      : 'Se utiliza un simulador local de orientación; no se envían mensajes a Google.',
    `MindEase conserva mensajes, resúmenes y recomendaciones hasta ${days} días desde el inicio de cada sesión. La eliminación automática se ejecuta diariamente.`,
    'Puedes retirar tu consentimiento y eliminar tu historial desde el menú de esta pantalla. Se conserva únicamente el registro de aceptación versionado; al retirar el consentimiento también se elimina ese registro.',
    'Eliminar el historial de MindEase no garantiza borrar copias ya procesadas por el proveedor ni respaldos sujetos a su propio ciclo de retención. Consulta el aviso de privacidad del servicio antes de compartir información.',
  ].join('\n\n');
  return { version: `v2-${createHash('sha256').update(text).digest('hex').slice(0, 20)}`, text, retentionDays: days, provider: gemini ? 'GOOGLE_GEMINI' : 'MOCK' };
}

export function assertAIDataConfiguration() {
  if ((process.env.AI_PROVIDER || 'mock').toLowerCase() === 'gemini' &&
      process.env.AI_GEMINI_DATA_POLICY_CONFIRMED !== 'true') {
    throw new AppError('La orientación no está habilitada: falta verificar la política de datos del proveedor.', 503);
  }
  if (process.env.NODE_ENV === 'production' && process.env.AI_RETENTION_ENABLED !== 'true') {
    throw new AppError('La orientación no está habilitada: falta configurar la retención.', 503);
  }
}

export async function assertAIConsent(userId: string, db: any = prisma) {
  assertAIDataConfiguration();
  const consent = await db.userConsent.findFirst({ where: {
    userId, consentType: `AI_ORIENTATION_${aiPrivacyNotice().version}`,
  } });
  if (!consent) throw new AppError('Debes aceptar el aviso vigente de orientación con IA.', 403);
}

export async function purgeExpiredAIData(now = new Date()) {
  const cutoff = new Date(now.getTime() - aiPrivacyNotice().retentionDays * 86400000);
  // Cascades remove messages and recommendations, never other clinical/payment records.
  return prisma.aIOrientationSession.deleteMany({ where: { createdAt: { lt: cutoff } } });
}

export function startAIRetention() {
  if (process.env.AI_RETENTION_ENABLED !== 'true') return () => {};
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await purgeExpiredAIData(); }
    catch { console.error('[AI_RETENTION_FAILED]'); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => void run(), 86400000);
  timer.unref();
  return () => clearInterval(timer);
}
