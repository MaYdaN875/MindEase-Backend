import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { TicketCategory, TicketPriority, TicketSource, TicketStatus } from '@prisma/client';
import { sendNotification } from '../services/notificationService';

const assignTicketSchema = z.object({
  agentId: z.string().trim().nullable(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(TicketStatus),
  priority: z.nativeEnum(TicketPriority).optional(),
});

const agentMessageSchema = z.object({
  content: z.string().trim().min(1, 'El mensaje no puede estar vacío').max(3000),
  isInternalNote: z.boolean().optional().default(false),
  attachments: z.array(z.string().trim()).max(5).optional().default([]),
});

// Guard helper to check if user has support staff privileges
const ensureSupportStaff = (req: AuthenticatedRequest) => {
  const userRoles = req.user?.roles || [];
  const isStaff = userRoles.some(r => ['SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(r));
  if (!isStaff) {
    throw new AppError('Acceso denegado: se requieren privilegios de Soporte o Administración', 403);
  }
};

// List tickets for support agent console with multiple filters
export const getAllTickets = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureSupportStaff(req);
    const userId = req.user!.userId;
    const {
      status,
      priority,
      category,
      source,
      assigned,
      search,
      cursor,
      limit = '20',
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);
    const where: any = {};

    if (status) {
      where.status = status as TicketStatus;
    }

    if (priority) {
      where.priority = priority as TicketPriority;
    }

    if (category) {
      where.category = category as TicketCategory;
    }

    if (source) {
      where.source = source as TicketSource;
    }

    if (assigned === 'unassigned') {
      where.assignedToId = null;
    } else if (assigned === 'me') {
      where.assignedToId = userId;
    } else if (assigned && typeof assigned === 'string' && assigned.trim() !== '') {
      where.assignedToId = assigned.trim();
    }

    if (search) {
      const q = String(search).trim();
      where.OR = [
        { subject: { contains: q, mode: 'insensitive' } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: [
        { priority: 'desc' },
        { updatedAt: 'desc' },
      ],
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        assignedTo: {
          select: { id: true, name: true, email: true },
        },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            content: true,
            isInternalNote: true,
            createdAt: true,
            sender: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: { messages: true },
        },
      },
    };

    if (cursor) {
      queryOptions.cursor = { id: String(cursor) };
      queryOptions.skip = 1;
    }

    const tickets: any[] = await prisma.supportTicket.findMany(queryOptions);
    const hasMore = tickets.length > parsedLimit;
    const items = hasMore ? tickets.slice(0, parsedLimit) : tickets;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    const formatted = items.map((t: any) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      status: t.status,
      source: t.source,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      user: t.user,
      assignedTo: t.assignedTo,
      firstResponseAt: t.firstResponseAt,
      lastMessage: t.messages[0] || null,
      messagesCount: t._count.messages,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      resolvedAt: t.resolvedAt,
      closedAt: t.closedAt,
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

// Assign ticket to an agent (or me or unassign)
export const assignTicket = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureSupportStaff(req);
    const { id: ticketId } = req.params;
    const currentUserId = req.user!.userId;

    const parsed = assignTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const targetAgentId = parsed.data.agentId === 'me' ? currentUserId : parsed.data.agentId;

    if (targetAgentId) {
      const agent = await prisma.user.findUnique({
        where: { id: targetAgentId },
        include: { userRoles: { include: { role: true } } },
      });

      if (!agent) {
        throw new AppError('El agente seleccionado no existe', 404);
      }

      const isAgentStaff = agent.userRoles.some(ur => ['SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(ur.role.name));
      if (!isAgentStaff) {
        throw new AppError('El usuario asignado no tiene rol de Soporte ni Administración', 400);
      }
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new AppError('Ticket no encontrado', 404);
    }

    // If ticket was OPEN and is now assigned -> automatically transition to IN_PROGRESS
    const newStatus = ticket.status === TicketStatus.OPEN && targetAgentId ? TicketStatus.IN_PROGRESS : ticket.status;

    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        assignedToId: targetAgentId,
        status: newStatus,
      },
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(200).json({
      status: 'success',
      message: targetAgentId ? 'Ticket asignado exitosamente' : 'Ticket desasignado',
      data: { ticket: updated },
    });
  } catch (error) {
    next(error);
  }
};

// Update ticket status and priority from support console
export const updateTicketStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureSupportStaff(req);
    const { id: ticketId } = req.params;

    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { status, priority } = parsed.data;

    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new AppError('Ticket no encontrado', 404);
    }

    let resolvedAt = ticket.resolvedAt;
    let closedAt = ticket.closedAt;

    if (status === TicketStatus.RESOLVED && ticket.status !== TicketStatus.RESOLVED) {
      resolvedAt = new Date();
    }
    if (status === TicketStatus.CLOSED && ticket.status !== TicketStatus.CLOSED) {
      closedAt = new Date();
    }

    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status,
        ...(priority ? { priority } : {}),
        resolvedAt,
        closedAt,
      },
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });

    // Notify ticket owner about status change
    const statusLabels: Record<TicketStatus, string> = {
      OPEN: 'Abierto',
      IN_PROGRESS: 'En atención',
      WAITING_USER: 'Esperando tu respuesta',
      RESOLVED: 'Resuelto',
      CLOSED: 'Cerrado',
    };

    sendNotification({
      userId: ticket.userId,
      title: `Actualización en ticket #${ticket.ticketNumber}`,
      content: `El estado de tu ticket cambió a "${statusLabels[status]}".`,
      type: 'SYSTEM',
      referenceId: ticket.id,
    }).catch(e => console.error('[Support Notification] Error:', e));

    res.status(200).json({
      status: 'success',
      message: 'Estado del ticket actualizado exitosamente',
      data: { ticket: updated },
    });
  } catch (error) {
    next(error);
  }
};

// Support agent adds message (public response or internal note)
export const addAgentMessage = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureSupportStaff(req);
    const { id: ticketId } = req.params;
    const agentId = req.user!.userId;

    const parsed = agentMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { content, isInternalNote, attachments } = parsed.data;

    const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new AppError('Ticket no encontrado', 404);
    }

    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId,
          senderId: agentId,
          content,
          isInternalNote: isInternalNote || false,
          attachments,
        },
        include: {
          sender: { select: { id: true, name: true } },
        },
      });

      // If it is a public response:
      // 1. If firstResponseAt is not set, set it now.
      // 2. Set status to WAITING_USER (unless ticket is already RESOLVED or CLOSED).
      const updates: any = {
        updatedAt: new Date(),
      };

      if (!isInternalNote) {
        if (!ticket.firstResponseAt) {
          updates.firstResponseAt = new Date();
        }
        if (ticket.status !== TicketStatus.RESOLVED && ticket.status !== TicketStatus.CLOSED) {
          updates.status = TicketStatus.WAITING_USER;
        }
      }

      const updatedTicket = await tx.supportTicket.update({
        where: { id: ticketId },
        data: updates,
      });

      return { message, updatedTicket };
    });

    // Notify ticket owner if public message
    if (!isInternalNote) {
      sendNotification({
        userId: ticket.userId,
        title: `Nueva respuesta en ticket #${ticket.ticketNumber}`,
        content: content.slice(0, 100),
        type: 'SYSTEM',
        referenceId: ticket.id,
      }).catch(e => console.error('[Support Notification] Error:', e));
    }

    res.status(201).json({
      status: 'success',
      message: isInternalNote ? 'Nota interna guardada' : 'Respuesta enviada al usuario',
      data: {
        message: result.message,
        ticketStatus: result.updatedTicket.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Metrics for support dashboard
export const getSupportMetrics = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    ensureSupportStaff(req);

    const [
      totalTickets,
      openCount,
      inProgressCount,
      waitingUserCount,
      resolvedCount,
      closedCount,
      urgentOpenCount,
      unassignedCount,
      respondedTickets,
    ] = await Promise.all([
      prisma.supportTicket.count(),
      prisma.supportTicket.count({ where: { status: TicketStatus.OPEN } }),
      prisma.supportTicket.count({ where: { status: TicketStatus.IN_PROGRESS } }),
      prisma.supportTicket.count({ where: { status: TicketStatus.WAITING_USER } }),
      prisma.supportTicket.count({ where: { status: TicketStatus.RESOLVED } }),
      prisma.supportTicket.count({ where: { status: TicketStatus.CLOSED } }),
      prisma.supportTicket.count({ where: { priority: TicketPriority.URGENT, status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] } } }),
      prisma.supportTicket.count({ where: { assignedToId: null, status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] } } }),
      prisma.supportTicket.findMany({
        where: { firstResponseAt: { not: null } },
        select: { createdAt: true, firstResponseAt: true },
        take: 100, // sample last 100 tickets
      }),
    ]);

    // Calculate average first response time in minutes
    let avgResponseMinutes = 0;
    if (respondedTickets.length > 0) {
      const totalMinutes = respondedTickets.reduce((acc, t) => {
        const diffMs = t.firstResponseAt!.getTime() - t.createdAt.getTime();
        return acc + Math.max(diffMs / 60000, 0);
      }, 0);
      avgResponseMinutes = Math.round(totalMinutes / respondedTickets.length);
    }

    res.status(200).json({
      status: 'success',
      data: {
        totalTickets,
        openCount,
        inProgressCount,
        waitingUserCount,
        resolvedCount,
        closedCount,
        activeTicketsCount: openCount + inProgressCount + waitingUserCount,
        urgentOpenCount,
        unassignedCount,
        avgFirstResponseMinutes: avgResponseMinutes,
      },
    });
  } catch (error) {
    next(error);
  }
};
