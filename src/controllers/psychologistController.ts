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

export const getVerifiedPsychologists = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { specialty, search } = req.query;

    const whereClause: any = {
      status: 'VERIFICADO',
      user: {
        status: 'ACTIVE',
      },
    };

    if (search && typeof search === 'string') {
      whereClause.OR = [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { description: { contains: search, mode: 'insensitive' } },
        { academicBackground: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (specialty && typeof specialty === 'string') {
      whereClause.specialties = {
        some: {
          specialty: {
            name: { contains: specialty, mode: 'insensitive' },
          },
        },
      };
    }

    const psychologists = await prisma.psychologistProfile.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        specialties: {
          include: {
            specialty: true,
          },
        },
        availabilities: {
          where: { isActive: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        psychologists,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getPublicProfileById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const profile = await prisma.psychologistProfile.findFirst({
      where: {
        OR: [{ id }, { userId: id }],
        status: 'VERIFICADO',
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        specialties: {
          include: {
            specialty: true,
          },
        },
        availabilities: {
          where: { isActive: true },
        },
      },
    });

    if (!profile) {
      throw new AppError('Psicólogo no encontrado o no verificado', 404);
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

export const getPsychologistDashboard = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
      },
    });

    if (!profile) {
      throw new AppError('No posees un perfil de psicólogo registrado', 404);
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 1. Next immediate appointment (upcoming or scheduled for today)
    const nextAppointment = await prisma.appointment.findFirst({
      where: {
        psychologistId: profile.id,
        status: { in: ['CONFIRMED', 'PENDING'] },
        OR: [
          { startAt: { gte: now } },
          { startAt: { gte: startOfToday } },
        ],
      },
      orderBy: { startAt: 'asc' },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        consultation: true,
      },
    });

    // 2. Metric counts
    const upcomingCount = await prisma.appointment.count({
      where: {
        psychologistId: profile.id,
        status: 'CONFIRMED',
        startAt: { gte: now },
      },
    });

    const pendingCount = await prisma.appointment.count({
      where: {
        psychologistId: profile.id,
        status: 'PENDING',
      },
    });

    const completedCount = await prisma.appointment.count({
      where: {
        psychologistId: profile.id,
        status: 'COMPLETED',
      },
    });

    // Distinct patients count
    const distinctPatients = await prisma.appointment.groupBy({
      by: ['userId'],
      where: {
        psychologistId: profile.id,
        status: { notIn: ['CANCELLED'] },
      },
    });
    const totalPatientsCount = distinctPatients.length;

    // Monthly Earnings (sum of price of CONFIRMED or COMPLETED appointments in current month)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthlyAppointments = await prisma.appointment.findMany({
      where: {
        psychologistId: profile.id,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        startAt: { gte: startOfMonth },
      },
      select: { price: true },
    });
    const monthlyEarnings = monthlyAppointments.reduce(
      (acc, curr) => acc + (curr.price || 0),
      0
    );

    // 3. Recent Activity (last 5 appointments created or updated)
    const recentAppointments = await prisma.appointment.findMany({
      where: { psychologistId: profile.id },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        user: {
          select: { id: true, name: true },
        },
      },
    });

    const recentActivity = recentAppointments.map((appt) => {
      let title = `Cita con ${appt.user.name}`;
      if (appt.status === 'CONFIRMED') title = `Cita confirmada con ${appt.user.name}`;
      else if (appt.status === 'COMPLETED') title = `Consulta completada con ${appt.user.name}`;
      else if (appt.status === 'CANCELLED') title = `Cita cancelada con ${appt.user.name}`;
      else if (appt.status === 'PENDING') title = `Nueva solicitud de cita de ${appt.user.name}`;

      return {
        id: appt.id,
        title,
        status: appt.status,
        timestamp: appt.updatedAt,
        startAt: appt.startAt,
        patientName: appt.user.name,
      };
    });

    res.status(200).json({
      status: 'success',
      data: {
        doctor: {
          id: profile.id,
          name: profile.user.name,
          email: profile.user.email,
          status: profile.status,
          consultationPrice: profile.consultationPrice,
        },
        nextAppointment,
        stats: {
          upcomingCount,
          pendingCount,
          completedCount,
          totalPatientsCount,
          monthlyEarnings,
        },
        recentActivity,
      },
    });
  } catch (error) {
    next(error);
  }
};


