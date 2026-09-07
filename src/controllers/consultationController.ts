import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import prisma from '../config/db';
import { ConsultationStatus, AppointmentStatus } from '@prisma/client';

export const getConsultation = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { appointmentId } = req.params;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        psychologist: true,
        consultation: true,
      },
    });

    if (!appointment || !appointment.consultation) {
      return next(new AppError('Consulta no encontrada para esta cita', 404));
    }

    const isPatient = appointment.userId === userId;
    const isPsychologist = appointment.psychologist.userId === userId;
    const isAdmin = req.user!.roles.includes('ADMIN');

    if (!isPatient && !isPsychologist && !isAdmin) {
      return next(new AppError('No tienes permisos para acceder a esta consulta', 403));
    }

    const consultation = appointment.consultation;

    // Confidentiality rule: Patients cannot read the therapist's private clinical notes
    const sanitizedConsultation = {
      id: consultation.id,
      appointmentId: consultation.appointmentId,
      status: consultation.status,
      startedAt: consultation.startedAt,
      endedAt: consultation.endedAt,
      meetingUrl: consultation.meetingUrl,
      createdAt: consultation.createdAt,
      updatedAt: consultation.updatedAt,
      clinicalNotes: isPsychologist || isAdmin ? consultation.clinicalNotes : undefined,
    };

    res.status(200).json({
      status: 'success',
      data: {
        consultation: sanitizedConsultation,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const startConsultation = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { appointmentId } = req.params;
    const { meetingUrl } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        psychologist: true,
        consultation: true,
      },
    });

    if (!appointment || !appointment.consultation) {
      return next(new AppError('Consulta no encontrada', 404));
    }

    const isPsychologist = appointment.psychologist.userId === userId;
    const isAdmin = req.user!.roles.includes('ADMIN');

    if (!isPsychologist && !isAdmin) {
      return next(new AppError('Solo el profesional tratante puede iniciar la consulta', 403));
    }

    const updated = await prisma.consultation.update({
      where: { appointmentId },
      data: {
        status: ConsultationStatus.IN_PROGRESS,
        startedAt: appointment.consultation.startedAt || new Date(),
        meetingUrl: meetingUrl || appointment.consultation.meetingUrl,
      },
    });

    res.status(200).json({
      status: 'success',
      message: 'Consulta iniciada con éxito',
      data: {
        consultation: updated,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const completeConsultation = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { appointmentId } = req.params;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        psychologist: true,
        consultation: true,
      },
    });

    if (!appointment || !appointment.consultation) {
      return next(new AppError('Consulta no encontrada', 404));
    }

    const isPsychologist = appointment.psychologist.userId === userId;
    const isAdmin = req.user!.roles.includes('ADMIN');

    if (!isPsychologist && !isAdmin) {
      return next(new AppError('Solo el profesional tratante puede concluir la consulta', 403));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const cons = await tx.consultation.update({
        where: { appointmentId },
        data: {
          status: ConsultationStatus.COMPLETED,
          endedAt: new Date(),
        },
      });

      await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: AppointmentStatus.COMPLETED,
        },
      });

      return cons;
    });

    res.status(200).json({
      status: 'success',
      message: 'Consulta y cita concluidas con éxito',
      data: {
        consultation: updated,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateClinicalNotes = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const { appointmentId } = req.params;
    const { clinicalNotes } = req.body;

    if (clinicalNotes === undefined) {
      return next(new AppError('Se debe proporcionar el campo clinicalNotes', 400));
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        psychologist: true,
        consultation: true,
      },
    });

    if (!appointment || !appointment.consultation) {
      return next(new AppError('Consulta no encontrada', 404));
    }

    const isPsychologist = appointment.psychologist.userId === userId;

    if (!isPsychologist) {
      return next(
        new AppError('Acceso denegado: Únicamente el profesional asignado puede redactar notas clínicas confidenciales', 403)
      );
    }

    const updated = await prisma.consultation.update({
      where: { appointmentId },
      data: { clinicalNotes },
    });

    res.status(200).json({
      status: 'success',
      message: 'Notas clínicas actualizadas con éxito en el expediente del paciente',
      data: {
        consultation: updated,
      },
    });
  } catch (error) {
    next(error);
  }
};
