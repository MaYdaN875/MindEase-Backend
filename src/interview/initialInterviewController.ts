import { NextFunction, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import {
  completeInitialInterview,
  getInitialInterviewPrivacyNotice,
  getInterviewProgress,
  getInterviewReview,
  getInterviewStatus,
  getProfessionalInitialInterviewPdf,
  getProfessionalInitialInterviewReport,
  saveInterviewAnswer,
  startInitialInterview,
  reviseInterviewAnswer,
} from './initialInterviewService';

type Handler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;
const handle = (action: (req: AuthenticatedRequest, res: Response) => Promise<void>): Handler =>
  async (req, res, next) => {
    try {
      await action(req, res);
    } catch (error) {
      next(error);
    }
  };

function assertPatient(req: AuthenticatedRequest): string {
  const roles = req.user?.roles ?? [];
  if (!roles.includes('USER') || roles.some(role =>
    ['ADMIN', 'SUPERADMIN', 'PSYCHOLOGIST', 'PSYCHOLOGIST_APPLICANT', 'PSYCHOLOGIST_VERIFIED'].includes(role))) {
    throw new AppError('Esta entrevista está disponible únicamente para pacientes.', 403, 'INTERVIEW_PATIENT_ONLY');
  }
  if (!req.user?.userId) throw new AppError('No autorizado.', 401);
  return req.user.userId;
}

function professionalUserId(req: AuthenticatedRequest): string {
  if (!req.user?.userId) throw new AppError('No autorizado.', 401);
  return req.user.userId;
}

export const getStatus = handle(async (req, res) => {
  const data = await getInterviewStatus(assertPatient(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data });
});

export const getProgress = handle(async (req, res) => {
  const data = await getInterviewProgress(assertPatient(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data });
});

export const start = handle(async (req, res) => {
  const parsed = z.object({
    consentVersion: z.string().min(1).max(80),
    adultConfirmed: z.literal(true),
  }).strict().safeParse(req.body);
  if (!parsed.success) throw new AppError('Acepta el aviso vigente y confirma que eres mayor de edad.', 400, 'INTERVIEW_CONSENT_REQUIRED');
  const data = await startInitialInterview(assertPatient(req), parsed.data.adultConfirmed, parsed.data.consentVersion);
  res.status(200).json({ status: 'success', data });
});

export const answer = handle(async (req, res) => {
  const parsed = z.object({
    questionId: z.string().min(1).max(80),
    answer: z.string().trim().min(1).max(300),
  }).strict().safeParse(req.body);
  if (!parsed.success) throw new AppError('La respuesta no cumple el formato permitido.', 400, 'INTERVIEW_INVALID_ANSWER');
  const data = await saveInterviewAnswer(assertPatient(req), parsed.data.questionId, parsed.data.answer);
  res.json({ status: 'success', data });
});

export const complete = handle(async (req, res) => {
  const parsed = z.object({ confirmed: z.literal(true) }).strict().safeParse(req.body);
  if (!parsed.success) throw new AppError('Confirma que deseas finalizar la entrevista.', 400, 'INTERVIEW_CONFIRMATION_REQUIRED');
  const data = await completeInitialInterview(assertPatient(req), parsed.data.confirmed);
  res.json({ status: 'success', data });
});

export const review = handle(async (req, res) => {
  const data = await getInterviewReview(assertPatient(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data });
});

export const revise = handle(async (req, res) => {
  const parsed = z.object({
    questionId: z.string().min(1).max(80),
    answer: z.string().trim().min(1).max(300),
  }).strict().safeParse(req.body);
  if (!parsed.success) throw new AppError('La corrección no cumple el formato permitido.', 400, 'INTERVIEW_INVALID_ANSWER');
  const data = await reviseInterviewAnswer(assertPatient(req), parsed.data.questionId, parsed.data.answer);
  res.json({ status: 'success', data });
});

export const resumeProfessionalInterview = handle(async (_req, _res) => {
  throw new AppError('La reanudación de una entrevista en crisis requiere un protocolo clínico aprobado y aún no está disponible.', 503, 'INTERVIEW_RESUME_UNAVAILABLE');
});

export const getProfessionalReport = handle(async (req, res) => {
  const parsed = z.object({
    patientId: z.string().uuid(),
    appointmentId: z.string().uuid(),
  }).safeParse({ patientId: req.params.patientId, appointmentId: req.query.appointmentId });
  if (!parsed.success) throw new AppError('Paciente o cita inválidos.', 400);
  const data = await getProfessionalInitialInterviewReport({
    professionalUserId: professionalUserId(req),
    roles: req.user!.roles,
    ...parsed.data,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'success',
    data: {
      recordId: data.recordId,
      interviewDate: data.interviewDate,
      report: data.report,
      answers: data.answers,
      disclaimer: 'DEMOSTRACIÓN ACADÉMICA con datos ficticios. Informe generado mediante IA, sin supervisión clínica ni validez para diagnóstico, tratamiento o atención real.',
    },
  });
});

export const downloadProfessionalPdf = handle(async (req, res) => {
  const parsed = z.object({
    patientId: z.string().uuid(),
    appointmentId: z.string().uuid(),
  }).safeParse({ patientId: req.params.patientId, appointmentId: req.query.appointmentId });
  if (!parsed.success) throw new AppError('Paciente o cita inválidos.', 400);
  const data = await getProfessionalInitialInterviewPdf({
    professionalUserId: professionalUserId(req),
    roles: req.user!.roles,
    ...parsed.data,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="informe-entrevista-${data.recordId}.pdf"`);
  res.send(data.pdf);
});

export const getPrivacyNotice = handle(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: getInitialInterviewPrivacyNotice() });
});
