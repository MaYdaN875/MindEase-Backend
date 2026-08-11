import { Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { uploadDir } from '../middlewares/uploadMiddleware';

const updateProfileSchema = z.object({
  description: z.string().optional(),
  academicBackground: z.string().optional(),
  experience: z.string().optional(),
  consultationPrice: z.number().nonnegative().optional(),
  availability: z.any().optional(), // Can store JSON scheduler template
  languages: z.string().optional(),
  location: z.string().optional(),
  licenseNumber: z.string().optional(),
  specialties: z.array(z.string()).optional(), // Array of specialty names
});

export const getProfile = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
      include: {
        specialties: {
          include: {
            specialty: true,
          },
        },
        documents: true,
      },
    });

    if (!profile) {
      throw new AppError('Psychologist profile not found', 404);
    }

    res.status(200).json({
      status: 'success',
      data: {
        profile,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateProfile = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const validated = updateProfileSchema.parse(req.body);

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new AppError('Psychologist profile not found', 404);
    }

    const { specialties, ...textFields } = validated;

    // Update main text details
    await prisma.psychologistProfile.update({
      where: { id: profile.id },
      data: textFields,
    });

    // Update specialties if provided
    if (specialties) {
      // Clear previous mapping
      await prisma.psychologistSpecialty.deleteMany({
        where: { psychologistId: profile.id },
      });

      // Upsert specialties and create links
      for (const specName of specialties) {
        const specialty = await prisma.specialty.upsert({
          where: { name: specName },
          update: {},
          create: { name: specName },
        });

        await prisma.psychologistSpecialty.create({
          data: {
            psychologistId: profile.id,
            specialtyId: specialty.id,
          },
        });
      }
    }

    const fullProfile = await prisma.psychologistProfile.findUnique({
      where: { id: profile.id },
      include: {
        specialties: {
          include: {
            specialty: true,
          },
        },
        documents: true,
      },
    });

    res.status(200).json({
      status: 'success',
      data: {
        profile: fullProfile,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(error.errors[0].message, 400));
    }
    next(error);
  }
};

export const uploadDocument = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { documentType } = req.body;
    const file = req.file;

    if (!file) {
      throw new AppError('No file uploaded', 400);
    }

    if (!documentType || !['ID', 'DEGREE', 'LICENSE', 'OTHER'].includes(documentType)) {
      throw new AppError('Invalid or missing documentType. Must be ID, DEGREE, LICENSE or OTHER', 400);
    }

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      // Cleanup uploaded file since profile doesn't exist
      fs.unlinkSync(file.path);
      throw new AppError('Psychologist profile not found', 404);
    }

    // Save document details
    const document = await prisma.professionalDocument.create({
      data: {
        psychologistId: profile.id,
        documentType,
        storageKey: file.filename,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
      },
    });

    res.status(201).json({
      status: 'success',
      data: {
        document,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const deleteDocument = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { documentId } = req.params;

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new AppError('Psychologist profile not found', 404);
    }

    const document = await prisma.professionalDocument.findUnique({
      where: { id: documentId },
    });

    if (!document || document.psychologistId !== profile.id) {
      throw new AppError('Document not found or access denied', 404);
    }

    // Delete file from disk
    const filePath = path.join(uploadDir, document.storageKey);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete record from DB
    await prisma.professionalDocument.delete({
      where: { id: documentId },
    });

    res.status(200).json({
      status: 'success',
      message: 'Document deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

export const submitForReview = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
      include: {
        documents: true,
      },
    });

    if (!profile) {
      throw new AppError('Psychologist profile not found', 404);
    }

    // Verification check: Needs license and at least 2 key documents (ID and DEGREE/LICENSE)
    if (!profile.licenseNumber || !profile.description) {
      throw new AppError('Completa tu número de cédula y semblanza profesional antes de enviar', 400);
    }

    const hasID = profile.documents.some((doc) => doc.documentType === 'ID');
    const hasDegree = profile.documents.some((doc) => doc.documentType === 'DEGREE' || doc.documentType === 'LICENSE');

    if (!hasID || !hasDegree) {
      throw new AppError('Debes subir por lo menos tu identificación oficial y tu título/cédula profesional', 400);
    }

    const oldStatus = profile.status;
    const newStatus = 'PENDIENTE_REVISION';

    if (oldStatus === newStatus) {
      throw new AppError('La solicitud ya se encuentra pendiente de revisión', 400);
    }

    // Update status
    await prisma.psychologistProfile.update({
      where: { id: profile.id },
      data: { status: newStatus },
    });

    // Log in history
    await prisma.verificationStatusHistory.create({
      data: {
        psychologistId: profile.id,
        fromStatus: oldStatus,
        toStatus: newStatus,
        changedById: userId!,
        comment: 'Solicitud enviada por el psicólogo para validación',
      },
    });

    // Create verification request
    await prisma.verificationRequest.create({
      data: {
        psychologistId: profile.id,
        status: 'PENDING',
      },
    });

    res.status(200).json({
      status: 'success',
      message: 'Solicitud enviada con éxito. El estado actual es PENDIENTE_REVISION',
    });
  } catch (error) {
    next(error);
  }
};

export const getReviewStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new AppError('Psychologist profile not found', 404);
    }

    const history = await prisma.verificationStatusHistory.findMany({
      where: { psychologistId: profile.id },
      orderBy: { changedAt: 'desc' },
      include: {
        changedBy: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    res.status(200).json({
      status: 'success',
      data: {
        currentStatus: profile.status,
        history,
      },
    });
  } catch (error) {
    next(error);
  }
};
