import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma, PostStatus } from '@prisma/client';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';

const filters = z.object({
  cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(), active: z.enum(['true', 'false']).optional(),
  categoryId: z.string().uuid().optional(), channelId: z.string().uuid().optional(),
  status: z.nativeEnum(PostStatus).optional(), postId: z.string().uuid().optional(),
});
const categoryBody = z.object({
  name: z.string().trim().min(2).max(100), slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  description: z.string().trim().max(1000).nullable().optional(), isActive: z.boolean().optional(),
}).strict();
const page = <T extends { id: string }>(items: T[], limit: number) => ({ items: items.slice(0, limit), hasMore: items.length > limit, nextCursor: items.length > limit ? items[limit - 1].id : null });
function parseQuery(req: AuthenticatedRequest) {
  const parsed = filters.safeParse(req.query);
  if (!parsed.success) throw new AppError('Filtros inválidos', 400);
  return parsed.data;
}
function fail(error: unknown, next: NextFunction) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return next(new AppError('Ese slug ya existe', 409));
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return next(new AppError('Recurso no encontrado', 404));
  next(error);
}

export async function listCommunityResources(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const q = parseQuery(req);
    const options = { take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }] };
    const text = q.search ? { contains: q.search, mode: 'insensitive' as const } : undefined;
    const active = q.active === undefined ? undefined : q.active === 'true';
    let items: { id: string }[];
    switch (req.params.resource) {
      case 'categories':
        items = await prisma.communityCategory.findMany({ ...options, where: { isActive: active, name: text }, include: { _count: { select: { channels: true } } } }); break;
      case 'channels':
        items = await prisma.communityChannel.findMany({ ...options, where: { isActive: active, categoryId: q.categoryId, ...(text ? { OR: [{ name: text }, { description: text }] } : {}) }, include: { category: true, psychologist: { select: { id: true, user: { select: { id: true, name: true } } } }, _count: { select: { posts: true, followers: true } } } }); break;
      case 'posts':
        items = await prisma.communityPost.findMany({ ...options, where: { status: q.status, channelId: q.channelId, ...(text ? { OR: [{ title: text }, { content: text }] } : {}) }, include: { channel: { select: { id: true, name: true } }, author: { select: { id: true, name: true } }, media: true } }); break;
      case 'comments':
        items = await prisma.postComment.findMany({ ...options, where: { postId: q.postId, isHidden: active === undefined ? undefined : !active, content: text }, include: { user: { select: { id: true, name: true } }, post: { select: { id: true, title: true } } } }); break;
      case 'history':
        items = await prisma.auditLog.findMany({ ...options, where: { action: { startsWith: 'COMMUNITY_' } }, select: { id: true, action: true, details: true, createdAt: true, user: { select: { id: true, name: true } } } }); break;
      default: throw new AppError('Recurso no encontrado', 404);
    }
    res.json({ status: 'success', data: page(items, q.limit) });
  } catch (error) { fail(error, next); }
}

export async function saveCommunityCategory(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const parsed = (req.params.id ? categoryBody.partial() : categoryBody).safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data).length) throw new AppError('Datos de categoría inválidos', 400);
    const category = await prisma.$transaction(async tx => {
      const before = req.params.id ? await tx.communityCategory.findUniqueOrThrow({ where: { id: req.params.id } }) : null;
      const result = req.params.id
        ? await tx.communityCategory.update({ where: { id: req.params.id }, data: parsed.data })
        : await tx.communityCategory.create({ data: parsed.data as z.infer<typeof categoryBody> });
      await tx.auditLog.create({ data: { userId: req.user!.userId, action: 'COMMUNITY_CATEGORY_SAVE', details: { targetId: result.id, before, after: result } as unknown as Prisma.InputJsonValue } });
      return result;
    });
    res.status(req.params.id ? 200 : 201).json({ status: 'success', data: { category } });
  } catch (error) { fail(error, next); }
}

export async function setCommunityChannelStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const parsed = z.object({ isActive: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError('Estado y motivo obligatorios', 400);
    const channel = await prisma.$transaction(async tx => {
      const before = await tx.communityChannel.findUniqueOrThrow({ where: { id: req.params.id } });
      const result = await tx.communityChannel.update({ where: { id: before.id }, data: { isActive: parsed.data.isActive } });
      await tx.auditLog.create({ data: { userId: req.user!.userId, action: 'COMMUNITY_CHANNEL_STATUS', details: { targetId: before.id, before: before.isActive, after: result.isActive, reason: parsed.data.reason } } });
      return result;
    });
    res.json({ status: 'success', data: { channel } });
  } catch (error) { fail(error, next); }
}
