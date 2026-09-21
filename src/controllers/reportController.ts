import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { ReportReason, ReportStatus, PostStatus } from '@prisma/client';

const createReportSchema = z.object({
  channelId: z.string().uuid().optional().nullable(),
  postId: z.string().uuid().optional().nullable(),
  commentId: z.string().uuid().optional().nullable(),
  reason: z.nativeEnum(ReportReason),
  details: z.string().trim().max(1000).optional().nullable(),
}).refine(data => {
  const targets = [data.channelId, data.postId, data.commentId].filter(Boolean);
  return targets.length === 1;
}, {
  message: 'Debe especificar exactamente un objetivo para el reporte (canal, publicación o comentario)',
});

const reviewReportSchema = z.object({
  status: z.nativeEnum(ReportStatus),
  moderatorNotes: z.string().trim().max(1000).optional().nullable(),
});

const moderatePostSchema = z.object({
  action: z.enum(['HIDE', 'UNHIDE']),
  hiddenReason: z.string().trim().min(3, 'El motivo de moderación es obligatorio').max(500),
});

const moderateCommentSchema = z.object({
  action: z.enum(['HIDE', 'UNHIDE']),
  hiddenReason: z.string().trim().min(3, 'El motivo de moderación es obligatorio').max(500),
});

export const createReport = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const reporterId = req.user!.userId;
    const parsed = createReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { channelId, postId, commentId, reason, details } = parsed.data;

    // Verify entity existence
    if (channelId) {
      const channel = await prisma.communityChannel.findUnique({ where: { id: channelId } });
      if (!channel) throw new AppError('El canal reportado no existe', 404);
      
      const existing = await prisma.communityReport.findUnique({
        where: { reporterId_channelId: { reporterId, channelId } },
      });
      if (existing) throw new AppError('Ya has reportado este canal previamente', 400);
    }

    if (postId) {
      const post = await prisma.communityPost.findUnique({ where: { id: postId } });
      if (!post) throw new AppError('La publicación reportada no existe', 404);

      const existing = await prisma.communityReport.findUnique({
        where: { reporterId_postId: { reporterId, postId } },
      });
      if (existing) throw new AppError('Ya has reportado esta publicación previamente', 400);
    }

    if (commentId) {
      const comment = await prisma.postComment.findUnique({ where: { id: commentId } });
      if (!comment) throw new AppError('El comentario reportado no existe', 404);

      const existing = await prisma.communityReport.findUnique({
        where: { reporterId_commentId: { reporterId, commentId } },
      });
      if (existing) throw new AppError('Ya has reportado este comentario previamente', 400);
    }

    const report = await prisma.communityReport.create({
      data: {
        reporterId,
        channelId: channelId || null,
        postId: postId || null,
        commentId: commentId || null,
        reason,
        details: details || null,
        status: ReportStatus.PENDING,
      },
    });

    res.status(201).json({
      status: 'success',
      message: 'Reporte recibido. El equipo de moderación revisará el contenido.',
      data: { report },
    });
  } catch (error) {
    next(error);
  }
};

export const getReports = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));
    if (!isStaff) {
      throw new AppError('No autorizado para gestionar reportes', 403);
    }

    const { status, targetType, cursor, limit = '20' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);

    const where: any = {};
    if (status) {
      where.status = status as ReportStatus;
    }

    if (targetType === 'channel') {
      where.channelId = { not: null };
    } else if (targetType === 'post') {
      where.postId = { not: null };
    } else if (targetType === 'comment') {
      where.commentId = { not: null };
    }

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: { createdAt: 'desc' },
      include: {
        reporter: {
          select: { id: true, name: true, email: true },
        },
        reviewedBy: {
          select: { id: true, name: true },
        },
        channel: {
          select: { id: true, name: true, isActive: true },
        },
        post: {
          select: { id: true, title: true, status: true, author: { select: { id: true, name: true } } },
        },
        comment: {
          select: { id: true, content: true, isHidden: true, user: { select: { id: true, name: true } } },
        },
      },
    };

    if (cursor) {
      queryOptions.cursor = { id: String(cursor) };
      queryOptions.skip = 1;
    }

    const reports = await prisma.communityReport.findMany(queryOptions);
    const hasMore = reports.length > parsedLimit;
    const items = hasMore ? reports.slice(0, parsedLimit) : reports;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

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

export const reviewReport = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));
    if (!isStaff) {
      throw new AppError('No autorizado para gestionar reportes', 403);
    }

    const { id } = req.params;
    const reviewerId = req.user!.userId;

    const parsed = reviewReportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const report = await prisma.communityReport.findUnique({
      where: { id },
    });

    if (!report) {
      throw new AppError('Reporte no encontrado', 404);
    }

    const updated = await prisma.communityReport.update({
      where: { id },
      data: {
        status: parsed.data.status,
        moderatorNotes: parsed.data.moderatorNotes || null,
        reviewedById: reviewerId,
      },
      include: {
        reviewedBy: { select: { id: true, name: true } },
      },
    });

    res.status(200).json({
      status: 'success',
      message: 'Reporte actualizado exitosamente',
      data: { report: updated },
    });
  } catch (error) {
    next(error);
  }
};

export const moderatePost = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));
    if (!isStaff) {
      throw new AppError('No tienes permisos de moderación', 403);
    }

    const { id: postId } = req.params;
    const moderatorId = req.user!.userId;

    const parsed = moderatePostSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const post = await prisma.communityPost.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new AppError('Publicación no encontrada', 404);
    }

    const { action, hiddenReason } = parsed.data;

    let updated;
    if (action === 'HIDE') {
      updated = await prisma.communityPost.update({
        where: { id: postId },
        data: {
          status: PostStatus.HIDDEN,
          hiddenAt: new Date(),
          hiddenReason,
          hiddenById: moderatorId,
        },
      });
    } else {
      updated = await prisma.communityPost.update({
        where: { id: postId },
        data: {
          status: PostStatus.PUBLISHED,
          hiddenAt: null,
          hiddenReason: null,
          hiddenById: null,
        },
      });
    }

    res.status(200).json({
      status: 'success',
      message: action === 'HIDE' ? 'Publicación ocultada por moderación' : 'Publicación reactivada',
      data: { post: updated },
    });
  } catch (error) {
    next(error);
  }
};

export const moderateComment = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));
    if (!isStaff) {
      throw new AppError('No tienes permisos de moderación', 403);
    }

    const { id: commentId } = req.params;

    const parsed = moderateCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const comment = await prisma.postComment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new AppError('Comentario no encontrado', 404);
    }

    const { action, hiddenReason } = parsed.data;

    const updated = await prisma.postComment.update({
      where: { id: commentId },
      data: {
        isHidden: action === 'HIDE',
        hiddenAt: action === 'HIDE' ? new Date() : null,
        hiddenReason: action === 'HIDE' ? hiddenReason : null,
      },
    });

    res.status(200).json({
      status: 'success',
      message: action === 'HIDE' ? 'Comentario ocultado por moderación' : 'Comentario reactivado',
      data: { comment: updated },
    });
  } catch (error) {
    next(error);
  }
};
