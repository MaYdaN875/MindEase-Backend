import { IAIProvider } from './aiProvider.interface';
import { AIConversationContext, AIOrientationResult, PreferredModality } from '../types/ai.types';

export class MockAIProvider implements IAIProvider {
  readonly providerName = 'MOCK';

  async generateOrientation(context: AIConversationContext): Promise<AIOrientationResult> {
    const text = (context.userMessage || '').toLowerCase();
    const historyCount = context.history.length;

    // Check crisis keywords for mock simulation
    const isCrisis = /(suicid|matar(me)?|quitarme la vida|autolesi|morir(me)?|acabar con todo)/i.test(text);
    if (isCrisis) {
      return {
        assistantMessage:
          'Lamento mucho que estés pasando por este momento tan difícil. Tu vida y tu bienestar son lo más importante. Por favor, comunícate de inmediato con una línea de apoyo o acude a un centro de urgencias. Estamos aquí para ayudarte a encontrar apoyo profesional seguro.',
        needsProfile: {
          primaryConcern: 'Situación de crisis o angustia elevada reportada por el usuario',
          topics: ['crisis', 'apoyo_urgente'],
          suggestedSpecialties: [
            {
              name: 'Psicología Clínica',
              reason: 'Atención especializada para momentos de crisis y contención emocional.',
            },
          ],
          preferences: {
            modality: 'ONLINE',
            preferredTime: null,
            maxBudget: null,
          },
        },
        safety: {
          riskLevel: 'EMERGENCY',
          requiresImmediateHelp: true,
          flags: ['CRISIS_KEYWORDS_DETECTED'],
        },
        conversation: {
          shouldContinue: false,
          isComplete: true,
          summary: 'Usuario reportó angustia severa. Se activaron recursos de contención inmediata.',
        },
      };
    }

    // Detect topics & specialties
    const topics: string[] = [];
    const suggestedSpecialties: Array<{ name: string; reason: string }> = [];

    if (text.includes('dormir') || text.includes('sueño') || text.includes('insomnio')) {
      topics.push('insomnio', 'calidad_del_sueño');
      suggestedSpecialties.push({
        name: 'Manejo del Estrés',
        reason: 'Técnicas de regulación y hábitos para mejorar la conciliación del sueño.',
      });
    }

    if (text.includes('estrés') || text.includes('estres') || text.includes('trabajo') || text.includes('presión')) {
      topics.push('estrés', 'sobrecarga_laboral');
      if (!suggestedSpecialties.some(s => s.name === 'Manejo del Estrés')) {
        suggestedSpecialties.push({
          name: 'Manejo del Estrés',
          reason: 'Estrategias para gestionar demandas laborales y reducir el agotamiento.',
        });
      }
    }

    if (text.includes('ansiedad') || text.includes('pánico') || text.includes('angustia') || text.includes('nervios')) {
      topics.push('ansiedad', 'preocupación_constante');
      suggestedSpecialties.push({
        name: 'Terapia Cognitivo-Conductual',
        reason: 'Identificación y modificación de patrones de pensamiento que alimentan la inquietud.',
      });
    }

    if (text.includes('triste') || text.includes('desánimo') || text.includes('llorar') || text.includes('vacío')) {
      topics.push('estado_de_ánimo', 'tristeza');
      suggestedSpecialties.push({
        name: 'Psicología Clínica',
        reason: 'Espacio de exploración profunda sobre el estado afectivo y revitalización personal.',
      });
    }

    if (text.includes('pareja') || text.includes('relación') || text.includes('ruptura') || text.includes('familia')) {
      topics.push('vínculos_afectivos', 'comunicación');
      suggestedSpecialties.push({
        name: 'Terapia de Pareja',
        reason: 'Acompañamiento en resolución de conflictos afectivos y comunicación asertiva.',
      });
    }

    // Fallback topic/specialty if none matched
    if (suggestedSpecialties.length === 0) {
      topics.push('bienestar_general');
      suggestedSpecialties.push({
        name: 'Psicología Clínica',
        reason: 'Orientación general personalizada para comprender y atender lo que estás experimentando.',
      });
    }

    // Filter against availableSpecialties if provided
    const validSpecialties = suggestedSpecialties.filter(s =>
      context.availableSpecialties.length === 0 ||
      context.availableSpecialties.some(
        avail => avail.toLowerCase() === s.name.toLowerCase()
      )
    );

    // Preferences detection
    let modality: PreferredModality = 'ANY';
    if (text.includes('online') || text.includes('virtual') || text.includes('línea') || text.includes('video')) {
      modality = 'ONLINE';
    } else if (text.includes('presencial') || text.includes('consultorio')) {
      modality = 'IN_PERSON';
    }

    // Budget detection (e.g. "$500", "500 pesos", "hasta 600")
    const budgetMatch = text.match(/(\$|hasta|de\s*)?\s*(\d{3,4})\s*(pesos|mxn)?/i);
    const maxBudget = budgetMatch ? parseInt(budgetMatch[2], 10) : null;

    // Progression: After 2+ exchanges, suggest concluding
    const isReadyToComplete = historyCount >= 4;

    let assistantMessage: string;
    if (isReadyToComplete) {
      assistantMessage =
        'Gracias por compartir esto conmigo. Con base en lo que me has contado, he preparado un resumen de áreas que podrían ayudarte, junto con psicólogos verificados en MindEase que cuentan con experiencia en este tipo de situaciones. ¿Te gustaría ver las recomendaciones?';
    } else if (historyCount === 0) {
      assistantMessage =
        'Comprendo lo que mencionas y es muy válido buscar apoyo. ¿Desde hace cuánto tiempo sientes que esta situación comenzó a intensificarse en tu día a día?';
    } else {
      assistantMessage =
        'Entiendo. ¿Prefieres que las sesiones sean de forma virtual (videollamada) o estás buscando atención presencial si estuviera disponible?';
    }

    return {
      assistantMessage,
      needsProfile: {
        primaryConcern: topics.length > 0 ? `Atención orientada a ${topics.join(', ')}` : 'Orientación psicológica general',
        topics,
        suggestedSpecialties: validSpecialties.length > 0 ? validSpecialties : suggestedSpecialties,
        preferences: {
          modality,
          preferredTime: null,
          maxBudget,
        },
      },
      safety: {
        riskLevel: 'LOW',
        requiresImmediateHelp: false,
        flags: [],
      },
      conversation: {
        shouldContinue: !isReadyToComplete,
        isComplete: isReadyToComplete,
        summary: `Usuario consultó por ${topics.join(', ')}. Modalidad preferida: ${modality}.`,
      },
    };
  }
}
