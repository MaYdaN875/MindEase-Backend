import prisma from '../../config/db';
import { AppError } from '../../middlewares/errorMiddleware';
import { AIProviderFactory } from '../providers/aiProviderFactory';
import { AISafetyService } from './aiSafetyService';
import { AIRecommendationService } from './aiRecommendationService';
import { PROMPT_VERSION } from '../prompts/orientationPrompt';
import {
  AIChatMessage,
  AIOrientationResult,
  CrisisResourceData,
  NeedsProfile,
  OrientationRecommendationsResponse,
} from '../types/ai.types';

export class AIOrientationService {
  private static readonly MAX_CONTEXT_MESSAGES = 6;
  private static readonly MAX_MESSAGES_PER_SESSION = 20;

  /**
   * Crea una nueva sesión de orientación. Si ya existe una activa, la reutiliza o cierra según estado.
   */
  static async createOrGetSession(userId: string): Promise<any> {
    const existing = await prisma.aIOrientationSession.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (existing) {
      return existing;
    }

    const provider = AIProviderFactory.getProvider();

    // Crear sesión y el primer mensaje de bienvenida de la IA
    const session = await prisma.aIOrientationSession.create({
      data: {
        userId,
        status: 'ACTIVE',
        riskLevel: 'LOW',
        promptVersion: PROMPT_VERSION,
        provider: provider.providerName,
        messages: {
          create: {
            role: 'ASSISTANT',
            content:
              'Hola, bienvenido(a) a MindEase. Soy tu asistente de orientación inicial. Estoy aquí para escucharte y ayudarte a identificar qué tipo de apoyo profesional podría ser más útil para ti. ¿Qué te gustaría contarme sobre lo que estás viviendo últimamente?',
          },
        },
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return session;
  }

  /**
   * Obtiene la sesión activa actual del usuario si existe.
   */
  static async getActiveSession(userId: string): Promise<any> {
    return prisma.aIOrientationSession.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * Obtiene una sesión por su ID asegurando que pertenezca al usuario autenticado.
   */
  static async getSessionById(userId: string, sessionId: string): Promise<any> {
    const session = await prisma.aIOrientationSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      throw new AppError('Sesión de orientación no encontrada', 404);
    }

    if (session.userId !== userId) {
      throw new AppError('No tienes permiso para acceder a esta sesión', 403);
    }

    return session;
  }

  /**
   * Procesa el mensaje del usuario con la capa de seguridad, invocación de IA y guardado.
   */
  static async processMessage(
    userId: string,
    sessionId: string,
    userMessageText: string
  ): Promise<{
    userMessage: any;
    assistantMessage: any;
    isComplete: boolean;
    riskLevel: string;
    crisisResources?: CrisisResourceData[];
  }> {
    const session = await this.getSessionById(userId, sessionId);

    if (session.status === 'COMPLETED') {
      throw new AppError('Esta sesión de orientación ya fue completada.', 400);
    }

    if (session.status === 'CANCELLED') {
      throw new AppError('Esta sesión de orientación fue cancelada.', 400);
    }

    if (session.messages.length >= this.MAX_MESSAGES_PER_SESSION) {
      throw new AppError(
        'Has alcanzado el número máximo de mensajes para esta sesión de orientación. Por favor finalízala para ver tus recomendaciones.',
        400
      );
    }

    // 1. Pre-evaluación con AISafetyService
    const preSafety = AISafetyService.evaluateUserInput(userMessageText);

    // Guardar el mensaje del usuario
    const savedUserMsg = await prisma.aIMessage.create({
      data: {
        sessionId,
        role: 'USER',
        content: userMessageText.trim(),
      },
    });

    // 2. Manejo de Crisis o Emergencia inmediata
    if (preSafety.riskLevel === 'EMERGENCY' || preSafety.riskLevel === 'HIGH') {
      const crisisResources = await AISafetyService.getCrisisResources('MX');
      const crisisContent =
        preSafety.emergencyMessage ||
        'Tu bienestar y seguridad son lo más importante. Te recomendamos encarecidamente comunicarte de inmediato con los recursos de apoyo y contención especializada.';

      const savedAssistantMsg = await prisma.aIMessage.create({
        data: {
          sessionId,
          role: 'ASSISTANT',
          content: crisisContent,
        },
      });

      await prisma.aIOrientationSession.update({
        where: { id: sessionId },
        data: {
          status: 'ESCALATED',
          riskLevel: preSafety.riskLevel,
          summary: 'Sesión escalada debido a indicadores de riesgo o crisis detectados.',
        },
      });

      return {
        userMessage: savedUserMsg,
        assistantMessage: savedAssistantMsg,
        isComplete: true,
        riskLevel: preSafety.riskLevel,
        crisisResources,
      };
    }

    // 3. Preparar contexto para la IA
    const history: AIChatMessage[] = session.messages
      .slice(-this.MAX_CONTEXT_MESSAGES)
      .map((m: any) => ({
        role: m.role as 'USER' | 'ASSISTANT',
        content: m.content,
      }));

    // Obtener especialidades activas de la BD para el contexto
    const dbSpecialties = await prisma.specialty.findMany({ select: { name: true } });
    const availableSpecialties = dbSpecialties.map(s => s.name);

    // 4. Invocar proveedor de IA
    const provider = AIProviderFactory.getProvider();
    let result: AIOrientationResult;

    try {
      result = await provider.generateOrientation({
        sessionId,
        userId,
        history,
        userMessage: userMessageText,
        availableSpecialties,
      });
    } catch (_err) {
      throw new AppError(
        'La orientación con IA no se encuentra disponible temporalmente. Inténtalo de nuevo en unos minutos.',
        503
      );
    }

    // 5. Post-evaluación y saneamiento de salida
    const { safeText } = AISafetyService.sanitizeAndValidateAssistantOutput(
      result.assistantMessage
    );

    // Guardar respuesta del asistente
    const savedAssistantMsg = await prisma.aIMessage.create({
      data: {
        sessionId,
        role: 'ASSISTANT',
        content: safeText,
      },
    });

    // Actualizar estado de la sesión
    const updatedStatus = result.conversation.isComplete ? 'COMPLETED' : 'ACTIVE';
    const completedAt = result.conversation.isComplete ? new Date() : null;

    await prisma.aIOrientationSession.update({
      where: { id: sessionId },
      data: {
        status: updatedStatus,
        riskLevel: result.safety.riskLevel,
        summary: result.conversation.summary || null,
        needsProfile: result.needsProfile as any,
        completedAt,
      },
    });

    return {
      userMessage: savedUserMsg,
      assistantMessage: savedAssistantMsg,
      isComplete: result.conversation.isComplete,
      riskLevel: result.safety.riskLevel,
    };
  }

  /**
   * Finaliza la sesión manualmente si el usuario decide concluir antes y genera recomendaciones.
   */
  static async completeSession(
    userId: string,
    sessionId: string
  ): Promise<OrientationRecommendationsResponse> {
    const session = await this.getSessionById(userId, sessionId);

    let needsProfile: NeedsProfile = session.needsProfile as any;

    // Si aún no tenía perfil estructurado guardado, construir uno base con el historial
    if (!needsProfile) {
      needsProfile = {
        primaryConcern: session.summary || 'Orientación inicial para apoyo psicológico',
        topics: ['bienestar_general'],
        suggestedSpecialties: [
          {
            name: 'Psicología Clínica',
            reason: 'Área general recomendada para evaluar tus necesidades individuales.',
          },
        ],
        preferences: {
          modality: 'ONLINE',
          preferredTime: null,
          maxBudget: null,
        },
      };
    }

    await prisma.aIOrientationSession.update({
      where: { id: sessionId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        needsProfile: needsProfile as any,
      },
    });

    return AIRecommendationService.generateRecommendations(sessionId, needsProfile);
  }

  /**
   * Obtiene las recomendaciones de una sesión.
   */
  static async getRecommendations(
    userId: string,
    sessionId: string
  ): Promise<OrientationRecommendationsResponse> {
    const session = await this.getSessionById(userId, sessionId);

    const needsProfile: NeedsProfile = (session.needsProfile as any) || {
      primaryConcern: session.summary || 'Orientación inicial',
      topics: [],
      suggestedSpecialties: [
        {
          name: 'Psicología Clínica',
          reason: 'Acompañamiento clínico integral.',
        },
      ],
      preferences: { modality: 'ONLINE', preferredTime: null, maxBudget: null },
    };

    return AIRecommendationService.generateRecommendations(sessionId, needsProfile);
  }
}
