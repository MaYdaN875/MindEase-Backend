import { Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { uploadDir } from '../middlewares/uploadMiddleware';
import { eligibleProfessionalWhere, serializable } from '../services/clinicalPolicy';

const updateProfileSchema = z.object({
  description: z.string().optional(),
  academicBackground: z.string().optional(),
  experience: z.string().optional(),
  consultationPrice: z.number().nonnegative().optional(),
  availability: z.any().optional(), // Can store JSON scheduler template
  languages: z.string().optional(),
  location: z.string().optional(),
  licenseNumber: z.string().optional(),
  autoConfirmAppointments: z.boolean().optional(),
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

export const updateProfile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400);
    const fullProfile = await serializable(async tx => {
      const profile = await tx.psychologistProfile.findUnique({ where: { userId: req.user!.userId } });
      if (!profile) throw new AppError('Perfil no encontrado', 404);
      const { specialties, ...textFields } = parsed.data;
      if (textFields.licenseNumber !== undefined && textFields.licenseNumber !== profile.licenseNumber && ['VERIFICADO', 'EN_REVISION', 'PENDIENTE_REVISION'].includes(profile.status)) throw new AppError('La cédula no puede cambiar durante o después de la acreditación', 409);
      await tx.psychologistProfile.update({ where: { id: profile.id }, data: textFields });
      if (specialties) {
        await tx.psychologistSpecialty.deleteMany({ where: { psychologistId: profile.id } });
        for (const name of new Set(specialties.map(s => s.trim()).filter(Boolean))) {
          const specialty = await tx.specialty.upsert({ where: { name }, update: {}, create: { name } });
          await tx.psychologistSpecialty.create({ data: { psychologistId: profile.id, specialtyId: specialty.id } });
        }
      }
      return tx.psychologistProfile.findUnique({ where: { id: profile.id }, include: { specialties: { include: { specialty: true } }, documents: true } });
    });
    res.status(200).json({ status: 'success', data: { profile: fullProfile } });
  } catch (error) { next(error); }
};

export const uploadDocument = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = req.file;
    if (!file) throw new AppError('No se recibió un archivo', 400);
    const { documentType } = req.body;
    if (!['ID', 'DEGREE', 'LICENSE', 'OTHER'].includes(documentType)) throw new AppError('Tipo de documento inválido', 400);
    const bytes = await fs.promises.readFile(file.path);
    const ext = path.extname(file.originalname).toLowerCase();
    const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!((ext === '.pdf' && pdf) || (ext === '.png' && png) || (['.jpg', '.jpeg'].includes(ext) && jpg))) throw new AppError('El contenido no corresponde a un PDF o imagen válido', 400);
    const document = await serializable(async tx => {
      const profile = await tx.psychologistProfile.findUnique({ where: { userId: req.user!.userId } });
      if (!profile) throw new AppError('Perfil no encontrado', 404);
      if (!['REGISTRO_INCOMPLETO', 'REQUIERE_CAMBIOS', 'RECHAZADO'].includes(profile.status)) throw new AppError('Los documentos están bloqueados durante la revisión y después de la acreditación', 409);
      return tx.professionalDocument.create({ data: { psychologistId: profile.id, documentType, storageKey: file.filename, originalFilename: file.originalname, mimeType: pdf ? 'application/pdf' : png ? 'image/png' : 'image/jpeg', fileSize: file.size } });
    });
    res.status(201).json({ status: 'success', data: { document } });
  } catch (error) {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => undefined);
    next(error);
  }
};

export const deleteDocument = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const document = await serializable(async tx => {
      const profile = await tx.psychologistProfile.findUnique({ where: { userId: req.user!.userId } });
      if (!profile) throw new AppError('Perfil no encontrado', 404);
      if (!['REGISTRO_INCOMPLETO', 'REQUIERE_CAMBIOS', 'RECHAZADO'].includes(profile.status)) throw new AppError('Los documentos están bloqueados durante la revisión y después de la acreditación', 409);
      const document = await tx.professionalDocument.findUnique({ where: { id: req.params.documentId } });
      if (!document || document.psychologistId !== profile.id) throw new AppError('Documento no encontrado', 404);
      await tx.professionalDocument.delete({ where: { id: document.id } });
      return document;
    });
    await fs.promises.unlink(path.join(uploadDir, path.basename(document.storageKey))).catch(() => undefined);
    res.status(200).json({ status: 'success', message: 'Documento eliminado' });
  } catch (error) { next(error); }
};

export const submitForReview = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await serializable(async tx => {
      const userId = req.user!.userId;
      const profile = await tx.psychologistProfile.findUnique({ where: { userId }, include: { documents: true } });
      if (!profile) throw new AppError('Perfil no encontrado', 404);
      if (!['REGISTRO_INCOMPLETO', 'REQUIERE_CAMBIOS', 'RECHAZADO'].includes(profile.status)) throw new AppError('El perfil no admite una nueva solicitud', 409);
      if (!profile.licenseNumber?.trim() || !profile.description?.trim()) throw new AppError('Completa tu cédula y semblanza profesional', 400);
      if (!['ID', 'DEGREE', 'LICENSE'].every(type => profile.documents.some(d => d.documentType === type))) throw new AppError('Sube identificación, título y cédula profesional', 400);
      if (await tx.verificationRequest.findFirst({ where: { psychologistId: profile.id, status: { in: ['PENDING', 'IN_PROGRESS'] } } })) throw new AppError('Ya existe una solicitud abierta', 409);
      await tx.psychologistProfile.update({ where: { id: profile.id }, data: { status: 'PENDIENTE_REVISION' } });
      await tx.verificationStatusHistory.create({ data: { psychologistId: profile.id, fromStatus: profile.status, toStatus: 'PENDIENTE_REVISION', changedById: userId, comment: 'Solicitud enviada por el profesional' } });
      await tx.verificationRequest.create({ data: { psychologistId: profile.id, status: 'PENDING' } });
    });
    res.status(200).json({ status: 'success', message: 'Solicitud enviada para revisión' });
  } catch (error) { next(error); }
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

    const whereClause: any = { ...eligibleProfessionalWhere };

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
        psychologists: await Promise.all(psychologists.map(async profile => {
          const stats = await prisma.patientReview.aggregate({ where: { appointment: { psychologistId: profile.id, status: 'COMPLETED', consultation: { status: 'COMPLETED' } } }, _avg: { rating: true }, _count: true });
          return { ...profile, rating: stats._avg.rating, reviewsCount: stats._count };
        })),
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
        ...eligibleProfessionalWhere,
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
