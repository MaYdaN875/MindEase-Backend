import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../../config/db';
import { AuthenticatedRequest } from '../../middlewares/authMiddleware';
import { AppError } from '../../middlewares/errorMiddleware';
import { AIOrientationService } from '../services/aiOrientationService';

const messageSchema = z.object({
  message: z
    .string({ required_error: 'El mensaje es obligatorio' })
    .trim()
    .min(1, 'El mensaje no puede estar vacío')
    .max(2000, 'El mensaje supera la longitud máxima permitida (2000 caracteres)'),
});

export const getConsentStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const consent = await prisma.userConsent.findFirst({
      where: {
        userId,
        consentType: 'AI_ORIENTATION_CONSENT',
      },
    });

    res.status(200).json({
      status: 'success',
      data: {
        hasConsent: !!consent,
        acceptedAt: consent?.acceptedAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const registerConsent = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const existing = await prisma.userConsent.findFirst({
      where: {
        userId,
        consentType: 'AI_ORIENTATION_CONSENT',
      },
    });

    if (existing) {
      res.status(200).json({
        status: 'success',
        message: 'Consentimiento ya registrado previamente',
        data: { consent: existing },
      });
      return;
    }

    const consent = await prisma.userConsent.create({
      data: {
        userId,
        consentType: 'AI_ORIENTATION_CONSENT',
      },
    });

    res.status(201).json({
      status: 'success',
      message: 'Consentimiento de orientación con IA registrado con éxito',
      data: { consent },
    });
  } catch (error) {
    next(error);
  }
};

export const createSession = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;

    // Verificar consentimiento antes de iniciar
    const consent = await prisma.userConsent.findFirst({
      where: {
        userId,
        consentType: 'AI_ORIENTATION_CONSENT',
      },
    });

    if (!consent) {
      throw new AppError(
        'Debes aceptar el consentimiento informado antes de iniciar la orientación con IA.',
        403
      );
    }

    const session = await AIOrientationService.createOrGetSession(userId);

    res.status(201).json({
      status: 'success',
      data: { session },
    });
  } catch (error) {
    next(error);
  }
};

export const getActiveSession = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const session = await AIOrientationService.getActiveSession(userId);

    res.status(200).json({
      status: 'success',
      data: { session: session || null },
    });
  } catch (error) {
    next(error);
  }
};

export const getSessionById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const session = await AIOrientationService.getSessionById(userId, id);

    res.status(200).json({
      status: 'success',
      data: { session },
    });
  } catch (error) {
    next(error);
  }
};

export const sendMessage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const result = await AIOrientationService.processMessage(
      userId,
      id,
      parsed.data.message
    );

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const completeSession = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const recommendations = await AIOrientationService.completeSession(userId, id);

    res.status(200).json({
      status: 'success',
      message: 'Orientación completada exitosamente',
      data: recommendations,
    });
  } catch (error) {
    next(error);
  }
};

export const getRecommendations = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const recommendations = await AIOrientationService.getRecommendations(userId, id);

    res.status(200).json({
      status: 'success',
      data: recommendations,
    });
  } catch (error) {
    next(error);
  }
};
