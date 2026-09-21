import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';

const channelCreateSchema = z.object({
  name: z.string().trim().min(3, 'El nombre del canal debe tener al menos 3 caracteres').max(100, 'El nombre no puede exceder 100 caracteres'),
  description: z.string().trim().min(10, 'La descripción debe tener al menos 10 caracteres').max(1000, 'La descripción no puede exceder 1000 caracteres'),
  categoryId: z.string().uuid('ID de categoría inválido'),
  coverImageUrl: z.string().trim().url('URL de portada inválida').or(z.string().trim().startsWith('/uploads/')).optional().nullable(),
  specialties: z.string().trim().max(255).optional().nullable(),
});

const channelUpdateSchema = channelCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const getCategories = async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const categories = await prisma.communityCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
      },
    });

    res.status(200).json({
      status: 'success',
      data: { categories },
    });
  } catch (error) {
    next(error);
  }
};

export const getChannels = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category, search, following, mine, cursor, limit = '20' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);
    const userId = req.user?.userId;

    const where: any = {
      isActive: true,
    };

    // Filter by Category (slug or UUID)
    if (category) {
      const catStr = String(category).trim();
      where.category = {
        OR: [
          { slug: catStr },
          { id: catStr },
        ],
      };
    }

    // Filter by Search text in name or description
    if (search) {
      const q = String(search).trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }

    // Filter by Channels followed by current user
    if (following === 'true') {
      if (!userId) throw new AppError('Se requiere autenticación para consultar canales seguidos', 401);
      where.followers = {
        some: { userId },
      };
    }

    // Filter by Channels created by current psychologist
    if (mine === 'true') {
      if (!userId) throw new AppError('Se requiere autenticación para consultar tus canales', 401);
      where.psychologist = {
        userId,
      };
    }

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: { createdAt: 'desc' },
      include: {
        category: {
          select: { id: true, name: true, slug: true },
        },
        psychologist: {
          select: {
            id: true,
            userId: true,
            photoUrl: true,
            user: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: {
            followers: true,
            posts: { where: { status: 'PUBLISHED' } },
          },
        },
      },
    };

    if (cursor) {
      queryOptions.cursor = { id: String(cursor) };
      queryOptions.skip = 1;
    }

    const channels: any[] = await prisma.communityChannel.findMany(queryOptions);

    const hasMore = channels.length > parsedLimit;
    const items: any[] = hasMore ? channels.slice(0, parsedLimit) : channels;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    // Resolve isFollowing for authenticated user
    let userFollowedSet = new Set<string>();
    if (userId && items.length > 0) {
      const follows = await prisma.channelFollow.findMany({
        where: {
          userId,
          channelId: { in: items.map(c => c.id) },
        },
        select: { channelId: true },
      });
      userFollowedSet = new Set(follows.map(f => f.channelId));
    }

    const mappedItems = items.map((channel: any) => ({
      id: channel.id,
      name: channel.name,
      description: channel.description,

      coverImageUrl: channel.coverImageUrl,
      specialties: channel.specialties,
      isActive: channel.isActive,
      createdAt: channel.createdAt,
      category: channel.category,
      psychologist: {
        id: channel.psychologist.id,
        name: channel.psychologist.user.name,
        photoUrl: channel.psychologist.photoUrl,
      },
      followersCount: channel._count.followers,
      postsCount: channel._count.posts,
      isFollowing: userFollowedSet.has(channel.id),
      isOwner: userId ? channel.psychologist.userId === userId : false,
    }));

    res.status(200).json({
      status: 'success',
      data: {
        items: mappedItems,
        nextCursor,
        hasMore,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getChannelById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    const channel = await prisma.communityChannel.findUnique({
      where: { id },
      include: {
        category: {
          select: { id: true, name: true, slug: true, description: true },
        },
        psychologist: {
          select: {
            id: true,
            userId: true,
            photoUrl: true,
            description: true,
            user: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: {
            followers: true,
            posts: { where: { status: 'PUBLISHED' } },
          },
        },
      },
    });

    if (!channel) {
      throw new AppError('Canal no encontrado', 404);
    }

    const isOwner = userId ? channel.psychologist.userId === userId : false;
    const isAdmin = req.user?.roles ? req.user.roles.some((r: string) => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r)) : false;

    if (!channel.isActive && !isOwner && !isAdmin) {
      throw new AppError('El canal no se encuentra disponible', 404);
    }

    let isFollowing = false;
    if (userId) {
      const follow = await prisma.channelFollow.findUnique({
        where: {
          userId_channelId: {
            userId,
            channelId: channel.id,
          },
        },
      });
      isFollowing = !!follow;
    }

    res.status(200).json({
      status: 'success',
      data: {
        channel: {
          id: channel.id,
          name: channel.name,
          description: channel.description,
          coverImageUrl: channel.coverImageUrl,
          specialties: channel.specialties,
          isActive: channel.isActive,
          createdAt: channel.createdAt,
          updatedAt: channel.updatedAt,
          category: channel.category,
          psychologist: {
            id: channel.psychologist.id,
            name: channel.psychologist.user.name,
            photoUrl: channel.psychologist.photoUrl,
            description: channel.psychologist.description,
          },
          followersCount: channel._count.followers,
          postsCount: channel._count.posts,
          isFollowing,
          isOwner,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const createChannel = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const userRoles = req.user!.roles || [];

    // Strictly enforce PSYCHOLOGIST_VERIFIED
    if (!userRoles.includes('PSYCHOLOGIST_VERIFIED')) {
      throw new AppError('Solo los psicólogos verificados pueden crear canales en la comunidad', 403);
    }

    const profile = await prisma.psychologistProfile.findUnique({
      where: { userId },
    });

    if (!profile || profile.status !== 'VERIFICADO') {
      throw new AppError('El perfil profesional debe estar completamente verificado para crear canales', 403);
    }

    const parsed = channelCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { name, description, categoryId, coverImageUrl, specialties } = parsed.data;

    const category = await prisma.communityCategory.findUnique({
      where: { id: categoryId },
    });

    if (!category || !category.isActive) {
      throw new AppError('La categoría seleccionada no existe o no está activa', 400);
    }

    const channel = await prisma.communityChannel.create({
      data: {
        psychologistId: profile.id,
        categoryId,
        name,
        description,
        coverImageUrl: coverImageUrl || null,
        specialties: specialties || null,
      },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        psychologist: { select: { id: true, user: { select: { name: true } } } },
        _count: { select: { followers: true, posts: true } },
      },
    });

    res.status(201).json({
      status: 'success',
      message: 'Canal creado exitosamente',
      data: {
        channel: {
          ...channel,
          followersCount: channel._count.followers,
          postsCount: channel._count.posts,
          isFollowing: false,
          isOwner: true,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateChannel = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;
    const isAdmin = req.user!.roles?.some((r: string) => ['ADMIN', 'SUPERADMIN'].includes(r));

    const channel = await prisma.communityChannel.findUnique({
      where: { id },
      include: { psychologist: true },
    });

    if (!channel) {
      throw new AppError('Canal no encontrado', 404);
    }

    if (channel.psychologist.userId !== userId && !isAdmin) {
      throw new AppError('No tienes permisos para modificar este canal', 403);
    }

    const parsed = channelUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    if (parsed.data.categoryId) {
      const category = await prisma.communityCategory.findUnique({
        where: { id: parsed.data.categoryId },
      });
      if (!category || !category.isActive) {
        throw new AppError('La categoría especificada no es válida', 400);
      }
    }

    const updated = await prisma.communityChannel.update({
      where: { id },
      data: parsed.data,
      include: {
        category: { select: { id: true, name: true, slug: true } },
        psychologist: { select: { id: true, user: { select: { name: true } } } },
        _count: { select: { followers: true, posts: true } },
      },
    });

    res.status(200).json({
      status: 'success',
      message: 'Canal actualizado exitosamente',
      data: {
        channel: {
          ...updated,
          followersCount: updated._count.followers,
          postsCount: updated._count.posts,
          isFollowing: true,
          isOwner: true,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const toggleFollowChannel = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: channelId } = req.params;
    const userId = req.user!.userId;

    const channel = await prisma.communityChannel.findUnique({
      where: { id: channelId },
    });

    if (!channel || !channel.isActive) {
      throw new AppError('El canal no existe o no está disponible', 404);
    }

    const existingFollow = await prisma.channelFollow.findUnique({
      where: {
        userId_channelId: {
          userId,
          channelId,
        },
      },
    });

    let isFollowing: boolean;
    if (existingFollow) {
      // Unfollow
      await prisma.channelFollow.delete({
        where: { id: existingFollow.id },
      });
      isFollowing = false;
    } else {
      // Follow
      await prisma.channelFollow.create({
        data: {
          userId,
          channelId,
        },
      });
      isFollowing = true;
    }

    const followersCount = await prisma.channelFollow.count({
      where: { channelId },
    });

    res.status(200).json({
      status: 'success',
      message: isFollowing ? 'Ahora sigues este canal' : 'Has dejado de seguir este canal',
      data: {
        isFollowing,
        followersCount,
      },
    });
  } catch (error) {
    next(error);
  }
};
