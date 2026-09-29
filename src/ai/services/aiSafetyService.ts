import prisma from '../../config/db';
import { AISafetyEvaluation, CrisisResourceData, AIOrientationResult, NeedsProfile, AIRiskLevelType } from '../types/ai.types';
import { needsProfileSchema } from '../schemas/aiOrientationSchema';

export class AISafetyService {
  static readonly SAFE_REPLY = 'Esta herramienta no puede establecer diagnósticos ni indicar tratamientos. Podrías buscar apoyo humano; podría ser beneficioso consultar con un profesional para evaluar tu situación. ¿Qué tipo de apoyo te gustaría encontrar?';
  static readonly SAFE_SUMMARY = 'Orientación general. La evaluación de necesidades corresponde a un profesional; no se ha establecido un diagnóstico.';

  private static normalized(text: string): string {
    return text.normalize('NFKD').replace(/[\u0300-\u036f\u200b-\u200f\ufeff]/g, '')
      .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Defense in depth only: these rules are not a clinical classifier or proof of safe output.
  private static readonly OUTPUT_VIOLATIONS = [
    /\b(tienes?|sufres? de|padeces?|presentas?)\s+(?:un[ao]?\s+|de\s+)?(?:depresion|ansiedad clinica|trastorno|bipolaridad|esquizofrenia|tdah)\b/i,
    /\b(?:tu diagnostico es|el diagnostico (?:es|del usuario)|te diagnostico|diagnosticad[oa] con)\b/i,
    /\b(?:te receto|debes tomar|debes suspender|deja de tomar|suspende (?:el|la|tu)|cambia (?:la|tu) dosis|aumenta (?:la|tu) dosis|reduce (?:la|tu) dosis)\b/i,
    /\b(?:toma|tomar|tomate)\s+(?:(?:el|la|un|una)\s+)?(?:medicamento|antidepresivo|ansiolitico|farmaco|pastilla|sertralina|fluoxetina|alprazolam)\b/i,
    /\b(?:toma|tomar|tomate)\b.{0,60}\b\d+(?:[.,]\d+)?\s*(?:mg|miligramos|ml)\b/i,
    /\b(?:cura garantizada|te curare|no necesitas (?:un |ir al )?(?:psicologo|terapeuta))\b/i,
  ];

  private static unsafe(text: string): boolean {
    const normalized = this.normalized(text);
    return [...this.DIAGNOSTIC_VIOLATIONS, ...this.OUTPUT_VIOLATIONS].some(pattern => pattern.test(normalized));
  }

  static sanitizeNeedsProfile(value: unknown): NeedsProfile {
    const parsed = needsProfileSchema.safeParse(value);
    const empty: NeedsProfile = { primaryConcern: null, topics: [], suggestedSpecialties: [],
      preferences: { modality: null, preferredTime: null, maxBudget: null } };
    if (!parsed.success) return empty;
    const profile = parsed.data;
    const texts = [profile.primaryConcern || '', ...profile.topics,
      ...profile.suggestedSpecialties.flatMap(s => [s.name, s.reason])];
    return texts.some(text => this.unsafe(text)) ? { ...empty, preferences: profile.preferences } : profile;
  }

  static sanitizeOrientationResult(result: AIOrientationResult): AIOrientationResult {
    const texts = [result.assistantMessage, result.conversation.summary || '',
      result.needsProfile.primaryConcern || '', ...result.needsProfile.topics,
      ...result.needsProfile.suggestedSpecialties.flatMap(s => [s.name, s.reason])];
    if (!texts.some(text => this.unsafe(text))) return result;
    return { ...result, assistantMessage: this.SAFE_REPLY,
      needsProfile: { primaryConcern: null, topics: [], suggestedSpecialties: [], preferences: result.needsProfile.preferences },
      conversation: { shouldContinue: true, isComplete: false, summary: this.SAFE_SUMMARY },
      // Never remove or reduce risk reported by the model while replacing its prose.
    };
  }

  static sanitizeSummary(text: string | null): string | null {
    return text && this.unsafe(text) ? this.SAFE_SUMMARY : text;
  }

  static evaluateConversation(text: string, history: Array<{ role: string; content: string }>, priorRisk: AIRiskLevelType = 'LOW'): AISafetyEvaluation {
    const userTexts = history.filter(m => m.role === 'USER').slice(-12).map(m => m.content);
    const candidates = [this.evaluateUserInput(text),
      ...userTexts.map(t => this.evaluateUserInput(t)),
      this.evaluateUserInput([...userTexts, text].join(' '))];
    const ranks = { LOW: 0, MODERATE: 1, HIGH: 2, EMERGENCY: 3 };
    const strongest = candidates.reduce((a, b) => ranks[b.riskLevel] > ranks[a.riskLevel] ? b : a);
    const riskLevel = ranks[priorRisk] > ranks[strongest.riskLevel] ? priorRisk : strongest.riskLevel;
    return { ...strongest, riskLevel, requiresImmediateHelp: riskLevel === 'HIGH' || riskLevel === 'EMERGENCY',
      flags: [...strongest.flags, ...(riskLevel !== candidates[0].riskLevel ? ['CONTEXT_RISK_RETAINED'] : [])] };
  }
  // Patrones de alto riesgo (Suicidio, autolesión, violencia inminente)
  private static readonly EMERGENCY_PATTERNS = [
    /\b(suicid\w*|quitarme la vida|matar(me)?|no quiero vivir|acabar con mi vida)\b/i,
    /\b(cortarme las venas|ahorcar(me)?|tirarme de|lanzarme a las v[ií]as)\b/i,
    /\b(voy a matar|hacerle da[ñn]o a|apu[ñn]alar)\b/i,
  ];

  // Patrones de riesgo moderado a alto (ideación pasiva, autolesión no letal, abuso grave)
  private static readonly HIGH_RISK_PATTERNS = [
    /\b(ojal[aá] me muriera|desear[ií]a no despertar|no le veo sentido a vivir|no vale la pena vivir)\b/i,
    /\b(me corto|me autolesiono|golpearme|quemarme la piel)\b/i,
    /\b(abuso f[ií]sico|violencia dom[eé]stica|agresi[oó]n sexual)\b/i,
  ];

  // Patrones de riesgo moderado (angustia intensa, ataques de pánico severos, desesperación)
  private static readonly MODERATE_RISK_PATTERNS = [
    /\b(ataque de p[aá]nico|no puedo respirar|siento que me muero de ansiedad|desesperaci[oó]n total)\b/i,
    /\b(no puedo m[aá]s|estoy colapsando|crisis de angustia)\b/i,
  ];

  // Patrones de infracción clínica en salida (diagnósticos o recetas prohibidas)
  private static readonly DIAGNOSTIC_VIOLATIONS = [
    /\b(tienes|sufres de|padeces)\s+(depresi[oó]n|ansiedad cl[ií]nica|trastorno|bipolaridad|esquizofrenia|tdah)\b/i,
    /\b(tu diagn[oó]stico es|te diagnostico con)\b/i,
    /\b(debes tomar|toma|te receto|suspende el|deja de tomar)\s+(medicamento|antidepresivo|ansiol[ií]tico|f[aá]rmaco|pastilla)\b/i,
  ];

  /**
   * Evaluación previa del mensaje del usuario antes de enviarlo al modelo.
   */
  static evaluateUserInput(text: string): AISafetyEvaluation {
    const trimmed = this.normalized(text);
    const flags: string[] = [];

    for (const pattern of this.EMERGENCY_PATTERNS) {
      if (pattern.test(trimmed)) {
        flags.push('EMERGENCY_RISK_DETECTED');
        return {
          riskLevel: 'EMERGENCY',
          requiresImmediateHelp: true,
          flags,
          emergencyMessage:
            'Percibimos que podrías estar atravesando una situación muy difícil o de riesgo. Tu seguridad y bienestar son prioritarios. Por favor comunícate de inmediato con las líneas de ayuda de emergencia mostradas a continuación.',
        };
      }
    }

    for (const pattern of this.HIGH_RISK_PATTERNS) {
      if (pattern.test(trimmed)) {
        flags.push('HIGH_RISK_DETECTED');
        return {
          riskLevel: 'HIGH',
          requiresImmediateHelp: true,
          flags,
          emergencyMessage:
            'Lo que describes requiere atención prioritaria y contención humana directa. Te recomendamos acudir a un centro de apoyo inmediato o contactar a las líneas de orientación en crisis.',
        };
      }
    }

    for (const pattern of this.MODERATE_RISK_PATTERNS) {
      if (pattern.test(trimmed)) {
        flags.push('MODERATE_RISK_DETECTED');
        return {
          riskLevel: 'MODERATE',
          requiresImmediateHelp: false,
          flags,
        };
      }
    }

    return {
      riskLevel: 'LOW',
      requiresImmediateHelp: false,
      flags,
    };
  }

  /**
   * Validación posterior de la respuesta generada para garantizar cumplimiento ético y clínico.
   */
  static sanitizeAndValidateAssistantOutput(text: string): {
    safeText: string;
    hasViolations: boolean;
  } {
    const hasViolations = this.unsafe(text);
    return { safeText: hasViolations ? this.SAFE_REPLY : text, hasViolations };
  }

  /**
   * Obtiene recursos de crisis según país desde la base de datos o fallbacks seguros.
   */
  static async getCrisisResources(countryCode: string = 'MX'): Promise<CrisisResourceData[]> {
    try {
      const resources = await prisma.aICrisisResource.findMany({
        where: {
          isActive: true,
          OR: [{ countryCode: countryCode.toUpperCase() }, { countryCode: 'DEFAULT' }],
        },
        orderBy: { createdAt: 'asc' },
      });

      if (resources.length > 0) {
        return resources.map(r => ({
          id: r.id,
          countryCode: r.countryCode,
          name: r.name,
          phone: r.phone,
          url: r.url,
          description: r.description,
          type: r.type,
          isActive: r.isActive,
        }));
      }
    } catch (_err) {
      // Continuar a fallback estático en caso de que la tabla aún no contenga registros
    }

    // Recursos de emergencia predeterminados confiables (México y Línea de apoyo)
    return [
      {
        countryCode: 'MX',
        name: 'Línea de la Vida (México)',
        phone: '800 911 2000',
        url: 'https://www.gob.mx/salud/conadic/acciones-y-programas/linea-de-la-vida-988',
        description: 'Atención especializada en salud mental y prevención del suicidio, 24/7.',
        type: 'SUICIDE_PREVENTION',
      },
      {
        countryCode: 'MX',
        name: 'Número de Emergencias 911',
        phone: '911',
        url: null,
        description: 'Servicio de atención a emergencias y auxilio médico inmediato.',
        type: 'EMERGENCY',
      },
      {
        countryCode: 'MX',
        name: 'SAPTEL (Salud Mental)',
        phone: '55 5259 8121',
        url: 'https://www.saptel.org.mx',
        description: 'Servicio de apoyo psicológico vía telefónica.',
        type: 'MENTAL_HEALTH',
      },
    ];
  }
}
