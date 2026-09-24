import { AIConversationContext, AIOrientationResult } from '../types/ai.types';

export interface IAIProvider {
  readonly providerName: string;

  generateOrientation(
    context: AIConversationContext
  ): Promise<AIOrientationResult>;
}
