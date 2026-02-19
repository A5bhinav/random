import { TextChunker } from '../adapters/tts/chunker.js';
import type { TTSAdapter } from '../adapters/tts/types.js';
import type { OpenAILLMAdapter, CoachTurnContext } from '../adapters/llm/openai.js';

/**
 * CoachPipeline coordinates one coach response turn:
 *   LLM stream → TextChunker → TTS speak() per sentence → TTS flush()
 *
 * Usage per turn:
 *   const text = await pipeline.run(ctx)   // streams LLM, feeds TTS
 *   // TTS audio flows asynchronously via tts 'audio' events
 *
 * Barge-in:
 *   pipeline.cancel()  // aborts the LLM stream; the TTS adapter's clear()
 *                      // must be called separately by the orchestrator
 */
export class CoachPipeline {
  private abortController: AbortController | null = null;
  private readonly chunker = new TextChunker();
  private accumulatedText = '';

  constructor(
    private readonly tts: TTSAdapter,
    private readonly llm: OpenAILLMAdapter,
  ) {
    this.chunker.on('sentence', (sentence: string) => {
      this.accumulatedText += (this.accumulatedText ? ' ' : '') + sentence;
      this.tts.speak(sentence);
    });
  }

  /** Stream one coach turn. Returns the full coach text on completion, '' on barge-in. */
  async run(ctx: CoachTurnContext): Promise<string> {
    // Reset state for this turn
    this.accumulatedText = '';
    this.chunker.reset();
    this.abortController = new AbortController();

    try {
      for await (const token of this.llm.streamCoachTurn(ctx, this.abortController.signal)) {
        this.chunker.addToken(token);
      }
      this.chunker.flush();
      this.tts.flush();
      return this.accumulatedText;
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') return ''; // normal barge-in path
      throw err;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Abort the current LLM stream (barge-in).
   * The caller must also call tts.clear() to stop audio playback.
   */
  cancel(): void {
    this.chunker.reset();
    this.abortController?.abort();
  }

  get isRunning(): boolean {
    return this.abortController !== null;
  }
}
