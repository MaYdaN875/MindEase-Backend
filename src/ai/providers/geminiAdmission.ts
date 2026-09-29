import prisma from '../../config/db';
import { AppError } from '../../middlewares/errorMiddleware';

// One shared bucket across this deployment, users, models and replicas.
// No prompts, credentials or user identifiers are stored here.
export const geminiAdmission = {
  async acquire(): Promise<void> {
    const rpm = Number(process.env.AI_GEMINI_REQUESTS_PER_MINUTE || '4');
    if (!Number.isInteger(rpm) || rpm < 1 || rpm > 1000) {
      throw new AppError('Configuración de capacidad de IA inválida.', 503, 'AI_CONFIGURATION_ERROR');
    }
    const intervalMs = Math.ceil(60000 / rpm);
    const admitted = await prisma.$queryRaw<Array<{ key: string }>>`
      INSERT INTO "AIProviderGate" ("key", "nextAllowedAt", "reason")
      VALUES ('gemini', clock_timestamp() + ${intervalMs} * interval '1 millisecond', 'AI_PROVIDER_RATE_LIMIT')
      ON CONFLICT ("key") DO UPDATE SET
        "nextAllowedAt" = clock_timestamp() + ${intervalMs} * interval '1 millisecond',
        "reason" = 'AI_PROVIDER_RATE_LIMIT'
      WHERE "AIProviderGate"."nextAllowedAt" <= clock_timestamp()
      RETURNING "key"`;
    if (admitted.length) return;
    const [gate] = await prisma.$queryRaw<Array<{ seconds: number; reason: string }>>`
      SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("nextAllowedAt" - clock_timestamp()))))::int AS seconds,
        "reason" FROM "AIProviderGate" WHERE "key" = 'gemini'`;
    const daily = gate?.reason === 'AI_PROVIDER_DAILY_QUOTA';
    throw new AppError(daily
      ? 'La cuota diaria de Google está agotada. Conservamos tu texto; vuelve más tarde o revisa la cuota del proyecto.'
      : 'El servicio de IA está en pausa para evitar más solicitudes. Conservamos tu texto.',
    429, gate?.reason || 'AI_PROVIDER_RATE_LIMIT', !daily, daily ? undefined : (gate?.seconds || 60));
  },
  async pause(seconds: number, reason: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "AIProviderGate" SET
        "reason" = CASE WHEN "nextAllowedAt" < clock_timestamp() + ${seconds} * interval '1 second'
          THEN ${reason} ELSE "reason" END,
        "nextAllowedAt" = GREATEST("nextAllowedAt", clock_timestamp() + ${seconds} * interval '1 second')
      WHERE "key" = 'gemini'`;
  },
};
