import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number,
    public code?: string,
    public retryable = false,
    public retryAfterSeconds?: number,
    public providerStatus?: number,
  ) {
    super(message);
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  // Prisma/parser/provider exceptions may contain conversation text. Never expose them for AI routes.
  if (_req.originalUrl.startsWith('/api/ai/')) {
    const details = err instanceof AppError ? {
      code: err.code || 'AI_REQUEST_FAILED', retryable: err.retryable,
      retryAfterSeconds: err.retryAfterSeconds,
    } : { code: 'AI_INTERNAL_ERROR', retryable: false };
    console.error(`[AI_REQUEST_FAILED] status=${statusCode} code=${details.code}${err instanceof AppError && err.providerStatus ? ` providerStatus=${err.providerStatus}` : ''}`);
    if (details.retryAfterSeconds) res.setHeader('Retry-After', String(details.retryAfterSeconds));
    res.status(statusCode).json({ status: 'error', statusCode,
      ...details,
      message: err instanceof AppError ? err.message : 'No se pudo procesar la solicitud de orientación.' });
    return;
  }
  const message = err.message || 'Internal Server Error';

  console.error(`[Error] ${statusCode} - ${message}`, err);

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
