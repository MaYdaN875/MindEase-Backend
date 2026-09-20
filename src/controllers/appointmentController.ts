import { Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import prisma from '../config/db';
import { sendNotification } from '../services/notificationService';
import { appointmentView, assertAppointmentTransition, requireProfessional, serializable } from '../services/clinicalPolicy';
import { localDate, scheduleTimeZone, slotsForDate } from '../services/scheduling';
import { processAppointmentRefund } from '../services/refundPolicy';
import { requirePaid } from '../services/paymentWorkflow';
import { cents } from '../services/money';

const details = {
  psychologist: { include: { user: { select: { id: true, name: true } }, specialties: { include: { specialty: true } } } },
  user: { select: { id: true, name: true, email: true, phone: true } },
  consultation: true,
} satisfies Prisma.AppointmentInclude;
const bookingSchema = z.object({
  psychologistId: z.string().uuid(), startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }),
});
const statusSchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
  cancellationReason: z.string().trim().max(1000).optional(),
});
const isAdministrator = (roles: string[]) => roles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r));

export const createAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = bookingSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Se requiere un profesional y fechas ISO con zona horaria válidos', 400);
    const { psychologistId, startAt, endAt } = parsed.data;
    const userId = req.user!.userId;
    const startDate = new Date(startAt), endDate = new Date(endAt);
    if (startDate >= endDate || startDate.getTime() <= Date.now()) throw new AppError('La cita debe tener duración positiva y comenzar en el futuro', 400);
    const appointment = await serializable(async tx => {
      const patient = await tx.user.findUnique({ where: { id: userId } });
      if (!patient || patient.status !== 'ACTIVE') throw new AppError('La cuenta no se encuentra activa', 403);
      const psychologist = await requireProfessional(tx, psychologistId);
      if (psychologist.userId === userId) throw new AppError('No puedes agendar una cita contigo mismo', 400);
      const availability = await tx.psychologistAvailability.findMany({ where: { psychologistId, isActive: true } });
      const { slots } = slotsForDate(localDate(startDate), availability);
      if (!slots.some(s => s.startAt === startDate.toISOString() && s.endAt === endDate.toISOString())) {
        throw new AppError('El horario o la duración no corresponden a la disponibilidad publicada', 400);
      }
      const collision = await tx.appointment.findFirst({
        where: {
          OR: [{ psychologistId }, { userId }], status: { in: ['PENDING', 'CONFIRMED'] },
          startAt: { lt: endDate }, endAt: { gt: startDate },
        },
      });
      if (collision) throw new AppError('El paciente o el profesional ya tiene una cita en ese horario', 409);
      const price = cents(psychologist.consultationPrice ?? 0) / 100;
      const requiresPayment = price > 0;
      return tx.appointment.create({
        data: {
          psychologistId, userId, startAt: startDate, endAt: endDate,
          status: requiresPayment ? 'PENDING' : (psychologist.autoConfirmAppointments ? 'CONFIRMED' : 'PENDING'),
          price,
          consultation: { create: { status: 'SCHEDULED' } },
        }, include: details,
      });
    });
    const confirmed = appointment.status === 'CONFIRMED';
    const formatted = startDate.toLocaleString('es-MX', { timeZone: scheduleTimeZone() });
    if (confirmed) {
      await Promise.all([
        sendNotification({ userId: appointment.psychologist.userId, title: 'Nueva cita confirmada', content: appointment.user.name + ' ha reservado el ' + formatted + '.', type: 'APPOINTMENT_CONFIRMED', referenceId: appointment.id }),
        sendNotification({ userId, title: 'Cita confirmada', content: 'Tu cita está confirmada.', type: 'APPOINTMENT_CONFIRMED', referenceId: appointment.id }),
      ]);
    } else if (appointment.price <= 0) {
      await Promise.all([
        sendNotification({ userId: appointment.psychologist.userId, title: 'Nueva solicitud de cita', content: appointment.user.name + ' ha solicitado el ' + formatted + '.', type: 'APPOINTMENT_REQUEST', referenceId: appointment.id }),
        sendNotification({ userId, title: 'Solicitud enviada', content: 'Tu solicitud está pendiente de confirmación por el profesional.', type: 'APPOINTMENT_REQUEST', referenceId: appointment.id }),
      ]);
    }
    res.status(201).json({ status: 'success', message: confirmed ? 'Cita confirmada' : 'Solicitud de cita enviada', data: { appointment: appointmentView(appointment, userId) } });
  } catch (error) { next(error); }
};

export const getMyAppointments = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { status, as } = req.query;
    const where: Prisma.AppointmentWhereInput = {};
    if (status !== undefined) {
      const parsed = statusSchema.shape.status.safeParse(status);
      if (!parsed.success) throw new AppError('Estado de cita inválido', 400);
      where.status = parsed.data;
    }
    if (as !== undefined && as !== 'patient' && as !== 'psychologist') throw new AppError('Tipo de agenda inválido', 400);
    if (as === 'psychologist') {
      const profile = await prisma.psychologistProfile.findUnique({ where: { userId } });
      if (!profile) throw new AppError('No posees perfil de psicólogo', 404);
      where.psychologistId = profile.id;
      where.AND = [{ OR: [{ price: 0 }, { payment: { status: 'SUCCEEDED' } }, { status: { in: ['CANCELLED', 'COMPLETED', 'NO_SHOW'] } }] }];
    } else { where.userId = userId; }
    const appointments = await prisma.appointment.findMany({ where, orderBy: { startAt: 'desc' }, include: details });
    res.status(200).json({ status: 'success', data: { appointments: appointments.map(a => appointmentView(a, userId)) } });
  } catch (error) { next(error); }
};

export const getAppointmentById = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: details });
    if (!appointment) throw new AppError('Cita no encontrada', 404);
    if (appointment.userId !== userId && appointment.psychologist.userId !== userId && !isAdministrator(req.user!.roles)) throw new AppError('No tienes permisos para ver esta cita', 403);
    res.status(200).json({ status: 'success', data: { appointment: appointmentView(appointment, userId) } });
  } catch (error) { next(error); }
};

export const updateAppointmentStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Estado o motivo de cancelación inválidos', 400);
    const { status, cancellationReason } = parsed.data;
    const userId = req.user!.userId;
    const admin = isAdministrator(req.user!.roles);
    const { appointment, updated, changed } = await serializable(async tx => {
      const appointment = await tx.appointment.findUnique({ where: { id: req.params.id }, include: details });
      if (!appointment) throw new AppError('Cita no encontrada', 404);
      const professional = appointment.psychologist.userId === userId;
      if (appointment.userId !== userId && !professional && !admin) throw new AppError('No tienes permisos para modificar esta cita', 403);
      if (status === 'CANCELLED' && appointment.status === 'CANCELLED') return { appointment, updated: appointment, changed: false };
      assertAppointmentTransition(appointment.status, status, professional, admin, appointment.consultation?.status, appointment.endAt);
      if (status === 'CONFIRMED') {
        await requirePaid(tx, appointment);
        await requireProfessional(tx, appointment.psychologistId);
        if (appointment.startAt.getTime() <= Date.now()) throw new AppError('No se pueden confirmar solicitudes vencidas', 409);
      }
      const updated = await tx.appointment.update({ where: { id: appointment.id }, data: { status, ...(status === 'CANCELLED' && { cancellationReason }) } });
      if (status === 'CANCELLED' || status === 'NO_SHOW') {
        await tx.consultation.updateMany({ where: { appointmentId: appointment.id }, data: { status: 'CANCELLED' } });
      }
      if (status === 'CANCELLED') {
        await processAppointmentRefund(tx, appointment.id, cancellationReason);
      }
      return { appointment, updated, changed: true };
    });
    if (changed && (status === 'CONFIRMED' || status === 'CANCELLED')) {
      await sendNotification({
        userId: userId === appointment.userId ? appointment.psychologist.userId : appointment.userId,
        title: status === 'CONFIRMED' ? 'Cita confirmada' : 'Cita cancelada',
        content: status === 'CONFIRMED' ? 'El profesional confirmó tu cita.' : 'La cita fue cancelada.' + (cancellationReason ? ' Motivo: ' + cancellationReason : ''),
        type: status === 'CONFIRMED' ? 'APPOINTMENT_CONFIRMED' : 'APPOINTMENT_CANCELLED', referenceId: appointment.id,
      });
    }
    res.status(200).json({ status: 'success', message: 'Cita actualizada a ' + status, data: { appointment: updated } });
  } catch (error) { next(error); }
};
