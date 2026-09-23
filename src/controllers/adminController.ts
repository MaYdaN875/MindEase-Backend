import { Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { uploadDir } from '../middlewares/uploadMiddleware';
import { UserStatus } from '@prisma/client';
import { serializable } from '../services/clinicalPolicy';
import { reviewApplication } from '../services/verification';

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

export const assignRevisor = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await reviewApplication(req.params.applicationId, req.user!.userId, 'ASSIGN', req.body?.notes);
    res.status(200).json({ status: 'success', message: 'Solicitud actualizada correctamente' });
  } catch (error) { next(error); }
};

export const approveApplication = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await reviewApplication(req.params.applicationId, req.user!.userId, 'APPROVE', req.body?.notes);
    res.status(200).json({ status: 'success', message: 'Solicitud actualizada correctamente' });
  } catch (error) { next(error); }
};

export const requestChanges = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await reviewApplication(req.params.applicationId, req.user!.userId, 'REQUEST_CHANGES', req.body?.notes);
    res.status(200).json({ status: 'success', message: 'Solicitud actualizada correctamente' });
  } catch (error) { next(error); }
};

export const rejectApplication = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await reviewApplication(req.params.applicationId, req.user!.userId, 'REJECT', req.body?.notes);
    res.status(200).json({ status: 'success', message: 'Solicitud actualizada correctamente' });
  } catch (error) { next(error); }
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
      requesterRoles.includes('ADMIN') || requesterRoles.includes('REVISOR') || requesterRoles.includes('SUPERADMIN');
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

export const updateDocumentStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { documentId } = req.params;
    const { status, expiresAt } = req.body;
    const adminId = req.user?.userId;

    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      throw new AppError('Estado de documento no válido (PENDING, APPROVED, REJECTED)', 400);
    }

    const document = await prisma.professionalDocument.findUnique({
      where: { id: documentId },
      include: {
        psychologist: true,
      },
    });

    if (!document) {
      throw new AppError('Documento no encontrado', 404);
    }

    const updateData: any = {
      status,
    };

    if (expiresAt !== undefined) {
      if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw new AppError('Fecha de expiración inválida', 400);
      updateData.expiresAt = expiresAt ? new Date(expiresAt) : null;
    }

    const updatedDocument = await prisma.professionalDocument.update({
      where: { id: documentId },
      data: updateData,
    });

    await createAuditLog(adminId!, 'UPDATE_DOCUMENT_STATUS', {
      documentId,
      psychologistId: document.psychologistId,
      documentType: document.documentType,
      oldStatus: document.status,
      newStatus: status,
      expiresAt: updateData.expiresAt,
    });

    res.status(200).json({
      status: 'success',
      data: {
        document: updatedDocument,
      },
      message: `Documento ${document.documentType} marcado como ${status}`,
    });
  } catch (error) {
    next(error);
  }
};

export const getAuditLogs = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { search, action, limit } = req.query;

    const where: any = {};

    if (action && typeof action === 'string' && action !== 'all') {
      where.action = action;
    }

    if (search && typeof search === 'string') {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { ipAddress: { contains: search } },
      ];
    }

    const take = limit ? parseInt(limit as string, 10) : 100;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
      include: {
        user: {
          select: {
            id: true,
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
      if (!Object.values(UserStatus).includes(status as UserStatus)) throw new AppError('Estado de cuenta inválido', 400);
      where.status = status;
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

export const updateUserRoles = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { roles } = req.body;
    const userId = req.params.userId;
    if (!Array.isArray(roles) || !roles.length || roles.some(r => typeof r !== 'string') || new Set(roles).size !== roles.length) throw new AppError('Especifica roles únicos válidos', 400);
    await serializable(async tx => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { userRoles: { include: { role: true } }, psychologistProfile: true } });
      if (!user) throw new AppError('Usuario no encontrado', 404);
      const oldRoles = user.userRoles.map(r => r.role.name);
      if ((roles.includes('SUPERADMIN') || oldRoles.includes('SUPERADMIN')) && !req.user!.roles.includes('SUPERADMIN')) throw new AppError('Solo SUPERADMIN puede gestionar este rol', 403);
      if (userId === req.user!.userId && !roles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r))) throw new AppError('No puedes retirar tu propio acceso administrativo', 400);
      if (roles.includes('PSYCHOLOGIST_VERIFIED') && user.psychologistProfile?.status !== 'VERIFICADO') throw new AppError('El rol profesional requiere una acreditación aprobada', 400);
      const valid = await tx.role.findMany({ where: { name: { in: roles } } });
      if (valid.length !== roles.length) throw new AppError('Uno o más roles no existen', 400);
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({ data: valid.map(r => ({ userId, roleId: r.id })) });
      await tx.auditLog.create({ data: { userId: req.user!.userId, action: 'UPDATE_USER_ROLES', details: { targetUserId: userId, oldRoles, newRoles: roles } } });
    });
    res.status(200).json({ status: 'success', message: 'Roles actualizados' });
  } catch (error) { next(error); }
};

export const updateUserStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status } = req.body;
    if (!Object.values(UserStatus).includes(status)) throw new AppError('Estado de cuenta inválido', 400);
    const userId = req.params.userId;
    if (userId === req.user!.userId && status !== 'ACTIVE') throw new AppError('No puedes desactivar tu propia cuenta administrativa', 400);
    await serializable(async tx => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { userRoles: { include: { role: true } } } });
      if (!user) throw new AppError('Usuario no encontrado', 404);
      if (user.userRoles.some(r => r.role.name === 'SUPERADMIN') && !req.user!.roles.includes('SUPERADMIN')) throw new AppError('Solo SUPERADMIN puede modificar esta cuenta', 403);
      await tx.user.update({ where: { id: userId }, data: { status } });
      await tx.auditLog.create({ data: { userId: req.user!.userId, action: 'UPDATE_USER_STATUS', details: { targetUserId: userId, oldStatus: user.status, newStatus: status } } });
      await tx.notification.create({ data: { userId, title: 'Estado de cuenta actualizado', content: 'El estado de tu cuenta cambió a ' + status + '.' } });
    });
    res.status(200).json({ status: 'success', message: 'Estado de cuenta actualizado' });
  } catch (error) { next(error); }
};

export const listSpecialties = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const specialties = await prisma.specialty.findMany({
      include: {
        _count: {
          select: {
            psychologists: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        specialties,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const createSpecialty = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name } = req.body;
    const adminId = req.user?.userId;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError('El nombre de la especialidad es obligatorio', 400);
    }

    const trimmedName = name.trim();

    const existing = await prisma.specialty.findFirst({
      where: { name: { equals: trimmedName, mode: 'insensitive' } },
    });

    if (existing) {
      throw new AppError('Ya existe una especialidad con este nombre', 409);
    }

    const specialty = await prisma.specialty.create({
      data: { name: trimmedName },
    });

    await createAuditLog(adminId!, 'CREATE_SPECIALTY', {
      specialtyId: specialty.id,
      name: specialty.name,
    });

    res.status(201).json({
      status: 'success',
      data: {
        specialty,
      },
      message: 'Especialidad creada con éxito',
    });
  } catch (error) {
    next(error);
  }
};

export const updateSpecialty = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { specialtyId } = req.params;
    const { name } = req.body;
    const adminId = req.user?.userId;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError('El nombre de la especialidad es obligatorio', 400);
    }

    const trimmedName = name.trim();

    const specialty = await prisma.specialty.findUnique({
      where: { id: specialtyId },
    });

    if (!specialty) {
      throw new AppError('Especialidad no encontrada', 404);
    }

    const duplicate = await prisma.specialty.findFirst({
      where: {
        name: { equals: trimmedName, mode: 'insensitive' },
        id: { not: specialtyId },
      },
    });

    if (duplicate) {
      throw new AppError('Ya existe otra especialidad con este nombre', 409);
    }

    const updated = await prisma.specialty.update({
      where: { id: specialtyId },
      data: { name: trimmedName },
    });

    await createAuditLog(adminId!, 'UPDATE_SPECIALTY', {
      specialtyId,
      oldName: specialty.name,
      newName: trimmedName,
    });

    res.status(200).json({
      status: 'success',
      data: {
        specialty: updated,
      },
      message: 'Especialidad actualizada con éxito',
    });
  } catch (error) {
    next(error);
  }
};

export const deleteSpecialty = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { specialtyId } = req.params;
    const adminId = req.user?.userId;

    const specialty = await prisma.specialty.findUnique({
      where: { id: specialtyId },
      include: {
        _count: {
          select: {
            psychologists: true,
          },
        },
      },
    });

    if (!specialty) {
      throw new AppError('Especialidad no encontrada', 404);
    }

    if (specialty._count.psychologists > 0) {
      throw new AppError(
        `No se puede eliminar la especialidad porque está asignada a ${specialty._count.psychologists} psicólogo(s).`,
        400
      );
    }

    await prisma.specialty.delete({
      where: { id: specialtyId },
    });

    await createAuditLog(adminId!, 'DELETE_SPECIALTY', {
      specialtyId,
      deletedName: specialty.name,
    });

    res.status(200).json({
      status: 'success',
      message: 'Especialidad eliminada con éxito',
    });
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------
// Dashboard & Analytics
// ----------------------------------------------------
export const getDashboardStats = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      totalPsychologists,
      verifiedPsychologists,
      pendingRequests,
      resolvedRequests,
      statusGroups,
      topSpecialties,
      recentAuditLogs,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { status: 'SUSPENDED' } }),
      prisma.psychologistProfile.count(),
      prisma.psychologistProfile.count({ where: { status: 'VERIFICADO' } }),
      prisma.verificationRequest.count({ where: { status: 'PENDING' } }),
      prisma.verificationRequest.count({ where: { status: 'RESOLVED' } }),
      prisma.psychologistProfile.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      prisma.specialty.findMany({
        select: {
          id: true,
          name: true,
          _count: {
            select: { psychologists: true },
          },
        },
        orderBy: {
          psychologists: { _count: 'desc' },
        },
        take: 5,
      }),
      prisma.auditLog.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
    ]);

    const approvedReviews = await prisma.verificationReview.count({
      where: { decision: 'APPROVE' },
    });
    const rejectedReviews = await prisma.verificationReview.count({
      where: { decision: 'REJECT' },
    });
    const totalDecisions = approvedReviews + rejectedReviews;
    const approvalRate = totalDecisions > 0 ? Math.round((approvedReviews / totalDecisions) * 100) : 100;

    const statusDistribution: Record<string, number> = {};
    for (const group of statusGroups) {
      statusDistribution[group.status] = group._count.id;
    }

    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalUsers,
          activeUsers,
          suspendedUsers,
          totalPsychologists,
          verifiedPsychologists,
          pendingRequests,
          resolvedRequests,
          approvalRate,
          statusDistribution,
          topSpecialties: topSpecialties.map((s) => ({
            id: s.id,
            name: s.name,
            count: s._count.psychologists,
          })),
          recentAuditLogs,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------
// Security & Compliance CSV Export
// ----------------------------------------------------
export const exportAuditLogsCsv = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const adminId = req.user?.userId;
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    const csvRows = [
      ['Timestamp', 'Admin / User Name', 'Email', 'Action', 'IP Address', 'Details'].join(','),
    ];

    for (const log of logs) {
      const timestamp = new Date(log.createdAt).toISOString();
      const userName = (log.user?.name || 'System / Automated').replace(/"/g, '""');
      const userEmail = (log.user?.email || 'N/A').replace(/"/g, '""');
      const action = (log.action || '').replace(/"/g, '""');
      const ip = (log.ipAddress || '127.0.0.1').replace(/"/g, '""');
      const details = JSON.stringify(log.details || {}).replace(/"/g, '""');

      csvRows.push(
        `"${timestamp}","${userName}","${userEmail}","${action}","${ip}","${details}"`
      );
    }

    await createAuditLog(adminId!, 'DATA_EXPORT', {
      format: 'CSV',
      totalRecords: logs.length,
    });

    const csvContent = csvRows.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="mindease_compliance_audit_logs.csv"'
    );
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
};

// ----------------------------------------------------
// System Notifications Management
// ----------------------------------------------------
export const listNotifications = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    const notifications = await prisma.notification.findMany({
      where: {
        userId,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    const unreadCount = await prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });

    res.status(200).json({
      status: 'success',
      data: {
        notifications,
        unreadCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const markNotificationRead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { notificationId } = req.params;

    const ownNotification = await prisma.notification.findFirst({ where: { id: notificationId, userId: req.user!.userId } });
    if (!ownNotification) throw new AppError('Notificación no encontrada', 404);

    const notification = await prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });

    res.status(200).json({
      status: 'success',
      data: { notification },
    });
  } catch (error) {
    next(error);
  }
};

export const markAllNotificationsRead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    res.status(200).json({
      status: 'success',
      message: 'Todas las notificaciones marcadas como leídas',
    });
  } catch (error) {
    next(error);
  }
};

export const broadcastNotification = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const adminId = req.user?.userId;
    const { title, message, targetUserId } = req.body;

    if (!title || !message) {
      throw new AppError('Título y mensaje son obligatorios', 400);
    }

    if (targetUserId) {
      const notif = await prisma.notification.create({
        data: {
          userId: targetUserId,
          title,
          content: message,
          isRead: false,
        },
      });

      await createAuditLog(adminId!, 'BROADCAST_NOTIFICATION', {
        targetUserId,
        title,
      });

      res.status(201).json({
        status: 'success',
        data: { notification: notif },
        message: 'Notificación enviada al usuario',
      });
      return;
    }

    const allUsers = await prisma.user.findMany({ select: { id: true } });
    await prisma.notification.createMany({
      data: allUsers.map((u) => ({
        userId: u.id,
        title,
        content: message,
        isRead: false,
      })),
    });

    await createAuditLog(adminId!, 'BROADCAST_NOTIFICATION', {
      broadcastCount: allUsers.length,
      title,
    });

    res.status(201).json({
      status: 'success',
      message: `Aviso emitido a ${allUsers.length} usuarios del sistema`,
    });
  } catch (error) {
    next(error);
  }
};
