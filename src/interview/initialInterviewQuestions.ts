export type InterviewAnswerType = 'text' | 'date' | 'choice';

export interface InterviewQuestion {
  id: string;
  module: string;
  prompt: string;
  answerType: InterviewAnswerType;
  options?: string[];
}

const yesNo = ['Sí', 'No', 'Prefiero no responder'];

export const initialInterviewQuestions: InterviewQuestion[] = [
  { id: 'preferred_name', module: 'Información general', prompt: '¿Cómo te gustaría que te llamemos?', answerType: 'text' },
  { id: 'birth_date', module: 'Información general', prompt: 'Si te sientes cómodo/a, ¿cuál es tu fecha de nacimiento?', answerType: 'date', options: ['Prefiero no responder'] },
  { id: 'education', module: 'Información general', prompt: '¿Cuál es tu nivel de estudios?', answerType: 'choice', options: ['Secundaria', 'Preparatoria', 'Universidad', 'Posgrado', 'Otro', 'Prefiero no responder'] },
  { id: 'occupation', module: 'Información general', prompt: '¿Cuál opción describe mejor tu situación actual?', answerType: 'choice', options: ['Estudio', 'Trabajo', 'Busco empleo', 'Cuido de otras personas', 'Pensionado/a o jubilado/a', 'Otra', 'Prefiero no responder'] },
  { id: 'general_residence', module: 'Información general', prompt: '¿En qué región general resides?', answerType: 'choice', options: ['Ciudad de México', 'Estado de México', 'Otro estado de México', 'Otro país', 'Prefiero no responder'] },
  { id: 'reason_for_support', module: 'Motivo de consulta', prompt: '¿Qué te ha motivado a buscar apoyo psicológico en este momento?', answerType: 'text' },
  { id: 'duration', module: 'Motivo de consulta', prompt: '¿Desde cuándo has experimentado esta situación?', answerType: 'choice', options: ['Menos de una semana', 'Hace algunas semanas', 'Hace algunos meses', 'Hace más de un año', 'No estoy seguro/a', 'Prefiero no responder'] },
  { id: 'daily_impact', module: 'Motivo de consulta', prompt: '¿Cómo afecta principalmente tu vida cotidiana?', answerType: 'choice', options: ['Sueño', 'Trabajo o estudio', 'Relaciones', 'Estado de ánimo', 'Autocuidado', 'Varias áreas', 'Prefiero no responder'] },
  { id: 'affected_areas', module: 'Motivo de consulta', prompt: '¿Qué área deseas atender primero?', answerType: 'choice', options: ['Ansiedad o estrés', 'Tristeza o motivación', 'Relaciones', 'Sueño', 'Duelo o pérdidas', 'Autoestima', 'Otro', 'Prefiero no responder'] },
  { id: 'prior_help', module: 'Motivo de consulta', prompt: '¿Has buscado ayuda anteriormente por esta situación?', answerType: 'choice', options: yesNo },
  { id: 'expectations', module: 'Motivo de consulta', prompt: '¿Qué esperas conseguir mediante la atención profesional?', answerType: 'choice', options: ['Comprender lo que siento', 'Aprender estrategias', 'Sentirme mejor', 'Recibir apoyo', 'Resolver una situación', 'No estoy seguro/a', 'Prefiero no responder'] },
  { id: 'current_emotion', module: 'Estado emocional', prompt: '¿Cómo describirías tu estado emocional durante las últimas dos semanas?', answerType: 'choice', options: ['Estable', 'Nervioso/a o ansioso/a', 'Triste o apagado/a', 'Irritable', 'Variado', 'Muy difícil de describir', 'Prefiero no responder'] },
  { id: 'emotional_changes', module: 'Estado emocional', prompt: '¿Has tenido cambios importantes en tu ánimo, ansiedad, estrés o tristeza?', answerType: 'choice', options: ['No', 'Leves', 'Moderados', 'Intensos', 'No estoy seguro/a', 'Prefiero no responder'] },
  { id: 'sleep', module: 'Estado emocional', prompt: '¿Cómo has dormido últimamente?', answerType: 'choice', options: ['Bien', 'Me cuesta conciliar el sueño', 'Me despierto varias veces', 'Duermo demasiado', 'Me canso al despertar', 'Prefiero no responder'] },
  { id: 'appetite', module: 'Estado emocional', prompt: '¿Has notado cambios en tu apetito o alimentación?', answerType: 'choice', options: ['No', 'Como menos', 'Como más', 'Muy variable', 'Prefiero no responder'] },
  { id: 'concentration_energy', module: 'Estado emocional', prompt: '¿Cómo están tu concentración y energía actualmente?', answerType: 'choice', options: ['Bien', 'Concentración baja', 'Poca energía', 'Ambas dificultades', 'No estoy seguro/a', 'Prefiero no responder'] },
  { id: 'relationships', module: 'Estado emocional', prompt: '¿Cómo te afectan actualmente tus relaciones?', answerType: 'choice', options: ['Sin dificultades', 'Leves dificultades', 'Conflictos frecuentes', 'Me siento aislado/a', 'Evito relacionarme', 'Prefiero no responder'] },
  { id: 'stressors', module: 'Estado emocional', prompt: '¿Qué suele generar más malestar?', answerType: 'choice', options: ['Trabajo o estudio', 'Familia', 'Pareja', 'Dinero', 'Salud', 'Varias situaciones', 'Prefiero no responder'] },
  { id: 'coping', module: 'Estado emocional', prompt: '¿Qué recurso te ayuda más a afrontar dificultades?', answerType: 'choice', options: ['Hablar con alguien', 'Actividad física', 'Descanso', 'Entretenimiento', 'Espiritualidad o reflexión', 'No tengo una estrategia', 'Prefiero no responder'] },
  { id: 'prior_treatment', module: 'Antecedentes', prompt: '¿Has recibido atención psicológica o psiquiátrica anteriormente?', answerType: 'choice', options: yesNo },
  { id: 'prior_diagnosis_or_medication', module: 'Antecedentes', prompt: '¿Existe algún diagnóstico previo comunicado por un profesional?', answerType: 'choice', options: ['Sí', 'No', 'No recuerdo', 'Prefiero no responder'] },
  { id: 'family_history', module: 'Antecedentes', prompt: '¿Hay antecedentes familiares de salud mental que consideres relevantes?', answerType: 'choice', options: yesNo },
  { id: 'important_events', module: 'Antecedentes', prompt: '¿Has tenido algún acontecimiento importante recientemente?', answerType: 'choice', options: ['Pérdida o duelo', 'Cambio familiar', 'Cambio laboral o académico', 'Problemas de salud', 'Ninguno', 'Prefiero no responder'] },
  { id: 'family_relationships', module: 'Antecedentes', prompt: '¿Cómo describirías actualmente tu relación con tu familia?', answerType: 'choice', options: ['De apoyo', 'Estable', 'Conflictiva', 'Distante', 'No tengo contacto', 'Prefiero no responder'] },
  { id: 'support_network', module: 'Antecedentes', prompt: '¿Con quién cuentas principalmente como red de apoyo?', answerType: 'choice', options: ['Familia', 'Pareja', 'Amigos', 'Profesional', 'Nadie', 'Varios grupos', 'Prefiero no responder'] },
  { id: 'self_harm_thoughts', module: 'Seguridad y bienestar', prompt: 'En las últimas semanas, ¿has tenido pensamientos de hacerte daño, aunque no tengas intención de hacerlo?', answerType: 'choice', options: yesNo },
  { id: 'suicide_thoughts', module: 'Seguridad y bienestar', prompt: '¿Has tenido pensamientos de quitarte la vida o de no querer seguir viviendo?', answerType: 'choice', options: yesNo },
  { id: 'immediate_plan_or_means', module: 'Seguridad y bienestar', prompt: '¿Tienes ahora intención, un plan o acceso a medios para hacerte daño o quitarte la vida?', answerType: 'choice', options: yesNo },
  { id: 'danger_from_others', module: 'Seguridad y bienestar', prompt: '¿Te encuentras actualmente en peligro por violencia, abuso o acciones de otra persona?', answerType: 'choice', options: yesNo },
  { id: 'danger_to_others', module: 'Seguridad y bienestar', prompt: '¿Sientes que podrías hacer daño a otra persona en este momento?', answerType: 'choice', options: yesNo },
  { id: 'care_preference', module: 'Preferencias de atención', prompt: '¿Qué tipo de atención o profesional prefieres?', answerType: 'choice', options: ['Psicología', 'Psiquiatría', 'No estoy seguro/a', 'Prefiero no responder'] },
  { id: 'care_modality', module: 'Preferencias de atención', prompt: '¿Qué modalidad prefieres?', answerType: 'choice', options: ['En línea', 'Presencial', 'Cualquiera', 'Prefiero no responder'] },
  { id: 'availability', module: 'Preferencias de atención', prompt: '¿Qué horario te resulta más fácil?', answerType: 'choice', options: ['Mañana', 'Tarde', 'Noche', 'Fin de semana', 'Variable', 'Prefiero no responder'] },
  { id: 'personal_goals', module: 'Preferencias de atención', prompt: '¿Qué objetivo personal priorizas?', answerType: 'choice', options: ['Reducir ansiedad o estrés', 'Mejorar el ánimo', 'Dormir mejor', 'Mejorar relaciones', 'Fortalecer habilidades', 'No estoy seguro/a', 'Prefiero no responder'] },
];

export function getInterviewQuestion(id: string | null | undefined): InterviewQuestion | null {
  return initialInterviewQuestions.find(question => question.id === id) || null;
}

export function validateInterviewAnswer(questionId: string, value: string): string {
  const question = getInterviewQuestion(questionId);
  if (!question) throw new Error('La pregunta activa no es válida.');
  const answer = value.trim();
  if (!answer || answer.length > (question.answerType === 'text' ? 300 : 160)) throw new Error('La respuesta excede el límite permitido.');
  if (question.answerType === 'choice' && !question.options?.includes(answer)) {
    throw new Error('Selecciona una de las opciones disponibles.');
  }
  if (question.answerType === 'date' && !question.options?.includes(answer)) {
    const parsed = new Date(`${answer}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(answer) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== answer || parsed.getTime() > Date.now()) {
      throw new Error('Indica una fecha válida que no sea posterior al día de hoy.');
    }
  }
  return answer;
}

export function nextInterviewQuestionId(questionId: string, answers: Record<string, string>): string | null {
  const index = initialInterviewQuestions.findIndex(question => question.id === questionId);
  if (index < 0) return null;
  for (let nextIndex = index + 1; nextIndex < initialInterviewQuestions.length; nextIndex++) {
    const candidate = initialInterviewQuestions[nextIndex];
    if (candidate.id === 'prior_help_details' && answers.prior_help !== 'Sí') continue;
    if (candidate.id === 'prior_treatment_details' && answers.prior_treatment !== 'Sí') continue;
    if (candidate.id === 'family_history_details' && answers.family_history !== 'Sí') continue;
    return candidate.id;
  }
  return null;
}
