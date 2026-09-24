import { z } from 'zod';

export const suggestedSpecialtySchema = z.object({
  name: z.string().min(1).max(100),
  reason: z.string().min(1).max(300),
});

export const preferencesSchema = z.object({
  modality: z.enum(['ONLINE', 'IN_PERSON', 'ANY']).nullable().catch(null),
  preferredTime: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'WEEKEND', 'ANY']).nullable().catch(null),
  maxBudget: z.number().nonnegative().nullable().catch(null),
});

export const needsProfileSchema = z.object({
  primaryConcern: z.string().nullable().catch(null),
  topics: z.array(z.string()).default([]),
  suggestedSpecialties: z.array(suggestedSpecialtySchema).default([]),
  preferences: preferencesSchema.default({
    modality: null,
    preferredTime: null,
    maxBudget: null,
  }),
});

export const aiSafetyEvaluationSchema = z.object({
  riskLevel: z.enum(['LOW', 'MODERATE', 'HIGH', 'EMERGENCY']).default('LOW'),
  requiresImmediateHelp: z.boolean().default(false),
  flags: z.array(z.string()).default([]),
  emergencyMessage: z.string().optional(),
});

export const aiOrientationResultSchema = z.object({
  assistantMessage: z.string().min(1),
  needsProfile: needsProfileSchema,
  safety: aiSafetyEvaluationSchema,
  conversation: z.object({
    shouldContinue: z.boolean().default(true),
    isComplete: z.boolean().default(false),
    summary: z.string().optional(),
  }),
});

export type AIOrientationResultValidated = z.infer<typeof aiOrientationResultSchema>;
