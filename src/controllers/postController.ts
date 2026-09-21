import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { PostMediaType, PostStatus } from '@prisma/client';

const postMediaSchema = z.object({
  type: z.nativeEnum(PostMediaType),
  url: z.string().trim().min(1, 'La URL del recurso es obligatoria'),
  thumbnailUrl: z.string().trim().url().optional().nullable(),
  caption: z.string().trim().max(255).optional().nullable(),
  sizeBytes: z.number().int().positive().optional().nullable(),
});

const postCreateSchema = z.object({
  channelId: z.string().uuid('ID de canal inválido'),
  title: z.string().trim().min(3, 'El título debe tener al menos 3 caracteres').max(200, 'El título no puede exceder 200 caracteres'),
  content: z.string().trim().min(10, 'El contenido debe tener al menos 10 caracteres'),
  tags: z.array(z.string().trim().min(1)).max(10, 'Máximo 10 etiquetas').optional().default([]),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional().default('PUBLISHED'),
  media: z.array(postMediaSchema).max(5, 'Máximo 5 elementos multimedia por publicación').optional().default([]),
});

const postUpdateSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  content: z.string().trim().min(10).optional(),
  tags: z.array(z.string().trim().min(1)).max(10).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  media: z.array(postMediaSchema).max(5).optional(),
});

const commentCreateSchema = z.object({
  content: z.string().trim().min(1, 'El comentario no puede estar vacío').max(1000, 'El comentario no puede superar 1000 caracteres'),
});

// Upload media handler for files handled by multer
export const uploadPostMedia = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) {
      throw new AppError('No se ha subido ningún archivo', 400);
    }

    const isPdf = req.file.mimetype === 'application/pdf';
    const mediaType: PostMediaType = isPdf ? PostMediaType.DOCUMENT : PostMediaType.IMAGE;
    const fileUrl = `/uploads/community/${req.file.filename}`;

    res.status(200).json({
      status: 'success',
      data: {
        url: fileUrl,
        type: mediaType,
        sizeBytes: req.file.size,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Helper to notify channel followers asynchronously
const notifyChannelFollowers = async (channelId: string, postTitle: string, channelName: string, postId: string) => {
  try {
    const followers = await prisma.channelFollow.findMany({
      where: { channelId },
      select: { userId: true },
    });

    if (followers.length === 0) return;

    const notificationsData = followers.map(f => ({
      userId: f.userId,
      title: `Nueva publicación en ${channelName}`,
      content: postTitle,
      type: 'COMMUNITY_NEW_POST',
      referenceId: postId,
      isRead: false,
    }));

    await prisma.notification.createMany({
      data: notificationsData,
    });
  } catch (err) {
    console.error('[Community Notification] Error notifying channel followers:', err);
  }
};

export const createPost = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const userRoles = req.user?.roles || [];

    if (!userId) {
      throw new AppError('Autenticación requerida', 401);
    }

    // Role check: PSYCHOLOGIST_VERIFIED or ADMIN
    const isPsychologist = userRoles.includes('PSYCHOLOGIST_VERIFIED');
    const isAdmin = userRoles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r));

    if (!isPsychologist && !isAdmin) {
      throw new AppError('Solo psicólogos verificados pueden crear publicaciones', 403);
    }

    const parsed = postCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { channelId, title, content, tags, status, media } = parsed.data;

    // Check channel existence and ownership
    const channel = await prisma.communityChannel.findUnique({
      where: { id: channelId },
      include: { psychologist: true },
    });

    if (!channel || !channel.isActive) {
      throw new AppError('El canal no existe o está desactivado', 404);
    }

    if (channel.psychologist.userId !== userId && !isAdmin) {
      throw new AppError('No tienes autorización para publicar en este canal', 403);
    }

    const isPublished = status === 'PUBLISHED';

    const post: any = await prisma.communityPost.create({
      data: {
        channelId,
        authorId: userId,
        title,
        content,
        tags,
        status: status as PostStatus,
        publishedAt: isPublished ? new Date() : null,
        media: {
          create: media.map(m => ({
            type: m.type,
            url: m.url,
            thumbnailUrl: m.thumbnailUrl,
            caption: m.caption,
            sizeBytes: m.sizeBytes,
          })),
        },
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            psychologistProfile: {
              select: {
                id: true,
                photoUrl: true,
              },
            },
          },
        },
        channel: {
          select: {
            id: true,
            name: true,
            coverImageUrl: true,
            category: { select: { id: true, name: true, slug: true } },
          },
        },
        media: true,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    if (isPublished) {
      // Asynchronously notify followers
      notifyChannelFollowers(channelId, post.title, channel.name, post.id);
    }

    res.status(201).json({
      status: 'success',
      message: isPublished ? 'Publicación creada y publicada con éxito' : 'Borrador guardado con éxito',
      data: {
        post: {
          ...post,
          likesCount: post._count.likes,
          commentsCount: post._count.comments,
          isLiked: false,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getPosts = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      channelId,
      category,
      tag,
      search,
      following,
      mine,
      status = 'PUBLISHED',
      cursor,
      limit = '20',
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);
    const userId = req.user?.userId;
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));

    const where: any = {};

    // Filter by status:
    // Only author or admin/moderator can request non-PUBLISHED posts.
    if (status !== 'PUBLISHED') {
      if (!userId) {
        throw new AppError('No autorizado para ver publicaciones no públicas', 403);
      }
      const isPsychologist = userRoles.includes('PSYCHOLOGIST_VERIFIED');
      if (!isAdmin && !isPsychologist) {
        throw new AppError('No autorizado para consultar publicaciones en este estado', 403);
      }
      if (!isAdmin) {
        // Normal psychologist can only see their own non-published posts
        where.authorId = userId;
      }
      where.status = status as PostStatus;
    } else {

      where.status = 'PUBLISHED';
      // Ensure channel is active
      where.channel = { isActive: true };
    }

    if (channelId) {
      where.channelId = String(channelId);
    }

    if (category) {
      const catStr = String(category).trim();
      where.channel = {
        ...(where.channel || {}),
        category: {
          OR: [
            { slug: catStr },
            { id: catStr },
          ],
        },
      };
    }

    if (tag) {
      where.tags = {
        has: String(tag).trim(),
      };
    }

    if (search) {
      const q = String(search).trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { content: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (following === 'true') {
      if (!userId) {
        throw new AppError('Autenticación requerida para ver publicaciones seguidas', 401);
      }
      where.channel = {
        ...(where.channel || {}),
        followers: {
          some: { userId },
        },
      };
    }

    if (mine === 'true') {
      if (!userId) {
        throw new AppError('Autenticación requerida para consultar tus publicaciones', 401);
      }
      where.authorId = userId;
    }

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            psychologistProfile: {
              select: {
                id: true,
                photoUrl: true,
              },
            },
          },
        },
        channel: {
          select: {
            id: true,
            name: true,
            coverImageUrl: true,
            category: { select: { id: true, name: true, slug: true } },
          },
        },
        media: true,
        _count: {
          select: {
            likes: true,
            comments: { where: { isHidden: false } },
          },
        },
      },
    };

    if (cursor) {
      queryOptions.cursor = { id: String(cursor) };
      queryOptions.skip = 1;
    }

    const posts: any[] = await prisma.communityPost.findMany(queryOptions);

    const hasMore = posts.length > parsedLimit;
    const items: any[] = hasMore ? posts.slice(0, parsedLimit) : posts;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    // Check user likes if authenticated
    let likedPostIds = new Set<string>();
    if (userId && items.length > 0) {
      const likes = await prisma.postLike.findMany({
        where: {
          userId,
          postId: { in: items.map(p => p.id) },
        },
        select: { postId: true },
      });
      likedPostIds = new Set(likes.map(l => l.postId));
    }

    const formatted = items.map((post: any) => ({
      ...post,
      likesCount: post._count.likes,
      commentsCount: post._count.comments,
      isLiked: likedPostIds.has(post.id),
      isAuthor: post.authorId === userId,
    }));

    res.status(200).json({
      status: 'success',
      data: {
        items: formatted,
        nextCursor,
        hasMore,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getPostById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));

    const post: any = await prisma.communityPost.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            psychologistProfile: {
              select: {
                id: true,
                photoUrl: true,
              },
            },
          },
        },
        channel: {
          select: {
            id: true,
            name: true,
            coverImageUrl: true,
            isActive: true,
            category: { select: { id: true, name: true, slug: true } },
            psychologist: {
              select: {
                id: true,
                userId: true,
              },
            },
          },
        },
        media: true,
        _count: {
          select: {
            likes: true,
            comments: { where: { isHidden: false } },
          },
        },
      },
    });

    if (!post) {
      throw new AppError('Publicación no encontrada', 404);
    }

    // Access control: if not PUBLISHED or channel inactive, only author or admin can view
    const isOwner = post.authorId === userId;
    if ((post.status !== 'PUBLISHED' || !post.channel.isActive) && !isOwner && !isAdmin) {
      throw new AppError('La publicación no está disponible', 404);
    }

    let isLiked = false;
    if (userId) {
      const like = await prisma.postLike.findUnique({
        where: {
          userId_postId: {
            userId,
            postId: post.id,
          },
        },
      });
      isLiked = !!like;
    }

    res.status(200).json({
      status: 'success',
      data: {
        post: {
          ...post,
          likesCount: post._count.likes,
          commentsCount: post._count.comments,
          isLiked,
          isAuthor: isOwner,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updatePost = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r));

    const post = await prisma.communityPost.findUnique({
      where: { id },
      include: { channel: true },
    });

    if (!post) {
      throw new AppError('Publicación no encontrada', 404);
    }

    if (post.authorId !== userId && !isAdmin) {
      throw new AppError('No tienes permisos para modificar esta publicación', 403);
    }

    const parsed = postUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { title, content, tags, status, media } = parsed.data;

    // Check if status is transitioning to PUBLISHED
    let publishedAt = post.publishedAt;
    let shouldNotify = false;
    if (status === 'PUBLISHED' && post.status !== 'PUBLISHED') {
      publishedAt = new Date();
      shouldNotify = true;
    }

    // Execute update in transaction if media is included
    const updated: any = await prisma.$transaction(async tx => {
      if (media) {
        await tx.postMedia.deleteMany({ where: { postId: id } });
        await tx.postMedia.createMany({
          data: media.map(m => ({
            postId: id,
            type: m.type,
            url: m.url,
            thumbnailUrl: m.thumbnailUrl,
            caption: m.caption,
            sizeBytes: m.sizeBytes,
          })),
        });
      }

      return tx.communityPost.update({
        where: { id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(status !== undefined ? { status: status as PostStatus } : {}),
          publishedAt,
        },
        include: {
          media: true,
          channel: { select: { id: true, name: true } },
          _count: { select: { likes: true, comments: true } },
        },
      });
    });

    if (shouldNotify) {
      notifyChannelFollowers(post.channelId, updated.title, updated.channel.name, updated.id);
    }

    res.status(200).json({
      status: 'success',
      message: 'Publicación actualizada exitosamente',
      data: {
        post: {
          ...updated,
          likesCount: updated._count.likes,
          commentsCount: updated._count.comments,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const deletePost = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r));

    const post = await prisma.communityPost.findUnique({
      where: { id },
    });

    if (!post) {
      throw new AppError('Publicación no encontrada', 404);
    }

    if (post.authorId !== userId && !isAdmin) {
      throw new AppError('No tienes permisos para eliminar esta publicación', 403);
    }

    await prisma.communityPost.delete({
      where: { id },
    });

    res.status(200).json({
      status: 'success',
      message: 'Publicación eliminada correctamente',
    });
  } catch (error) {
    next(error);
  }
};

// ========================
// INTERACTIONS (LIKES & 1-LEVEL COMMENTS)
// ========================

export const toggleLikePost = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: postId } = req.params;
    const userId = req.user!.userId;

    const post = await prisma.communityPost.findUnique({
      where: { id: postId },
    });

    if (!post || post.status !== 'PUBLISHED') {
      throw new AppError('Publicación no disponible para interacción', 404);
    }

    const existingLike = await prisma.postLike.findUnique({
      where: {
        userId_postId: {
          userId,
          postId,
        },
      },
    });

    let isLiked: boolean;
    if (existingLike) {
      await prisma.postLike.delete({
        where: { id: existingLike.id },
      });
      isLiked = false;
    } else {
      await prisma.postLike.create({
        data: {
          userId,
          postId,
        },
      });
      isLiked = true;
    }

    const likesCount = await prisma.postLike.count({
      where: { postId },
    });

    res.status(200).json({
      status: 'success',
      data: {
        isLiked,
        likesCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getComments = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: postId } = req.params;
    const { cursor, limit = '30' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 30, 1), 100);
    const userId = req.user?.userId;
    const userRoles = req.user?.roles || [];
    const isAdmin = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));

    const post = await prisma.communityPost.findUnique({
      where: { id: postId },
    });

    if (!post || (post.status !== 'PUBLISHED' && !isAdmin && post.authorId !== userId)) {
      throw new AppError('Publicación no encontrada o no disponible', 404);
    }

    const where: any = {
      postId,
    };

    // Ordinary users don't see hidden comments
    if (!isAdmin) {
      where.isHidden = false;
    }

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: { createdAt: 'asc' }, // Strict 1-level chronological thread
      include: {
        user: {
          select: {
            id: true,
            name: true,
            psychologistProfile: {
              select: {
                photoUrl: true,
              },
            },
          },
        },
      },
    };

    if (cursor) {
      queryOptions.cursor = { id: String(cursor) };
      queryOptions.skip = 1;
    }

    const comments: any[] = await prisma.postComment.findMany(queryOptions);
    const hasMore = comments.length > parsedLimit;
    const items: any[] = hasMore ? comments.slice(0, parsedLimit) : comments;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    const formatted = items.map((c: any) => ({
      id: c.id,
      postId: c.postId,
      content: c.content,
      isHidden: c.isHidden,
      createdAt: c.createdAt,
      author: {
        id: c.user.id,
        name: c.user.name,
        photoUrl: c.user.psychologistProfile?.photoUrl || null,
      },
      isOwner: c.userId === userId,
    }));

    res.status(200).json({
      status: 'success',
      data: {
        items: formatted,
        nextCursor,
        hasMore,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const addComment = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: postId } = req.params;
    const userId = req.user!.userId;

    const parsed = commentCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const post = await prisma.communityPost.findUnique({
      where: { id: postId },
      include: { channel: true },
    });

    if (!post || post.status !== 'PUBLISHED' || !post.channel.isActive) {
      throw new AppError('No se puede comentar en una publicación no disponible o canal inactivo', 404);
    }

    // Strictly 1-level: creating a direct comment on the post
    const comment: any = await prisma.postComment.create({
      data: {
        postId,
        userId,
        content: parsed.data.content,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            psychologistProfile: {
              select: {
                photoUrl: true,
              },
            },
          },
        },
      },
    });

    res.status(201).json({
      status: 'success',
      message: 'Comentario agregado exitosamente',
      data: {
        comment: {
          id: comment.id,
          postId: comment.postId,
          content: comment.content,
          isHidden: comment.isHidden,
          createdAt: comment.createdAt,
          author: {
            id: comment.user.id,
            name: comment.user.name,
            photoUrl: comment.user.psychologistProfile?.photoUrl || null,
          },
          isOwner: true,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const deleteComment = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { commentId } = req.params;
    const userId = req.user!.userId;
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));

    const comment = await prisma.postComment.findUnique({
      where: { id: commentId },
      include: {
        post: {
          include: {
            channel: {
              include: { psychologist: true },
            },
          },
        },
      },
    });

    if (!comment) {
      throw new AppError('Comentario no encontrado', 404);
    }

    const isCommentAuthor = comment.userId === userId;
    const isChannelOwner = comment.post.channel.psychologist.userId === userId;

    if (!isCommentAuthor && !isChannelOwner && !isStaff) {
      throw new AppError('No tienes autorización para eliminar este comentario', 403);
    }

    await prisma.postComment.delete({
      where: { id: commentId },
    });

    res.status(200).json({
      status: 'success',
      message: 'Comentario eliminado exitosamente',
    });
  } catch (error) {
    next(error);
  }
};
