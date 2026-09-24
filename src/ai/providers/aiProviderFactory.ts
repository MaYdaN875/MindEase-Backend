import { IAIProvider } from './aiProvider.interface';
import { MockAIProvider } from './mockAIProvider';
import { GeminiAIProvider } from './geminiAIProvider';

export class AIProviderFactory {
  private static instance: IAIProvider | null = null;

  static getProvider(): IAIProvider {
    if (this.instance) {
      return this.instance;
    }

    const providerType = (process.env.AI_PROVIDER || 'mock').toLowerCase().trim();

    switch (providerType) {
      case 'gemini':
        this.instance = new GeminiAIProvider();
        break;
      case 'mock':
      default:
        this.instance = new MockAIProvider();
        break;
    }

    return this.instance;
  }

  // Permite inyectar un mock para tests unitarios
  static setProvider(provider: IAIProvider | null): void {
    this.instance = provider;
  }
}
