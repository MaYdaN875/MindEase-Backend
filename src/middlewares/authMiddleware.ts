import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { AppError } from './errorMiddleware';
import prisma from '../config/db';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

export const authMiddleware = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('No token provided, authorization denied', 401));
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) return next(new AppError('La cuenta ya no existe', 401));
    if (user.status !== 'ACTIVE') return next(new AppError('La cuenta no se encuentra activa', 403));
    req.user = { userId: user.id, roles: user.userRoles.map(ur => ur.role.name) };
    next();
  } catch (error) {
    if (error instanceof Error && ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      next(new AppError('Token is not valid or expired', 401));
    } else { next(error); }
  }
};

export const optionalAuthMiddleware = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (user && user.status === 'ACTIVE') {
      req.user = { userId: user.id, roles: user.userRoles.map(ur => ur.role.name) };
    }
  } catch (_e) {
    // Silently proceed for optional auth
  }
  next();
};

