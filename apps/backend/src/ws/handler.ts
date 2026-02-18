import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import {
  PROTOCOL_VERSION,
  TIMER_TOTAL_MS,
  ErrorCode,
  HEARTBEAT_TIMEOUT_MS,
  AUDIO_FRAME_MAX_BYTES,
  AUDIO_FRAME_WARN_BYTES,
  type BaseEvent,
  type ClientHello,
  type AuthAnonymous,
  type SessionStart,
} from '@coach/shared';
import { verifySupabaseToken } from '../auth/token.js';
import { ConnectionPhase, ConnectionState } from './connection-state.js';
import { validateClientMessage } from './validator.js';
import { sendEvent, sendError } from './helpers.js';
import { SessionTimer } from '../orchestrator/timer.js';
import { PITCH_3MIN_DEFAULT_PLAN } from '@coach/shared';
import { ensureUserProfile, createSession, endSession } from '../lib/repository.js';

interface HandlerDeps {
  jwtSecret: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

// Active sessions keyed by connectionId
const sessionMap = new Map<string, { timer: SessionTimer; connState: ConnectionState; startTs: number }>();

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

    // Start heartbeat timeout
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

      // Binary frame handling
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        handleBinaryFrame(socket, connState, buf, deps);
        return;
      }

      // JSON message
      const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const result = validateClientMessage(raw);
      if (!result.valid) {
        sendError(socket, connState.sessionId ?? '', result.errorCode, result.message);
        return;
      }

      const event = result.event;

      try {
        routeEvent(socket, connState, event, deps);
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

    case 'client.ping':
      // Heartbeat already reset above, no-op
      break;

    case 'client.barge_in':
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'client.barge_in');
      // Barge-in logic will be wired in Milestone 5
      deps.logger.info({ connectionId: connState.connectionId }, 'Barge-in received (not yet wired)');
      break;

    case 'audio.start':
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'audio.start');
      connState.audioStarted = true;
      deps.logger.info({ connectionId: connState.connectionId }, 'Audio started');
      break;

    case 'audio.stop':
      connState.expectMinPhase(ConnectionPhase.SESSION_ACTIVE, 'audio.stop');
      connState.audioStarted = false;
      deps.logger.info({ connectionId: connState.connectionId }, 'Audio stopped');
      break;

    default:
      sendError(socket, connState.sessionId ?? '', ErrorCode.ERR_BAD_EVENT_SCHEMA, `Unhandled event type: ${event.type}`);
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

    // Ensure user profile exists in DB (fire-and-forget)
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

  const durationMs = event.payload.requested_duration_ms || TIMER_TOTAL_MS;
  const startTs = Date.now();

  // Send session.start_ack
  sendEvent(socket, {
    type: 'session.start_ack',
    session_id: sessionId,
    payload: { session_id: sessionId, duration_ms: durationMs, start_ts: startTs },
  });

  // Persist session to DB (fire-and-forget)
  if (connState.userId) {
    createSession({
      sessionId,
      userId: connState.userId,
      drillId: event.payload.drill_id,
      requestedDurationMs: durationMs,
    }).catch(() => {});
  }

  // Send session.plan (static fallback for now, LLM generation in Milestone 4)
  sendEvent(socket, {
    type: 'session.plan',
    session_id: sessionId,
    payload: { plan: PITCH_3MIN_DEFAULT_PLAN },
  });

  // Start timer
  const timer = new SessionTimer(durationMs, {
    onTick: (remainingMs) => {
      sendEvent(socket, {
        type: 'timer.tick',
        session_id: sessionId,
        payload: { remaining_ms: remainingMs, segment_name: 'pitch' },
      });
    },
    onWarning: (remainingMs) => {
      const seconds = Math.round(remainingMs / 1000);
      sendEvent(socket, {
        type: 'timer.warning',
        session_id: sessionId,
        payload: { remaining_ms: remainingMs, message: `${seconds} seconds remaining` },
      });
    },
    onExpired: () => {
      const actualMs = Date.now() - startTs;
      endSession(sessionId, 'ended', actualMs).catch(() => {});

      sendEvent(socket, {
        type: 'timer.expired',
        session_id: sessionId,
        payload: {},
      });
      sendEvent(socket, {
        type: 'server.goodbye',
        session_id: sessionId,
        payload: { reason: 'Timer expired' },
      });
      socket.close(1000, 'Session ended');
    },
  });

  timer.start();
  sessionMap.set(connState.connectionId, { timer, connState, startTs });

  deps.logger.info({ connectionId: connState.connectionId, sessionId, durationMs }, 'Session started');
}

function handleBinaryFrame(
  socket: WebSocket,
  connState: ConnectionState,
  data: Buffer,
  deps: HandlerDeps,
): void {
  // Binary before audio.start is a protocol violation
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

  // Frame size validation
  if (data.length > AUDIO_FRAME_MAX_BYTES) {
    deps.logger.warn(
      { connectionId: connState.connectionId, size: data.length },
      'Audio frame too large, dropped',
    );
    return;
  }

  if (data.length > AUDIO_FRAME_WARN_BYTES) {
    deps.logger.warn(
      { connectionId: connState.connectionId, size: data.length },
      'Audio frame larger than target 640 bytes',
    );
  }

  // Audio routing will be wired in Milestone 3
  deps.logger.info(
    { connectionId: connState.connectionId, size: data.length },
    'Audio frame received',
  );
}

function cleanup(connectionId: string, heartbeatTimeout: ReturnType<typeof setTimeout> | null): void {
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
  const session = sessionMap.get(connectionId);
  if (session) {
    // Persist abnormal disconnect if session was still running
    if (session.connState.sessionId && session.connState.phase === ConnectionPhase.SESSION_ACTIVE) {
      const actualMs = Date.now() - session.startTs;
      endSession(session.connState.sessionId, 'error', actualMs, 'disconnect').catch(() => {});
    }
    session.timer.destroy();
    sessionMap.delete(connectionId);
  }
}
