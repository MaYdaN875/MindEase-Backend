import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../middlewares/authMiddleware';
import { AppError } from '../../middlewares/errorMiddleware';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const userRequestMap = new Map<string, RateLimitRecord>();

// Cleanup de registros expirados cada 5 minutos para evitar fugas de memoria
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of userRequestMap.entries()) {
    if (now > value.resetAt) {
      userRequestMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

export const aiRateLimiter = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const userId = req.user?.userId;
  if (!userId) {
    return next(new AppError('No autorizado', 401));
  }

  const limit = parseInt(process.env.AI_RATE_LIMIT_PER_MINUTE || '15', 10);
  const windowMs = 60 * 1000;
  const now = Date.now();

  const record = userRequestMap.get(userId);

  if (!record || now > record.resetAt) {
    userRequestMap.set(userId, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (record.count >= limit) {
    const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
    return next(
      new AppError(
        `Has alcanzado el límite de mensajes por minuto para orientación con IA. Inténtalo de nuevo en ${retryAfterSeconds} segundos.`,
        429
      )
    );
  }

  record.count += 1;
  next();
};
