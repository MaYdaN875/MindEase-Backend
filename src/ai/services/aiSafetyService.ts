import prisma from '../../config/db';
import { AISafetyEvaluation, CrisisResourceData } from '../types/ai.types';

export class AISafetyService {
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
    const trimmed = text.trim();
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
    let safeText = text;
    let hasViolations = false;

    for (const pattern of this.DIAGNOSTIC_VIOLATIONS) {
      if (pattern.test(safeText)) {
        hasViolations = true;
        // Reemplazar la frase indebida con fórmula prudente
        safeText = safeText.replace(
          pattern,
          'podría ser beneficioso consultar con un profesional para evaluar tu situación'
        );
      }
    }

    // Asegurar que contenga disclaimer si se detectan temas delicados
    return { safeText, hasViolations };
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
