/**
 * Typed EventEmitter surface for the TTS adapter.
 * Concrete implementations extend EventEmitter and satisfy this shape.
 */
export type TTSAdapter = {
  on(event: 'audio', listener: (chunk: Buffer) => void): unknown;
  on(event: 'flushed', listener: () => void): unknown;
  on(event: 'cleared', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  /** Open the WebSocket connection to the TTS provider. */
  connect(): Promise<void>;
  /**
   * Queue text for synthesis. Multiple speak() calls before flush() are
   * concatenated by Deepgram into one coherent utterance (better prosody).
   * Always send complete sentences, not token-by-token fragments.
   */
  speak(text: string): void;
  /** Signal end of utterance — provider starts generating audio. */
  flush(): void;
  /**
   * Immediately stop synthesis and discard buffered audio.
   * Returns a Promise that resolves when the provider confirms the clear
   * (or after a 2-second timeout fallback).
   * Use for barge-in.
   */
  clear(): Promise<void>;
  /** Gracefully close the connection. */
  close(): void;
};
