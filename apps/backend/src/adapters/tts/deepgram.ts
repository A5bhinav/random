import WebSocket, { type RawData } from 'ws';
import { EventEmitter } from 'node:events';
import { DEEPGRAM_TTS_MODEL, DEEPGRAM_TTS_CLEAR_TIMEOUT_MS } from '@coach/shared';
import type { TTSAdapter } from './types.js';

/**
 * Deepgram streaming TTS adapter.
 *
 * Events emitted:
 *   audio    — raw PCM Buffer (linear16, 16kHz, mono) ready to forward to client
 *   flushed  — provider confirmed flush (all queued text is generating)
 *   cleared  — provider confirmed clear (barge-in complete, queue empty)
 *   error    — provider error
 *   close    — connection closed
 *
 * Barge-in protocol:
 *   1. Call clear() — sends Clear message, returns Promise
 *   2. Promise resolves when Deepgram sends UserActionResult { action: 'Clear' }
 *      or after DEEPGRAM_TTS_CLEAR_TIMEOUT_MS (2s) fallback
 *   3. Client must drop its jitter buffer immediately on receiving tts.cleared
 *
 * Prosody note: send full sentences via speak(), not token fragments.
 * Deepgram concatenates multiple speak() calls before flush() into one unit.
 */
export class DeepgramTTSAdapter extends EventEmitter implements TTSAdapter {
  private ws: WebSocket | null = null;
  private clearResolver: (() => void) | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = DEEPGRAM_TTS_MODEL) {
    super();
    this.apiKey = apiKey;
    this.model = model;
  }

  async connect(): Promise<void> {
    const params = new URLSearchParams({
      model: this.model,
      encoding: 'linear16',
      sample_rate: '16000',
      container: 'raw',
    });

    const url = `wss://api.deepgram.com/v1/speak?${params}`;

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    return new Promise((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', reject);
      this.ws!.on('message', (data: RawData, isBinary: boolean) =>
        this.handleMessage(data, isBinary),
      );
      this.ws!.on('close', () => this.emit('close'));
    });
  }

  speak(text: string): void {
    this.sendControl({ type: 'Speak', text });
  }

  flush(): void {
    this.sendControl({ type: 'Flush' });
  }

  clear(): Promise<void> {
    this.sendControl({ type: 'Clear' });
    return new Promise((resolve) => {
      this.clearResolver = resolve;
      this.clearTimer = setTimeout(() => {
        // Timeout fallback — resolve anyway so callers never hang
        this.clearResolver = null;
        this.clearTimer = null;
        resolve();
        this.emit('cleared');
      }, DEEPGRAM_TTS_CLEAR_TIMEOUT_MS);
    });
  }

  close(): void {
    this.sendControl({ type: 'Close' });
    this.ws?.close();
    this.ws = null;
  }

  private sendControl(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      // Raw PCM audio bytes — forward directly to client
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.emit('audio', buf);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === 'UserActionResult') {
      const action = msg.action as string;
      const result = msg.result as string;

      if (action === 'Flush' && result === 'submitted') {
        this.emit('flushed');
      } else if (action === 'Clear' && result === 'submitted') {
        if (this.clearTimer) {
          clearTimeout(this.clearTimer);
          this.clearTimer = null;
        }
        if (this.clearResolver) {
          this.clearResolver();
          this.clearResolver = null;
        }
        this.emit('cleared');
      }
    } else if (msg.type === 'Error') {
      this.emit('error', new Error(`Deepgram TTS error: ${JSON.stringify(msg)}`));
    }
  }
}
