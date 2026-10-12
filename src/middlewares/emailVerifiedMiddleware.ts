import { Response, NextFunction } from 'express';
import prisma from '../config/db';
import { AuthenticatedRequest } from './authMiddleware';
import { AppError } from './errorMiddleware';

export const requireVerifiedEmail = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt) {
      return next(new AppError('Debes verificar tu correo electrónico para continuar.', 403, 'EMAIL_NOT_VERIFIED'));
    }
    next();
  } catch (error) {
    next(error);
  }
};
