import type { ErrorCode } from './errors.js';
import type { SessionPlan, WordTimestamp } from './session.js';

// ── Base envelope ──────────────────────────────────────────────────────

export interface BaseEvent {
  type: string;
  event_id: string;
  session_id: string;
  ts_ms: number;
  payload: Record<string, unknown>;
}

// ── Client events ──────────────────────────────────────────────────────

export interface ClientHello extends BaseEvent {
  type: 'client.hello';
  payload: {
    protocol_version: string;
    app_version: string;
    device_info: {
      platform: 'ios' | 'android';
      os_version: string;
    };
  };
}

export interface AuthAnonymous extends BaseEvent {
  type: 'auth.anonymous';
  payload: {
    token: string;
  };
}

export interface SessionStart extends BaseEvent {
  type: 'session.start';
  payload: {
    requested_duration_ms: number;
    content_id: string;
    user_goal?: string;
  };
}

export interface SessionExtend extends BaseEvent {
  type: 'session.extend';
  payload: {
    extra_ms: number;
  };
}

export interface AudioStart extends BaseEvent {
  type: 'audio.start';
  payload: {
    codec: 'pcm_s16le';
    sample_rate_hz: 16000;
    channels: 1;
    chunk_ms: 20;
  };
}

export interface AudioStop extends BaseEvent {
  type: 'audio.stop';
  payload: Record<string, never>;
}

export interface ClientBargeIn extends BaseEvent {
  type: 'client.barge_in';
  payload: Record<string, never>;
}

export interface ClientPing extends BaseEvent {
  type: 'client.ping';
  payload: Record<string, never>;
}

export interface ClientResume extends BaseEvent {
  type: 'client.resume';
  payload: {
    resume_token: string;
    last_server_event_id: string;
  };
}

export type ClientEvent =
  | ClientHello
  | AuthAnonymous
  | SessionStart
  | SessionExtend
  | AudioStart
  | AudioStop
  | ClientBargeIn
  | ClientPing
  | ClientResume;

// ── Server events ──────────────────────────────────────────────────────

export interface ServerHello extends BaseEvent {
  type: 'server.hello';
  payload: {
    protocol_version: string;
    connection_id: string;
  };
}

export interface AuthOk extends BaseEvent {
  type: 'auth.ok';
  payload: {
    user_id: string;
  };
}

export interface AuthError extends BaseEvent {
  type: 'auth.error';
  payload: {
    message: string;
  };
}

export interface SessionStartAck extends BaseEvent {
  type: 'session.start_ack';
  payload: {
    session_id: string;
    duration_ms: number;
    start_ts: number;
  };
}

export interface SessionPlanEvent extends BaseEvent {
  type: 'session.plan';
  payload: {
    plan: SessionPlan;
  };
}

export interface TimerTick extends BaseEvent {
  type: 'timer.tick';
  payload: {
    remaining_ms: number;
    segment_name: string;
  };
}

export interface TimerWarning extends BaseEvent {
  type: 'timer.warning';
  payload: {
    remaining_ms: number;
    message: string;
  };
}

export interface TimerExpired extends BaseEvent {
  type: 'timer.expired';
  payload: Record<string, never>;
}

export interface SttPartial extends BaseEvent {
  type: 'stt.partial';
  payload: {
    text: string;
    confidence: number;
  };
}

export interface SttFinal extends BaseEvent {
  type: 'stt.final';
  payload: {
    text: string;
    confidence: number;
    words?: WordTimestamp[];
  };
}

export interface CoachText extends BaseEvent {
  type: 'coach.text';
  payload: {
    text: string;
    turn_type: string;
  };
}

export interface TtsStart extends BaseEvent {
  type: 'tts.start';
  payload: {
    tts_seq: number;
  };
}

export interface TtsEnd extends BaseEvent {
  type: 'tts.end';
  payload: {
    tts_seq: number;
  };
}

export interface TtsCleared extends BaseEvent {
  type: 'tts.cleared';
  payload: Record<string, never>;
}

export interface ServerError extends BaseEvent {
  type: 'server.error';
  payload: {
    code: ErrorCode;
    message: string;
  };
}

export interface ServerInterrupt extends BaseEvent {
  type: 'server.interrupt';
  payload: {
    reason: 'off_topic' | 'time_pressure' | 'move_on';
    message: string;
  };
}

export interface ServerGoodbye extends BaseEvent {
  type: 'server.goodbye';
  payload: {
    reason: string;
  };
}

export type ServerEvent =
  | ServerHello
  | AuthOk
  | AuthError
  | SessionStartAck
  | SessionPlanEvent
  | TimerTick
  | TimerWarning
  | TimerExpired
  | SttPartial
  | SttFinal
  | CoachText
  | TtsStart
  | TtsEnd
  | TtsCleared
  | ServerInterrupt
  | ServerError
  | ServerGoodbye;

// ── Type guards ────────────────────────────────────────────────────────

const CLIENT_EVENT_TYPES = new Set<string>([
  'client.hello',
  'auth.anonymous',
  'session.start',
  'session.extend',
  'audio.start',
  'audio.stop',
  'client.barge_in',
  'client.ping',
  'client.resume',
]);

const SERVER_EVENT_TYPES = new Set<string>([
  'server.hello',
  'auth.ok',
  'auth.error',
  'session.start_ack',
  'session.plan',
  'timer.tick',
  'timer.warning',
  'timer.expired',
  'stt.partial',
  'stt.final',
  'coach.text',
  'tts.start',
  'tts.end',
  'tts.cleared',
  'server.interrupt',
  'server.error',
  'server.goodbye',
]);

export function isClientEvent(e: BaseEvent): e is ClientEvent {
  return CLIENT_EVENT_TYPES.has(e.type);
}

export function isServerEvent(e: BaseEvent): e is ServerEvent {
  return SERVER_EVENT_TYPES.has(e.type);
}

export function isBinaryFrame(msg: unknown): msg is ArrayBuffer | Buffer {
  return msg instanceof ArrayBuffer || Buffer.isBuffer(msg);
}
