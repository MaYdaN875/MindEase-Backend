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

    let request = await prisma.verificationRequest.findFirst({
      where: {
        OR: [
          { id: applicationId },
          { psychologistId: applicationId },
        ],
      },
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
      // Fallback: check if applicationId is a psychologistProfile id directly
      const profile = await prisma.psychologistProfile.findUnique({
        where: { id: applicationId },
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
      });

      if (!profile) {
        throw new AppError('Verification request or psychologist profile not found', 404);
      }

      request = {
        id: profile.id,
        psychologistId: profile.id,
        revisorId: null,
        status: profile.status === 'VERIFICADO' ? 'RESOLVED' : 'PENDING',
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        psychologist: profile,
        reviews: [],
      } as any;
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

export const listUsers = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { search, role, status } = req.query;

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.userRoles = {
        some: {
          role: {
            name: role as string,
          },
        },
      };
    }

    if (status) {
      where.psychologistProfile = {
        status: status as any,
      };
    }

    const users = await prisma.user.findMany({
      where,
      include: {
        userRoles: {
          include: {
            role: true,
          },
        },
        psychologistProfile: {
          include: {
            specialties: {
              include: {
                specialty: true,
              },
            },
            documents: {
              select: {
                id: true,
                documentType: true,
                status: true,
              },
            },
          },
        },
        consents: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        users,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listRoles = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: { name: 'asc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        roles,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateUserRoles = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { userId } = req.params;
    const { roles } = req.body;
    const adminId = req.user?.userId;

    if (!Array.isArray(roles) || roles.length === 0) {
      throw new AppError('Debes especificar al menos un rol válido', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    const validRoles = await prisma.role.findMany({
      where: { name: { in: roles } },
    });

    if (validRoles.length !== roles.length) {
      throw new AppError('Uno o más roles especificados no existen', 400);
    }

    await prisma.$transaction([
      prisma.userRole.deleteMany({
        where: { userId },
      }),
      prisma.userRole.createMany({
        data: validRoles.map((r) => ({
          userId,
          roleId: r.id,
        })),
      }),
    ]);

    await createAuditLog(adminId!, 'UPDATE_USER_ROLES', {
      targetUserId: userId,
      oldRoles: user.userRoles.map((ur) => ur.role.name),
      newRoles: roles,
    });

    res.status(200).json({
      status: 'success',
      message: 'Roles actualizados con éxito',
    });
  } catch (error) {
    next(error);
  }
};

export const updateUserStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { userId } = req.params;
    const { status } = req.body;
    const adminId = req.user?.userId;

    if (!status) {
      throw new AppError('Debes especificar el nuevo estado', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { psychologistProfile: true },
    });

    if (!user) {
      throw new AppError('Usuario no encontrado', 404);
    }

    const isSuspending = status === 'SUSPENDED' || status === 'SUSPENDIDO';

    // 1. Update User model status
    const newUserStatus = isSuspending ? 'SUSPENDED' : 'ACTIVE';
    await prisma.user.update({
      where: { id: userId },
      data: { status: newUserStatus },
    });

    // 2. If user is a psychologist, update psychologistProfile status accordingly
    if (user.psychologistProfile) {
      let newPsychologistStatus = status;
      if (isSuspending) {
        newPsychologistStatus = 'SUSPENDIDO';
      } else if (status === 'ACTIVE' || status === 'ACTIVO') {
        newPsychologistStatus = 'VERIFICADO';
      }

      await prisma.psychologistProfile.update({
        where: { id: user.psychologistProfile.id },
        data: { status: newPsychologistStatus as any },
      });

      await prisma.verificationStatusHistory.create({
        data: {
          psychologistId: user.psychologistProfile.id,
          fromStatus: user.psychologistProfile.status,
          toStatus: newPsychologistStatus as any,
          changedById: adminId!,
          comment: `Estado administrativo actualizado a ${newPsychologistStatus}`,
        },
      });
    }

    await createAuditLog(adminId!, 'UPDATE_USER_STATUS', {
      targetUserId: userId,
      newStatus: newUserStatus,
      psychologistStatus: user.psychologistProfile ? (isSuspending ? 'SUSPENDIDO' : 'VERIFICADO') : undefined,
    });

    res.status(200).json({
      status: 'success',
      message: `Estado del usuario actualizado a ${isSuspending ? 'SUSPENDIDO' : 'ACTIVO'}`,
    });
  } catch (error) {
    next(error);
  }
};

