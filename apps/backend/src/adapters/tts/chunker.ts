import { EventEmitter } from 'node:events';

/**
 * TextChunker buffers streaming LLM tokens and emits complete sentences.
 *
 * Why this matters:
 *   Deepgram TTS generates dramatically better prosody when given complete
 *   sentences vs. token-by-token fragments. This class absorbs the latency
 *   of accumulating a sentence (~100-300ms) for much better voice quality.
 *
 * Usage:
 *   chunker.on('sentence', (text) => ttsAdapter.speak(text))
 *   // For each LLM token:
 *   chunker.addToken(token)
 *   // When LLM stream ends:
 *   chunker.flush()   // emits any remaining text
 *   ttsAdapter.flush()
 *
 * Events:
 *   sentence — a complete sentence ready to send to TTS
 */
export class TextChunker extends EventEmitter {
  private buffer = '';

  /** Feed one LLM token; may emit zero or more 'sentence' events. */
  addToken(token: string): void {
    this.buffer += token;
    for (const sentence of this.extractSentences()) {
      this.emit('sentence', sentence);
    }
  }

  /** Emit whatever remains in the buffer (call when LLM stream ends). */
  flush(): void {
    const text = this.buffer.trim();
    if (text) {
      this.emit('sentence', text);
      this.buffer = '';
    }
  }

  /** Discard the buffer without emitting (call on barge-in). */
  reset(): void {
    this.buffer = '';
  }

  /**
   * Extract all complete sentences from the buffer.
   * Splits on whitespace that immediately follows a sentence-ending character (.!?).
   * The delimiter (whitespace) is consumed; the punctuation stays with the sentence.
   * Anything after the last sentence boundary remains in this.buffer.
   */
  private extractSentences(): string[] {
    // Lookbehind: split at whitespace that is preceded by ./?/!
    const parts = this.buffer.split(/(?<=[.!?])\s+/);
    if (parts.length <= 1) return []; // no complete sentence yet

    // All parts except the last are complete sentences
    const complete = parts.slice(0, -1);
    this.buffer = parts[parts.length - 1];

    return complete.map((s) => s.trim()).filter((s) => s.length > 0);
  }
}
