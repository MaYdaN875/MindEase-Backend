import prisma from '../../config/db';
import { eligibleProfessionalWhere } from '../../services/clinicalPolicy';
import {
  NeedsProfile,
  OrientationRecommendationsResponse,
  RecommendedPsychologist,
  RecommendedSpecialty,
} from '../types/ai.types';

export class AIRecommendationService {
  /**
   * Genera recomendaciones de especialidades y psicólogos verificados a partir del NeedsProfile.
   */
  static async generateRecommendations(
    sessionId: string,
    needsProfile: NeedsProfile
  ): Promise<OrientationRecommendationsResponse> {
    const session = await prisma.aIOrientationSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new Error(`Orientation session ${sessionId} not found`);
    }

    // 1. Resolver especialidades reales en la base de datos
    const allDbSpecialties = await prisma.specialty.findMany();
    const resolvedSpecialties: RecommendedSpecialty[] = [];

    for (const suggested of needsProfile.suggestedSpecialties) {
      const match = allDbSpecialties.find(
        dbSpec =>
          dbSpec.name.toLowerCase() === suggested.name.toLowerCase() ||
          dbSpec.name.toLowerCase().includes(suggested.name.toLowerCase()) ||
          suggested.name.toLowerCase().includes(dbSpec.name.toLowerCase())
      );

      if (match && !resolvedSpecialties.some(r => r.id === match.id)) {
        resolvedSpecialties.push({
          id: match.id,
          name: match.name,
          reason: suggested.reason,
        });
      }
    }

    // Si ninguna coincidió de forma exacta, asignar la especialidad más general si existe (ej. Psicología Clínica)
    if (resolvedSpecialties.length === 0 && allDbSpecialties.length > 0) {
      const defaultSpec =
        allDbSpecialties.find(s => s.name.toLowerCase().includes('clínica')) ||
        allDbSpecialties[0];
      resolvedSpecialties.push({
        id: defaultSpec.id,
        name: defaultSpec.name,
        reason: 'Especialidad base recomendada para evaluación y acompañamiento inicial.',
      });
    }

    // 2. Buscar psicólogos verificados y activos (política de seguridad clínica)
    const specialtyIds = resolvedSpecialties.map(s => s.id);

    const eligiblePsychologists = await prisma.psychologistProfile.findMany({
      where: {
        ...eligibleProfessionalWhere,
        specialties: specialtyIds.length > 0 ? {
          some: {
            specialtyId: { in: specialtyIds },
          },
        } : undefined,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
          },
        },
        specialties: {
          include: {
            specialty: true,
          },
        },
        availabilities: {
          where: { isActive: true },
        },
      },
    });

    // Si no hay psicólogos que coincidan con la especialidad específica, consultar psicólogos verificados generales
    const candidates = eligiblePsychologists.length > 0
      ? eligiblePsychologists
      : await prisma.psychologistProfile.findMany({
          where: eligibleProfessionalWhere,
          include: {
            user: { select: { id: true, name: true } },
            specialties: { include: { specialty: true } },
            availabilities: { where: { isActive: true } },
          },
          take: 5,
        });

    // 3. Scoring determinístico
    const maxBudget = needsProfile.preferences.maxBudget;
    const preferredModality = needsProfile.preferences.modality;

    const scoredPsychologists: RecommendedPsychologist[] = candidates.map(psych => {
      let score = 0;
      const matchReasons: string[] = [];

      // Coincidencia de especialidad (+50)
      const psychSpecialtyIds = psych.specialties.map(s => s.specialtyId);
      const matchingCount = specialtyIds.filter(id => psychSpecialtyIds.includes(id)).length;
      if (matchingCount > 0) {
        score += 50;
        matchReasons.push('Cuenta con especialidad afín a tus necesidades');
      }

      // Modalidad compatible (+20)
      if (preferredModality === 'ONLINE' || preferredModality === 'ANY' || !preferredModality) {
        score += 20;
        matchReasons.push('Disponible para consultas por videollamada');
      } else {
        score += 10;
      }

      // Presupuesto compatible (+15)
      if (maxBudget && psych.consultationPrice && psych.consultationPrice <= maxBudget) {
        score += 15;
        matchReasons.push(`Tarifa ($${psych.consultationPrice} MXN) dentro de tu presupuesto esperado`);
      } else if (!maxBudget) {
        score += 10;
      }

      // Disponibilidad activa configurada (+15)
      if (psych.availabilities.length > 0) {
        score += 15;
        matchReasons.push('Horarios de atención activos para agendar');
      }

      return {
        id: psych.id,
        userId: psych.user.id,
        name: psych.user.name,
        academicBackground: psych.academicBackground,
        photoUrl: psych.photoUrl,
        consultationPrice: psych.consultationPrice,
        score,
        matchReasons,
        specialties: psych.specialties.map(s => s.specialty.name),
      };
    });

    // Ordenar de mayor a menor puntuación
    scoredPsychologists.sort((a, b) => b.score - a.score);

    // 4. Persistir recomendaciones en la base de datos (evitando duplicados)
    await prisma.aIRecommendation.deleteMany({
      where: { sessionId },
    });

    for (const spec of resolvedSpecialties) {
      const topPsych = scoredPsychologists.find(p => p.specialties.includes(spec.name));
      await prisma.aIRecommendation.create({
        data: {
          sessionId,
          specialtyId: spec.id,
          psychologistId: topPsych ? topPsych.id : null,
          reason: spec.reason,
          score: topPsych ? topPsych.score : 50,
        },
      });
    }

    return {
      sessionId,
      isComplete: session.status === 'COMPLETED',
      riskLevel: session.riskLevel,
      summary: session.summary,
      suggestedSpecialties: resolvedSpecialties,
      recommendedPsychologists: scoredPsychologists,
    };
  }
}
