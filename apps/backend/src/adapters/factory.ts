import { DeepgramSTTAdapter } from './stt/deepgram.js';
import { DeepgramTTSAdapter } from './tts/deepgram.js';
import { OpenAILLMAdapter } from './llm/openai.js';
import type { STTAdapter } from './stt/types.js';
import type { TTSAdapter } from './tts/types.js';

export interface AdapterFactory {
  /** Create a new STT adapter instance (one per session). */
  createSTTAdapter(): STTAdapter;
  /** Create a new TTS adapter instance (one per session). */
  createTTSAdapter(): TTSAdapter;
  /** Get the shared LLM adapter (one instance for the process). */
  getLLMAdapter(): OpenAILLMAdapter;
}

/**
 * Config-driven adapter factory.
 * The LLM adapter is shared (stateless); STT/TTS adapters are per-session.
 */
export function createAdapterFactory(config: {
  deepgramApiKey: string;
  openaiApiKey: string;
}): AdapterFactory {
  const llm = new OpenAILLMAdapter(config.openaiApiKey);

  return {
    createSTTAdapter: () => new DeepgramSTTAdapter(config.deepgramApiKey),
    createTTSAdapter: () => new DeepgramTTSAdapter(config.deepgramApiKey),
    getLLMAdapter: () => llm,
  };
}
