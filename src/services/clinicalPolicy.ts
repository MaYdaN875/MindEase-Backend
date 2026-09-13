import { Prisma, Consultation } from '@prisma/client';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';

export const eligibleProfessionalWhere: Prisma.PsychologistProfileWhereInput = {
  status: 'VERIFICADO',
  user: { status: 'ACTIVE', userRoles: { some: { role: { name: 'PSYCHOLOGIST_VERIFIED' } } } },
};

export async function requireProfessional(tx: Prisma.TransactionClient, id: string) {
  const profile = await tx.psychologistProfile.findFirst({
    where: { id, ...eligibleProfessionalWhere },
  });
  if (!profile) throw new AppError('El profesional debe tener cuenta activa, acreditación y rol verificados', 403);
  return profile;
}

// Re-read predicates on retry: simultaneous bookings cannot both commit.
export async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error;
    }
  }
  throw new AppError('La información cambió durante la operación. Actualiza e inténtalo de nuevo', 409);
}

export function consultationView(consultation: Consultation | null, canReadNotes: boolean) {
  if (!consultation) return null;
  const { clinicalNotes, ...publicFields } = consultation;
  return canReadNotes ? { ...publicFields, clinicalNotes } : publicFields;
}

export function appointmentView<T extends { consultation: Consultation | null; psychologist: { userId: string } }>(
  appointment: T, viewerId: string,
) {
  return { ...appointment, consultation: consultationView(appointment.consultation, appointment.psychologist.userId === viewerId) };
}

export function assertAppointmentTransition(current: string, target: string, isProfessional: boolean, isAdmin: boolean, consultationStatus?: string, endAt?: Date) {
  if (!['PENDING', 'CONFIRMED'].includes(current)) throw new AppError('La cita ya está cerrada', 409);
  if (consultationStatus === 'IN_PROGRESS') throw new AppError('Finaliza la consulta en curso desde el módulo de consultas', 409);
  if (target === 'CANCELLED') return;
  if (!isProfessional && !isAdmin) throw new AppError('El paciente solamente puede cancelar su cita', 403);
  if (current === 'PENDING' && target === 'CONFIRMED') return;
  if (current === 'CONFIRMED' && target === 'NO_SHOW' && endAt && endAt.getTime() <= Date.now()) return;
  throw new AppError('Transición inválida. Las consultas se completan desde el módulo de consultas', 409);
}
