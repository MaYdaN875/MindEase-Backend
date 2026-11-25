import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';

const registerDeviceTokenSchema = z.object({
  token: z.string().trim().min(20).max(512),
  platform: z.enum(['android', 'ios', 'web']).optional().default('android'),
});

const unregisterDeviceTokenSchema = z.object({
  token: z.string().trim().min(20).max(512),
});

export const getMyNotifications = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return next(new AppError('No autenticado', 401));
    }

    const { limit = '50', isRead } = req.query;
    const take = parseInt(limit as string, 10) || 50;

    const where: any = { userId };
    if (isRead !== undefined) {
      where.isRead = isRead === 'true';
    }

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
      prisma.notification.count({
        where: { userId, isRead: false },
      }),
    ]);

    res.status(200).json({
      status: 'success',
      unreadCount,
      data: notifications,
    });
  } catch (error) {
    next(error);
  }
};

export const markAsRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) {
      return next(new AppError('No autenticado', 401));
    }

    const notification = await prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      return next(new AppError('Notificación no encontrada', 404));
    }

    if (notification.userId !== userId) {
      return next(new AppError('No autorizado para modificar esta notificación', 403));
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });

    res.status(200).json({
      status: 'success',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const markAllAsRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return next(new AppError('No autenticado', 401));
    }

    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    res.status(200).json({
      status: 'success',
      message: 'Todas las notificaciones han sido marcadas como leídas',
    });
  } catch (error) {
    next(error);
  }
};

export const registerDeviceToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return next(new AppError('No autenticado', 401));
    }

    const { token, platform } = registerDeviceTokenSchema.parse(req.body);

    // Reassign token to the current user in case another account used this device previously.
    await prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform, lastSeenAt: new Date() },
      update: { userId, platform, lastSeenAt: new Date() },
    });

    res.status(200).json({
      status: 'success',
      message: 'Dispositivo registrado para notificaciones',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError('Token de dispositivo inválido', 400));
    }
    next(error);
  }
};

export const unregisterDeviceToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return next(new AppError('No autenticado', 401));
    }

    const { token } = unregisterDeviceTokenSchema.parse(req.body);

    await prisma.deviceToken.deleteMany({
      where: { userId, token },
    });

    res.status(200).json({
      status: 'success',
      message: 'Dispositivo desvinculado de notificaciones',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError('Token de dispositivo inválido', 400));
    }
    next(error);
  }
};
