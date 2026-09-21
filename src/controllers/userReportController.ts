import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import {
  TicketCategory,
  TicketPriority,
  TicketSource,
  TicketStatus,
  UserReportReason,
  UserReportStatus,
} from '@prisma/client';

const createUserReportSchema = z.object({
  reportedUserId: z.string().uuid('ID de usuario a reportar inválido'),
  appointmentId: z.string().uuid().optional().nullable(),
  reason: z.nativeEnum(UserReportReason),
  description: z.string().trim().min(10, 'La descripción debe tener al menos 10 caracteres').max(2000),
  evidenceUrls: z.array(z.string().trim()).max(5).optional().default([]),
});

const investigateReportSchema = z.object({
  status: z.nativeEnum(UserReportStatus),
  moderatorNotes: z.string().trim().max(1000).optional().nullable(),
  escalateToTicket: z.boolean().optional().default(false),
});

const ensureModerationStaff = (req: AuthenticatedRequest) => {
  const userRoles = req.user?.roles || [];
  const isStaff = userRoles.some(r => ['MODERATOR', 'SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(r));
  if (!isStaff) {
    throw new AppError('Acceso denegado: se requieren privilegios de Moderación o Soporte', 403);
  }
};

// Create a new interpersonal conduct report against another user
export const createUserReport = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reporterId = req.user!.userId;

    const parsed = createUserReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { reportedUserId, appointmentId, reason, description, evidenceUrls } = parsed.data;

    if (reporterId === reportedUserId) {
      throw new AppError('No puedes reportarte a ti mismo', 400);
    }

    const reportedUser = await prisma.user.findUnique({
      where: { id: reportedUserId },
    });

    if (!reportedUser) {
      throw new AppError('El usuario que intentas reportar no existe', 404);
    }

    // If appointmentId is provided, verify participants
    if (appointmentId) {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: { psychologist: true },
      });

      if (!appointment) {
        throw new AppError('La cita especificada no existe', 404);
      }

      const isParticipant = appointment.userId === reporterId || appointment.psychologist.userId === reporterId;
      if (!isParticipant) {
        throw new AppError('Solo los participantes de la cita pueden vincularla al reporte', 403);
      }
    }

    // Check for duplicate pending report
    const existingPending = await prisma.userReport.findFirst({
      where: {
        reporterId,
        reportedUserId,
        appointmentId: appointmentId || null,
        status: { in: [UserReportStatus.PENDING, UserReportStatus.INVESTIGATING] },
      },
    });

    if (existingPending) {
      throw new AppError('Ya existe un reporte en revisión para este usuario en este contexto', 400);
    }

    const report = await prisma.userReport.create({
      data: {
        reporterId,
        reportedUserId,
        appointmentId: appointmentId || null,
        reason,
        description,
        evidenceUrls,
        status: UserReportStatus.PENDING,
      },
      include: {
        reportedUser: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json({
      status: 'success',
      message: 'Reporte registrado exitosamente. Será evaluado por el equipo de moderación.',
      data: { report },
    });
  } catch (error) {
    next(error);
  }
};

// List user reports for moderation/support staff
export const getUserReports = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureModerationStaff(req);

    const { status, reason, reportedUserId, cursor, limit = '20' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);

    const where: any = {};
    if (status) where.status = status as UserReportStatus;
    if (reason) where.reason = reason as UserReportReason;
    if (reportedUserId) where.reportedUserId = String(reportedUserId).trim();

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: { createdAt: 'desc' },
      include: {
        reporter: {
          select: { id: true, name: true, email: true },
        },
        reportedUser: {
          select: {
            id: true,
            name: true,
            email: true,
            psychologistProfile: { select: { id: true, status: true } },
          },
        },
        appointment: {
          select: { id: true, startAt: true, status: true, price: true },
        },
        reviewedBy: {
          select: { id: true, name: true },
        },
        ticket: {
          select: { id: true, ticketNumber: true, status: true },
        },
      },
    };

    if (cursor) {
      queryOptions.cursor = { id: String(cursor) };
      queryOptions.skip = 1;
    }

    const reports: any[] = await prisma.userReport.findMany(queryOptions);
    const hasMore = reports.length > parsedLimit;
    const items = hasMore ? reports.slice(0, parsedLimit) : reports;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    res.status(200).json({
      status: 'success',
      data: {
        items,
        nextCursor,
        hasMore,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Investigate, resolve, or escalate user report to a support ticket
export const investigateUserReport = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureModerationStaff(req);
    const { id } = req.params;
    const staffId = req.user!.userId;

    const parsed = investigateReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { status, moderatorNotes, escalateToTicket } = parsed.data;

    const report = await prisma.userReport.findUnique({
      where: { id },
      include: {
        reportedUser: { select: { name: true, email: true } },
        reporter: { select: { name: true, email: true } },
      },
    });

    if (!report) {
      throw new AppError('Reporte no encontrado', 404);
    }

    const result = await prisma.$transaction(async (tx) => {
      let createdTicket = null;

      if (escalateToTicket && !report.ticketId) {
        createdTicket = await tx.supportTicket.create({
          data: {
            userId: report.reporterId,
            assignedToId: staffId,
            source: TicketSource.USER_REPORT,
            category: TicketCategory.REPORT,
            priority: TicketPriority.HIGH,
            status: TicketStatus.IN_PROGRESS,
            subject: `Investigación de reporte conductual (${report.reason}) contra ${report.reportedUser.name}`,
            referenceType: 'USER_REPORT',
            referenceId: report.id,
            messages: {
              create: {
                senderId: staffId,
                content: `Ticket generado automáticamente por escalamiento de reporte. Motivo: ${report.reason}. Descripción del reportero: "${report.description}".`,
                isInternalNote: true,
              },
            },
          },
        });
      }

      const updatedReport = await tx.userReport.update({
        where: { id },
        data: {
          status,
          moderatorNotes: moderatorNotes || null,
          reviewedById: staffId,
          ...(createdTicket ? { ticketId: createdTicket.id } : {}),
        },
        include: {
          reviewedBy: { select: { id: true, name: true } },
          ticket: { select: { id: true, ticketNumber: true } },
        },
      });

      return { report: updatedReport, ticket: createdTicket };
    });

    res.status(200).json({
      status: 'success',
      message: 'Reporte actualizado exitosamente',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
