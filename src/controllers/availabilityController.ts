import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import prisma from '../config/db';
import { requireProfessional, serializable } from '../services/clinicalPolicy';
import { parseSchedules, scheduleTimeZone, slotsForDate, validateDate } from '../services/scheduling';

export const getMyAvailability = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const profile = await prisma.psychologistProfile.findUnique({ where: { userId: req.user!.userId }, include: { availabilities: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] } } });
    if (!profile) throw new AppError('Perfil no encontrado', 404);
    res.status(200).json({ status: 'success', data: { availabilities: profile.availabilities, timeZone: scheduleTimeZone() } });
  } catch (error) { next(error); }
};

export const updateMyAvailability = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const schedules = parseSchedules(req.body.availabilities);
    const availabilities = await serializable(async tx => {
      const profile = await tx.psychologistProfile.findUnique({ where: { userId: req.user!.userId } });
      if (!profile) throw new AppError('Perfil no encontrado', 404);
      await requireProfessional(tx, profile.id);
      await tx.psychologistAvailability.deleteMany({ where: { psychologistId: profile.id } });
      if (schedules.length) await tx.psychologistAvailability.createMany({ data: schedules.map(s => ({ ...s, psychologistId: profile.id })) });
      return tx.psychologistAvailability.findMany({ where: { psychologistId: profile.id }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });
    });
    res.status(200).json({ status: 'success', message: 'Disponibilidad actualizada', data: { availabilities, timeZone: scheduleTimeZone() } });
  } catch (error) { next(error); }
};

export const getAvailableSlots = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { date } = req.query;
    validateDate(date);
    const psychologistId = req.params.psychologistId;
    const profile = await requireProfessional(prisma, psychologistId);
    const schedules = await prisma.psychologistAvailability.findMany({ where: { psychologistId, isActive: true } });
    const { dayOfWeek, slots: generated } = slotsForDate(date, schedules);
    const appointments = generated.length ? await prisma.appointment.findMany({
      where: { psychologistId, status: { in: ['PENDING', 'CONFIRMED'] }, startAt: { lt: new Date(generated[generated.length - 1].endAt) }, endAt: { gt: new Date(generated[0].startAt) } },
    }) : [];
    const now = Date.now();
    const slots = generated.map(s => ({ ...s, available: Date.parse(s.startAt) > now && !appointments.some(a => a.startAt.getTime() < Date.parse(s.endAt) && a.endAt.getTime() > Date.parse(s.startAt)) }));
    res.status(200).json({ status: 'success', data: { date, dayOfWeek, psychologistId, consultationPrice: profile.consultationPrice, slots, timeZone: scheduleTimeZone() } });
  } catch (error) { next(error); }
};
