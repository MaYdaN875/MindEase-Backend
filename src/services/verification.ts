import { PsychologistStatus } from '@prisma/client';
import { AppError } from '../middlewares/errorMiddleware';
import { serializable } from './clinicalPolicy';

export async function reviewApplication(applicationId: string, reviewerId: string, decision: 'ASSIGN' | 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT', notes?: string) {
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 5000)) throw new AppError('Las notas deben ser texto de hasta 5000 caracteres', 400);
  if (['REQUEST_CHANGES', 'REJECT'].includes(decision) && (typeof notes !== 'string' || !notes.trim() || notes.length > 5000)) throw new AppError('Indica un motivo de hasta 5000 caracteres', 400);
  await serializable(async tx => {
    const request = await tx.verificationRequest.findUnique({ where: { id: applicationId }, include: { psychologist: { include: { documents: true } } } });
    if (!request) throw new AppError('Solicitud no encontrada', 404);
    const profile = request.psychologist;
    if (profile.userId === reviewerId) throw new AppError('No puedes revisar tu propia solicitud', 403);
    if (!['PENDING', 'IN_PROGRESS'].includes(request.status) || !['PENDIENTE_REVISION', 'EN_REVISION'].includes(profile.status)) throw new AppError('La solicitud ya fue resuelta o no está en revisión', 409);
    const statuses: Record<typeof decision, PsychologistStatus> = { ASSIGN: 'EN_REVISION', APPROVE: 'VERIFICADO', REQUEST_CHANGES: 'REQUIERE_CAMBIOS', REJECT: 'RECHAZADO' };
    if (decision === 'APPROVE') {
      const valid = profile.documents.filter(d => d.status === 'APPROVED' && (!d.expiresAt || d.expiresAt.getTime() > Date.now()));
      if (!profile.licenseNumber?.trim() || !profile.description?.trim() || !['ID', 'DEGREE', 'LICENSE'].every(type => valid.some(d => d.documentType === type))) {
        throw new AppError('Para aprobar se requieren semblanza, cédula y documentos vigentes aprobados de identificación, título y cédula', 400);
      }
      const verified = await tx.role.findUnique({ where: { name: 'PSYCHOLOGIST_VERIFIED' } });
      if (!verified) throw new AppError('Falta configurar el rol profesional', 500);
      await tx.userRole.deleteMany({ where: { userId: profile.userId, role: { name: 'PSYCHOLOGIST_APPLICANT' } } });
      await tx.userRole.upsert({ where: { userId_roleId: { userId: profile.userId, roleId: verified.id } }, update: {}, create: { userId: profile.userId, roleId: verified.id } });
    }
    await tx.psychologistProfile.update({ where: { id: profile.id }, data: { status: statuses[decision] } });
    await tx.verificationStatusHistory.create({ data: { psychologistId: profile.id, fromStatus: profile.status, toStatus: statuses[decision], changedById: reviewerId, comment: notes?.trim() || decision } });
    await tx.verificationRequest.update({ where: { id: request.id }, data: { revisorId: reviewerId, status: decision === 'ASSIGN' ? 'IN_PROGRESS' : 'RESOLVED' } });
    if (decision !== 'ASSIGN') {
      await tx.verificationReview.create({ data: { requestId: request.id, revisorId: reviewerId, decision, notes: notes?.trim() || 'Documentación profesional aprobada' } });
      await tx.notification.create({ data: { userId: profile.userId, title: 'Actualización de verificación profesional', content: 'Estado: ' + statuses[decision] + (notes ? '. ' + notes.trim() : '') } });
    }
    await tx.auditLog.create({ data: { userId: reviewerId, action: decision + '_APPLICATION', details: { applicationId, psychologistId: profile.id } } });
  });
}
