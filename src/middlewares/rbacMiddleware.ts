import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './authMiddleware';
import { AppError } from './errorMiddleware';

export const checkRole = (allowedRoles: string[]) => {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('Not authenticated', 401));
    }

    const { roles } = req.user;
    const hasRole = roles.some((role) => allowedRoles.includes(role));

    if (!hasRole) {
      return next(new AppError('Forbidden: Access is denied', 403));
    }

    next();
  };
};
