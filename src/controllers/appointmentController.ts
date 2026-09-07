import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import prisma from '../config/db';
import { AppointmentStatus, ConsultationStatus } from '@prisma/client';

export const createAppointment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const patientUserId = req.user!.userId;
    const { psychologistId, startAt, endAt } = req.body;

    if (!psychologistId || !startAt || !endAt) {
      return next(new AppError('psychologistId, startAt y endAt son requeridos', 400));
    }

    const startDate = new Date(startAt);
    const endDate = new Date(endAt);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return next(new AppError('Fechas inválidas provistas', 400));
    }

    if (startDate >= endDate) {
      return next(new AppError('startAt debe ser anterior a endAt', 400));
    }

    if (startDate.getTime() < Date.now()) {
      return next(new AppError('No es posible agendar citas en fechas u horas pasadas', 400));
    }

    // Verify psychologist exists and is VERIFICADO
    const psychologist = await prisma.psychologistProfile.findUnique({
      where: { id: psychologistId },
      include: { user: true },
    });

    if (!psychologist) {
      return next(new AppError('Psicólogo no encontrado', 404));
    }

    if (psychologist.status !== 'VERIFICADO') {
      return next(new AppError('Este profesional aún no se encuentra verificado para consultas', 400));
    }

    if (psychologist.user.status !== 'ACTIVE') {
      return next(new AppError('La cuenta del profesional no se encuentra activa', 400));
    }

    if (psychologist.userId === patientUserId) {
      return next(new AppError('No puedes agendar una cita contigo mismo', 400));
    }

    // Check collision / overlapping appointments for this psychologist
    const psychologistCollision = await prisma.appointment.findFirst({
      where: {
        psychologistId,
        status: { notIn: [AppointmentStatus.CANCELLED] },
        OR: [
          {
            startAt: { lt: endDate },
            endAt: { gt: startDate },
          },
        ],
      },
    });

    if (psychologistCollision) {
      return next(new AppError('El psicólogo ya tiene una cita reservada en ese horario', 409));
    }

    // Check collision for the patient
    const patientCollision = await prisma.appointment.findFirst({
      where: {
        userId: patientUserId,
        status: { notIn: [AppointmentStatus.CANCELLED] },
        OR: [
          {
            startAt: { lt: endDate },
            endAt: { gt: startDate },
          },
        ],
      },
    });

    if (patientCollision) {
      return next(new AppError('Ya tienes otra cita agendada en ese mismo horario', 409));
    }

    const price = psychologist.consultationPrice || 0;

    // Create Appointment and linked Consultation in a single transaction
    const appointment = await prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.create({
        data: {
          psychologistId,
          userId: patientUserId,
          startAt: startDate,
          endAt: endDate,
          status: AppointmentStatus.CONFIRMED,
          price,
          consultation: {
            create: {
              status: ConsultationStatus.SCHEDULED,
            },
          },
        },
        include: {
          psychologist: {
            include: {
              user: {
                select: { id: true, name: true, email: true, phone: true },
              },
            },
          },
          user: {
            select: { id: true, name: true, email: true, phone: true },
          },
          consultation: true,
        },
      });

      return appt;
    });

    res.status(201).json({
      status: 'success',
      message: 'Cita reservada exitosamente',
      data: {
        appointment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getMyAppointments = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { status, as } = req.query; // as: 'patient' | 'psychologist'

    let whereClause: any = {};

    if (status && Object.values(AppointmentStatus).includes(status as AppointmentStatus)) {
      whereClause.status = status as AppointmentStatus;
    }

    if (as === 'psychologist') {
      const profile = await prisma.psychologistProfile.findUnique({
        where: { userId },
      });
      if (!profile) {
        return next(new AppError('No posees perfil de psicólogo', 404));
      }
      whereClause.psychologistId = profile.id;
    } else {
      // By default or as patient
      whereClause.userId = userId;
    }

    const appointments = await prisma.appointment.findMany({
      where: whereClause,
      orderBy: { startAt: 'desc' },
      include: {
        psychologist: {
          include: {
            user: {
              select: { id: true, name: true, email: true, phone: true },
            },
            specialties: {
              include: { specialty: true },
            },
          },
        },
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        consultation: true,
      },
    });

    res.status(200).json({
      status: 'success',
      data: {
        appointments,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getAppointmentById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        psychologist: {
          include: {
            user: {
              select: { id: true, name: true, email: true, phone: true },
            },
          },
        },
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        consultation: true,
      },
    });

    if (!appointment) {
      return next(new AppError('Cita no encontrada', 404));
    }

    const isPatient = appointment.userId === userId;
    const isPsychologist = appointment.psychologist.userId === userId;
    const isAdmin = req.user!.roles.includes('ADMIN');

    if (!isPatient && !isPsychologist && !isAdmin) {
      return next(new AppError('No tienes permisos para ver esta cita', 403));
    }

    res.status(200).json({
      status: 'success',
      data: {
        appointment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateAppointmentStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const { status, cancellationReason } = req.body;

    if (!status || !Object.values(AppointmentStatus).includes(status)) {
      return next(new AppError('Estado de cita inválido', 400));
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        psychologist: true,
      },
    });

    if (!appointment) {
      return next(new AppError('Cita no encontrada', 404));
    }

    const isPatient = appointment.userId === userId;
    const isPsychologist = appointment.psychologist.userId === userId;
    const isAdmin = req.user!.roles.includes('ADMIN');

    if (!isPatient && !isPsychologist && !isAdmin) {
      return next(new AppError('No tienes permisos para modificar esta cita', 403));
    }

    // Update appointment and sync consultation status
    const updated = await prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.update({
        where: { id },
        data: {
          status,
          cancellationReason: status === AppointmentStatus.CANCELLED ? cancellationReason : appointment.cancellationReason,
        },
      });

      if (status === AppointmentStatus.CANCELLED) {
        await tx.consultation.updateMany({
          where: { appointmentId: id },
          data: { status: ConsultationStatus.CANCELLED },
        });
      } else if (status === AppointmentStatus.COMPLETED) {
        await tx.consultation.updateMany({
          where: { appointmentId: id },
          data: { status: ConsultationStatus.COMPLETED, endedAt: new Date() },
        });
      }

      return appt;
    });

    res.status(200).json({
      status: 'success',
      message: `Cita actualizada al estado ${status}`,
      data: {
        appointment: updated,
      },
    });
  } catch (error) {
    next(error);
  }
};
