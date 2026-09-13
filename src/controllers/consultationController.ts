import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import prisma from '../config/db';
import { sendNotification } from '../services/notificationService';
import { consultationView, requireProfessional, serializable } from '../services/clinicalPolicy';

export const getConsultation = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.appointmentId }, include: { psychologist: true, consultation: true } });
    if (!appointment?.consultation) throw new AppError('Consulta no encontrada', 404);
    const professional = appointment.psychologist.userId === req.user!.userId;
    const admin = req.user!.roles.some(r => ['ADMIN', 'SUPERADMIN'].includes(r));
    if (!professional && appointment.userId !== req.user!.userId && !admin) throw new AppError('Acceso denegado', 403);
    res.status(200).json({ status: 'success', data: { consultation: consultationView(appointment.consultation, professional) } });
  } catch (error) { next(error); }
};

const startSchema = z.object({ meetingUrl: z.string().url().refine(value => new URL(value).protocol === 'https:', 'El enlace debe usar HTTPS').optional() });

export const startConsultation = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError('Proporciona un enlace HTTPS válido', 400);
    const { appointment, consultation } = await serializable(async tx => {
      const appointment = await tx.appointment.findUnique({ where: { id: req.params.appointmentId }, include: { psychologist: true, consultation: true } });
      if (!appointment?.consultation) throw new AppError('Consulta no encontrada', 404);
      if (appointment.psychologist.userId !== req.user!.userId) throw new AppError('Solo el profesional tratante puede iniciar la consulta', 403);
      await requireProfessional(tx, appointment.psychologistId);
      if (appointment.status !== 'CONFIRMED' || appointment.consultation.status !== 'SCHEDULED') throw new AppError('Solo puede iniciarse una cita confirmada con consulta programada', 409);
      if (Date.now() < appointment.startAt.getTime() - 15 * 60000 || Date.now() >= appointment.endAt.getTime()) throw new AppError('La consulta puede iniciarse desde 15 minutos antes de la cita y antes de su hora de fin', 409);
      const consultation = await tx.consultation.update({ where: { appointmentId: appointment.id }, data: { status: 'IN_PROGRESS', startedAt: new Date(), meetingUrl: parsed.data.meetingUrl ?? appointment.consultation.meetingUrl } });
      return { appointment, consultation };
    });
    await sendNotification({ userId: appointment.userId, title: 'Tu consulta ha iniciado', content: consultation.meetingUrl ? 'El profesional inició la consulta. El enlace de la sesión está disponible.' : 'El profesional inició la consulta.', type: 'CONSULTATION_STARTED', referenceId: appointment.id });
    res.status(200).json({ status: 'success', message: 'Consulta iniciada', data: { consultation } });
  } catch (error) { next(error); }
};

export const completeConsultation = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { appointment, consultation } = await serializable(async tx => {
      const appointment = await tx.appointment.findUnique({ where: { id: req.params.appointmentId }, include: { psychologist: true, consultation: true } });
      if (!appointment?.consultation) throw new AppError('Consulta no encontrada', 404);
      if (appointment.psychologist.userId !== req.user!.userId) throw new AppError('Solo el profesional tratante puede finalizar la consulta', 403);
      await requireProfessional(tx, appointment.psychologistId);
      if (appointment.status !== 'CONFIRMED' || appointment.consultation.status !== 'IN_PROGRESS') throw new AppError('Solo puede finalizarse una consulta en curso', 409);
      const consultation = await tx.consultation.update({ where: { appointmentId: appointment.id }, data: { status: 'COMPLETED', endedAt: new Date() } });
      await tx.appointment.update({ where: { id: appointment.id }, data: { status: 'COMPLETED' } });
      return { appointment, consultation };
    });
    await sendNotification({ userId: appointment.userId, title: 'Consulta completada', content: 'Tu consulta ha finalizado. Gracias por confiar en MindEase.', type: 'SYSTEM', referenceId: appointment.id });
    res.status(200).json({ status: 'success', message: 'Consulta finalizada', data: { consultation } });
  } catch (error) { next(error); }
};

export const updateClinicalNotes = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = z.object({ clinicalNotes: z.string().max(50000) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Las notas deben ser texto de hasta 50000 caracteres', 400);
    const consultation = await serializable(async tx => {
      const appointment = await tx.appointment.findUnique({ where: { id: req.params.appointmentId }, include: { psychologist: true, consultation: true } });
      if (!appointment?.consultation) throw new AppError('Consulta no encontrada', 404);
      if (appointment.psychologist.userId !== req.user!.userId) throw new AppError('Solo el profesional tratante puede editar las notas', 403);
      await requireProfessional(tx, appointment.psychologistId);
      if (!['IN_PROGRESS', 'COMPLETED'].includes(appointment.consultation.status)) throw new AppError('La consulta debe estar iniciada o completada', 409);
      const result = await tx.consultation.update({ where: { appointmentId: appointment.id }, data: parsed.data });
      await tx.auditLog.create({ data: { userId: req.user!.userId, action: 'UPDATE_CLINICAL_NOTES', details: { appointmentId: appointment.id } } });
      return result;
    });
    res.status(200).json({ status: 'success', message: 'Notas guardadas', data: { consultation } });
  } catch (error) { next(error); }
};
