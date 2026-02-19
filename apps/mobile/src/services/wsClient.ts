import { Platform } from 'react-native';
import Constants from 'expo-constants';
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BACKOFF_MS,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_CHUNK_MS,
} from '@coach/shared';
import type { ServerEvent } from '@coach/shared';
import { getToken } from './auth';
import { Config } from '../config';

// ── Helpers ───────────────────────────────────────────────────────────────────

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type Handler<T = unknown> = (payload: T) => void;

// ── WSClient ──────────────────────────────────────────────────────────────────

/**
 * Manages the WebSocket connection to the backend.
 *
 * Connection handshake (auto, on connect):
 *   server.hello → client.hello → auth.anonymous → auth.ok → ready
 *
 * After auth.ok the caller should invoke startSession().
 * Binary frames received from the server are emitted as 'binary' events
 * with an ArrayBuffer payload.
 */
export class WSClient {
  private ws: WebSocket | null = null;
  private sessionId = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  private readonly handlers = new Map<string, Set<Handler>>();

  // ── Public API ─────────────────────────────────────────────────────────────

  connect(): void {
    void this._connect();
  }

  startSession(contentId: string, durationMs: number, userGoal?: string): void {
    this._send('session.start', {
      content_id: contentId,
      requested_duration_ms: durationMs,
      ...(userGoal ? { user_goal: userGoal } : {}),
    });
  }

  audioStart(): void {
    this._send('audio.start', {
      codec: AUDIO_CODEC,
      sample_rate_hz: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      chunk_ms: AUDIO_CHUNK_MS,
    });
  }

  audioStop(): void {
    this._send('audio.stop', {});
  }

  bargeIn(): void {
    this._send('client.barge_in', {});
  }

  extend(extraMs: number): void {
    this._send('session.extend', { extra_ms: extraMs });
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Subscribe to a named event.
   * Returns an unsubscribe function.
   */
  on<T = unknown>(event: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as Handler);
    return () => this.handlers.get(event)?.delete(handler as Handler);
  }

  destroy(): void {
    this.destroyed = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'Client destroyed');
    this.handlers.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    if (this.destroyed) return;
    try {
      const token = await getToken();
      const url = Config.BACKEND_URL.replace(/^http/, 'ws') + '/v1/ws';
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        // server.hello handler will fire once the server sends its greeting
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this._emit('binary', event.data);
          return;
        }
        try {
          const msg = JSON.parse(event.data as string) as ServerEvent;
          this._handleServerEvent(msg, token);
        } catch {
          // malformed JSON — ignore
        }
      };

      ws.onclose = () => {
        this._stopHeartbeat();
        this._emit('disconnected', null);
        if (!this.destroyed) this._scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire right after onerror — handled there
      };
    } catch {
      if (!this.destroyed) this._scheduleReconnect();
    }
  }

  private _handleServerEvent(msg: ServerEvent, pendingToken: string): void {
    switch (msg.type) {
      case 'server.hello':
        // Complete the handshake
        this._sendRaw('client.hello', {
          protocol_version: PROTOCOL_VERSION,
          app_version: Config.APP_VERSION,
          device_info: {
            platform: Platform.OS as 'ios' | 'android',
            os_version: String(Platform.Version),
          },
        });
        this._sendRaw('auth.anonymous', { token: pendingToken });
        break;

      case 'auth.ok':
        this.reconnectAttempt = 0;
        this._startHeartbeat();
        this._emit('auth.ok', msg.payload);
        break;

      case 'session.start_ack':
        this.sessionId = msg.payload.session_id;
        this._emit('session.start_ack', msg.payload);
        break;

      default:
        this._emit(msg.type, msg.payload);
    }
  }

  private _send(type: string, payload: Record<string, unknown>): void {
    this._sendRaw(type, payload);
  }

  private _sendRaw(type: string, payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const envelope = {
      type,
      event_id: genId(),
      session_id: this.sessionId,
      ts_ms: Date.now(),
      payload,
    };
    this.ws.send(JSON.stringify(envelope));
  }

  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this._sendRaw('client.ping', {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => void this._connect(), delay);
  }

  private _emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }
}
