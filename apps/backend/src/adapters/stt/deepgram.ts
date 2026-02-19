import WebSocket, { type RawData } from 'ws';
import { EventEmitter } from 'node:events';
import {
  DEEPGRAM_STT_MODEL,
  DEEPGRAM_STT_ENDPOINTING_MS,
  DEEPGRAM_STT_UTTERANCE_END_MS,
  DEEPGRAM_STT_KEEPALIVE_INTERVAL_MS,
} from '@coach/shared';
import type { STTAdapter, STTConfig, STTPartialEvent, STTFinalEvent } from './types.js';

/**
 * Deepgram real-time STT adapter.
 *
 * Events emitted:
 *   partial  — interim or intermediate-stable transcript (for live display)
 *   final    — turn-boundary transcript (triggers coach response generation)
 *   utterance_end — backup turn boundary when speech_final never fires
 *   error    — provider error
 *   close    — connection closed
 *
 * Turn-taking logic (from Deepgram docs):
 *   speech_final: true  → endpointing triggered; emit final
 *   is_final: true, speech_final: false → stable partial; emit partial
 *   is_final: false  → interim; emit partial
 *   type: UtteranceEnd → backup boundary; emit utterance_end
 */
export class DeepgramSTTAdapter extends EventEmitter implements STTAdapter {
  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async connect(config: STTConfig): Promise<void> {
    const params = new URLSearchParams({
      model: DEEPGRAM_STT_MODEL,
      interim_results: 'true',
      endpointing: String(DEEPGRAM_STT_ENDPOINTING_MS),
      utterance_end_ms: String(DEEPGRAM_STT_UTTERANCE_END_MS),
      encoding: 'linear16',
      sample_rate: String(config.sampleRateHz),
      channels: String(config.channels),
      punctuate: 'true',
      smart_format: 'true',
    });

    const url = `wss://api.deepgram.com/v1/listen?${params}`;

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    return new Promise((resolve, reject) => {
      this.ws!.once('open', () => {
        this.startKeepAlive();
        resolve();
      });
      this.ws!.once('error', reject);
      this.ws!.on('message', (data: RawData) => this.handleMessage(data));
      this.ws!.on('close', () => {
        this.stopKeepAlive();
        this.emit('close');
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  finalize(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'Finalize' }));
    }
  }

  close(): void {
    this.stopKeepAlive();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(data: RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === 'Results') {
      const channel = msg.channel as { alternatives?: Array<{ transcript?: string; confidence?: number; words?: unknown[] }> };
      const alt = channel?.alternatives?.[0];
      if (!alt || typeof alt.transcript !== 'string' || !alt.transcript) return;

      const text = alt.transcript;
      const confidence = alt.confidence ?? 0;
      const words = alt.words;
      const speechFinal = msg.speech_final as boolean;

      if (speechFinal) {
        const event: STTFinalEvent = { text, confidence, words: words as STTFinalEvent['words'] };
        this.emit('final', event);
      } else {
        const event: STTPartialEvent = { text, confidence };
        this.emit('partial', event);
      }
    } else if (msg.type === 'UtteranceEnd') {
      this.emit('utterance_end');
    } else if (msg.type === 'Error') {
      this.emit('error', new Error(`Deepgram STT error: ${JSON.stringify(msg)}`));
    }
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, DEEPGRAM_STT_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
