import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import {
  PROTOCOL_VERSION,
  ErrorCode,
  HEARTBEAT_TIMEOUT_MS,
  AUDIO_FRAME_MAX_BYTES,
  AUDIO_FRAME_WARN_BYTES,
  type BaseEvent,
  type ClientHello,
  type AuthAnonymous,
  type SessionStart,
  type SessionExtend,
} from '@coach/shared';
import { verifySupabaseToken } from '../auth/token.js';
import { ConnectionPhase, ConnectionState } from './connection-state.js';
import { validateClientMessage } from './validator.js';
import { sendEvent, sendError } from './helpers.js';
import { ensureUserProfile, createSession } from '../lib/repository.js';
import { SessionOrchestrator } from '../orchestrator/session.js';
import type { AdapterFactory } from '../adapters/factory.js';

interface HandlerDeps {
  jwtSecret: string;
  factory: AdapterFactory | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

// Active sessions keyed by connectionId
const sessionMap = new Map<
  string,
  { orchestrator: SessionOrchestrator; connState: ConnectionState }
>();

export async function registerWSHandler(app: FastifyInstance, deps: HandlerDeps) {
  app.get('/v1/ws', { websocket: true }, (socket: WebSocket, _req) => {
    const connectionId = uuid();
    const connState = new ConnectionState(connectionId);
    let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

    deps.logger.info({ connectionId }, 'WS connected');

    // Step 1: Send server.hello
    sendEvent(socket, {
      type: 'server.hello',
      session_id: '',
      payload: { protocol_version: PROTOCOL_VERSION, connection_id: connectionId },
    });

    const resetHeartbeat = () => {
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = setTimeout(() => {
        deps.logger.warn({ connectionId }, 'Heartbeat timeout, closing');
        socket.close(4008, 'Heartbeat timeout');
      }, HEARTBEAT_TIMEOUT_MS);
    };
    resetHeartbeat();

    socket.on('message', (data, isBinary) => {
      resetHeartbeat();

      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        handleBinaryFrame(socket, connState, buf, deps);
        return;
      }

      const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const result = validateClientMessage(raw);
      if (!result.valid) {
        sendError(socket, connState.sessionId ?? '', result.errorCode, result.message);
        return;
      }

      try {
        routeEvent(socket, connState, result.event, deps);
      } catch (err) {
        deps.logger.error({ connectionId, err }, 'Error routing event');
        sendError(
          socket,
          connState.sessionId ?? '',
          ErrorCode.ERR_SESSION_STATE,
          err instanceof Error ? err.message : 'Internal error',
        );
      }
    });

    socket.on('close', (code, reason) => {
      deps.logger.info({ connectionId, code, reason: reason?.toString() }, 'WS closed');
      cleanup(connectionId, heartbeatTimeout);
    });

    socket.on('error', (err) => {
      deps.logger.error({ connectionId, err }, 'WS error');
      cleanup(connectionId, heartbeatTimeout);
    });
  });
}

function routeEvent(
  socket: WebSocket,
  connState: ConnectionState,
  event: BaseEvent,
  deps: HandlerDeps,
): void {
  switch (event.type) {
    case 'client.hello':
      handleClientHello(socket, connState, event as unknown as ClientHello, deps);
      break;

    case 'auth.anonymous':
      handleAuth(socket, connState, event as unknown as AuthAnonymous, deps);
      break;

    case 'session.start':
      handleSessionStart(socket, connState, event as unknown as SessionStart, deps);
      break;

    case 'session.extend': {
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'session.extend');
      const session = sessionMap.get(connState.connectionId);
      if (!session) {
        sendError(socket, connState.sessionId ?? '', ErrorCode.ERR_SESSION_STATE, 'No active session');
        break;
      }
      const extend = event as unknown as SessionExtend;
      session.orchestrator.handleExtend(extend.payload.extra_ms);
      break;
    }

    case 'client.ping':
      break; // heartbeat already reset above

    case 'client.barge_in':
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'client.barge_in');
      sessionMap.get(connState.connectionId)?.orchestrator.handleBargeIn();
      break;

    case 'audio.start':
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'audio.start');
      connState.audioStarted = true;
      sessionMap.get(connState.connectionId)?.orchestrator.handleAudioStart();
      break;

    case 'audio.stop':
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'audio.stop');
      connState.audioStarted = false;
      sessionMap.get(connState.connectionId)?.orchestrator.handleAudioStop();
      break;

    default:
      sendError(
        socket,
        connState.sessionId ?? '',
        ErrorCode.ERR_BAD_EVENT_SCHEMA,
        `Unhandled event type: ${event.type}`,
      );
  }
}

function handleClientHello(
  socket: WebSocket,
  connState: ConnectionState,
  event: ClientHello,
  deps: HandlerDeps,
): void {
  connState.expectPhase(ConnectionPhase.CONNECTED, 'client.hello');

  const clientVersion = event.payload.protocol_version;
  if (clientVersion !== PROTOCOL_VERSION) {
    sendError(socket, '', ErrorCode.ERR_BAD_EVENT_SCHEMA, `Unsupported protocol version: ${clientVersion}`);
    socket.close(4001, 'Unsupported protocol version');
    return;
  }

  connState.phase = ConnectionPhase.HELLO_RECEIVED;
  deps.logger.info({ connectionId: connState.connectionId, clientVersion }, 'Hello received');
}

async function handleAuth(
  socket: WebSocket,
  connState: ConnectionState,
  event: AuthAnonymous,
  deps: HandlerDeps,
): Promise<void> {
  connState.expectPhase(ConnectionPhase.HELLO_RECEIVED, 'auth.anonymous');

  try {
    const claims = await verifySupabaseToken(event.payload.token, deps.jwtSecret);
    connState.userId = claims.sub;
    connState.phase = ConnectionPhase.AUTHENTICATED;

    sendEvent(socket, {
      type: 'auth.ok',
      session_id: '',
      payload: { user_id: claims.sub },
    });

    ensureUserProfile(claims.sub).catch(() => {});
    deps.logger.info({ connectionId: connState.connectionId, userId: claims.sub }, 'Authenticated');
  } catch (err) {
    sendEvent(socket, {
      type: 'auth.error',
      session_id: '',
      payload: { message: err instanceof Error ? err.message : 'Authentication failed' },
    });
    socket.close(4003, 'Authentication failed');
  }
}

function handleSessionStart(
  socket: WebSocket,
  connState: ConnectionState,
  event: SessionStart,
  deps: HandlerDeps,
): void {
  connState.expectPhase(ConnectionPhase.AUTHENTICATED, 'session.start');

  const sessionId = uuid();
  connState.sessionId = sessionId;
  connState.phase = ConnectionPhase.SESSION_ACTIVE;

  const durationMs = event.payload.requested_duration_ms;
  const startTs = Date.now();

  // Send ack immediately (before async init)
  sendEvent(socket, {
    type: 'session.start_ack',
    session_id: sessionId,
    payload: { session_id: sessionId, duration_ms: durationMs, start_ts: startTs },
  });

  // Persist session row to DB (fire-and-forget)
  if (connState.userId) {
    createSession({
      sessionId,
      userId: connState.userId,
      contentId: event.payload.content_id,
      requestedDurationMs: durationMs,
    }).catch(() => {});
  }

  // Build send/sendBinary callbacks bound to this socket
  const send = (ev: Omit<BaseEvent, 'event_id' | 'ts_ms'>) => sendEvent(socket, ev);
  const sendBinary = (buf: Buffer) => {
    if (socket.readyState === 1 /* OPEN */) socket.send(buf);
  };

  // Provide a logger shim compatible with OrchestratorLogger
  const logger = {
    info: (obj: Record<string, unknown>, msg: string) =>
      deps.logger.info({ ...obj }, msg),
    warn: (obj: Record<string, unknown>, msg: string) =>
      deps.logger.warn({ ...obj }, msg),
    error: (obj: Record<string, unknown>, msg: string) =>
      deps.logger.error({ ...obj }, msg),
  };

  // Use a stub factory in test / when factory is null
  const factory = deps.factory ?? createStubFactory();

  const orchestrator = new SessionOrchestrator({
    sessionId,
    userId: connState.userId ?? '',
    contentId: event.payload.content_id,
    durationMs,
    startTs,
    factory,
    send,
    sendBinary,
    logger,
  });

  sessionMap.set(connState.connectionId, { orchestrator, connState });
  orchestrator.start();

  deps.logger.info({ connectionId: connState.connectionId, sessionId, durationMs }, 'Session started');
}

function handleBinaryFrame(
  socket: WebSocket,
  connState: ConnectionState,
  data: Buffer,
  deps: HandlerDeps,
): void {
  if (!connState.audioStarted) {
    sendError(
      socket,
      connState.sessionId ?? '',
      ErrorCode.ERR_SESSION_STATE,
      'Binary frame received before audio.start',
    );
    socket.close(4002, 'Binary before audio.start');
    return;
  }

  if (data.length > AUDIO_FRAME_MAX_BYTES) {
    deps.logger.warn({ connectionId: connState.connectionId, size: data.length }, 'Audio frame too large, dropped');
    return;
  }

  if (data.length > AUDIO_FRAME_WARN_BYTES) {
    deps.logger.warn({ connectionId: connState.connectionId, size: data.length }, 'Audio frame larger than target 640 bytes');
  }

  sessionMap.get(connState.connectionId)?.orchestrator.handleAudioChunk(data);
}

function cleanup(connectionId: string, heartbeatTimeout: ReturnType<typeof setTimeout> | null): void {
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
  const session = sessionMap.get(connectionId);
  if (session) {
    session.orchestrator.destroy();
    sessionMap.delete(connectionId);
  }
}

// ── Stub factory for test/no-factory mode ─────────────────────────────────────

/**
 * Returns a factory that creates no-op adapters (used in tests and when
 * API keys are unavailable). The orchestrator's initialize() will exit early
 * because getContentPack() returns null in test mode.
 */
function createStubFactory(): import('../adapters/factory.js').AdapterFactory {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  function stubSTT() {
    const e = new EventEmitter();
    return Object.assign(e, {
      connect: async () => {},
      sendAudio: () => {},
      finalize: () => {},
      close: () => {},
    });
  }

  function stubTTS() {
    const e = new EventEmitter();
    return Object.assign(e, {
      connect: async () => {},
      speak: () => {},
      flush: () => {},
      clear: async () => {},
      close: () => {},
    });
  }

  const stubLLM = {
    generatePlan: async () => { throw new Error('stub'); },
    streamCoachTurn: async function* () { /* no tokens */ },
    decidePacing: async () => { throw new Error('stub'); },
    generateScorecard: async () => '',
  };

  return {
    createSTTAdapter: () => stubSTT() as unknown as import('../adapters/stt/types.js').STTAdapter,
    createTTSAdapter: () => stubTTS() as unknown as import('../adapters/tts/types.js').TTSAdapter,
    getLLMAdapter: () => stubLLM as unknown as import('../adapters/llm/openai.js').OpenAILLMAdapter,
  };
}
