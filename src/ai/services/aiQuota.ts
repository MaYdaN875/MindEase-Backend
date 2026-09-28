import { AppError } from '../../middlewares/errorMiddleware';

export function orientationQuota(messages: Array<{ role: string }>) {
  const limit = Number(process.env.AI_MAX_MESSAGES_PER_SESSION || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError('El límite de orientación no está configurado correctamente.', 503, 'AI_CONFIGURATION_ERROR');
  }
  // Count answered user turns, not greetings, responses, or old failed/abandoned user messages.
  let used = 0;
  let pendingUser = false;
  for (const message of messages) {
    if (message.role === 'USER') pendingUser = true;
    else if (message.role === 'ASSISTANT' && pendingUser) { used++; pendingUser = false; }
  }
  return { limit, used, remaining: Math.max(0, limit - used) };
}
