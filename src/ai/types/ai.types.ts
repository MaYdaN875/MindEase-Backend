export type AIRiskLevelType = 'LOW' | 'MODERATE' | 'HIGH' | 'EMERGENCY';

export type PreferredModality = 'ONLINE' | 'IN_PERSON' | 'ANY';
export type PreferredTime = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'WEEKEND' | 'ANY';

export interface NeedsProfile {
  primaryConcern: string | null;
  topics: string[];
  suggestedSpecialties: Array<{
    name: string;
    reason: string;
  }>;
  preferences: {
    modality: PreferredModality | null;
    preferredTime: PreferredTime | null;
    maxBudget: number | null;
  };
}

export interface AISafetyEvaluation {
  riskLevel: AIRiskLevelType;
  requiresImmediateHelp: boolean;
  flags: string[];
  emergencyMessage?: string;
}

export interface AIOrientationResult {
  assistantMessage: string;
  needsProfile: NeedsProfile;
  safety: AISafetyEvaluation;
  conversation: {
    shouldContinue: boolean;
    isComplete: boolean;
    summary?: string;
  };
}

export interface AIChatMessage {
  role: 'USER' | 'ASSISTANT';
  content: string;
}

export interface AIConversationContext {
  sessionId: string;
  userId: string;
  history: AIChatMessage[];
  userMessage: string;
  availableSpecialties: string[];
}

export interface CrisisResourceData {
  id?: string;
  countryCode: string;
  name: string;
  phone: string;
  url?: string | null;
  description?: string | null;
  type: string;
  isActive?: boolean;
}

export interface RecommendedSpecialty {
  id: string;
  name: string;
  reason: string;
}

export interface RecommendedPsychologist {
  id: string;
  userId: string;
  name: string;
  academicBackground: string | null;
  photoUrl: string | null;
  consultationPrice: number | null;
  score: number;
  matchReasons: string[];
  specialties: string[];
}

export interface OrientationRecommendationsResponse {
  sessionId: string;
  isComplete: boolean;
  riskLevel: AIRiskLevelType;
  summary: string | null;
  suggestedSpecialties: RecommendedSpecialty[];
  recommendedPsychologists: RecommendedPsychologist[];
}
