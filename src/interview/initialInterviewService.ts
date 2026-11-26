import { createHash } from 'crypto';
import { InitialInterviewAccessAction, InitialInterviewStatus } from '@prisma/client';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';
import { AISafetyService } from '../ai/services/aiSafetyService';
import { CrisisProtocolService } from '../services/crisisProtocolService';
import { eligibleProfessionalWhere, requireProfessional, serializable } from '../services/clinicalPolicy';
import { requirePaid } from '../services/paymentWorkflow';
import { decryptClinicalData, encryptClinicalData, assertInitialInterviewEncryptionConfigured } from './clinicalDataEncryption';
import { getInterviewQuestion, initialInterviewQuestions, nextInterviewQuestionId, validateInterviewAnswer } from './initialInterviewQuestions';
import { createInitialInterviewPdf } from './initialInterviewPdf';
import { assertInterviewProviderConfiguration, generateInitialInterviewReport, InitialInterviewReport } from './geminiReportProvider';

const privacyText = [
  'No hay supervisión humana ni seguimiento automático de alertas. No se contactará a un profesional ni a emergencias automáticamente.',
  'Esta entrevista inicial estructurada es voluntaria y está disponible para personas adultas. No es un diagnóstico, tratamiento ni servicio de emergencia.',
  'Se recopilan tus respuestas para preparar un informe preliminar dirigido exclusivamente a profesionales autorizados con una cita pagada asociada a tu expediente.',
  'Las respuestas y el informe se cifran en la base de datos. Para generar el informe se envían a Google Gemini respuestas relacionadas con la atención. Se excluyen ciertos campos identificativos y se intentan ocultar datos de contacto, pero el texto libre puede contener datos que permitan identificarte.',
  'Evita incluir nombres completos, teléfonos, correos, direcciones, identificaciones o datos de terceras personas en tus respuestas.',
  'El proveedor puede tratar la información conforme a sus políticas vigentes. Eliminar datos de MindEase no garantiza la eliminación inmediata de copias procesadas por el proveedor o sus respaldos.',
  'El informe no será visible ni descargable desde tu perfil. El acceso profesional requiere una cita propia vinculada a ti, pago confirmado, profesional acreditado y cuenta activa. Administradores no tienen acceso automático.',
  'Puedes solicitar información o ejercer tus derechos de privacidad desde Perfil > Ayuda y soporte. La conservación y supresión se sujetan al aviso de privacidad y a las obligaciones legales aplicables.',
].join('\n\n');

export const initialInterviewConsentVersion =
  `v1-${createHash('sha256').update(privacyText).digest('hex').slice(0, 20)}`;

export function getInitialInterviewPrivacyNotice() {
  return {
    version: initialInterviewConsentVersion,
    title: 'Consentimiento para entrevista inicial asistida por IA',
    text: privacyText,
    provider: 'GOOGLE_GEMINI',
  };
}

function assertInterviewConfiguration(): void {
  assertInitialInterviewEncryptionConfigured();
  assertInterviewProviderConfiguration();
}

function progressView(interview: {
  id: string;
  status: InitialInterviewStatus;
  nextQuestionId: string | null;
  startedAt: Date;
}) {
  const index = interview.nextQuestionId
    ? initialInterviewQuestions.findIndex(question => question.id === interview.nextQuestionId)
    : initialInterviewQuestions.length;
  return {
    status: interview.status,
    question: interview.status === 'IN_PROGRESS' ? getInterviewQuestion(interview.nextQuestionId) : null,
    progress: {
      current: Math.min(index + 1, initialInterviewQuestions.length),
      total: initialInterviewQuestions.length,
      percent: Math.round((Math.min(index, initialInterviewQuestions.length) / initialInterviewQuestions.length) * 100),
    },
    startedAt: interview.startedAt,
  };
}

export async function getInterviewStatus(patientId: string) {
  const [interview, consent] = await Promise.all([
    prisma.initialInterview.findUnique({ where: { patientId }, select: { status: true } }),
    prisma.userConsent.findFirst({
      where: { userId: patientId, consentType: `INITIAL_INTERVIEW_${initialInterviewConsentVersion}` },
      select: { acceptedAt: true },
    }),
  ]);
  return {
    status: interview?.status ?? 'PENDING',
    available: true,
    hasConsent: !!consent,
    acceptedAt: consent?.acceptedAt ?? null,
    privacyNotice: getInitialInterviewPrivacyNotice(),
  };
}

export async function getInterviewProgress(patientId: string) {
  const interview = await prisma.initialInterview.findUnique({
    where: { patientId },
    select: { id: true, status: true, nextQuestionId: true, startedAt: true },
  });
  if (!interview) {
    return {
      status: 'PENDING' as const,
      question: null,
      progress: { current: 0, total: initialInterviewQuestions.length, percent: 0 },
      startedAt: null,
    };
  }
  const progress = { ...progressView(interview), startedAt: interview.startedAt };
  return interview.status === 'ESCALATED'
    ? {
      ...progress,
      needsImmediateHelp: true,
      safetyMessage: 'La entrevista está pausada para priorizar tu seguridad. Esta herramienta no es un servicio de emergencia; contacta a servicios de emergencia o a una persona de confianza.',
      resources: await AISafetyService.getCrisisResources('MX'),
    }
    : progress;
}

export async function startInitialInterview(patientId: string, adultConfirmed: boolean, consentVersion: string) {
  if (!adultConfirmed || consentVersion !== initialInterviewConsentVersion) {
    throw new AppError('Confirma que eres mayor de edad y acepta el aviso vigente de privacidad para continuar.', 400, 'INTERVIEW_CONSENT_REQUIRED');
  }
  assertInterviewConfiguration();

  const result = await prisma.$transaction(async tx => {
    const consentType = `INITIAL_INTERVIEW_${initialInterviewConsentVersion}`;
    const existingConsent = await tx.userConsent.findFirst({
      where: { userId: patientId, consentType },
      select: { id: true },
    });
    if (!existingConsent) {
      await tx.userConsent.create({
        data: {
          userId: patientId,
          consentType,
          legalCode: 'INITIAL_INTERVIEW',
          legalVersion: initialInterviewConsentVersion,
        },
      });
    }

    return tx.initialInterview.upsert({
      where: { patientId },
      update: { consentVersion: initialInterviewConsentVersion, adultConfirmed },
      create: {
        patientId,
        consentVersion: initialInterviewConsentVersion,
        adultConfirmed,
        nextQuestionId: initialInterviewQuestions[0].id,
        answersCiphertext: encryptClinicalData({}),
      },
    });
  });
  return progressView(result);
}

const immediateRiskQuestions = new Map<string, 'HIGH' | 'EMERGENCY'>([
  ['self_harm_thoughts', 'HIGH'],
  ['suicide_thoughts', 'EMERGENCY'],
  ['immediate_plan_or_means', 'EMERGENCY'],
  ['danger_from_others', 'EMERGENCY'],
  ['danger_to_others', 'EMERGENCY'],
]);

const outOfScopePatterns = [
  /\b(?:ignora|olvida|desactiva)\b.{0,50}\b(?:instrucciones|reglas|sistema|prompt)\b/i,
  /\b(?:revela|muestra|dime)\b.{0,40}\b(?:instrucciones|prompt|datos de otros pacientes|información del sistema)\b/i,
  /\b(?:dame|necesito|quiero)\b.{0,40}\b(?:un consejo|consejos|un diagnóstico|un tratamiento|medicamentos|una receta)\b/i,
  /\b(?:diagnostíca|diagnostica|prescribe|recétame|recomiéndame un medicamento)\b/i,
];

export function isInterviewOutOfScopeRequest(questionId: string, answer: string): boolean {
  const question = getInterviewQuestion(questionId);
  return question?.answerType === 'text' && outOfScopePatterns.some(pattern => pattern.test(answer));
}

export function isAdultBirthDate(value: string, now = new Date()): boolean {
  if (value === 'Prefiero no responder') return true;
  const birthDate = new Date(`${value}T00:00:00.000Z`);
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  if (now.getUTCMonth() < birthDate.getUTCMonth() ||
    (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate())) age--;
  return age >= 18;
}

export function classifyInitialInterviewRisk(questionId: string, answer: string): 'LOW' | 'MODERATE' | 'HIGH' | 'EMERGENCY' {
  const normalized = answer.trim().toLocaleLowerCase('es-MX');
  const explicitRisk = immediateRiskQuestions.get(questionId);
  return explicitRisk && normalized === 'sí'
    ? explicitRisk
    : AISafetyService.evaluateUserInput(answer).riskLevel;
}

export function assessInterviewRisk(questionId: string, answer: string, previousAnswers: string[], priorRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'EMERGENCY' = 'LOW') {
  const contextualRisk = AISafetyService.evaluateConversation(
    answer, previousAnswers.map(content => ({ role: 'USER', content })), priorRisk,
  ).riskLevel;
  const directRisk = classifyInitialInterviewRisk(questionId, answer);
  const rank = { LOW: 0, MODERATE: 1, HIGH: 2, EMERGENCY: 3 };
  return rank[directRisk] > rank[contextualRisk] ? directRisk : contextualRisk;
}

export async function saveInterviewAnswer(patientId: string, questionId: string, rawAnswer: string) {
  const answer = validateInterviewAnswer(questionId, rawAnswer);
  if (questionId === 'birth_date' && !isAdultBirthDate(answer)) {
    throw new AppError('La entrevista asistida por IA está disponible únicamente para personas adultas.', 403, 'INTERVIEW_ADULTS_ONLY');
  }
  const result = await serializable(async tx => {
    const interview = await tx.initialInterview.findUnique({ where: { patientId } });
    if (!interview) throw new AppError('La entrevista no ha comenzado.', 409, 'INTERVIEW_NOT_STARTED');
    if (interview.status === 'ESCALATED') throw new AppError('La entrevista está pausada para priorizar tu seguridad.', 409, 'INTERVIEW_ESCALATED');
    if (interview.status === 'COMPLETED') throw new AppError('La entrevista ya fue completada.', 409, 'INTERVIEW_COMPLETED');

    const answers = interview.answersCiphertext
      ? decryptClinicalData<Record<string, string>>(interview.answersCiphertext)
      : {};
    if (questionId !== interview.nextQuestionId) {
      if (answers[questionId] === answer) return { interview, needsHelp: false };
      throw new AppError('La respuesta no corresponde a la pregunta activa. Actualiza el progreso antes de continuar.', 409, 'INTERVIEW_STALE_QUESTION');
    }

    answers[questionId] = answer;
    const riskLevel = assessInterviewRisk(questionId, answer, Object.values(answers).slice(0, -1), interview.riskLevel);
    const needsHelp = riskLevel === 'HIGH' || riskLevel === 'EMERGENCY';
    if (!needsHelp && isInterviewOutOfScopeRequest(questionId, answer)) {
      return { interview, needsHelp: false, outOfScope: true };
    }
    const nextQuestionId = needsHelp ? null : nextInterviewQuestionId(questionId, answers);
    const updated = await tx.initialInterview.update({
      where: { id: interview.id },
      data: {
        answersCiphertext: encryptClinicalData(answers),
        nextQuestionId,
        riskLevel,
        ...(needsHelp ? { status: 'ESCALATED' } : {}),
      },
    });
    if (needsHelp) {
      await CrisisProtocolService.record(tx, {
        userId: patientId,
        source: 'INITIAL_INTERVIEW',
        sourceId: interview.id,
        severity: riskLevel,
      });
    }
    return { interview: updated, needsHelp };
  });

  if (result.needsHelp) {
    return {
      ...progressView(result.interview),
      needsImmediateHelp: true,
      safetyMessage: 'Gracias por contarlo. Tu seguridad es prioritaria. Esta entrevista no es un servicio de emergencia; contacta ahora a los servicios de emergencia o a una persona de confianza.',
      resources: await AISafetyService.getCrisisResources('MX'),
    };
  }
  if ('outOfScope' in result && result.outOfScope) {
    return { ...progressView(result.interview), needsImmediateHelp: false,
      boundaryMessage: 'Esta sección está destinada exclusivamente a la entrevista inicial. No puedo ofrecer consejos ni diagnósticos. Continuemos con la pregunta indicada.' };
  }
  return { ...progressView(result.interview), needsImmediateHelp: false };
}

export async function getInterviewReview(patientId: string) {
  const interview = await prisma.initialInterview.findUnique({ where: { patientId } });
  if (!interview || interview.status !== 'IN_PROGRESS' || interview.nextQuestionId) {
    throw new AppError('La revisión estará disponible al responder todas las preguntas.', 409, 'INTERVIEW_REVIEW_NOT_READY');
  }
  const answers = interview.answersCiphertext
    ? decryptClinicalData<Record<string, string>>(interview.answersCiphertext)
    : {};
  return {
    answers: initialInterviewQuestions
      .filter(question => Object.prototype.hasOwnProperty.call(answers, question.id))
      .map(question => ({
        questionId: question.id,
        module: question.module,
        prompt: question.prompt,
        answerType: question.answerType,
        options: question.options ?? [],
        answer: answers[question.id],
      })),
    total: initialInterviewQuestions.length,
  };
}

export async function reviseInterviewAnswer(patientId: string, questionId: string, rawAnswer: string) {
  const answer = validateInterviewAnswer(questionId, rawAnswer);
  const result = await serializable(async tx => {
    const interview = await tx.initialInterview.findUnique({ where: { patientId } });
    if (!interview || interview.status !== 'IN_PROGRESS' || interview.nextQuestionId) {
      throw new AppError('Solo puedes corregir respuestas antes de finalizar la entrevista.', 409, 'INTERVIEW_REVISION_NOT_ALLOWED');
    }
    const answers = interview.answersCiphertext
      ? decryptClinicalData<Record<string, string>>(interview.answersCiphertext)
      : {};
    if (!Object.prototype.hasOwnProperty.call(answers, questionId)) {
      throw new AppError('La respuesta no pertenece a esta entrevista.', 400, 'INTERVIEW_INVALID_ANSWER');
    }
    answers[questionId] = answer;
    const riskLevel = Object.entries(answers).reduce<'LOW' | 'MODERATE' | 'HIGH' | 'EMERGENCY'>((strongest, [id, value]) => {
      const current = classifyInitialInterviewRisk(id, value);
      const rank = { LOW: 0, MODERATE: 1, HIGH: 2, EMERGENCY: 3 };
      return rank[current] > rank[strongest] ? current : strongest;
    }, AISafetyService.evaluateConversation('', Object.values(answers).map(content => ({ role: 'USER', content })), interview.riskLevel).riskLevel);
    const needsHelp = riskLevel === 'HIGH' || riskLevel === 'EMERGENCY';
    const updated = await tx.initialInterview.update({
      where: { id: interview.id },
      data: {
        answersCiphertext: encryptClinicalData(answers),
        riskLevel,
        ...(needsHelp ? { status: 'ESCALATED' } : {}),
      },
    });
    if (needsHelp) {
      await CrisisProtocolService.record(tx, {
        userId: patientId,
        source: 'INITIAL_INTERVIEW',
        sourceId: interview.id,
        severity: riskLevel,
      });
    }
    return { interview: updated, needsHelp };
  });
  return result.needsHelp
    ? {
      ...progressView(result.interview),
      needsImmediateHelp: true,
      safetyMessage: 'Gracias por contarlo. Tu seguridad es prioritaria. Esta entrevista no es un servicio de emergencia; contacta ahora a los servicios de emergencia o a una persona de confianza.',
      resources: await AISafetyService.getCrisisResources('MX'),
    }
    : { ...progressView(result.interview), needsImmediateHelp: false };
}

export async function resumeInitialInterviewByProfessional(input: {
  professionalUserId: string;
  roles: string[];
  patientId: string;
  appointmentId: string;
}) {
  if (!hasVerifiedInterviewProfessionalRole(input.roles)) {
    throw new AppError('Solo un profesional acreditado puede reanudar la entrevista.', 403, 'INTERVIEW_RESUME_DENIED');
  }
  return serializable(async tx => {
    const profile = await tx.psychologistProfile.findFirst({
      where: { userId: input.professionalUserId, ...eligibleProfessionalWhere },
      select: { id: true },
    });
    if (!profile) throw new AppError('El profesional no está activo y acreditado.', 403, 'INTERVIEW_RESUME_DENIED');

    const appointment = await tx.appointment.findFirst({
      where: {
        id: input.appointmentId,
        userId: input.patientId,
        psychologistId: profile.id,
      },
      include: { payment: true },
    });
    if (!appointment || !isEligiblePaidInterviewAppointment({
      patientId: input.patientId,
      psychologistId: profile.id,
      status: appointment.status,
      price: appointment.price,
      payment: appointment.payment,
    })) {
      throw new AppError('Se requiere una cita pagada y válida para reanudar.', 403, 'INTERVIEW_APPOINTMENT_NOT_AUTHORIZED');
    }

    const interview = await tx.initialInterview.findUnique({ where: { patientId: input.patientId } });
    if (!interview) throw new AppError('La entrevista no existe.', 404, 'INTERVIEW_NOT_FOUND');
    if (interview.status !== 'ESCALATED') {
      throw new AppError('La entrevista no está escalada.', 409, 'INTERVIEW_NOT_ESCALATED');
    }

    const answers = interview.answersCiphertext
      ? decryptClinicalData<Record<string, string>>(interview.answersCiphertext)
      : {};
    for (const questionId of [
      'self_harm_thoughts',
      'suicide_thoughts',
      'immediate_plan_or_means',
      'danger_from_others',
      'danger_to_others',
    ]) {
      delete answers[questionId];
    }

    const nextQuestionId = initialInterviewQuestions.find(question =>
      !Object.prototype.hasOwnProperty.call(answers, question.id),
    )?.id ?? null;

    const resumed = await tx.initialInterview.update({
      where: { id: interview.id },
      data: {
        status: 'IN_PROGRESS',
        riskLevel: 'LOW',
        nextQuestionId,
        answersCiphertext: encryptClinicalData(answers),
      },
    });
    await tx.auditLog.create({
      data: {
        userId: input.professionalUserId,
        action: 'RESUME_INITIAL_INTERVIEW',
        details: {
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          interviewId: interview.id,
          previousRiskLevel: interview.riskLevel,
        },
      },
    });
    return progressView(resumed);
  });
}

export async function completeInitialInterview(patientId: string, confirmed: boolean) {
  if (!confirmed) throw new AppError('Confirma que la información es correcta para finalizar.', 400, 'INTERVIEW_CONFIRMATION_REQUIRED');
  assertInterviewConfiguration();
  const interview = await prisma.initialInterview.findUnique({ where: { patientId } });
  if (!interview) throw new AppError('La entrevista no ha comenzado.', 409, 'INTERVIEW_NOT_STARTED');
  if (interview.status === 'COMPLETED') return { status: 'COMPLETED', completedAt: interview.completedAt };
  if (interview.status === 'ESCALATED') throw new AppError('La entrevista requiere apoyo humano y no puede finalizarse automáticamente.', 409, 'INTERVIEW_ESCALATED');
  if (interview.nextQuestionId || !interview.answersCiphertext) {
    throw new AppError('Completa todas las preguntas antes de finalizar.', 409, 'INTERVIEW_INCOMPLETE');
  }

  const answers = decryptClinicalData<Record<string, string>>(interview.answersCiphertext);
  const generatedReport = await generateInitialInterviewReport(answers);
  const birthDate = answers.birth_date && answers.birth_date !== 'Prefiero no responder'
    ? new Date(`${answers.birth_date}T00:00:00.000Z`)
    : null;
  let age: number | null = null;
  if (birthDate) {
    const now = new Date();
    age = now.getUTCFullYear() - birthDate.getUTCFullYear();
    if (now.getUTCMonth() < birthDate.getUTCMonth() ||
      (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate())) age--;
  }
  const report = {
    ...generatedReport,
    generalData: {
      'Nombre preferido': answers.preferred_name || null,
      'Edad calculada': age,
      'Escolaridad': answers.education || null,
      'Ocupación': answers.occupation || null,
    },
  };
  const completedAt = new Date();
  const pdf = await createInitialInterviewPdf({ recordId: interview.id, createdAt: completedAt, report });
  const reportCiphertext = encryptClinicalData(report);
  const pdfCiphertext = encryptClinicalData(pdf.toString('base64'));

  const update = await prisma.initialInterview.updateMany({
    where: { id: interview.id, status: 'IN_PROGRESS', nextQuestionId: null, answersCiphertext: interview.answersCiphertext },
    data: { status: 'COMPLETED', reportCiphertext, pdfCiphertext, completedAt },
  });
  if (update.count !== 1) {
    const current = await prisma.initialInterview.findUnique({ where: { id: interview.id }, select: { status: true, completedAt: true } });
    if (current?.status === 'COMPLETED') return { status: current.status, completedAt: current.completedAt };
    throw new AppError('El estado de la entrevista cambió. Actualiza e inténtalo nuevamente.', 409, 'INTERVIEW_STATE_CHANGED');
  }
  return { status: 'COMPLETED', completedAt };
}

function interviewReportAndAnswers(interview: {
  id: string;
  completedAt: Date | null;
  answersCiphertext: string | null;
  reportCiphertext: string | null;
  pdfCiphertext: string | null;
}) {
  if (!interview.completedAt || !interview.answersCiphertext || !interview.reportCiphertext || !interview.pdfCiphertext) {
    throw new AppError('El informe de entrevista no está disponible.', 404, 'INTERVIEW_REPORT_NOT_FOUND');
  }
  return {
    recordId: interview.id,
    interviewDate: interview.completedAt,
    answers: decryptClinicalData<Record<string, string>>(interview.answersCiphertext),
    report: decryptClinicalData<InitialInterviewReport & { generalData?: Record<string, string | number | null> }>(interview.reportCiphertext),
    pdf: Buffer.from(decryptClinicalData<string>(interview.pdfCiphertext), 'base64'),
  };
}

async function authorizeProfessionalAccess(input: {
  professionalUserId: string;
  roles: string[];
  patientId: string;
  appointmentId: string;
  action: InitialInterviewAccessAction;
}) {
  if (!hasVerifiedInterviewProfessionalRole(input.roles)) {
    throw new AppError('Solo un profesional acreditado puede consultar este expediente.', 403, 'INTERVIEW_ACCESS_DENIED');
  }

  return serializable(async tx => {
    const profile = await tx.psychologistProfile.findFirst({
      where: { userId: input.professionalUserId, ...eligibleProfessionalWhere },
      select: { id: true },
    });
    if (!profile) throw new AppError('El profesional no está activo y acreditado.', 403, 'INTERVIEW_ACCESS_DENIED');

    const appointment = await tx.appointment.findFirst({
      where: {
        id: input.appointmentId,
        userId: input.patientId,
        psychologistId: profile.id,
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] },
      },
      include: { payment: true },
    });
    if (!appointment || !isEligiblePaidInterviewAppointment({
      patientId: input.patientId,
      psychologistId: profile.id,
      status: appointment.status,
      price: appointment.price,
      payment: appointment.payment,
    })) {
      throw new AppError('No existe una cita pagada y vigente que autorice este acceso.', 403, 'INTERVIEW_APPOINTMENT_NOT_AUTHORIZED');
    }
    await requireProfessional(tx, profile.id);
    await requirePaid(tx, appointment);

    const interview = await tx.initialInterview.findUnique({ where: { patientId: input.patientId } });
    if (!interview || interview.status !== 'COMPLETED') {
      throw new AppError('No hay un informe completado disponible para este paciente.', 404, 'INTERVIEW_REPORT_NOT_FOUND');
    }
    const content = interviewReportAndAnswers(interview);
    await tx.initialInterviewAccessLog.create({
      data: {
        interviewId: interview.id,
        actorUserId: input.professionalUserId,
        appointmentId: appointment.id,
        action: input.action,
      },
    });
    return content;
  });
}

export function isEligiblePaidInterviewAppointment(input: {
  patientId: string;
  psychologistId: string;
  status: string;
  price: number;
  payment: { patientId: string; psychologistId: string; status: string } | null;
}): boolean {
  return input.price > 0 &&
    ['PENDING', 'CONFIRMED', 'COMPLETED'].includes(input.status) &&
    input.payment?.patientId === input.patientId &&
    input.payment.psychologistId === input.psychologistId &&
    input.payment.status === 'SUCCEEDED';
}

export function hasVerifiedInterviewProfessionalRole(roles: string[]): boolean {
  return roles.includes('PSYCHOLOGIST_VERIFIED');
}

export function getProfessionalInitialInterviewReport(input: Omit<Parameters<typeof authorizeProfessionalAccess>[0], 'action'>) {
  return authorizeProfessionalAccess({ ...input, action: 'VIEW_REPORT' });
}

export function getProfessionalInitialInterviewPdf(input: Omit<Parameters<typeof authorizeProfessionalAccess>[0], 'action'>) {
  return authorizeProfessionalAccess({ ...input, action: 'DOWNLOAD_PDF' });
}
