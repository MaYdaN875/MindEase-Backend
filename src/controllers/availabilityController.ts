import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import prisma from '../config/db';
import { DayOfWeek } from '@prisma/client';

const DAY_MAP: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

export const getMyAvailability = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const psychologist = await prisma.psychologistProfile.findUnique({
      where: { userId },
      include: {
        availabilities: {
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
    });

    if (!psychologist) {
      return next(new AppError('Perfil de psicólogo no encontrado', 404));
    }

    res.status(200).json({
      status: 'success',
      data: {
        availabilities: psychologist.availabilities,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateMyAvailability = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const psychologist = await prisma.psychologistProfile.findUnique({
      where: { userId },
    });

    if (!psychologist) {
      return next(new AppError('Perfil de psicólogo no encontrado', 404));
    }

    if (psychologist.status !== 'VERIFICADO') {
      return next(
        new AppError('Solo los psicólogos verificados pueden configurar su agenda', 403)
      );
    }

    const { availabilities } = req.body;

    if (!Array.isArray(availabilities)) {
      return next(new AppError('Se requiere un arreglo de disponibilidades', 400));
    }

    // Validate format
    for (const item of availabilities) {
      if (!Object.values(DayOfWeek).includes(item.dayOfWeek)) {
        return next(new AppError(`Día de la semana inválido: ${item.dayOfWeek}`, 400));
      }
      if (!item.startTime || !item.endTime) {
        return next(new AppError('startTime y endTime son obligatorios (formato HH:mm)', 400));
      }
      if (item.startTime >= item.endTime) {
        return next(new AppError(`El horario de inicio (${item.startTime}) debe ser menor al de fin (${item.endTime})`, 400));
      }
    }

    // Deduplicate identical schedules for the same day
    const uniqueAvailabilities: any[] = [];
    const seenSchedules = new Set<string>();
    for (const a of availabilities) {
      const key = `${a.dayOfWeek}-${a.startTime}-${a.endTime}`;
      if (!seenSchedules.has(key)) {
        seenSchedules.add(key);
        uniqueAvailabilities.push(a);
      }
    }

    // Replace all availabilities in transaction
    const updated = await prisma.$transaction(async (tx) => {
      await tx.psychologistAvailability.deleteMany({
        where: { psychologistId: psychologist.id },
      });

      if (uniqueAvailabilities.length > 0) {
        await tx.psychologistAvailability.createMany({
          data: uniqueAvailabilities.map((a: any) => ({
            psychologistId: psychologist.id,
            dayOfWeek: a.dayOfWeek,
            startTime: a.startTime,
            endTime: a.endTime,
            slotDuration: a.slotDuration || 50,
            isActive: a.isActive !== undefined ? a.isActive : true,
          })),
        });
      }

      return tx.psychologistAvailability.findMany({
        where: { psychologistId: psychologist.id },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      });
    });

    res.status(200).json({
      status: 'success',
      message: 'Disponibilidad actualizada exitosamente',
      data: {
        availabilities: updated,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getAvailableSlots = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { psychologistId } = req.params;
    const { date } = req.query; // format: YYYY-MM-DD

    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return next(new AppError('Formato de fecha inválido. Utiliza YYYY-MM-DD', 400));
    }

    const psychologist = await prisma.psychologistProfile.findUnique({
      where: { id: psychologistId },
      include: {
        availabilities: {
          where: { isActive: true },
        },
      },
    });

    if (!psychologist) {
      return next(new AppError('Psicólogo no encontrado', 404));
    }

    if (psychologist.status !== 'VERIFICADO') {
      return next(new AppError('El psicólogo aún no se encuentra verificado', 400));
    }

    // Determine day of the week in UTC
    const targetDate = new Date(`${date}T00:00:00.000Z`);
    if (isNaN(targetDate.getTime())) {
      return next(new AppError('Fecha inválida', 400));
    }

    const dayOfWeek = DAY_MAP[targetDate.getUTCDay()];
    const dayAvailabilities = psychologist.availabilities.filter(
      (a) => a.dayOfWeek === dayOfWeek
    );

    // Fetch existing booked appointments on that calendar date
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const existingAppointments = await prisma.appointment.findMany({
      where: {
        psychologistId: psychologist.id,
        status: { notIn: ['CANCELLED'] },
        startAt: { gte: dayStart },
        endAt: { lte: dayEnd },
      },
    });

    const slotsMap = new Map<string, { startAt: string; endAt: string; available: boolean }>();

    for (const schedule of dayAvailabilities) {
      const [startH, startM] = schedule.startTime.split(':').map(Number);
      const [endH, endM] = schedule.endTime.split(':').map(Number);
      const durationMs = (schedule.slotDuration || 50) * 60 * 1000;

      let currentSlotStart = new Date(`${date}T00:00:00.000Z`);
      currentSlotStart.setUTCHours(startH, startM, 0, 0);

      const scheduleEnd = new Date(`${date}T00:00:00.000Z`);
      scheduleEnd.setUTCHours(endH, endM, 0, 0);

      while (currentSlotStart.getTime() + durationMs <= scheduleEnd.getTime()) {
        const currentSlotEnd = new Date(currentSlotStart.getTime() + durationMs);
        const slotKey = currentSlotStart.toISOString();

        if (!slotsMap.has(slotKey)) {
          // Check if any existing appointment collides with this slot
          const hasCollision = existingAppointments.some((appt) => {
            const apptStart = new Date(appt.startAt).getTime();
            const apptEnd = new Date(appt.endAt).getTime();
            return (
              currentSlotStart.getTime() < apptEnd &&
              currentSlotEnd.getTime() > apptStart
            );
          });

          slotsMap.set(slotKey, {
            startAt: currentSlotStart.toISOString(),
            endAt: currentSlotEnd.toISOString(),
            available: !hasCollision,
          });
        }

        // Advance to next slot
        currentSlotStart = currentSlotEnd;
      }
    }

    const slots = Array.from(slotsMap.values()).sort((a, b) =>
      a.startAt.localeCompare(b.startAt)
    );

    res.status(200).json({
      status: 'success',
      data: {
        date,
        dayOfWeek,
        psychologistId,
        consultationPrice: psychologist.consultationPrice,
        slots,
      },
    });
  } catch (error) {
    next(error);
  }
};
