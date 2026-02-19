import type { WordTimestamp } from '@coach/shared';

export interface STTConfig {
  sampleRateHz: number;
  channels: number;
}

export interface STTPartialEvent {
  text: string;
  confidence: number;
}

export interface STTFinalEvent {
  text: string;
  confidence: number;
  words?: WordTimestamp[];
}

/**
 * Typed EventEmitter surface for the STT adapter.
 * Concrete implementations extend EventEmitter and satisfy this shape.
 */
export type STTAdapter = {
  on(event: 'partial', listener: (e: STTPartialEvent) => void): unknown;
  on(event: 'final', listener: (e: STTFinalEvent) => void): unknown;
  on(event: 'utterance_end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  /** Open the WebSocket connection to the STT provider. */
  connect(config: STTConfig): Promise<void>;
  /** Forward a raw PCM audio buffer to the provider. */
  sendAudio(chunk: Buffer): void;
  /** Request the provider to flush and finalize the current transcript. */
  finalize(): void;
  /** Gracefully close the connection. */
  close(): void;
};
