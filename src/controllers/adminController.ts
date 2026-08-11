import { Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { uploadDir } from '../middlewares/uploadMiddleware';

const createAuditLog = async (userId: string | null, action: string, details: any): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        details,
      },
    });
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
};

export const listApplications = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { status } = req.query;

    const applications = await prisma.verificationRequest.findMany({
      where: status ? { status: status as string } : undefined,
      include: {
        psychologist: {
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
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        applications,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getApplication = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { applicationId } = req.params;

    const request = await prisma.verificationRequest.findUnique({
      where: { id: applicationId },
      include: {
        psychologist: {
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
            documents: true,
            statusHistory: {
              include: {
                changedBy: {
                  select: {
                    name: true,
                    email: true,
                  },
                },
              },
              orderBy: { changedAt: 'desc' },
            },
          },
        },
        reviews: true,
      },
    });

    if (!request) {
      throw new AppError('Verification request not found', 404);
    }

    res.status(200).json({
      status: 'success',
      data: {
        request,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const assignRevisor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { applicationId } = req.params;
    const adminId = req.user?.userId;

    const request = await prisma.verificationRequest.findUnique({
      where: { id: applicationId },
    });

    if (!request) {
      throw new AppError('Verification request not found', 404);
    }

    await prisma.verificationRequest.update({
      where: { id: applicationId },
      data: {
        revisorId: adminId,
        status: 'IN_PROGRESS',
      },
    });

    // Log status transition to EN_REVISION on psychologist profile
    await prisma.psychologistProfile.update({
      where: { id: request.psychologistId },
      data: { status: 'EN_REVISION' },
    });

    await prisma.verificationStatusHistory.create({
      data: {
        psychologistId: request.psychologistId,
        fromStatus: 'PENDIENTE_REVISION',
        toStatus: 'EN_REVISION',
        changedById: adminId!,
        comment: 'Asignado a revisor administrativo',
      },
    });

    await createAuditLog(adminId!, 'ASSIGN_REVISOR', { applicationId, revisorId: adminId });

    res.status(200).json({
      status: 'success',
      message: 'Revisor asignado con éxito. Estado: EN_REVISION',
    });
  } catch (error) {
    next(error);
  }
};

export const approveApplication = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { applicationId } = req.params;
    const adminId = req.user?.userId;

    const request = await prisma.verificationRequest.findUnique({
      where: { id: applicationId },
      include: { psychologist: true },
    });

    if (!request) {
      throw new AppError('Verification request not found', 404);
    }

    const psychologist = request.psychologist;

    // 1. Update psychologist status to VERIFICADO
    const oldStatus = psychologist.status;
    await prisma.psychologistProfile.update({
      where: { id: psychologist.id },
      data: { status: 'VERIFICADO' },
    });

    // 2. Map role role to PSYCHOLOGIST_VERIFIED and remove PSYCHOLOGIST_APPLICANT
    const roleApplicant = await prisma.role.findUnique({ where: { name: 'PSYCHOLOGIST_APPLICANT' } });
    const roleVerified = await prisma.role.findUnique({ where: { name: 'PSYCHOLOGIST_VERIFIED' } });

    if (roleApplicant && roleVerified) {
      // Remove applicant relationship
      await prisma.userRole.delete({
        where: {
          userId_roleId: {
            userId: psychologist.userId,
            roleId: roleApplicant.id,
          },
        },
      });

      // Add verified role relationship
      await prisma.userRole.create({
        data: {
          userId: psychologist.userId,
          roleId: roleVerified.id,
        },
      });
    }

    // 3. Log history
    await prisma.verificationStatusHistory.create({
      data: {
        psychologistId: psychologist.id,
        fromStatus: oldStatus,
        toStatus: 'VERIFICADO',
        changedById: adminId!,
        comment: 'Solicitud aprobada e incorporación como profesional certificado',
      },
    });

    // 4. Create Review and close request
    await prisma.verificationReview.create({
      data: {
        requestId: applicationId,
        revisorId: adminId!,
        decision: 'APPROVE',
        notes: 'Documentación y cédula validadas correctamente',
      },
    });

    await prisma.verificationRequest.update({
      where: { id: applicationId },
      data: { status: 'RESOLVED' },
    });

    await createAuditLog(adminId!, 'APPROVE_APPLICATION', { applicationId, psychologistId: psychologist.id });

    res.status(200).json({
      status: 'success',
      message: 'Solicitud aprobada con éxito. El psicólogo ya es un profesional verificado.',
    });
  } catch (error) {
    next(error);
  }
};

export const requestChanges = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { applicationId } = req.params;
    const { notes } = req.body;
    const adminId = req.user?.userId;

    if (!notes) {
      throw new AppError('Indica qué cambios son requeridos', 400);
    }

    const request = await prisma.verificationRequest.findUnique({
      where: { id: applicationId },
      include: { psychologist: true },
    });

    if (!request) {
      throw new AppError('Verification request not found', 404);
    }

    const psychologist = request.psychologist;
    const oldStatus = psychologist.status;

    // 1. Update psychologist status to REQUIERE_CAMBIOS
    await prisma.psychologistProfile.update({
      where: { id: psychologist.id },
      data: { status: 'REQUIERE_CAMBIOS' },
    });

    // 2. Log history
    await prisma.verificationStatusHistory.create({
      data: {
        psychologistId: psychologist.id,
        fromStatus: oldStatus,
        toStatus: 'REQUIERE_CAMBIOS',
        changedById: adminId!,
        comment: `Observaciones: ${notes}`,
      },
    });

    // 3. Create Review & close request
    await prisma.verificationReview.create({
      data: {
        requestId: applicationId,
        revisorId: adminId!,
        decision: 'REQUEST_CHANGES',
        notes,
      },
    });

    await prisma.verificationRequest.update({
      where: { id: applicationId },
      data: { status: 'RESOLVED' },
    });

    await createAuditLog(adminId!, 'REQUEST_CHANGES', { applicationId, notes });

    res.status(200).json({
      status: 'success',
      message: 'Solicitud marcada para corrección. Se han notificado las observaciones.',
    });
  } catch (error) {
    next(error);
  }
};

export const rejectApplication = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { applicationId } = req.params;
    const { notes } = req.body;
    const adminId = req.user?.userId;

    if (!notes) {
      throw new AppError('Indica el motivo de rechazo administrativo', 400);
    }

    const request = await prisma.verificationRequest.findUnique({
      where: { id: applicationId },
      include: { psychologist: true },
    });

    if (!request) {
      throw new AppError('Verification request not found', 404);
    }

    const psychologist = request.psychologist;
    const oldStatus = psychologist.status;

    // 1. Update status to RECHAZADO
    await prisma.psychologistProfile.update({
      where: { id: psychologist.id },
      data: { status: 'RECHAZADO' },
    });

    // 2. Log history
    await prisma.verificationStatusHistory.create({
      data: {
        psychologistId: psychologist.id,
        fromStatus: oldStatus,
        toStatus: 'RECHAZADO',
        changedById: adminId!,
        comment: `Rechazo administrativo: ${notes}`,
      },
    });

    // 3. Create review & close request
    await prisma.verificationReview.create({
      data: {
        requestId: applicationId,
        revisorId: adminId!,
        decision: 'REJECT',
        notes,
      },
    });

    await prisma.verificationRequest.update({
      where: { id: applicationId },
      data: { status: 'RESOLVED' },
    });

    await createAuditLog(adminId!, 'REJECT_APPLICATION', { applicationId, notes });

    res.status(200).json({
      status: 'success',
      message: 'Solicitud rechazada correctamente.',
    });
  } catch (error) {
    next(error);
  }
};

export const downloadDocument = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { documentId } = req.params;
    const requesterId = req.user?.userId;
    const requesterRoles = req.user?.roles || [];

    const document = await prisma.professionalDocument.findUnique({
      where: { id: documentId },
      include: {
        psychologist: true,
      },
    });

    if (!document) {
      throw new AppError('Document not found', 404);
    }

    const isAdminOrRevisor =
      requesterRoles.includes('ADMIN') || requesterRoles.includes('REVISOR');
    const isOwner = document.psychologist.userId === requesterId;

    if (!isAdminOrRevisor && !isOwner) {
      throw new AppError('Unauthorized access to private document', 403);
    }

    const filePath = path.join(uploadDir, document.storageKey);

    if (!fs.existsSync(filePath)) {
      throw new AppError('File not found on private storage server', 404);
    }

    // Log the file access audit
    await createAuditLog(requesterId!, 'VIEW_DOCUMENT', {
      documentId,
      filename: document.originalFilename,
    });

    res.setHeader('Content-Type', document.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(document.originalFilename)}"`
    );
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
};

export const getAuditLogs = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
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
        logs,
      },
    });
  } catch (error) {
    next(error);
  }
};
