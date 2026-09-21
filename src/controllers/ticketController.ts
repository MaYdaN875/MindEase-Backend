import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { TicketCategory, TicketPriority, TicketSource, TicketStatus } from '@prisma/client';


const ticketCreateSchema = z.object({
  subject: z.string().trim().min(5, 'El asunto debe tener al menos 5 caracteres').max(150, 'El asunto no puede superar 150 caracteres'),
  category: z.nativeEnum(TicketCategory),
  priority: z.nativeEnum(TicketPriority).optional().default(TicketPriority.MEDIUM),
  content: z.string().trim().min(10, 'La descripción debe tener al menos 10 caracteres').max(3000, 'La descripción no puede superar 3000 caracteres'),
  attachments: z.array(z.string().trim()).max(5, 'Máximo 5 archivos adjuntos').optional().default([]),
  referenceType: z.enum(['APPOINTMENT', 'PAYMENT', 'USER_REPORT']).optional().nullable(),
  referenceId: z.string().trim().optional().nullable(),
});

const addMessageSchema = z.object({
  content: z.string().trim().min(1, 'El mensaje no puede estar vacío').max(3000, 'El mensaje no puede superar 3000 caracteres'),
  attachments: z.array(z.string().trim()).max(5).optional().default([]),
});

// Upload media/attachment for support ticket
export const uploadSupportAttachment = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) {
      throw new AppError('No se ha subido ningún archivo adjunto', 400);
    }

    const fileUrl = `/uploads/support/${req.file.filename}`;

    res.status(200).json({
      status: 'success',
      data: {
        url: fileUrl,
        sizeBytes: req.file.size,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Create a new support ticket as an authenticated user
export const createTicket = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const parsed = ticketCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { subject, category, priority, content, attachments, referenceType, referenceId } = parsed.data;

    const result = await prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          subject,
          category,
          priority,
          source: TicketSource.USER,
          status: TicketStatus.OPEN,
          referenceType: referenceType || null,
          referenceId: referenceId || null,
        },
      });

      const message = await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: userId,
          content,
          attachments,
          isInternalNote: false,
        },
        include: {
          sender: { select: { id: true, name: true } },
        },
      });

      return { ticket, message };
    });

    res.status(201).json({
      status: 'success',
      message: 'Ticket de soporte creado exitosamente',
      data: {
        ticket: {
          ...result.ticket,
          messages: [result.message],
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// List user's own tickets with cursor-based pagination
export const getMyTickets = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { status, category, cursor, limit = '20' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);

    const where: any = {
      userId,
    };

    if (status) {
      where.status = status as TicketStatus;
    }

    if (category) {
      where.category = category as TicketCategory;
    }

    const queryOptions: any = {
      where,
      take: parsedLimit + 1,
      orderBy: { updatedAt: 'desc' },
      include: {
        assignedTo: {
          select: { id: true, name: true },
        },
        messages: {
          where: { isInternalNote: false },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            content: true,
            createdAt: true,
            sender: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: {
            messages: { where: { isInternalNote: false } },
          },
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
      assignedTo: t.assignedTo,
      lastMessage: t.messages[0] || null,
      messagesCount: t._count.messages,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
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

// Get single ticket details and conversational thread
export const getTicketById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(r));

    const ticket: any = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        messages: {
          where: isStaff ? undefined : { isInternalNote: false },
          orderBy: { createdAt: 'asc' },
          include: {
            sender: {
              select: {
                id: true,
                name: true,
                userRoles: { include: { role: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });

    if (!ticket) {
      throw new AppError('Ticket no encontrado', 404);
    }

    // Access control: only ticket owner or support/admin staff can view
    if (ticket.userId !== userId && !isStaff) {
      throw new AppError('No tienes autorización para acceder a este ticket', 403);
    }

    const formattedMessages = ticket.messages.map((m: any) => ({
      id: m.id,
      content: m.content,
      isInternalNote: m.isInternalNote,
      attachments: m.attachments,
      createdAt: m.createdAt,
      sender: {
        id: m.sender.id,
        name: m.sender.name,
        isStaff: m.sender.userRoles?.some((ur: any) => ['SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(ur.role.name)),
      },
      isMine: m.senderId === userId,
    }));

    res.status(200).json({
      status: 'success',
      data: {
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          source: ticket.source,
          referenceType: ticket.referenceType,
          referenceId: ticket.referenceId,
          user: ticket.user,
          assignedTo: ticket.assignedTo,
          firstResponseAt: ticket.firstResponseAt,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          resolvedAt: ticket.resolvedAt,
          closedAt: ticket.closedAt,
          messages: formattedMessages,
          isOwner: ticket.userId === userId,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// Add user reply to existing ticket
export const addTicketMessage = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: ticketId } = req.params;
    const userId = req.user!.userId;
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(r));

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new AppError('Ticket no encontrado', 404);
    }

    if (ticket.userId !== userId && !isStaff) {
      throw new AppError('No tienes permisos para responder en este ticket', 403);
    }

    if (ticket.status === TicketStatus.CLOSED) {
      throw new AppError('No se pueden enviar mensajes a un ticket cerrado. Por favor crea uno nuevo.', 400);
    }

    const parsed = addMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { content, attachments } = parsed.data;

    // Automatic transition:
    // If ticket was WAITING_USER and user responds -> switch back to IN_PROGRESS
    let newStatus: TicketStatus | undefined;
    if (ticket.userId === userId && ticket.status === TicketStatus.WAITING_USER) {
      newStatus = TicketStatus.IN_PROGRESS;
    }

    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId,
          senderId: userId,
          content,
          attachments,
          isInternalNote: false,
        },
        include: {
          sender: { select: { id: true, name: true } },
        },
      });

      const updatedTicket = await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          updatedAt: new Date(),
          ...(newStatus ? { status: newStatus } : {}),
        },
      });

      return { message, updatedTicket };
    });

    res.status(201).json({
      status: 'success',
      message: 'Mensaje agregado al ticket',
      data: {
        message: result.message,
        ticketStatus: result.updatedTicket.status,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Close ticket voluntarily by user or support
export const closeTicket = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id: ticketId } = req.params;
    const userId = req.user!.userId;
    const userRoles = req.user?.roles || [];
    const isStaff = userRoles.some(r => ['SUPPORT', 'ADMIN', 'SUPERADMIN'].includes(r));

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new AppError('Ticket no encontrado', 404);
    }

    if (ticket.userId !== userId && !isStaff) {
      throw new AppError('No tienes permisos para cerrar este ticket', 403);
    }

    if (ticket.status === TicketStatus.CLOSED) {
      res.status(200).json({
        status: 'success',
        message: 'El ticket ya se encontraba cerrado',
        data: { ticket },
      });
      return;
    }

    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: TicketStatus.CLOSED,
        closedAt: new Date(),
      },
    });

    res.status(200).json({
      status: 'success',
      message: 'Ticket cerrado exitosamente',
      data: { ticket: updated },
    });
  } catch (error) {
    next(error);
  }
};
