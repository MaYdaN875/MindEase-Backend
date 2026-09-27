import { z } from 'zod';

export const suggestedSpecialtySchema = z.object({
  name: z.string().min(1).max(100),
  reason: z.string().min(1).max(300),
});

export const preferencesSchema = z.object({
  modality: z.enum(['ONLINE', 'IN_PERSON', 'ANY']).nullable(),
  preferredTime: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'WEEKEND', 'ANY']).nullable(),
  maxBudget: z.number().finite().nonnegative().nullable(),
});

export const needsProfileSchema = z.object({
  primaryConcern: z.string().max(2000).nullable(),
  topics: z.array(z.string().max(100)).max(20),
  suggestedSpecialties: z.array(suggestedSpecialtySchema).max(10),
  preferences: preferencesSchema.default({
    modality: null,
    preferredTime: null,
    maxBudget: null,
  }),
});

export const aiSafetyEvaluationSchema = z.object({
  riskLevel: z.enum(['LOW', 'MODERATE', 'HIGH', 'EMERGENCY']),
  requiresImmediateHelp: z.boolean(),
  flags: z.array(z.string().max(100)).max(20),
  emergencyMessage: z.string().max(2000).optional(),
});

export const aiOrientationResultSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(4000),
  needsProfile: needsProfileSchema,
  safety: aiSafetyEvaluationSchema,
  conversation: z.object({
    shouldContinue: z.boolean(),
    isComplete: z.boolean(),
    summary: z.string().max(2000).optional(),
  }),
});

export type AIOrientationResultValidated = z.infer<typeof aiOrientationResultSchema>;
