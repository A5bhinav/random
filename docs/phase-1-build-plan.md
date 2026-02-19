# Phase 1 Build Plan: Voice-First Time-Boxed AI Learning App

## Context

You're building a B2C voice-first learning app where users upload their own material (PDF, slides) and have a time-boxed Socratic conversation with an AI that grills them on it. The core loop: "I have 10 minutes — quiz me on this chapter." The AI owns the agenda, tracks which topics have been covered, and actively redirects the user to stay on pace. Phase 1 proves the real-time audio pipeline, file ingestion, AI-driven pacing, and server-authoritative timer all work end-to-end. Enterprise features (company-owned content, team analytics) come later.

**Confirmed decisions:** React Native, Deepgram STT+TTS, OpenAI (Structured Outputs), user-uploaded PDF/PPTX content, server-authoritative timer, user-specified session duration.

---

## Group 1: Repository Scaffolding & Infrastructure

1. **Initialize monorepo** -- root `package.json` with workspaces (`apps/*`, `packages/*`), `tsconfig.base.json`, `.env.example`, `.gitignore`, `.nvmrc` (Node 20)
2. **Shared package scaffold** -- `/packages/shared/` with TypeScript build, barrel exports
3. **Backend scaffold** -- `/apps/backend/` with Fastify, `@fastify/multipart`, `ws`, `ioredis`, `pg`, `ajv`, `jose`, `pino`, `pdf-parse`, `officeparser`; config loader with env validation
4. **Mobile scaffold** -- `/apps/mobile/` React Native bare workflow (iOS + Android targets), audio capture/playback native module deps, document picker dep (`react-native-document-picker`)
5. **Docker Compose** -- `/infra/docker-compose.yml` with Postgres 16, Redis 7, backend service; `/infra/postgres/init.sql` with Phase 1 schema (users, content_packs, sessions, session_events, transcripts tables + indexes)
6. **Doc stubs** -- `/docs/PROTOCOL.md`, `ARCHITECTURE.md`, `RUNBOOK.md`

## Group 2: Shared Types, Schemas, Validation

7. **WebSocket event types** -- `/packages/shared/src/types/events.ts`: update `session.start` payload (`content_id` replaces `drill_id`); add `session.extend` client event (`extra_ms`); add `server.interrupt` server event (`reason: 'off_topic' | 'time_pressure' | 'move_on'`, `message`); all other events unchanged
8. **Domain types** -- `session.ts`: keep `SessionPlan`, `SessionState`, `PacingDecision` (already has `off_topic`/`too_slow` reasons); add `ContentPack` type (content_id, filename, chunks); add `TopicCoverage` type (topic index, status: `pending | active | done | skipped`); extend `LiveSessionState` with `topics_coverage: TopicCoverage[]` and `current_topic_index`
9. **JSON Schemas + Ajv validators** -- `/packages/shared/src/schemas/`: update session-start (content_id, no drill_id); add session-extend schema; keep audio-start, event-envelope, pacing-decision schemas unchanged
10. **Constants** -- remove `TIMER_TOTAL_MS` hardcoded constant (duration is always user-specified); remove `PITCH_3MIN_DRILL` and `PITCH_3MIN_DEFAULT_PLAN`; add `PACING_CHECK_INTERVAL_MS = 5000`, `PACING_DEBOUNCE_MS = 15000`, `MAX_CONTENT_FILE_MB = 20`, `CONTENT_CHUNK_CHARS = 1500`; keep all audio/heartbeat/Deepgram/Redis constants
11. **Shared package tests** -- update schema tests: session-start with content_id, session-extend, server.interrupt; remove pitch drill schema tests

## Group 3: Backend Core -- HTTP, Auth, Database

12. **Fastify server** -- `/apps/backend/src/server.ts`: register `@fastify/multipart` for file upload; rest unchanged (plugins, graceful shutdown, structured error handling)
13. **Database layer** -- add `content_packs` table (content_id UUID, user_id, filename, mime_type, chunks JSONB array, created_at); update sessions table (`content_id` replaces `drill_id`); add content queries: `insertContentPack`, `getContentPack`; keep all existing session/event/transcript queries
14. **Redis layer** -- unchanged; `LiveSessionState` gains `topics_coverage` and `current_topic_index` fields
15. **Auth** -- unchanged; `POST /v1/auth/anonymous` endpoint (device_id -> token)
16. **HTTP endpoints** -- remove `GET /v1/drills`; add `POST /v1/content` (multipart file upload: parse PDF/PPTX, chunk text, store in DB, return `content_id`); keep `/healthz`, `/readyz`, `GET /v1/sessions/:id`
17. **Route registration** -- auth middleware for protected routes; `POST /v1/content` requires auth

## Group 4: Provider Adapters

18. **STT adapter (Deepgram)** -- unchanged: WebSocket to `wss://api.deepgram.com/v1/listen` with `interim_results=true`, `endpointing=500`, `utterance_end_ms=1000`; emits partial/final/utterance_end events; latency timestamps
19. **TTS adapter (Deepgram)** -- unchanged: WebSocket to `wss://api.deepgram.com/v1/speak` with Speak/Flush/Clear messages; `clear()` returns Promise resolving on Cleared confirmation; audio chunks emitted as events
20. **TTS text chunker** -- unchanged: buffers LLM tokens, emits complete sentences (split on `.!?` + space)
21. **LLM adapter (OpenAI)** -- unchanged pipeline: Structured Outputs for plan/pacing, streaming for coach turns; retry (2x) + fallback; now passes content chunks as context in all calls
22. **LLM prompts** -- rewrite all prompts for content-based sessions: (a) **plan prompt**: given content chunks + duration, generate topic-by-topic agenda with time budgets; (b) **coach turn prompt**: Socratic mode -- ask a question, probe the user's answer, max 2 sentences; (c) **pacing prompt**: given topics done/remaining + time left, decide whether to redirect, move on, or compress; (d) **scorecard prompt**: topic-by-topic coverage summary, weak spots, recommended next session; fallback plan = cover all topics evenly
23. **Adapter factory** -- unchanged: config-driven factory, reads provider names from env

## Group 5: Session Orchestrator & WebSocket Server

24. **State machine** -- add `content_loaded` event (CONFIGURING → PLANNING, triggered after content chunks are fetched from DB); add `session_extend` event (RUNNING_REP → RUNNING_REP, side effect: `extend_timer` + `replan_remaining`); keep all existing transitions; add `extend_timer` and `replan_remaining` to `SideEffect` type
25. **Timer engine** -- add `extend(extra_ms: number)` method that increases the deadline and emits updated tick; rest unchanged (wall-clock delta, 100ms tick, 1Hz client tick, warning callbacks, force close on expiry)
26. **Session orchestrator** -- on `session.start`: fetch content chunks from DB using `content_id`, pass to plan generation; add handler for `session.extend`: call `timer.extend()` then ask LLM to replan remaining topics; add handler for `server.interrupt` dispatch (called by pacing loop)
27. **Coach response pipeline** -- unchanged pipeline (LLM streaming -> chunker -> TTS -> client binary frames); all calls now include content chunks in LLM context window
28. **Latency instrumentation** -- unchanged: per-turn timestamps, p50/p95, `GET /v1/metrics`, logs every 60s
29. **WebSocket handler** -- add routing for `session.extend` event; add dispatch path for `server.interrupt` server event; rest unchanged (hello -> auth -> session.start -> route to orchestrator, heartbeat, clean close)
30. **Event validation** -- add Ajv validators for `session.extend` and `server.interrupt`; rest unchanged
31. **Pacing loop** -- rewrite: every 5s during RUNNING_REP, evaluate (a) topics covered vs. remaining, (b) time-per-remaining-topic budget, (c) semantic relevance of last user transcript to current topic; if off-topic or behind schedule: trigger `server.interrupt` (clear TTS, send redirect message via TTS, dispatch `server.interrupt` event to client); debounce max once per 15s

## Group 6: Mobile Client

32. **Navigation** -- Upload screen + Session screen, React Navigation stack (Home screen becomes Upload screen)
33. **WebSocket client** -- add `sendExtend(extra_ms)` method; add handler for `server.interrupt` event (stop mic immediately, switch to playback mode); rest unchanged (connect/auth/startSession/sendAudio/sendBargeIn/resume, exponential backoff)
34. **Auth service** -- unchanged: device ID from AsyncStorage, JWT management
35. **Audio capture** -- unchanged: PCM s16le 16kHz mono 20ms chunks, iOS/Android native modules
36. **Audio playback** -- unchanged: 200-400ms jitter buffer, `stopPlayback()` <150ms for barge-in
37. **Session screen UI** -- timer countdown with extend button (+5 min tap); push-to-talk (press-and-hold); topic progress bar (X of N topics covered); transcript area; status indicator that shows "AI redirecting..." on `server.interrupt`; warning banner at time thresholds; earcon sounds
38. **useSession hook** -- add: handle `server.interrupt` (stop capture, start playback); handle `session.extend` dispatch; expose topic coverage state for progress bar; handle scorecard payload in WRAPPING; cleanup on unmount
39. **Upload screen** -- file picker (PDF/PPTX via `react-native-document-picker`); upload to `POST /v1/content` with progress indicator; duration picker (5/10/15/20 min or custom); "Start Session" button once content_id is returned; mic permission request

## Group 7: Testing & Documentation

40. **Backend unit tests** -- keep: state machine transitions, timer accuracy/warnings/expiry, text chunker, WS validator; add: `timer.extend()` correctness, `session_extend` state machine transition, `server.interrupt` dispatch, topic coverage tracker logic, content chunking output
41. **Backend integration tests** -- keep: full WS lifecycle handshake, barge-in TTS clear, timer expiry DB persist; add: file upload → parse → chunk → session start flow; server-initiated interrupt mid-user-speech; time extension re-plans remaining topics; scorecard generated on WRAPPING
42. **Schema tests** -- update: session-start with content_id, session-extend, server.interrupt; remove pitch drill schema tests; keep all audio/envelope/pacing schemas
43. **Finalize docs** -- PROTOCOL.md: add `session.extend`, `server.interrupt` to event catalog; update state machine diagram; ARCHITECTURE.md: add content ingestion pipeline; RUNBOOK.md: update local setup (file upload flow, manual QA checklist)

---

## Key Files

| File | Role |
|------|------|
| `/packages/shared/src/types/events.ts` | Canonical client-server contract |
| `/packages/shared/src/types/session.ts` | `TopicCoverage`, `ContentPack`, `LiveSessionState` |
| `/apps/backend/src/orchestrator/session.ts` | Central coordinator: state machine + timer + adapters + content |
| `/apps/backend/src/orchestrator/pacing.ts` | Topic-aware pacing loop + server-initiated interrupt |
| `/apps/backend/src/ws/handler.ts` | WebSocket connection lifecycle |
| `/apps/backend/src/adapters/tts/deepgram.ts` | Most latency-sensitive adapter (streaming + barge-in) |
| `/apps/backend/src/orchestrator/coach-pipeline.ts` | LLM -> chunker -> TTS -> client audio pipeline |
| `/apps/backend/src/lib/repository.ts` | Content pack storage and retrieval |
| `/apps/mobile/src/hooks/useSession.ts` | Client-side session orchestration |
| `/apps/mobile/src/screens/UploadScreen.tsx` | File picker, upload, duration config, session start |

## Latency Targets

- Server-initiated interrupt to user hearing redirect (p50): <900ms
- Barge-in silence (user-initiated): <150ms
- End-of-turn to first TTS byte at client (p50): <900ms
- End-of-turn to first TTS byte at client (p95): <1800ms

## Verification

1. `docker compose up` starts Postgres, Redis, backend
2. `GET /healthz` returns 200; `GET /readyz` returns 200
3. Run mobile on iOS simulator, pick a PDF, upload it, set 10-minute duration, tap "Start Session"
4. Full session: AI speaks opening question -> user holds push-to-talk and answers -> AI probes follow-up -> topics tick off the progress bar -> session ends at time limit with scorecard
5. Server interrupt: user goes off-topic for 15s -> AI cuts in with redirect -> user hears redirect message, mic stops
6. Time extension: tap "+5 min" during session -> timer updates -> AI re-plans remaining topics
7. Barge-in: user-initiated press while AI is speaking -> audio stops instantly -> recording begins
8. Check `GET /v1/metrics` for p50/p95 latency data
9. Run `vitest` for backend tests (state machine, timer, topic tracker, schemas, WS lifecycle, server interrupt, time extension)
10. Manual QA: timer hard stop, malformed JSON doesn't crash server, reconnection within 5s, large PDF (100 pages) doesn't time out upload


I've added three comprehensive appendices to the plan file with all research findings:

Appendix A: Deepgram STT/TTS API Research

Full connection URLs with all query parameters
Complete JSON message formats for every incoming/outgoing message type
speech_final vs is_final behavior matrix
Voice model comparison table (7 Aura models with tone descriptions)
Latency characteristics table (50-400ms depending on text length)
Barge-in Clear behavior timeline
Rate limits and error code reference
Proper close sequence
Appendix B: React Native Audio Research

Library comparison table (6 libraries evaluated)
react-native-live-audio-stream configuration with code
Full iOS AVAudioSession setup (Swift) with route change + interruption handlers
Full Android AudioRecord setup (Java) with foreground service for Android 14+
Complete PCM playback native modules (AVAudioEngine for iOS, AudioTrack for Android)
JitterBuffer implementation
WebSocket binary frame support with performance analysis
Common pitfalls & solutions table
Appendix C: OpenAI + Fastify + Backend Research

Structured Outputs schema restrictions and the streaming incompatibility finding
Complete streaming + non-streaming code patterns
Fastify WebSocket handler patterns with typed routes
ioredis session state with TTL and reconnection
node-postgres batch insert, transaction patterns, pool monitoring
Graceful shutdown sequence
The plan is now ready to be copied to docs/phase-1-build-plan.md. I need to exit plan mode to do that.

Claude’s Plan
Phase 1 Detailed Build Plan: Voice-First Time-Boxed AI Coaching App
Context
Building a B2C voice-first coaching app: "I have 3 minutes -- drill me on my investor pitch." Phase 1 proves the real-time audio pipeline works with hard timer enforcement, barge-in, and streaming STT/TTS. Enterprise features come later.

Confirmed decisions: React Native, Deepgram STT+TTS, OpenAI (Structured Outputs), 3-minute investor pitch drill, server-authoritative timer.

Repository Layout

/apps/mobile/              React Native bare workflow
/apps/backend/             Node.js/TypeScript + Fastify
/packages/shared/          TypeScript types, JSON schemas, Ajv validators
/infra/                    Docker Compose, Postgres init SQL
/docs/                     PROTOCOL.md, ARCHITECTURE.md, RUNBOOK.md
Group 1: Repository Scaffolding & Infrastructure
Task 1: Initialize monorepo
Root package.json with npm workspaces: ["apps/*", "packages/*"]
tsconfig.base.json: strict mode, ES2022 target, path aliases
.env.example: DEEPGRAM_API_KEY, OPENAI_API_KEY, POSTGRES_URL=postgresql://coach:coach@localhost:5432/coach, REDIS_URL=redis://localhost:6379, JWT_SECRET, NODE_ENV=development
.gitignore: node_modules, dist, .env, *.pcm, coverage
.nvmrc: 20
Task 2: Shared package scaffold
/packages/shared/package.json: name @coach/shared, dependencies: ajv
/packages/shared/tsconfig.json: composite true, outDir dist
/packages/shared/src/index.ts: barrel export
Task 3: Backend scaffold
/apps/backend/package.json dependencies:
fastify, @fastify/websocket, @fastify/cors, ws
ioredis, pg
ajv, jose (JWT), pino, dotenv, openai, uuid
devDeps: vitest, typescript, @types/ws, tsx
/apps/backend/src/config.ts: typed config loader, validates all env vars at startup, fails fast on missing keys
/apps/backend/src/index.ts: imports server, calls server.listen({ port: 3000, host: '0.0.0.0' })
Task 4: Mobile scaffold
npx react-native init CoachMobile --directory apps/mobile
Install: react-native-live-audio-stream, @react-navigation/native, @react-navigation/native-stack, @react-native-async-storage/async-storage
Custom native modules needed for PCM playback (AVAudioEngine on iOS, AudioTrack on Android)
Task 5: Docker Compose + Postgres schema
/infra/docker-compose.yml: postgres:16, redis:7-alpine, backend service

/infra/postgres/init.sql:


CREATE TABLE users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anon_device_id TEXT UNIQUE,
  email TEXT NULL
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  drill_id TEXT NOT NULL,
  requested_duration_ms INT NOT NULL,
  actual_duration_ms INT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ended','error')),
  error_code TEXT NULL
);

CREATE TABLE session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  ts_ms BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE transcripts (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  turn_index INT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user','coach')),
  is_final BOOLEAN NOT NULL,
  text TEXT NOT NULL,
  provider TEXT NOT NULL,
  confidence REAL NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_events_session ON session_events(session_id, ts_ms);
CREATE INDEX idx_transcripts_session ON transcripts(session_id, turn_index);
Task 6: Doc stubs
/docs/PROTOCOL.md, /docs/ARCHITECTURE.md, /docs/RUNBOOK.md
Group 2: Shared Types, Schemas, Validation
Task 7: WebSocket event type definitions
/packages/shared/src/types/events.ts

Every event uses this envelope:


interface BaseEvent {
  type: string;
  event_id: string;
  session_id: string;
  ts_ms: number;
  payload: Record<string, unknown>;
}
Binary frames (audio.chunk, tts.chunk) are raw PCM bytes -- no JSON envelope.

Client events (discriminated union ClientEvent):

client.hello → { protocol_version: string, app_version: string, device_info: { platform: 'ios'|'android', os_version: string } }
auth.anonymous → { token: string }
session.start → { requested_duration_ms: number, drill_id: string, user_goal?: string }
audio.start → { codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, chunk_ms: 20 }
audio.chunk → BINARY frame (no JSON)
audio.stop → {}
client.barge_in → {}
client.ping → {}
client.resume → { resume_token: string, last_server_event_id: string }
Server events (discriminated union ServerEvent):

server.hello → { protocol_version: string, connection_id: string }
auth.ok → { user_id: string }
auth.error → { message: string }
session.start_ack → { session_id: string, duration_ms: number, start_ts: number }
session.plan → { plan: SessionPlan }
timer.tick → { remaining_ms: number, segment_name: string }
timer.warning → { remaining_ms: number, message: string }
timer.expired → {}
stt.partial → { text: string, confidence: number }
stt.final → { text: string, confidence: number, words?: WordTimestamp[] }
coach.text → { text: string, turn_type: string }
tts.start → { tts_seq: number }
tts.chunk → BINARY frame (raw PCM)
tts.end → { tts_seq: number }
tts.cleared → {}
server.error → { code: ErrorCode, message: string }
server.goodbye → { reason: string }
Type guards: isClientEvent(e), isServerEvent(e), isBinaryFrame(msg)

Task 8: Domain types
/packages/shared/src/types/session.ts:


enum SessionState {
  IDLE = 'IDLE',
  CONFIGURING = 'CONFIGURING',
  PLANNING = 'PLANNING',
  BRIEFING = 'BRIEFING',
  RUNNING_REP = 'RUNNING_REP',
  WRAPPING = 'WRAPPING',
  ENDED = 'ENDED'
}

interface SessionPlan {
  plan_version: string;
  session_goal: string;
  total_time_ms: number;
  segments: SessionSegment[];
  interrupt_rules: { hard_stop_at_end: boolean; warn_at_ms: number[] };
}

interface SessionSegment {
  segment_id: string;
  name: string;
  duration_ms: number;
  mode: 'coach_talk' | 'user_talk' | 'mixed';
  coach_prompt: string;
  success_criteria?: string[];
}

interface PacingDecision {
  should_interrupt: boolean;
  interrupt_reason: 'time_warning' | 'off_topic' | 'too_slow' | 'too_long' | 'none';
  message_to_user: string;
  recommended_next_action: 'continue' | 'ask_followup' | 'force_wrap_up' | 'redo_first_line';
  time_remaining_ms: number;
}
/packages/shared/src/types/errors.ts:


enum ErrorCode {
  ERR_UNAUTHORIZED = 'ERR_UNAUTHORIZED',
  ERR_BAD_EVENT_SCHEMA = 'ERR_BAD_EVENT_SCHEMA',
  ERR_UNSUPPORTED_AUDIO_FORMAT = 'ERR_UNSUPPORTED_AUDIO_FORMAT',
  ERR_PROVIDER_STT_UNAVAILABLE = 'ERR_PROVIDER_STT_UNAVAILABLE',
  ERR_PROVIDER_TTS_UNAVAILABLE = 'ERR_PROVIDER_TTS_UNAVAILABLE',
  ERR_LLM_UNAVAILABLE = 'ERR_LLM_UNAVAILABLE',
  ERR_SESSION_STATE = 'ERR_SESSION_STATE',
  ERR_RATE_LIMIT = 'ERR_RATE_LIMIT'
}
Task 9: JSON Schemas + Ajv validators
/packages/shared/src/schemas/: One file per schema, plus a factory that pre-compiles all validators.

Each schema exported as both a plain object (for OpenAI Structured Outputs json_schema parameter) and a compiled Ajv ValidateFunction.

Schemas needed: event-envelope, session-start-payload, audio-start-payload, session-plan, pacing-decision

Key schema restriction for OpenAI Structured Outputs: additionalProperties: false required on all objects, and ALL properties must be listed in required. This is mandatory for strict: true.

Task 10: Constants + default drill
/packages/shared/src/constants.ts:


export const PROTOCOL_VERSION = '1.0';
export const TIMER_TOTAL_MS = 180_000;
export const TIMER_TICK_INTERNAL_MS = 100;   // server tick resolution
export const TIMER_TICK_CLIENT_MS = 1_000;   // emit to client at 1Hz
export const TIMER_WARNING_THRESHOLDS = [60_000, 15_000];
export const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];
export const AUDIO_CODEC = 'pcm_s16le';
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_CHUNK_MS = 20;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/packages/shared/src/drills/pitch-3min.ts: default drill definition + static fallback plan:


export const PITCH_3MIN_DRILL = {
  drill_id: 'pitch_3min_v1',
  name: '3-Minute Investor Pitch',
  default_duration_ms: 180_000,
  description: 'Practice your investor pitch under time pressure.'
};

export const PITCH_3MIN_DEFAULT_PLAN: SessionPlan = {
  plan_version: '1.0',
  session_goal: 'Deliver a compelling 3-minute investor pitch',
  total_time_ms: 180_000,
  segments: [
    { segment_id: 'intro', name: 'Coach sets context', duration_ms: 15_000,
      mode: 'coach_talk', coach_prompt: 'Set the scene: you are a VC hearing this pitch. Explain the format in 2 sentences.' },
    { segment_id: 'pitch', name: 'User pitch rep', duration_ms: 120_000,
      mode: 'mixed', coach_prompt: 'Listen to the pitch. Interrupt with one tough question at the 60s mark.',
      success_criteria: ['Clear problem statement', 'Market size', 'Ask articulated'] },
    { segment_id: 'feedback', name: 'Coach feedback', duration_ms: 45_000,
      mode: 'coach_talk', coach_prompt: 'Give exactly 2 specific strength bullets, 1 improvement, and 1 redo line. Be direct.' }
  ],
  interrupt_rules: { hard_stop_at_end: true, warn_at_ms: [60_000, 15_000] }
};
Task 11: Shared package unit tests
Valid/invalid payloads for each schema
Event envelope validation
Session plan schema validation
Group 3: Backend Core -- HTTP, Auth, Database
Task 12: Fastify server setup
/apps/backend/src/server.ts:


import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';

const app = Fastify({ logger: { level: 'info' } });
await app.register(fastifyCors);
await app.register(fastifyWebsocket);
// Register route plugins...
Graceful shutdown: SIGINT/SIGTERM → close WS connections, drain HTTP, close DB pool, close Redis
Task 13: Database layer
/apps/backend/src/db/pool.ts: pg.Pool singleton, max 20 connections, 30s idle timeout

/apps/backend/src/db/queries/:

users.ts: findOrCreateAnonymous(deviceId) -- upsert using ON CONFLICT (anon_device_id) DO NOTHING + select
sessions.ts: createSession(...), endSession(id, actualMs, status, errorCode?), getSession(id)
events.ts: batch insert -- buffer events in memory, flush every 500ms with a single multi-row INSERT:

INSERT INTO session_events (session_id, ts_ms, type, payload)
VALUES ($1,$2,$3,$4), ($5,$6,$7,$8), ...
transcripts.ts: insertTranscript(sessionId, turnIndex, speaker, isFinal, text, provider, confidence)
Task 14: Redis layer
/apps/backend/src/redis/client.ts: ioredis singleton with auto-reconnect:


import Redis from 'ioredis';
const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3
});
/apps/backend/src/redis/session-store.ts:


interface LiveSessionState {
  session_id: string;
  user_id: string;
  state: SessionState;
  plan: SessionPlan;
  start_ts: number;
  elapsed_ms: number;
  current_segment_index: number;
  turn_index: number;
  last_client_audio_seq: number;
  last_server_tts_seq: number;
  resume_token: string;
}
// setex with 15-minute TTL, JSON serialize/deserialize
// getex to retrieve and refresh TTL atomically
Task 15: Authentication
/apps/backend/src/auth/token.ts: JWT with jose library

createAnonymousToken(userId, deviceId): HS256 signed, 24h expiry, claims { sub, device_id, iat, exp }
verifyToken(token): returns claims or throws
POST /v1/auth/anonymous: body { device_id: string } → findOrCreateAnonymousUser → returns { token, user_id, expires_at }

Task 16: HTTP endpoints
GET /healthz → 200 { status: 'ok' }
GET /readyz → checks pool.query('SELECT 1') + redis.ping(), returns 200 or 503
GET /v1/drills → returns [PITCH_3MIN_DRILL] (auth required)
GET /v1/sessions/:id → session record + transcript count (auth required)
Task 17: Route registration + auth middleware
preHandler hook verifies JWT for protected routes
Skip auth for /healthz, /readyz, /v1/auth/anonymous
Group 4: Provider Adapters
Task 18: STT Adapter -- Deepgram WebSocket
/apps/backend/src/adapters/stt/types.ts: STTAdapter interface with EventEmitter-style API:

connect(config), sendAudio(chunk: Buffer), finalize(), close()
Events: partial, final, utterance_end, error, close
/apps/backend/src/adapters/stt/deepgram.ts: DeepgramSTTAdapter

Connection URL:


wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&endpointing=500&utterance_end_ms=800&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&smart_format=true
Authentication: Authorization: Token ${apiKey} header on WebSocket upgrade.

Incoming message parsing:


// Response format from Deepgram:
{
  type: "Results",
  channel: {
    alternatives: [{ confidence: 0.95, transcript: "...", words: [...] }]
  },
  is_final: boolean,    // won't update this transcript further
  speech_final: boolean, // endpointing triggered
  duration: number,
  start: number
}
// UtteranceEnd message:
{ type: "UtteranceEnd", last_speech_time: number }
Turn-taking logic:

On speech_final: true → emit final event → triggers coach response generation
On is_final: true → lock transcript for scoring/storage
On UtteranceEnd without prior speech_final → treat as turn boundary, emit final
Control messages we send:

Finalize: { "type": "Finalize" } -- forces final transcript
KeepAlive: { "type": "KeepAlive" } -- every 30s if no audio
Close: send zero-length audio or { "type": "CloseStream" }
Endpointing config rationale: 500ms endpointing is aggressive but responsive for coaching turn-taking. 800ms utterance_end gives user time to resume after a natural pause. Tune later based on user feedback.

Task 19: TTS Adapter -- Deepgram WebSocket with Clear
/apps/backend/src/adapters/tts/types.ts: TTSAdapter interface:

connect(), speak(text), flush(), clear(): Promise<void>, close()
Events: audio, flushed, cleared, error
/apps/backend/src/adapters/tts/deepgram.ts: DeepgramTTSAdapter

Connection URL:


wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=raw
Voice model: aura-asteria-en (female, professional, clear) -- best for coaching tone. Alternative: aura-luna-en (warmer).

Control messages:


speak(text)  → ws.send(JSON.stringify({ type: "Speak", text }))
flush()      → ws.send(JSON.stringify({ type: "Flush" }))
clear()      → ws.send(JSON.stringify({ type: "Clear" }))
close()      → ws.send(JSON.stringify({ type: "Close" }))
Response handling:

Binary frames = raw PCM audio bytes (linear16, 16kHz) → emit audio event
{ type: "UserActionResult", action: "Flush", result: "submitted" } → emit flushed
{ type: "UserActionResult", action: "Clear", result: "submitted" } → emit cleared
Barge-in via Clear:

Clear is processed in ~50-100ms by Deepgram
Residual audio: 100-300ms may already be buffered -- client drops its jitter buffer instantly
clear() returns Promise that resolves on cleared confirmation (with 2s timeout fallback)
Multiple Speak before Flush: Server concatenates all queued text, generates as one unit. This is critical -- sending word-by-word produces poor prosody. Send full sentences.

Latency: ~100-150ms from Flush to first audio byte for typical coach utterances (5-15 words).

Task 20: TTS text chunker
/apps/backend/src/adapters/tts/chunker.ts: TextChunker class

Collects streaming LLM tokens into a buffer. Emits complete sentences on .!? followed by whitespace or end-of-stream. On explicit flush (LLM response complete), emits whatever remains.


class TextChunker extends EventEmitter {
  private buffer = '';

  addToken(token: string): void {
    this.buffer += token;
    const sentences = this.extractCompleteSentences();
    for (const sentence of sentences) {
      this.emit('sentence', sentence);
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.emit('sentence', this.buffer.trim());
      this.buffer = '';
    }
  }

  private extractCompleteSentences(): string[] {
    const sentenceEndRegex = /[.!?]\s+/g;
    // ... split on sentence boundaries, keep remainder in buffer
  }
}
Why this matters: Deepgram TTS generates much better prosody when given complete sentences vs fragments. Adds 100-300ms of buffering per sentence but dramatically improves voice quality.

Task 21: LLM Adapter -- OpenAI
/apps/backend/src/adapters/llm/openai.ts: OpenAILLMAdapter

Critical finding from research: Structured Outputs do NOT work with stream: true. You get the full JSON in one response, not partial tokens. Architecture must split:

Coach speech (needs streaming for TTS pipeline): Use stream: true WITHOUT Structured Outputs. Plain text output. Pipe tokens through TextChunker → TTS Speak.
Session plan generation: Use Structured Outputs (strict: true), non-streamed. Runs once pre-session, can afford 1-2s latency.
Pacing decisions: Use Structured Outputs (strict: true), non-streamed. gpt-4o-mini is fast enough (~200-400ms).
Streaming coach turn:


const controller = new AbortController();

const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  stream: true,
  messages: [...],
  max_tokens: 150,
  temperature: 0.7,
  signal: controller.signal  // for barge-in abort
});

for await (const chunk of stream) {
  const token = chunk.choices[0]?.delta?.content;
  if (token) textChunker.addToken(token);
}
textChunker.flush();
Barge-in cancellation: Call controller.abort() → stream stops immediately, catch AbortError.

Structured Output for plan/pacing:


const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'SessionPlan',
      schema: SESSION_PLAN_SCHEMA,  // from shared package
      strict: true
    }
  },
  messages: [...]
});
const plan: SessionPlan = JSON.parse(response.choices[0].message.content!);
Schema restrictions for Structured Outputs: All objects must have additionalProperties: false. All properties must appear in required array. No if/then/else. Enums work well.

Cost per session: ~$0.001 with gpt-4o-mini (6 turns × ~300 tokens each).

Retry logic: Up to 2 retries if JSON parse fails. If plan generation fails after retries, fall back to PITCH_3MIN_DEFAULT_PLAN.

Task 22: LLM Prompt Templates
/apps/backend/src/adapters/llm/prompts.ts

SESSION_PLAN_SYSTEM_PROMPT:


You are designing a 3-minute voice coaching session plan for a user practicing their investor pitch.
The user is on-the-go (walking/commuting) and needs strict time enforcement.
Output a structured plan that fits exactly within the total time budget.
Each segment has a coach prompt describing what the coach should do during that segment.
COACH_TURN_SYSTEM_PROMPT:


You are a seasoned venture capitalist conducting a live pitch practice session.
You are direct, insightful, and challenging but fair.
Keep every response to 2-3 sentences maximum (under 50 words).
No markdown, no emojis, no formatting -- this will be spoken aloud.

Session context:
- Time remaining: {time_remaining_sec}s
- Current segment: {segment_name}
- Turn number: {turn_index}
{time_remaining_sec < 30 ? 'This is your final feedback -- make it count.' : ''}
PACING_DECISION_SYSTEM_PROMPT:


You are a session pacing engine. Evaluate whether to interrupt the user based on:
- Time remaining vs content needed
- Whether user is on-track, rambling, or silent
Respond with a structured pacing decision.
COACH_OPENING_PROMPT: Sets the scene, explains the drill format, mentions time budget.

COACH_FEEDBACK_PROMPT: "Give exactly 2 specific strengths, 1 improvement area, and 1 specific line they should redo. Be ruthlessly specific."

Task 23: Adapter factory
/apps/backend/src/adapters/factory.ts: Config-driven, reads provider names from env. Returns typed adapter interfaces.

Group 5: Session Orchestrator & WebSocket Server
Task 24: Session state machine
/apps/backend/src/orchestrator/state-machine.ts

States: IDLE → CONFIGURING → PLANNING → BRIEFING → RUNNING_REP → WRAPPING → ENDED

Transition table:


IDLE → CONFIGURING           on: session.start received
CONFIGURING → PLANNING       on: config validated
PLANNING → BRIEFING          on: plan ready
BRIEFING → RUNNING_REP       on: coach opening TTS complete
RUNNING_REP → WRAPPING       on: enter feedback segment OR timer at 45s remaining
WRAPPING → ENDED             on: timer.expired OR feedback TTS complete
ANY → ENDED                  on: error OR timer.expired
transition(current, event) returns { newState, sideEffects[] } or throws ERR_SESSION_STATE.

Side effects: 'start_timer' | 'generate_plan' | 'start_briefing_tts' | 'start_stt' | 'stop_stt' | 'generate_coach_turn' | 'start_tts' | 'clear_tts' | 'persist_end'

Task 25: Timer engine
/apps/backend/src/orchestrator/timer.ts: SessionTimer class

Uses wall-clock delta: remaining = totalMs - (Date.now() - startTs) -- avoids setInterval drift
Internal tick at 100ms resolution
Emits to client at 1Hz via timer.tick
Warning callbacks fire once each at 60s and 15s remaining
On expiry: calls onExpired() callback
Continues during client disconnect (server authoritative)
getRemaining(): snapshot of remaining ms
destroy(): clears interval, prevents callbacks
Task 26: Session orchestrator
/apps/backend/src/orchestrator/session.ts: SessionOrchestrator class

One instance per active session. Owns state machine + timer + all adapters.

Lifecycle:

start(): validate drill → generate plan (LLM or fallback) → emit session.plan → speak coach opening → start timer → transition to RUNNING_REP
handleAudioStart(): connect STT adapter, set up partial/final listeners
handleAudioChunk(buf): forward to STT, increment audio seq
handleAudioStop(): finalize STT → wait for final transcript → generate coach response → stream through TTS
handleBargeIn(): clear TTS immediately → emit tts.cleared → log event
handleTimerExpired(): force finalize STT → clear TTS → emit timer.expired → persist session end → emit server.goodbye → close WS
handleDisconnect(): timer keeps running, mark WS as disconnected
handleResume(): validate resume token from Redis, reconnect
destroy(): clean up all adapters, timer, flush event buffer to Postgres
Task 27: Coach response pipeline
/apps/backend/src/orchestrator/coach-pipeline.ts


User speech ends (audio.stop + stt.final)
  → Record audio_stop_ts, stt_final_ts
  → Call openai.chat.completions.create({ stream: true }) with AbortController
  → Record llm_request_start_ts
  → Pipe tokens through TextChunker
  → On each complete sentence:
      → ttsAdapter.speak(sentence)
  → On LLM complete:
      → textChunker.flush()
      → ttsAdapter.flush()
      → Record llm_complete_ts
  → On TTS first audio chunk:
      → Record tts_first_byte_ts
      → Send tts.start to client WS
  → On each TTS audio chunk:
      → Send as binary frame to client WS
  → On TTS flushed:
      → Send tts.end to client WS
  → Also send coach.text (JSON) with full text for captions
Cancellation: If handleBargeIn() called mid-pipeline:

controller.abort() → stops OpenAI stream
ttsAdapter.clear() → stops Deepgram TTS
Drop any queued sentences in chunker
Send tts.cleared to client
Task 28: Latency instrumentation
/apps/backend/src/orchestrator/metrics.ts

Per-turn timestamps:


interface TurnMetrics {
  turn_index: number;
  audio_stop_ts: number;
  stt_final_ts: number;
  llm_request_start_ts: number;
  llm_first_token_ts: number;
  llm_complete_ts: number;
  tts_request_start_ts: number;
  tts_first_byte_ts: number;
  tts_first_byte_sent_ts: number;
  barge_in_ts?: number;
}
Compute:

End-to-end: tts_first_byte_sent_ts - audio_stop_ts (target p50 < 900ms, p95 < 1800ms)
STT latency: stt_final_ts - audio_stop_ts
LLM TTFT: llm_first_token_ts - llm_request_start_ts
TTS latency: tts_first_byte_ts - tts_request_start_ts
GET /v1/metrics → JSON with p50/p95 for each metric. Log p50/p95 every 60s via pino.

Task 29: WebSocket handler
/apps/backend/src/ws/handler.ts

Register at GET /v1/ws via @fastify/websocket:


app.get('/v1/ws', { websocket: true }, (socket, req) => {
  // socket IS the ws.WebSocket object
  socket.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      // JSON control message → parse, validate, route
    } else {
      // Binary audio frame → forward to orchestrator
    }
  });
});
Connection lifecycle:

Send server.hello with protocol_version, connection_id
Wait for client.hello → validate protocol version
Wait for auth.anonymous → verify JWT → send auth.ok
Wait for session.start → create SessionOrchestrator → route subsequent events
Heartbeat: expect client.ping every 15s. If none for 30s, close.
On WS close/error: call orchestrator.handleDisconnect(), clean up session map
Session map: Map<string, SessionOrchestrator> keyed by connection_id. Delete on close.

Task 30: Event validation
/apps/backend/src/ws/validator.ts

Uses pre-compiled Ajv validators from shared package. Returns typed result or sends server.error with specific code.

Task 31: Pacing loop
/apps/backend/src/orchestrator/pacing.ts: PacingLoop class

Runs every 5 seconds during RUNNING_REP state
Calls llmAdapter.generatePacingDecision() with current context
Debounce: max one interrupt per 15 seconds
If should_interrupt && interrupt_reason === 'time_warning': speak brief warning via TTS
If recommended_next_action === 'force_wrap_up': transition to WRAPPING
Group 6: Mobile Client
Task 32: Navigation
/apps/mobile/src/App.tsx: root with NavigationContainer
/apps/mobile/src/screens/HomeScreen.tsx: drill card + start button
/apps/mobile/src/screens/SessionScreen.tsx: active session UI
React Navigation native-stack: Home → Session
Task 33: WebSocket client
/apps/mobile/src/services/ws-client.ts: WSClient class


const ws = new WebSocket('ws://localhost:3000/v1/ws');
ws.binaryType = 'arraybuffer'; // CRITICAL: enable binary frame support
Sends JSON events as text frames
Sends audio as binary frames (ws.send(pcmArrayBuffer))
Receives binary frames (TTS audio) and text frames (JSON events)
Event emitter for all server events
Reconnection: exponential backoff [200, 500, 1000, 2000, 5000]ms
Heartbeat: send client.ping every 15s
React Native's built-in WebSocket supports binary frames via binaryType = 'arraybuffer'. Can handle 50+ messages/sec at 640 bytes each (20ms audio chunks at 16kHz mono 16-bit = 640 bytes).

Task 34: Auth service
/apps/mobile/src/services/auth.ts

getOrCreateDeviceId(): read from AsyncStorage or generate UUID
authenticate(httpUrl): POST /v1/auth/anonymous → store JWT in memory
Auto-refresh on expiry
Task 35: Audio capture
/apps/mobile/src/services/audio-capture.ts

Uses react-native-live-audio-stream -- streams raw PCM chunks in real-time:


import LiveAudioStream from 'react-native-live-audio-stream';

LiveAudioStream.init({
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6,  // Android: VOICE_COMMUNICATION (noise reduction)
  bufferSize: 4096
});

LiveAudioStream.start();
LiveAudioStream.on('data', (base64: string) => {
  // Library returns base64-encoded PCM -- decode to ArrayBuffer
  const pcm = base64ToArrayBuffer(base64);
  wsClient.sendAudioChunk(pcm);
});
iOS audio session (configure in native module or AppDelegate):

Category: .playAndRecord -- simultaneous capture + playback
Mode: .voiceChat -- optimized echo cancellation, noise reduction, mic gain
Options: .allowBluetooth, .defaultToSpeaker
Handle interruptions (phone call): pause capture, resume on end
Handle route changes (headphones unplugged): switch to speaker
Android:

Request RECORD_AUDIO permission at runtime
Android 14+: must declare <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/> and use foreground service with notification for continuous recording
AudioSource: VOICE_COMMUNICATION (6) for built-in noise reduction
Task 36: Audio playback
/apps/mobile/src/services/audio-playback.ts

Requires custom native module -- React Native has no built-in raw PCM buffer playback.

iOS native module (PCMAudioPlayer.swift):


// Uses AVAudioEngine + AVAudioPlayerNode
// - setupAudioEngine(): attach playerNode to engine, format 16kHz mono 16-bit
// - playPCMBuffer(data: Data): convert bytes to AVAudioPCMBuffer, schedule on playerNode
// - stop(): stop playerNode, clear scheduled buffers -- INSTANT for barge-in
Android native module (PCMAudioPlayer.java):


// Uses AudioTrack in MODE_STREAM
// - initialize(): create AudioTrack at 16kHz mono 16-bit
// - playPCMBuffer(byte[]): write to AudioTrack (WRITE_NON_BLOCKING)
// - stop(): stop + flush AudioTrack -- INSTANT for barge-in
Jitter buffer (JavaScript layer):

Buffer 200-400ms of audio before starting playback
On barge-in: stopPlayback() drops entire buffer instantly (0ms perceived)
Adaptive: increase buffer on packet loss, decrease on good conditions
Task 37: Session screen UI
/apps/mobile/src/screens/SessionScreen.tsx

States: connecting | briefing | listening | thinking | speaking | ended

UI elements:

Timer: large mm:ss countdown, updated from timer.tick
Push-to-talk button: large circle, press-and-hold to record
On press during speaking state: send client.barge_in first (stops playback), then start capture
On release: send audio.stop, transition to thinking
Transcript area: scrolling text, partials italic, finals normal, coach text distinguished
Status indicator: Listening... / Thinking... / Coach speaking...
Warning banner: appears on timer.warning
Earcon sounds: beep on recording start, alert on timer warning, chime on session end
Task 38: useSession hook
/apps/mobile/src/hooks/useSession.ts

Coordinates WSClient + AudioCapture + AudioPlayback + UI state. Handles all server events:

session.plan → brief display → transition to briefing
tts.start → transition to speaking, start playback
tts.chunk → enqueue audio buffer
tts.end → transition to idle
tts.cleared → confirm barge-in complete
stt.partial → update live transcript
stt.final → update locked transcript
timer.tick → update countdown
timer.warning → show warning
timer.expired → end session
server.error → error toast
Cleanup on unmount
Task 39: Home screen
Display single drill card (3-minute investor pitch)
"Start Drill" button
Request mic permission if needed
"Not for use while driving" disclaimer
Brief app description
Group 7: Testing & Documentation
Task 40: Backend unit tests
State machine: all legal transitions pass, illegal throw ERR_SESSION_STATE, ENDED reachable from every state
Timer: fires expired at 180s (±50ms tolerance), warnings at correct thresholds, continues after mock disconnect, destroy prevents callbacks
Text chunker: "Hello. World." → ["Hello.", "World."], partial buffering, flush emits remainder
WS validator: valid events pass, malformed JSON returns error, missing fields fail
Task 41: Backend integration tests
Full WS lifecycle: connect → hello → auth → session.start → start_ack
Barge-in: mock TTS adapter, verify clear() called, tts.cleared sent, no deadlock on 3x rapid barge-in
Timer expiry: start with 2s timer, verify timer.expired sent, session persisted with status ended, WS closed
Task 42: Schema tests
Every JSON schema against valid and invalid examples
Session plan rejects plans with segments exceeding total_time_ms
Pacing decision rejects unknown enum values
Task 43: Documentation
PROTOCOL.md: Full event catalog with JSON examples for every event type, binary frame format, state machine diagram (Mermaid), error code table, reconnection sequence

ARCHITECTURE.md: System diagram (Mermaid), data flow, component responsibilities, Redis key schema, provider adapter interfaces

RUNBOOK.md: Local setup steps, env var reference, manual QA checklist:

Timer stops at exactly 180s
Barge-in stops audio instantly
Partials appear while speaking
Reconnection works within 5s
Malformed messages don't crash server
Key Files
File	Role
/packages/shared/src/types/events.ts	Canonical client-server contract
/apps/backend/src/orchestrator/session.ts	Central coordinator: state machine + timer + adapters
/apps/backend/src/ws/handler.ts	WebSocket connection lifecycle
/apps/backend/src/adapters/tts/deepgram.ts	TTS streaming + barge-in (most latency-sensitive)
/apps/backend/src/adapters/tts/chunker.ts	LLM token → sentence → TTS pipeline
/apps/backend/src/orchestrator/coach-pipeline.ts	LLM → chunker → TTS → client audio
/apps/backend/src/adapters/llm/openai.ts	Streaming + Structured Outputs (separate calls)
/apps/mobile/src/hooks/useSession.ts	Client-side session orchestration
/apps/mobile/ios/PCMAudioPlayer.swift	Native PCM playback for iOS
/apps/mobile/android/.../PCMAudioPlayer.java	Native PCM playback for Android
Latency Targets
Metric	p50 Target	p95 Target
Barge-in to silence (client)	<50ms	<150ms
End-of-turn → first TTS byte at client	<900ms	<1800ms
STT final transcript after audio.stop	<300ms	<600ms
LLM time-to-first-token	<200ms	<500ms
TTS first audio byte after Flush	<150ms	<250ms
Verification
docker compose -f infra/docker-compose.yml up → Postgres + Redis + backend running
GET /healthz → 200; GET /readyz → 200
Run mobile on iOS simulator, tap "Start Drill"
Full session: coach speaks intro → user push-to-talk pitches → coach responds → timer counts down → hard stop at 180s
Barge-in: press push-to-talk while coach speaking → audio stops instantly → recording begins
GET /v1/metrics → p50/p95 latency data present
cd apps/backend && npx vitest → all tests pass
Manual QA per RUNBOOK.md checklist
Appendix A: Deepgram STT/TTS API Research
STT WebSocket API (wss://api.deepgram.com/v1/listen)
Full Connection URL for coaching:


wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&endpointing=500&utterance_end_ms=800&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&smart_format=true&language=en
Query Parameters Reference:

Parameter	Value	Purpose
model	nova-2	Low-latency, good for real-time
interim_results	true	Send partial transcripts as user speaks
endpointing	500	ms of silence before speech considered ended
utterance_end_ms	800	ms server waits after endpointing before UtteranceEnd
encoding	linear16	PCM 16-bit signed little-endian
sample_rate	16000	16kHz
channels	1	Mono
punctuate	true	Add punctuation
smart_format	true	Format numbers, dates, currency
language	en	English
search	["term1","term2"]	Boost detection of specific keywords
Authentication:

Header: Authorization: Token YOUR_API_KEY
Alternative: query parameter (less recommended)
Incoming Message Formats:

Partial transcript (interim_results=true):


{
  "type": "Results",
  "channel": {
    "alternatives": [{
      "confidence": 0.95,
      "transcript": "I think the customer needs"
    }]
  },
  "is_final": false,
  "speech_final": false,
  "duration": 0.85,
  "start": 1.23
}
Final transcript:


{
  "type": "Results",
  "channel": {
    "alternatives": [{
      "confidence": 0.98,
      "transcript": "I think the customer needs better pricing.",
      "words": [
        { "word": "I", "start": 1.23, "end": 1.4, "confidence": 0.99 },
        { "word": "think", "start": 1.4, "end": 1.65, "confidence": 0.98 }
      ]
    }]
  },
  "is_final": true,
  "speech_final": true,
  "duration": 2.1,
  "start": 1.23
}
UtteranceEnd:


{ "type": "UtteranceEnd", "last_speech_time": 5.82 }
Metadata (sent at connection start):


{
  "type": "Metadata",
  "open_time": 1234567890,
  "request_id": "abc-123-def-456",
  "channels": 1,
  "models": ["deepgram/nova-2"],
  "started": true
}
Error:


{ "type": "Error", "error": "Invalid audio encoding", "code": 400, "request_id": "abc-123" }
Understanding speech_final vs is_final:

Field	Meaning	Use Case
speech_final: true	End of coherent speech unit (endpointing triggered)	Trigger coach to speak
is_final: true	Deepgram won't update this transcript (high confidence)	Safe to use for scoring
Control Messages We Send:

Message	Format	Purpose
Finalize	{ "type": "Finalize" }	Force final transcript (on session end/stop)
KeepAlive	{ "type": "KeepAlive" }	Keep connection alive (every 30s if no audio)
CloseStream	{ "type": "CloseStream" }	Graceful close
Proper Close Sequence:

Stop sending audio
Send { "type": "Finalize" } to get final transcript
Wait for final Results with is_final: true
Close WebSocket: ws.close(1000, "Normal closure")
Endpointing Rationale:

500ms: Aggressive but responsive for coaching turn-taking
800ms utterance_end: Allows natural speaking rhythm
User might resume after 500ms pause, so we wait 800ms before sending UtteranceEnd
Tune later based on user feedback
Rate Limits (per Deepgram plan):

Starter: ~5-10 concurrent connections
Professional: 50+ concurrent
Enterprise: unlimited
Monthly audio minutes quota (e.g., 50,000 min/month on Pro)
Error Codes & Reconnection:

Code	Meaning	Action
401	Invalid API key	Check auth, don't retry
403	Quota exceeded	Wait or upgrade
429	Rate limited	Exponential backoff (2s, 4s, 8s)
500	Server error	Retry with exponential backoff
TTS WebSocket API (wss://api.deepgram.com/v1/speak)
Full Connection URL:


wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=raw
Query Parameters:

Parameter	Value	Purpose
model	aura-asteria-en	Voice model
encoding	linear16	PCM 16-bit
sample_rate	16000	Matches STT input
container	raw	No headers, just PCM bytes
Available Aura Voice Models:

Model	Gender	Tone	Best For
aura-asteria-en	Female	Professional, clear	Coaching (recommended)
aura-luna-en	Female	Warm, conversational	Friendly coaching
aura-stella-en	Female	Energetic, engaging	High-energy drilling
aura-athena-en	Female	Authoritative, confident	Leadership coaching
aura-hera-en	Female	Warm, supportive	Mentoring
aura-orion-en	Male	Professional, deep	Executive coaching
aura-arcas-en	Male	Calm, measured	Analytical coaching
All Aura models: <150ms to first audio byte.

Control Messages:

Speak:


{ "type": "Speak", "text": "Let me give you a hint. Focus on the customer's pain point first." }
Flush (triggers TTS generation):


{ "type": "Flush" }
Clear (barge-in -- cancel and stop):


{ "type": "Clear" }
Close:


{ "type": "Close" }
Response Messages:

Flush confirmation:


{ "type": "UserActionResult", "action": "Flush", "result": "submitted" }
Clear confirmation:


{ "type": "UserActionResult", "action": "Clear", "result": "submitted" }
Binary frames: raw PCM audio bytes (linear16, 16kHz)

Queuing Multiple Speak Before Flush:


{"type": "Speak", "text": "Here's "}
{"type": "Speak", "text": "my feedback: "}
{"type": "Speak", "text": "strong job."}
{"type": "Flush"}
Server concatenates all → "Here's my feedback: strong job." → generates as one unit with proper prosody.

Text Chunking and Prosody:

Full sentences produce MUCH better prosody than fragments
Sending word-by-word sounds robotic and unnatural
Best approach: collect LLM tokens → extract complete sentences → send to TTS
Natural pause points (sentence boundaries) produce the most natural sound
Latency Characteristics:

Scenario	Latency to First Audio Byte
Simple ("Yes.")	50-100ms
Full sentence (10-15 words)	100-150ms
Paragraph (50+ words)	150-250ms
Multiple paragraphs	250-400ms
Barge-In via Clear:

Clear is processed ~50-100ms after received by Deepgram
Residual audio: 100-300ms may already be in client buffer
Client drops jitter buffer instantly → near-zero perceived residual
clear() returns Promise resolving on cleared confirmation (2s timeout fallback)
Audio Format Math:

16kHz × 16-bit × 1 channel = 32,000 bytes per second of audio
20ms chunk = 640 bytes
1 second = 50 chunks at 640 bytes each
Appendix B: React Native Audio Research
Audio Capture Libraries Evaluated
Library	PCM Streaming	Real-time Chunks	Recommendation
react-native-live-audio-stream	YES (native)	YES (20ms)	USE THIS
react-native-audio-recorder-player	PARTIAL (file-based)	Via onProgress	Not recommended
expo-av	NO (high-level)	Limited	Only for Expo managed
@react-native-community/audio-toolkit	Deprecated	N/A	AVOID
react-native-webrtc	YES	YES	Heavier, overkill
Custom native module	Full control	Full control	Fallback option
react-native-live-audio-stream Configuration

import LiveAudioStream from 'react-native-live-audio-stream';

LiveAudioStream.init({
  sampleRate: 16000,      // 16kHz - optimal for speech recognition
  channels: 1,            // Mono
  bitsPerSample: 16,      // 16-bit signed PCM
  audioSource: 6,         // Android: VOICE_COMMUNICATION (noise reduction)
  bufferSize: 4096        // ~256ms at 16kHz
});

LiveAudioStream.start();
LiveAudioStream.on('data', (base64: string) => {
  // Library returns base64-encoded PCM -- decode to ArrayBuffer
  const pcm = base64ToArrayBuffer(base64);
  wsClient.sendAudioChunk(pcm);
});
Chunk Timing at 16kHz:

20ms chunk: 320 samples = 640 bytes (as Int16)
40ms chunk: 640 samples = 1280 bytes
This matches WebSocket performance sweet spot
iOS Audio Session Configuration (Critical)

import AVFoundation

let session = AVAudioSession.sharedInstance()
try session.setCategory(
    .playAndRecord,             // Simultaneous input/output
    mode: .voiceChat,           // Echo cancellation, noise reduction, mic gain
    options: [
        .duckOthers,            // Lower other audio during recording
        .allowBluetooth,        // Bluetooth headsets
        .allowBluetoothA2DP,    // Wireless headphones
        .defaultToSpeaker       // Speaker if no external device
    ]
)
try session.setActive(true, options: .notifyOthersOnDeactivation)
AVAudioSession Category Matrix:

.playAndRecord: CORRECT for simultaneous capture + playback
.record: Output blocked
.play: Input blocked
.default: Not optimized for voice
Mode .voiceChat: Optimizes microphone gain, enables echo cancellation, enables noise reduction. REQUIRED for voice coaching.

Route Change Handling (headphones plugged/unplugged):


NotificationCenter.default.addObserver(
    forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
) { notification in
    if let reason = notification.userInfo?[AVAudioSession.routeChangeReasonKey] as? UInt {
        switch AVAudioSession.RouteChangeReason(rawValue: reason) {
        case .oldDeviceUnavailable:
            try? session.overrideOutputAudioPort(.speaker)
        default: break
        }
    }
}
Interruption Handling (phone call, Siri):


NotificationCenter.default.addObserver(
    forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
) { notification in
    guard let type = notification.userInfo?[AVAudioSession.interruptionTypeKey] as? UInt else { return }
    switch AVAudioSession.InterruptionType(rawValue: type) {
    case .began:
        LiveAudioStream.stop()       // Pause capture
    case .ended:
        if options.contains(.shouldResume) { LiveAudioStream.start() }
    default: break
    }
}
Android Audio Configuration
Permissions (AndroidManifest.xml):


<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.READ_PHONE_STATE" />
<!-- Android 14+ -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />

<service android:name=".AudioCaptureService" android:foregroundServiceType="microphone" />
Runtime Permission (React Native):


import { PermissionsAndroid } from 'react-native';

const granted = await PermissionsAndroid.request(
  PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  { title: 'Voice Coaching App', message: 'Microphone needed for voice coaching', buttonPositive: 'Accept' }
);
Android AudioRecord (native module):


int sampleRate = 16000;
int channelConfig = AudioFormat.CHANNEL_IN_MONO;
int audioFormat = AudioFormat.ENCODING_PCM_16BIT;
int bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat);

AudioRecord recorder = new AudioRecord(
    MediaRecorder.AudioSource.VOICE_COMMUNICATION,  // Built-in noise reduction
    sampleRate, channelConfig, audioFormat, bufferSize
);
recorder.startRecording();
byte[] audioBuffer = new byte[640];  // 20ms at 16kHz mono 16-bit
int readSize = recorder.read(audioBuffer, 0, 640);
Foreground Service (Android 14+ required for continuous recording):


public class AudioCaptureService extends Service {
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        startAudioCapture();
        return START_STICKY;
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Voice Coaching")
            .setContentText("Recording in progress...")
            .setSmallIcon(R.drawable.ic_microphone)
            .build();
    }
}
Audio Playback -- Custom Native Modules Required
React Native has NO built-in raw PCM buffer playback. Workarounds (encoding to WAV/MP3) add unacceptable latency.

iOS: AVAudioEngine + AVAudioPlayerNode


class PCMAudioPlayer {
    let engine = AVAudioEngine()
    let playerNode = AVAudioPlayerNode()
    var audioFormat: AVAudioFormat?

    func setupAudioEngine() throws {
        audioFormat = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: audioFormat)
        try engine.start()
        playerNode.play()
    }

    func playPCMBuffer(_ pcmData: Data) {
        guard let audioFormat = audioFormat else { return }
        let frameLength = AVAudioFrameCount(pcmData.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: frameLength) else { return }
        buffer.frameLength = frameLength
        pcmData.withUnsafeBytes { bytes in
            memcpy(buffer.int16ChannelData![0], bytes.bindMemory(to: Int16.self).baseAddress, pcmData.count)
        }
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
    }

    func stop() {
        playerNode.stop()      // INSTANT -- clears scheduled buffers
        engine.stop()
    }
}
Android: AudioTrack in MODE_STREAM


public class PCMAudioPlayer {
    private AudioTrack audioTrack;

    public void initialize() {
        int bufferSize = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        audioTrack = new AudioTrack(
            AudioManager.STREAM_VOICE_CALL, 16000,
            AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
            bufferSize, AudioTrack.MODE_STREAM
        );
        audioTrack.play();
    }

    public void playPCMBuffer(byte[] pcmData) {
        audioTrack.write(pcmData, 0, pcmData.length, AudioTrack.WRITE_NON_BLOCKING);
    }

    public void stop() {
        audioTrack.stop();     // INSTANT -- stops + flushes
        audioTrack.release();
    }
}
Jitter Buffer Implementation

class JitterBuffer {
  constructor(minBufferMs = 200, maxBufferMs = 400) {
    this.minBufferMs = minBufferMs;
    this.maxBufferMs = maxBufferMs;
    this.buffer = [];
  }

  addPacket(pcmData, sequenceNumber, timestamp) {
    this.buffer.push({ data: pcmData, seq: sequenceNumber, time: timestamp });
    this.buffer.sort((a, b) => a.time - b.time);
    this.trimBuffer();
  }

  getNextChunk(targetTime) {
    const bufferSizeMs = this.buffer.length > 0
      ? (this.buffer[this.buffer.length - 1].time - this.buffer[0].time) : 0;
    if (bufferSizeMs < this.minBufferMs) return null;  // Wait for more data
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].time <= targetTime) return this.buffer.splice(i, 1)[0]?.data;
    }
    return null;
  }

  flush() { this.buffer = []; }  // INSTANT for barge-in
}
Adaptive buffering: Increase minBufferMs to 400 on >5% packet loss. Decrease to 200 on <1% loss.

WebSocket Binary Frame Support in React Native
React Native's built-in WebSocket DOES support binary frames:


const ws = new WebSocket('ws://localhost:3000/v1/ws');
ws.binaryType = 'arraybuffer';  // CRITICAL

ws.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    // Binary TTS audio
    const pcm = new Uint8Array(event.data);
    jitterBuffer.addPacket(pcm, seq++, Date.now());
  } else {
    // JSON control message
    const msg = JSON.parse(event.data);
  }
};

// Send audio as binary
ws.send(pcmArrayBuffer);
Performance at 50 msgs/sec (20ms chunks):

640 bytes per message
32 KB/s upload + 32 KB/s download = 64 KB/s total
WebSocket overhead: ~14 bytes/frame = 0.7 KB/s
Processing overhead: ~2-4ms per message (negligible)
Well within mobile network capability (1-10 Mbps on 4G/5G)
Common Pitfalls & Solutions
Problem	Cause	Solution
Audio plays while mic captures	Wrong AVAudioSession category	Use .playAndRecord + .voiceChat
Echo during playback	No echo cancellation	iOS: voiceChat handles it
Choppy playback	Jitter buffer underflow	Increase minBufferMs to 300-400
High battery drain	Continuous recording	Use push-to-talk
Permission denied crashes	Missing foreground service (Android 14+)	Wrap in startForegroundService()
Loss of audio on call	Interruption not handled	AVAudioSession interruption observer
Audio stutters on network	Missing jitter buffer	200-400ms buffer with reordering
Appendix C: OpenAI + Fastify + Backend Research
OpenAI Structured Outputs
API Specification:


response_format: {
  type: "json_schema",
  json_schema: {
    name: "SessionPlan",
    schema: {
      type: "object",
      properties: { /* ... */ },
      required: ["all", "properties", "listed"],
      additionalProperties: false   // MANDATORY for strict: true
    },
    strict: true
  }
}
Schema Restrictions (strict: true):

additionalProperties: false required on ALL objects
ALL properties must appear in required array
No if/then/else
No regex patterns or complex validations
Enums work well for constrained outputs
Nested objects must also have additionalProperties: false
Critical Finding: Structured Outputs + Streaming Incompatibility:

Structured Outputs do NOT work with stream: true
You receive the complete JSON in one response, not partial tokens
Architecture MUST split into two patterns:
Coach speech (streaming, no Structured Outputs):

const controller = new AbortController();
const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  stream: true,
  messages: [...],
  max_tokens: 150,
  temperature: 0.7,
  signal: controller.signal  // for barge-in abort
});

for await (const chunk of stream) {
  const token = chunk.choices[0]?.delta?.content;
  if (token) textChunker.addToken(token);
}
textChunker.flush();
Plan/pacing (Structured Outputs, no streaming):

const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'SessionPlan', schema: SESSION_PLAN_SCHEMA, strict: true }
  },
  messages: [...]
});
const plan: SessionPlan = JSON.parse(response.choices[0].message.content!);
Stream Event Structure:


// First chunk
{ choices: [{ delta: { role: "assistant", content: "" } }] }
// Middle chunks
{ choices: [{ delta: { content: "This is" }, finish_reason: null }] }
// Last chunk
{ choices: [{ delta: { content: "." }, finish_reason: "stop" }] }
Barge-In via AbortController:


controller.abort();  // Immediately stops OpenAI stream
// Catch AbortError in the streaming loop
Models Supporting Structured Outputs:

gpt-4o (most capable, higher cost)
gpt-4o-mini (fast, cheap -- ideal for real-time)
NOT available on gpt-3.5-turbo
Pricing per 3-minute coaching session (~6 turns × ~300 tokens each):

gpt-4o-mini: ~$0.001 per session
gpt-4o: ~$0.02 per session
Error Handling:

If model can't generate valid JSON: finish_reason: "error"
Retry up to 2 times with exponential backoff
Fall back to PITCH_3MIN_DEFAULT_PLAN if plan generation fails
OpenAI SDK Configuration:


import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
  maxRetries: 2
});
Fastify WebSocket Server
@fastify/websocket Registration:


import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

const app = Fastify({ logger: { level: 'info' } });
await app.register(fastifyWebsocket);

app.get('/v1/ws', { websocket: true }, (socket, req) => {
  // socket IS the ws.WebSocket object directly
  socket.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      // JSON control message
      const msg = JSON.parse(data);
    } else {
      // Binary audio frame
      orchestrator.handleAudioChunk(data);
    }
  });
  socket.on('close', () => { /* cleanup */ });
  socket.on('error', (err) => { /* log, don't crash */ });
});
Socket object is ws.WebSocket -- direct access to:

socket.send(data) -- text or binary
socket.close(1000, "reason")
socket.ping() -- keep-alive
socket.terminate() -- force close
socket.readyState -- OPEN/CLOSED/etc.
Typed WebSocket Route:


interface WSQuery { session_id: string }
app.get<{ Querystring: WSQuery }>('/v1/ws', { websocket: true }, (socket, req) => {
  const sessionId = req.query.session_id;  // typed!
});
Per-Connection Session Map:


const sessionMap = new Map<string, SessionOrchestrator>();

app.get('/v1/ws', { websocket: true }, (socket, req) => {
  const connId = uuid();
  const orchestrator = new SessionOrchestrator(/* ... */);
  sessionMap.set(connId, orchestrator);

  socket.on('close', () => {
    orchestrator.cleanup();
    sessionMap.delete(connId);
  });
});
Backpressure Handling:


// Check socket readiness before writing
if (socket.readyState === WebSocket.OPEN) {
  socket.send(response);
}
// Monitor drain events for buffer-full scenarios
socket.on('drain', () => { /* resume sending */ });
Concurrent Connection Capacity:

Single Node.js process: ~50,000-100,000 concurrent connections
Limited by file descriptors (ulimit -n)
Memory: ~1MB per connection (depends on buffering)
For production: nginx/HAProxy as WebSocket proxy → multiple Node.js processes
ioredis Session State Management
Connection with auto-reconnect:


import Redis from 'ioredis';
const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => !err.message.includes('READONLY')
});
Session State with TTL:


// Store with 15-minute TTL
async function saveSession(sessionId: string, state: LiveSessionState) {
  await redis.setex(`session:${sessionId}`, 900, JSON.stringify(state));
}

// Retrieve and refresh TTL atomically
async function getSession(sessionId: string): Promise<LiveSessionState | null> {
  const json = await redis.getex(`session:${sessionId}`, 'EX', 900);
  return json ? JSON.parse(json) : null;
}
Pub/Sub for future multi-instance coordination:


const publisher = new Redis();
const subscriber = new Redis();
await subscriber.subscribe('session:*');
subscriber.on('message', (channel, message) => { /* handle */ });
node-postgres (pg) Patterns
Connection Pool:


import { Pool } from 'pg';
const pool = new Pool({
  connectionString: config.POSTGRES_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  application_name: 'coach-backend'
});
Batch Insert for Event Logging:


async function batchInsertEvents(sessionId: string, events: Array<{ type: string; ts_ms: number; payload: any }>) {
  const values = events.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`).join(',');
  const params: any[] = [];
  events.forEach(e => params.push(sessionId, e.ts_ms, e.type, JSON.stringify(e.payload)));
  await pool.query(
    `INSERT INTO session_events (session_id, ts_ms, type, payload) VALUES ${values}`,
    params
  );
}
Transaction Pattern:


async function transactional<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
Pool Health Monitoring:


setInterval(() => {
  console.log(`Pool: ${pool.totalCount - pool.idleCount}/${pool.totalCount} in use`);
  if (pool.totalCount - pool.idleCount === pool.totalCount) console.warn('Pool exhausted!');
}, 10000);
Graceful Shutdown:


async function shutdown() {
  await pool.end();
  await redis.quit();
  console.log('Connections closed');
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

# Phase 1 Detailed Build Plan: Voice-First Time-Boxed AI Coaching App

## Context

Building a B2C voice-first coaching app: "I have 3 minutes -- drill me on my investor pitch." Phase 1 proves the real-time audio pipeline works with hard timer enforcement, barge-in, and streaming STT/TTS. Enterprise features come later.

**Confirmed decisions:** React Native, Deepgram STT+TTS, OpenAI (Structured Outputs), 3-minute investor pitch drill, server-authoritative timer.

## Critical Fixes Applied to This Plan

This plan has been hardened based on implementation experience. The following landmines were identified and fixed:

1. **Audio chunking mismatch:** Spec now explicitly requires 20ms chunks (640 bytes) with JS-side slicing if native library emits larger buffers. No more "640 bytes in theory, 4096 bytes in practice."

2. **Base64 transport bottleneck:** Plan now treats base64 audio decode as a **measured risk** requiring early profiling. Fallback to custom native module is documented.

3. **Binary framing rules:** Explicit rules added for direction-based type distinction, validation, buffer caps, and backpressure handling.

4. **Barge-in pipeline completeness:** Six-step cancellation sequence is now **mandatory and tested**, not optional. Missing any step = coach keeps talking.

5. **Canonical constants enforcement:** All Deepgram STT/TTS parameters must come from `/packages/shared/src/constants.ts`. No hardcoded values.

6. **Auth hardening:** Rate limiting + device binding are now **required in Phase 1.0**, not deferred.

7. **Persistence crash strategy:** Explicit behavior defined for batch insert failures, session end timeouts, and DB unavailability.

8. **Backgrounding safety:** App must pause capture/playback when backgrounded and require user tap to resume (prevents accidental recording).

9. **WS backpressure:** Server must check `socket.bufferedAmount` and drop TTS chunks if > 64KB (prevents OOM on slow networks).

10. **WebSocket stack clarity:** Only `@fastify/websocket` is used. No separate `ws` dependency. Socket parameter is `ws.WebSocket` directly.

### Phase 1.0 vs 1.1 Scope Split

**Phase 1.0 (ship now -- proves the product):**
These features are **REQUIRED** to prove the core value prop. Do not ship without them.
- Full voice loop: STT → LLM → TTS → client playback
- Server-authoritative hard timer (180s) with hard stop at expiry
- **Barge-in cancel (full pipeline: OpenAI stream abort + chunker reset + TTS clear + client buffer drop)**
- Push-to-talk with live transcripts (partial + final)
- Session persistence (start/end, transcripts, errors) with crash-safe batch writes
- Anonymous auth with device binding + rate limiting
- Audio chunking at 20ms (640 bytes) with base64 decode or native fallback
- Jitter buffer with hard cap (2000ms) and instant drop on barge-in
- WS backpressure handling (drop TTS chunks if `bufferedAmount > 64KB`)
- App backgrounding safety (pause capture/playback, show resume prompt)

**Phase 1.1 (polish next -- not blocking the demo):**
These features improve reliability/UX but are not required for the initial proof.
- Redis resume token + full reconnect with `last_server_event_id` replay (Phase 1.0: basic reconnect starts new session)
- `/v1/metrics` endpoint with percentile computation (Phase 1.0: log raw per-turn timestamps via pino, compute offline)
- Pacing loop (LLM-driven interrupts every 5s based on progress) (Phase 1.0: fixed time warnings at 60s + 15s)
- Adaptive jitter buffer sizing (Phase 1.0: fixed 300ms min buffer)
- Client network quality indicators (Phase 1.0: log warnings server-side only)

**If you must cut scope to ship faster:**
Safe to defer to Phase 1.1 without breaking the demo:
- Pacing loop (use fixed time warnings instead)
- `/v1/metrics` endpoint (log timings, compute later)
- Full reconnect with event replay (accept that disconnect = new session)

**Do NOT cut:**
- Barge-in (this is the killer feature)
- Server-authoritative timer (this is the constraint)
- Audio chunking + base64 handling (breaks turn-taking)
- Auth hardening (prevents abuse)
- Backgrounding safety (prevents accidental recording)

---

## Repository Layout

```
/apps/mobile/              React Native bare workflow
/apps/backend/             Node.js/TypeScript + Fastify
/packages/shared/          TypeScript types, JSON schemas, Ajv validators
/infra/                    Docker Compose, Postgres init SQL
/docs/                     PROTOCOL.md, ARCHITECTURE.md, RUNBOOK.md
```

---

## Group 1: Repository Scaffolding & Infrastructure

### Task 1: Initialize monorepo
- Root `package.json` with npm workspaces: `["apps/*", "packages/*"]`
- `tsconfig.base.json`: strict mode, ES2022 target, path aliases
- `.env.example`: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `POSTGRES_URL=postgresql://coach:coach@localhost:5432/coach`, `REDIS_URL=redis://localhost:6379`, `JWT_SECRET`, `NODE_ENV=development`
- `.gitignore`: node_modules, dist, .env, *.pcm, coverage
- `.nvmrc`: `20`

### Task 2: Shared package scaffold
- `/packages/shared/package.json`: name `@coach/shared`, dependencies: `ajv`
- `/packages/shared/tsconfig.json`: composite true, outDir dist
- `/packages/shared/src/index.ts`: barrel export

### Task 3: Backend scaffold
- `/apps/backend/package.json` dependencies:
  - `fastify`, `@fastify/websocket`, `@fastify/cors`, `@fastify/rate-limit`
  - **IMPORTANT:** NO separate `ws` dependency. `@fastify/websocket` exposes `ws.WebSocket` directly via the socket parameter.
  - `ioredis`, `pg`
  - `ajv`, `jose` (JWT), `pino`, `dotenv`, `openai`, `uuid`
  - devDeps: `vitest`, `typescript`, `@types/ws`, `tsx`
- `/apps/backend/src/config.ts`: typed config loader, validates all env vars at startup, fails fast on missing keys
- `/apps/backend/src/index.ts`: imports server, calls `server.listen({ port: 3000, host: '0.0.0.0' })`

### Task 4: Mobile scaffold
- `npx react-native init CoachMobile --directory apps/mobile`
- Install: `react-native-live-audio-stream`, `@react-navigation/native`, `@react-navigation/native-stack`, `@react-native-async-storage/async-storage`
- Custom native modules needed for PCM playback (AVAudioEngine on iOS, AudioTrack on Android)

### Task 5: Docker Compose + Postgres schema
**`/infra/docker-compose.yml`**: postgres:16, redis:7-alpine, backend service

**`/infra/postgres/init.sql`**:
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anon_device_id TEXT UNIQUE,
  email TEXT NULL
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  drill_id TEXT NOT NULL,
  requested_duration_ms INT NOT NULL,
  actual_duration_ms INT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ended','error')),
  error_code TEXT NULL
);

CREATE TABLE session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  ts_ms BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE transcripts (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  turn_index INT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user','coach')),
  is_final BOOLEAN NOT NULL,
  text TEXT NOT NULL,
  provider TEXT NOT NULL,
  confidence REAL NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_events_session ON session_events(session_id, ts_ms);
CREATE INDEX idx_transcripts_session ON transcripts(session_id, turn_index);
```

### Task 6: Doc stubs
- `/docs/PROTOCOL.md`, `/docs/ARCHITECTURE.md`, `/docs/RUNBOOK.md`

---

## Group 2: Shared Types, Schemas, Validation

### Task 7: WebSocket event type definitions
**`/packages/shared/src/types/events.ts`**

Every event uses this envelope:
```typescript
interface BaseEvent {
  type: string;
  event_id: string;
  session_id: string;
  ts_ms: number;
  payload: Record<string, unknown>;
}
```

Binary frames (audio.chunk, tts.chunk) are raw PCM bytes -- no JSON envelope.

**Binary Framing Rules (must be documented in PROTOCOL.md):**
1. **Direction distinguishes type:** Client→Server binary = user audio. Server→Client binary = TTS audio. No ambiguity. No header/magic bytes needed.
2. **Binary before `audio.start` is an error:** Server MUST reject binary frames received before a valid `audio.start` event. Send `server.error` with `ERR_SESSION_STATE` and close connection.
3. **Sequence numbers are implicit:** Frames arrive in WebSocket order (TCP guarantees). `last_client_audio_seq` / `last_server_tts_seq` in Redis are monotonic counters incremented per frame, used for resumption bookkeeping only (Phase 1.1).
4. **Target frame size:** 640 bytes (20ms at 16kHz mono 16-bit). Server accepts frames up to 1280 bytes (40ms), logs warning. Drops frames > 8192 bytes (256ms indicates buffer problem).
5. **No interleaving:** Client must not send binary and JSON in the same WebSocket message. One frame = one type.
6. **Buffer caps:** Client jitter buffer MUST enforce `JITTER_BUFFER_CAP_MS` (2000ms) hard cap. Drop oldest chunks if exceeded. Server monitors `socket.bufferedAmount` and skips TTS chunks if > 64KB (prevents unbounded memory growth on slow networks).

Client events (discriminated union `ClientEvent`):
- `client.hello` → `{ protocol_version: string, app_version: string, device_info: { platform: 'ios'|'android', os_version: string } }`
- `auth.anonymous` → `{ token: string }`
- `session.start` → `{ requested_duration_ms: number, drill_id: string, user_goal?: string }`
- `audio.start` → `{ codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, chunk_ms: 20 }`
- `audio.chunk` → BINARY frame (no JSON)
- `audio.stop` → `{}`
- `client.barge_in` → `{}`
- `client.ping` → `{}`
- `client.resume` → `{ resume_token: string, last_server_event_id: string }`

Server events (discriminated union `ServerEvent`):
- `server.hello` → `{ protocol_version: string, connection_id: string }`
- `auth.ok` → `{ user_id: string }`
- `auth.error` → `{ message: string }`
- `session.start_ack` → `{ session_id: string, duration_ms: number, start_ts: number }`
- `session.plan` → `{ plan: SessionPlan }`
- `timer.tick` → `{ remaining_ms: number, segment_name: string }`
- `timer.warning` → `{ remaining_ms: number, message: string }`
- `timer.expired` → `{}`
- `stt.partial` → `{ text: string, confidence: number }`
- `stt.final` → `{ text: string, confidence: number, words?: WordTimestamp[] }`
- `coach.text` → `{ text: string, turn_type: string }`
- `tts.start` → `{ tts_seq: number }`
- `tts.chunk` → BINARY frame (raw PCM)
- `tts.end` → `{ tts_seq: number }`
- `tts.cleared` → `{}`
- `server.error` → `{ code: ErrorCode, message: string }`
- `server.goodbye` → `{ reason: string }`

Type guards: `isClientEvent(e)`, `isServerEvent(e)`, `isBinaryFrame(msg)`

### Task 8: Domain types
**`/packages/shared/src/types/session.ts`**:
```typescript
enum SessionState {
  IDLE = 'IDLE',
  CONFIGURING = 'CONFIGURING',
  PLANNING = 'PLANNING',
  BRIEFING = 'BRIEFING',
  RUNNING_REP = 'RUNNING_REP',
  WRAPPING = 'WRAPPING',
  ENDED = 'ENDED'
}

interface SessionPlan {
  plan_version: string;
  session_goal: string;
  total_time_ms: number;
  segments: SessionSegment[];
  interrupt_rules: { hard_stop_at_end: boolean; warn_at_ms: number[] };
}

interface SessionSegment {
  segment_id: string;
  name: string;
  duration_ms: number;
  mode: 'coach_talk' | 'user_talk' | 'mixed';
  coach_prompt: string;
  success_criteria?: string[];
}

interface PacingDecision {
  should_interrupt: boolean;
  interrupt_reason: 'time_warning' | 'off_topic' | 'too_slow' | 'too_long' | 'none';
  message_to_user: string;
  recommended_next_action: 'continue' | 'ask_followup' | 'force_wrap_up' | 'redo_first_line';
  time_remaining_ms: number;
}
```

**`/packages/shared/src/types/errors.ts`**:
```typescript
enum ErrorCode {
  ERR_UNAUTHORIZED = 'ERR_UNAUTHORIZED',
  ERR_BAD_EVENT_SCHEMA = 'ERR_BAD_EVENT_SCHEMA',
  ERR_UNSUPPORTED_AUDIO_FORMAT = 'ERR_UNSUPPORTED_AUDIO_FORMAT',
  ERR_PROVIDER_STT_UNAVAILABLE = 'ERR_PROVIDER_STT_UNAVAILABLE',
  ERR_PROVIDER_TTS_UNAVAILABLE = 'ERR_PROVIDER_TTS_UNAVAILABLE',
  ERR_LLM_UNAVAILABLE = 'ERR_LLM_UNAVAILABLE',
  ERR_SESSION_STATE = 'ERR_SESSION_STATE',
  ERR_RATE_LIMIT = 'ERR_RATE_LIMIT'
}
```

### Task 9: JSON Schemas + Ajv validators
**`/packages/shared/src/schemas/`**: One file per schema, plus a factory that pre-compiles all validators.

Each schema exported as both a plain object (for OpenAI Structured Outputs `json_schema` parameter) and a compiled Ajv `ValidateFunction`.

Schemas needed: `event-envelope`, `session-start-payload`, `audio-start-payload`, `session-plan`, `pacing-decision`

**Key schema restriction for OpenAI Structured Outputs**: `additionalProperties: false` required on all objects, and ALL properties must be listed in `required`. This is mandatory for `strict: true`.

### Task 10: Constants + default drill
**`/packages/shared/src/constants.ts`**:
```typescript
export const PROTOCOL_VERSION = '1.0';
export const TIMER_TOTAL_MS = 180_000;
export const TIMER_TICK_INTERNAL_MS = 100;   // server tick resolution
export const TIMER_TICK_CLIENT_MS = 1_000;   // emit to client at 1Hz
export const TIMER_WARNING_THRESHOLDS = [60_000, 15_000];
export const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];
export const AUDIO_CODEC = 'pcm_s16le';
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_CHUNK_MS = 20;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;

// Deepgram STT -- CANONICAL values (do NOT duplicate elsewhere)
// These values MUST be used in all STT adapter connection URLs. No hardcoded values allowed.
export const DEEPGRAM_STT_MODEL = 'nova-2';
export const DEEPGRAM_STT_ENDPOINTING_MS = 500;
export const DEEPGRAM_STT_UTTERANCE_END_MS = 800;  // STANDARDIZED: use this value, not 1000
export const DEEPGRAM_STT_KEEPALIVE_INTERVAL_MS = 30_000;

// Deepgram TTS -- CANONICAL values
export const DEEPGRAM_TTS_MODEL = 'aura-asteria-en';
export const DEEPGRAM_TTS_CLEAR_TIMEOUT_MS = 2_000;

// Audio chunk sizes -- CRITICAL: must match actual capture config
export const AUDIO_CHUNK_BYTES = 640;  // 20ms × 16kHz × 2 bytes = 640 bytes
export const AUDIO_BYTES_PER_SECOND = 32_000;  // 16kHz × 16-bit × mono

// Jitter buffer limits
export const JITTER_BUFFER_MIN_MS = 200;
export const JITTER_BUFFER_MAX_MS = 400;
export const JITTER_BUFFER_CAP_MS = 2_000;  // Hard cap: drop old chunks beyond this
```

**`/packages/shared/src/drills/pitch-3min.ts`**: default drill definition + static fallback plan:
```typescript
export const PITCH_3MIN_DRILL = {
  drill_id: 'pitch_3min_v1',
  name: '3-Minute Investor Pitch',
  default_duration_ms: 180_000,
  description: 'Practice your investor pitch under time pressure.'
};

export const PITCH_3MIN_DEFAULT_PLAN: SessionPlan = {
  plan_version: '1.0',
  session_goal: 'Deliver a compelling 3-minute investor pitch',
  total_time_ms: 180_000,
  segments: [
    { segment_id: 'intro', name: 'Coach sets context', duration_ms: 15_000,
      mode: 'coach_talk', coach_prompt: 'Set the scene: you are a VC hearing this pitch. Explain the format in 2 sentences.' },
    { segment_id: 'pitch', name: 'User pitch rep', duration_ms: 120_000,
      mode: 'mixed', coach_prompt: 'Listen to the pitch. Interrupt with one tough question at the 60s mark.',
      success_criteria: ['Clear problem statement', 'Market size', 'Ask articulated'] },
    { segment_id: 'feedback', name: 'Coach feedback', duration_ms: 45_000,
      mode: 'coach_talk', coach_prompt: 'Give exactly 2 specific strength bullets, 1 improvement, and 1 redo line. Be direct.' }
  ],
  interrupt_rules: { hard_stop_at_end: true, warn_at_ms: [60_000, 15_000] }
};
```

### Task 11: Shared package unit tests
- Valid/invalid payloads for each schema
- Event envelope validation
- Session plan schema validation

---

## Group 3: Backend Core -- HTTP, Auth, Database

### Task 12: Fastify server setup
**`/apps/backend/src/server.ts`**:
```typescript
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';

const app = Fastify({ logger: { level: 'info' } });
await app.register(fastifyCors);
await app.register(fastifyWebsocket);
// Register route plugins...
```
- Graceful shutdown: SIGINT/SIGTERM → close WS connections, drain HTTP, close DB pool, close Redis

### Task 13: Database layer
**`/apps/backend/src/db/pool.ts`**: `pg.Pool` singleton, max 20 connections, 30s idle timeout

**`/apps/backend/src/db/queries/`**:
- `users.ts`: `findOrCreateAnonymous(deviceId)` -- upsert using `ON CONFLICT (anon_device_id) DO NOTHING` + select
- `sessions.ts`: `createSession(...)`, `endSession(id, actualMs, status, errorCode?)`, `getSession(id)`
- `events.ts`: batch insert -- buffer events in memory, flush every 500ms with a single multi-row INSERT:
  ```sql
  INSERT INTO session_events (session_id, ts_ms, type, payload)
  VALUES ($1,$2,$3,$4), ($5,$6,$7,$8), ...
  ```
- `transcripts.ts`: `insertTranscript(sessionId, turnIndex, speaker, isFinal, text, provider, confidence)`

**Persistence crash strategy (defines behavior when DB writes fail):**

1. **Must-persist events (write immediately, not batched):**
   - `session.start`, `session.end`, `server.error` (severity >= ERROR)
   - Use individual `INSERT` statements, NOT the batch buffer
   - If these fail: retry once after 200ms with exponential backoff
   - If retry fails: log error to pino (structured JSON) + Sentry/error tracker, but continue session
   - **Rationale:** Session state is more important than perfect event log. Better to have incomplete logs than crash the session.

2. **Batch event insert failure:**
   - If batch `INSERT` fails (network, timeout, constraint violation), retry once after 200ms
   - If retry fails: log to pino (structured JSON) and **continue session** -- do NOT block the voice loop for DB writes
   - Events in that batch are LOST, but session continues
   - Set a flag `db_write_degraded` in session state and send a low-priority `server.warning` to client (Phase 1.1)

3. **Session end persistence:**
   - On `timer.expired` or `server.goodbye`, flush the event batch buffer **synchronously** before closing WS
   - Use a 2-second timeout on the flush
   - If timeout fires: close WS anyway and log the lost events (with session_id for later recovery)
   - **Rationale:** Clean session closure is more important than a few lost events. Don't hang connections waiting for DB.

4. **Transcript insert failure:**
   - Transcripts are best-effort, not critical path
   - If `insertTranscript()` fails, log error but do NOT block session
   - User won't see live transcripts if DB is down, but voice loop continues

### Task 14: Redis layer
**`/apps/backend/src/redis/client.ts`**: ioredis singleton with auto-reconnect:
```typescript
import Redis from 'ioredis';
const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3
});
```

**`/apps/backend/src/redis/session-store.ts`**:
```typescript
interface LiveSessionState {
  session_id: string;
  user_id: string;
  state: SessionState;
  plan: SessionPlan;
  start_ts: number;
  elapsed_ms: number;
  current_segment_index: number;
  turn_index: number;
  last_client_audio_seq: number;
  last_server_tts_seq: number;
  resume_token: string;
}
// setex with 15-minute TTL, JSON serialize/deserialize
// getex to retrieve and refresh TTL atomically
```

### Task 15: Authentication
**`/apps/backend/src/auth/token.ts`**: JWT with `jose` library
- `createAnonymousToken(userId, deviceId)`: HS256 signed, 24h expiry, claims `{ sub, device_id, iat, exp }`
- `verifyToken(token)`: returns claims or throws

**`POST /v1/auth/anonymous`**: body `{ device_id: string }` → `findOrCreateAnonymousUser` → returns `{ token, user_id, expires_at }`

**Auth hardening (Phase 1.0 -- REQUIRED, not optional):**

1. **Rate limit `/v1/auth/anonymous`:**
   - Max 10 requests per minute per IP (use `@fastify/rate-limit`)
   - Prevents token-farming and abuse
   - Return 429 with `Retry-After` header if exceeded

2. **Device binding on resume:**
   - JWT contains `device_id` claim
   - On WS `client.resume` (Phase 1.1) or session start, verify `device_id` from JWT matches the original session's `device_id` in Redis
   - Reject mismatches with `ERR_UNAUTHORIZED` and close connection
   - Prevents token theft / session hijacking

3. **Token expiry:**
   - 24h lifetime
   - No refresh flow in Phase 1.0 -- user gets a new anonymous token on next app open
   - Expired tokens return `auth.error` on WS connection, client must re-authenticate via HTTP

### Task 16: HTTP endpoints
- `GET /healthz` → 200 `{ status: 'ok' }`
- `GET /readyz` → checks `pool.query('SELECT 1')` + `redis.ping()`, returns 200 or 503
- `GET /v1/drills` → returns `[PITCH_3MIN_DRILL]` (auth required)
- `GET /v1/sessions/:id` → session record + transcript count (auth required)

### Task 17: Route registration + auth middleware
- `preHandler` hook verifies JWT for protected routes
- Skip auth for `/healthz`, `/readyz`, `/v1/auth/anonymous`

---

## Group 4: Provider Adapters

### Task 18: STT Adapter -- Deepgram WebSocket

**`/apps/backend/src/adapters/stt/types.ts`**: `STTAdapter` interface with EventEmitter-style API:
- `connect(config)`, `sendAudio(chunk: Buffer)`, `finalize()`, `close()`
- Events: `partial`, `final`, `utterance_end`, `error`, `close`

**`/apps/backend/src/adapters/stt/deepgram.ts`**: `DeepgramSTTAdapter`

**Connection URL** (built from shared constants -- NEVER hardcode these values):

**CRITICAL:** All parameters MUST come from `/packages/shared/src/constants.ts`. No hardcoded values allowed. This ensures consistency across environments and makes tuning trivial.

```typescript
import {
  DEEPGRAM_STT_MODEL,
  DEEPGRAM_STT_ENDPOINTING_MS,
  DEEPGRAM_STT_UTTERANCE_END_MS,
  AUDIO_CODEC,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS
} from '@coach/shared';

const url = `wss://api.deepgram.com/v1/listen?model=${DEEPGRAM_STT_MODEL}`
  + `&interim_results=true`
  + `&endpointing=${DEEPGRAM_STT_ENDPOINTING_MS}`
  + `&utterance_end_ms=${DEEPGRAM_STT_UTTERANCE_END_MS}`
  + `&encoding=${AUDIO_CODEC}&sample_rate=${AUDIO_SAMPLE_RATE}&channels=${AUDIO_CHANNELS}`
  + `&punctuate=true&smart_format=true`;
```

**Why this matters:** If you hardcode `utterance_end_ms=1000` in one place and use the constant (800) elsewhere, turn-taking logic becomes inconsistent and debugging becomes hell.

**Authentication**: `Authorization: Token ${apiKey}` header on WebSocket upgrade.

**Incoming message parsing**:
```typescript
// Response format from Deepgram:
{
  type: "Results",
  channel: {
    alternatives: [{ confidence: 0.95, transcript: "...", words: [...] }]
  },
  is_final: boolean,    // won't update this transcript further
  speech_final: boolean, // endpointing triggered
  duration: number,
  start: number
}
// UtteranceEnd message:
{ type: "UtteranceEnd", last_speech_time: number }
```

**Turn-taking logic**:
- On `speech_final: true` → emit `final` event → triggers coach response generation
- On `is_final: true` → lock transcript for scoring/storage
- On `UtteranceEnd` without prior `speech_final` → treat as turn boundary, emit `final`

**Control messages we send**:
- Finalize: `{ "type": "Finalize" }` -- forces final transcript
- KeepAlive: `{ "type": "KeepAlive" }` -- every 30s if no audio
- Close: send zero-length audio or `{ "type": "CloseStream" }`

**Endpointing config rationale**: 500ms endpointing is aggressive but responsive for coaching turn-taking. 800ms utterance_end gives user time to resume after a natural pause. Tune later based on user feedback.

### Task 19: TTS Adapter -- Deepgram WebSocket with Clear

**`/apps/backend/src/adapters/tts/types.ts`**: `TTSAdapter` interface:
- `connect()`, `speak(text)`, `flush()`, `clear(): Promise<void>`, `close()`
- Events: `audio`, `flushed`, `cleared`, `error`

**`/apps/backend/src/adapters/tts/deepgram.ts`**: `DeepgramTTSAdapter`

**Connection URL**:
```
wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=raw
```

**Voice model**: `aura-asteria-en` (female, professional, clear) -- best for coaching tone. Alternative: `aura-luna-en` (warmer).

**Control messages**:
```typescript
speak(text)  → ws.send(JSON.stringify({ type: "Speak", text }))
flush()      → ws.send(JSON.stringify({ type: "Flush" }))
clear()      → ws.send(JSON.stringify({ type: "Clear" }))
close()      → ws.send(JSON.stringify({ type: "Close" }))
```

**Response handling**:
- Binary frames = raw PCM audio bytes (linear16, 16kHz) → emit `audio` event
- `{ type: "UserActionResult", action: "Flush", result: "submitted" }` → emit `flushed`
- `{ type: "UserActionResult", action: "Clear", result: "submitted" }` → emit `cleared`

**Barge-in via Clear**:
- Clear is processed in ~50-100ms by Deepgram
- Residual audio: 100-300ms may already be buffered -- client drops its jitter buffer instantly
- `clear()` returns Promise that resolves on `cleared` confirmation (with 2s timeout fallback)

**Multiple Speak before Flush**: Server concatenates all queued text, generates as one unit. This is critical -- sending word-by-word produces poor prosody. Send full sentences.

**Latency**: ~100-150ms from Flush to first audio byte for typical coach utterances (5-15 words).

### Task 20: TTS text chunker

**`/apps/backend/src/adapters/tts/chunker.ts`**: `TextChunker` class

Collects streaming LLM tokens into a buffer. Emits complete sentences on `.!?` followed by whitespace or end-of-stream. On explicit flush (LLM response complete), emits whatever remains.

```typescript
class TextChunker extends EventEmitter {
  private buffer = '';

  addToken(token: string): void {
    this.buffer += token;
    const sentences = this.extractCompleteSentences();
    for (const sentence of sentences) {
      this.emit('sentence', sentence);
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.emit('sentence', this.buffer.trim());
      this.buffer = '';
    }
  }

  reset(): void {
    // CRITICAL for barge-in: drop all buffered text
    // Called when user interrupts coach mid-sentence
    this.buffer = '';
  }

  private extractCompleteSentences(): string[] {
    const sentenceEndRegex = /[.!?]\s+/g;
    // ... split on sentence boundaries, keep remainder in buffer
  }
}
```

**Why this matters**: Deepgram TTS generates much better prosody when given complete sentences vs fragments. Adds 100-300ms of buffering per sentence but dramatically improves voice quality.

### Task 21: LLM Adapter -- OpenAI

**`/apps/backend/src/adapters/llm/openai.ts`**: `OpenAILLMAdapter`

**Critical finding from research**: Structured Outputs do NOT work with `stream: true`. You get the full JSON in one response, not partial tokens. Architecture must split:

1. **Coach speech** (needs streaming for TTS pipeline): Use `stream: true` WITHOUT Structured Outputs. Plain text output. Pipe tokens through TextChunker → TTS Speak.
2. **Session plan generation**: Use Structured Outputs (`strict: true`), non-streamed. Runs once pre-session, can afford 1-2s latency.
3. **Pacing decisions**: Use Structured Outputs (`strict: true`), non-streamed. gpt-4o-mini is fast enough (~200-400ms).

**Streaming coach turn**:
```typescript
const controller = new AbortController();

const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  stream: true,
  messages: [...],
  max_tokens: 150,
  temperature: 0.7,
  signal: controller.signal  // for barge-in abort
});

for await (const chunk of stream) {
  const token = chunk.choices[0]?.delta?.content;
  if (token) textChunker.addToken(token);
}
textChunker.flush();
```

**Barge-in cancellation**: Call `controller.abort()` → stream stops immediately, catch `AbortError`.

**Structured Output for plan/pacing**:
```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'SessionPlan',
      schema: SESSION_PLAN_SCHEMA,  // from shared package
      strict: true
    }
  },
  messages: [...]
});
const plan: SessionPlan = JSON.parse(response.choices[0].message.content!);
```

**Schema restrictions for Structured Outputs**: All objects must have `additionalProperties: false`. All properties must appear in `required` array. No `if/then/else`. Enums work well.

**Cost per session**: ~$0.001 with gpt-4o-mini (6 turns × ~300 tokens each).

**Retry logic**: Up to 2 retries if JSON parse fails. If plan generation fails after retries, fall back to `PITCH_3MIN_DEFAULT_PLAN`.

### Task 22: LLM Prompt Templates

**`/apps/backend/src/adapters/llm/prompts.ts`**

**SESSION_PLAN_SYSTEM_PROMPT**:
```
You are designing a 3-minute voice coaching session plan for a user practicing their investor pitch.
The user is on-the-go (walking/commuting) and needs strict time enforcement.
Output a structured plan that fits exactly within the total time budget.
Each segment has a coach prompt describing what the coach should do during that segment.
```

**COACH_TURN_SYSTEM_PROMPT**:
```
You are a seasoned venture capitalist conducting a live pitch practice session.
You are direct, insightful, and challenging but fair.
Keep every response to 2-3 sentences maximum (under 50 words).
No markdown, no emojis, no formatting -- this will be spoken aloud.

Session context:
- Time remaining: {time_remaining_sec}s
- Current segment: {segment_name}
- Turn number: {turn_index}
{time_remaining_sec < 30 ? 'This is your final feedback -- make it count.' : ''}
```

**PACING_DECISION_SYSTEM_PROMPT**:
```
You are a session pacing engine. Evaluate whether to interrupt the user based on:
- Time remaining vs content needed
- Whether user is on-track, rambling, or silent
Respond with a structured pacing decision.
```

**COACH_OPENING_PROMPT**: Sets the scene, explains the drill format, mentions time budget.

**COACH_FEEDBACK_PROMPT**: "Give exactly 2 specific strengths, 1 improvement area, and 1 specific line they should redo. Be ruthlessly specific."

### Task 23: Adapter factory
**`/apps/backend/src/adapters/factory.ts`**: Config-driven, reads provider names from env. Returns typed adapter interfaces.

---

## Group 5: Session Orchestrator & WebSocket Server

### Task 24: Session state machine
**`/apps/backend/src/orchestrator/state-machine.ts`**

States: `IDLE → CONFIGURING → PLANNING → BRIEFING → RUNNING_REP → WRAPPING → ENDED`

Transition table:
```
IDLE → CONFIGURING           on: session.start received
CONFIGURING → PLANNING       on: config validated
PLANNING → BRIEFING          on: plan ready
BRIEFING → RUNNING_REP       on: coach opening TTS complete
RUNNING_REP → WRAPPING       on: enter feedback segment OR timer at 45s remaining
WRAPPING → ENDED             on: timer.expired OR feedback TTS complete
ANY → ENDED                  on: error OR timer.expired
```

`transition(current, event)` returns `{ newState, sideEffects[] }` or throws `ERR_SESSION_STATE`.

Side effects: `'start_timer' | 'generate_plan' | 'start_briefing_tts' | 'start_stt' | 'stop_stt' | 'generate_coach_turn' | 'start_tts' | 'clear_tts' | 'persist_end'`

### Task 25: Timer engine
**`/apps/backend/src/orchestrator/timer.ts`**: `SessionTimer` class

- Uses wall-clock delta: `remaining = totalMs - (Date.now() - startTs)` -- avoids setInterval drift
- Internal tick at 100ms resolution
- Emits to client at 1Hz via `timer.tick`
- Warning callbacks fire once each at 60s and 15s remaining
- On expiry: calls `onExpired()` callback
- Continues during client disconnect (server authoritative)
- `getRemaining()`: snapshot of remaining ms
- `destroy()`: clears interval, prevents callbacks

### Task 26: Session orchestrator
**`/apps/backend/src/orchestrator/session.ts`**: `SessionOrchestrator` class

One instance per active session. Owns state machine + timer + all adapters.

**Lifecycle**:
1. `start()`: validate drill → generate plan (LLM or fallback) → emit `session.plan` → speak coach opening → start timer → transition to RUNNING_REP
2. `handleAudioStart()`: connect STT adapter, set up partial/final listeners
3. `handleAudioChunk(buf)`: forward to STT, increment audio seq
4. `handleAudioStop()`: finalize STT → wait for final transcript → generate coach response → stream through TTS
5. `handleBargeIn()`: clear TTS immediately → emit `tts.cleared` → log event
6. `handleTimerExpired()`: force finalize STT → clear TTS → emit `timer.expired` → persist session end → emit `server.goodbye` → close WS
7. `handleDisconnect()`: timer keeps running, mark WS as disconnected
8. `handleResume()`: **(Phase 1.1)** validate resume token from Redis, reconnect. Phase 1.0: basic reconnect re-authenticates and starts a new session if the old one is still running.
9. `destroy()`: clean up all adapters, timer, flush event buffer to Postgres

### Task 27: Coach response pipeline
**`/apps/backend/src/orchestrator/coach-pipeline.ts`**

```
User speech ends (audio.stop + stt.final)
  → Record audio_stop_ts, stt_final_ts
  → Call openai.chat.completions.create({ stream: true }) with AbortController
  → Record llm_request_start_ts
  → Pipe tokens through TextChunker
  → On each complete sentence:
      → ttsAdapter.speak(sentence)
  → On LLM complete:
      → textChunker.flush()
      → ttsAdapter.flush()
      → Record llm_complete_ts
  → On TTS first audio chunk:
      → Record tts_first_byte_ts
      → Send tts.start to client WS
  → On each TTS audio chunk:
      → Send as binary frame to client WS
  → On TTS flushed:
      → Send tts.end to client WS
  → Also send coach.text (JSON) with full text for captions
```

**CRITICAL: Barge-in cancellation -- FULL pipeline or coach keeps talking**

If `handleBargeIn()` called mid-pipeline, **ALL SIX of these steps must fire, in order, with NO exceptions:**

1. **Abort OpenAI stream:** `controller.abort()` → stops token generation immediately, catch `AbortError` in streaming loop
2. **Reset text chunker:** `textChunker.reset()` → drop all buffered tokens and queued sentences (prevents stale text from reaching TTS)
3. **Clear TTS adapter:** `ttsAdapter.clear()` → sends `{ type: "Clear" }` to Deepgram WebSocket, returns Promise
4. **Wait for confirmation:** Await `cleared` event from TTS adapter (with 2s timeout fallback)
5. **Notify client:** Send `tts.cleared` to client WebSocket
6. **Client drops buffer:** Client flushes jitter buffer instantly on receiving `tts.cleared` (do NOT drain remaining audio)

**If ANY step is skipped or fails silently:** The coach will resume speaking 500ms-2s later. This is the #1 UX-breaking bug. Test with rapid triple barge-in (press PTT 3 times in 2 seconds while coach is speaking) to verify no residual audio leaks through.

**Testing checklist:**
- Barge-in during LLM generation (before first TTS byte) → no audio plays
- Barge-in during TTS playback → audio stops within 150ms
- Rapid 3x barge-in → no audio leak, no deadlock
- Network delay on TTS clear confirmation → timeout fires, session continues

### Task 28: Latency instrumentation
**`/apps/backend/src/orchestrator/metrics.ts`**

Per-turn timestamps:
```typescript
interface TurnMetrics {
  turn_index: number;
  audio_stop_ts: number;
  stt_final_ts: number;
  llm_request_start_ts: number;
  llm_first_token_ts: number;
  llm_complete_ts: number;
  tts_request_start_ts: number;
  tts_first_byte_ts: number;
  tts_first_byte_sent_ts: number;
  barge_in_ts?: number;
}
```

Compute:
- End-to-end: `tts_first_byte_sent_ts - audio_stop_ts` (target p50 < 900ms, p95 < 1800ms)
- STT latency: `stt_final_ts - audio_stop_ts`
- LLM TTFT: `llm_first_token_ts - llm_request_start_ts`
- TTS latency: `tts_first_byte_ts - tts_request_start_ts`

`GET /v1/metrics` → **(Phase 1.1)** JSON with p50/p95 for each metric. **Phase 1.0:** Log raw per-turn timestamps via pino (structured JSON). Compute percentiles offline. Skip the `/v1/metrics` endpoint until Phase 1.1.

### Task 29: WebSocket handler
**`/apps/backend/src/ws/handler.ts`**

Register at `GET /v1/ws` via `@fastify/websocket`:

**IMPORTANT:** `@fastify/websocket` wraps the `ws` library. The `socket` parameter in your handler IS a `ws.WebSocket` object directly. You do NOT need a separate `ws` dependency. Import types with `import type { WebSocket } from 'ws';` for TypeScript.

```typescript
import type { WebSocket } from 'ws';  // Type-only import for socket typing

app.get('/v1/ws', { websocket: true }, (socket: WebSocket, req) => {
  // socket is ws.WebSocket -- has .send(), .close(), .ping(), .readyState, etc.

  socket.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      // JSON control message → parse, validate, route
      const event = JSON.parse(data);
      // ... validation + routing
    } else {
      // Binary audio frame → forward to orchestrator
      orchestrator.handleAudioChunk(data);
    }
  });

  socket.on('close', (code, reason) => {
    orchestrator.handleDisconnect();
    sessionMap.delete(connectionId);
  });

  socket.on('error', (err) => {
    logger.error({ err, connectionId }, 'WebSocket error');
    // Do NOT crash server on socket error
  });
});
```

**Connection lifecycle**:
1. Send `server.hello` with protocol_version, connection_id
2. Wait for `client.hello` → validate protocol version
3. Wait for `auth.anonymous` → verify JWT → send `auth.ok`
4. Wait for `session.start` → create SessionOrchestrator → route subsequent events
5. Heartbeat: expect `client.ping` every 15s. If none for 30s, close.
6. On WS close/error: call `orchestrator.handleDisconnect()`, clean up session map

**Session map**: `Map<string, SessionOrchestrator>` keyed by connection_id. Delete on close.

### Task 30: Event validation
**`/apps/backend/src/ws/validator.ts`**

Uses pre-compiled Ajv validators from shared package. Returns typed result or sends `server.error` with specific code.

### Task 31: Pacing loop **(Phase 1.1 -- defer)**
**`/apps/backend/src/orchestrator/pacing.ts`**: `PacingLoop` class

- Runs every 5 seconds during RUNNING_REP state
- Calls `llmAdapter.generatePacingDecision()` with current context
- Debounce: max one interrupt per 15 seconds
- If `should_interrupt && interrupt_reason === 'time_warning'`: speak brief warning via TTS
- If `recommended_next_action === 'force_wrap_up'`: transition to WRAPPING
- **Phase 1.0 substitute:** Hard-coded time warnings at 60s and 15s remaining (no LLM call). Coach speaks a fixed warning message via TTS.

---

## Group 6: Mobile Client

### Task 32: Navigation
- `/apps/mobile/src/App.tsx`: root with NavigationContainer
- `/apps/mobile/src/screens/HomeScreen.tsx`: drill card + start button
- `/apps/mobile/src/screens/SessionScreen.tsx`: active session UI
- React Navigation native-stack: Home → Session

### Task 33: WebSocket client
**`/apps/mobile/src/services/ws-client.ts`**: `WSClient` class

```typescript
const ws = new WebSocket('ws://localhost:3000/v1/ws');
ws.binaryType = 'arraybuffer'; // CRITICAL: enable binary frame support
```

- Sends JSON events as text frames
- Sends audio as binary frames (`ws.send(pcmArrayBuffer)`)
- Receives binary frames (TTS audio) and text frames (JSON events)
- Event emitter for all server events
- Reconnection: exponential backoff [200, 500, 1000, 2000, 5000]ms
- Heartbeat: send `client.ping` every 15s

React Native's built-in WebSocket supports binary frames via `binaryType = 'arraybuffer'`. Can handle 50+ messages/sec at 640 bytes each (20ms audio chunks at 16kHz mono 16-bit = 640 bytes).

### Task 34: Auth service
**`/apps/mobile/src/services/auth.ts`**
- `getOrCreateDeviceId()`: read from AsyncStorage or generate UUID
- `authenticate(httpUrl)`: POST `/v1/auth/anonymous` → store JWT in memory
- Auto-refresh on expiry

### Task 35: Audio capture
**`/apps/mobile/src/services/audio-capture.ts`**

Uses **`react-native-live-audio-stream`** -- streams raw PCM chunks in real-time.

**CRITICAL: Audio chunking + base64 transport**

The target is 20ms chunks (640 bytes at 16kHz mono 16-bit) for responsive turn-taking and low-latency barge-in. However, the library has two performance traps:

1. **bufferSize mismatch:** `bufferSize: 4096` produces ~256ms chunks (4096 bytes), NOT 20ms. This destroys turn-taking latency.
2. **Base64 encoding overhead:** The library emits base64 strings. Decoding adds CPU + GC pressure + latency jitter exactly where you can't afford it.

**Solution (Phase 1.0):**
- Accept native buffers at 4096 bytes (library limitation)
- **Slice in JS** into 640-byte subframes before sending
- **Measure dropped frames in first test session.** If CPU profiling shows >5% dropped frames or >10ms decode jitter, you MUST escalate to a custom native module that emits raw `ArrayBuffer` directly (no base64 round-trip).

```typescript
import LiveAudioStream from 'react-native-live-audio-stream';
import { AUDIO_CHUNK_BYTES } from '@coach/shared';  // 640

LiveAudioStream.init({
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6,  // Android: VOICE_COMMUNICATION (noise reduction)
  bufferSize: 4096  // Native buffer (~256ms). JS slicer below chops into 20ms.
});

LiveAudioStream.start();
LiveAudioStream.on('data', (base64: string) => {
  // PERFORMANCE WARNING: base64 decode is a known bottleneck.
  // Profile this code path in first test. If jitter > 10ms, replace library.
  const pcmBytes = base64ToArrayBuffer(base64);

  // Slice into 640-byte (20ms) subframes before sending
  for (let offset = 0; offset < pcmBytes.byteLength; offset += AUDIO_CHUNK_BYTES) {
    const chunk = pcmBytes.slice(offset, Math.min(offset + AUDIO_CHUNK_BYTES, pcmBytes.byteLength));
    wsClient.sendBinary(chunk);  // Send as binary frame, NOT JSON
  }
});
```

**Fallback plan if base64 is too slow:** Write a thin native module that exposes `onAudioData(callback: (buffer: ArrayBuffer) => void)` and bridges raw bytes directly to JS. iOS: AVAudioEngine tap → Data → JS ArrayBuffer. Android: AudioRecord read → byte[] → JS ArrayBuffer. No base64.

**iOS audio session** (configure in native module or AppDelegate):
- Category: `.playAndRecord` -- simultaneous capture + playback
- Mode: `.voiceChat` -- optimized echo cancellation, noise reduction, mic gain
- Options: `.allowBluetooth`, `.defaultToSpeaker`
- Handle interruptions (phone call): pause capture, resume on end
- Handle route changes (headphones unplugged): switch to speaker

**Android**:
- Request `RECORD_AUDIO` permission at runtime
- Android 14+: must declare `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE"/>` and use foreground service with notification for continuous recording
- AudioSource: `VOICE_COMMUNICATION` (6) for built-in noise reduction

### Task 36: Audio playback
**`/apps/mobile/src/services/audio-playback.ts`**

**Requires custom native module** -- React Native has no built-in raw PCM buffer playback.

**iOS native module** (`PCMAudioPlayer.swift`):
```swift
// Uses AVAudioEngine + AVAudioPlayerNode
// - setupAudioEngine(): attach playerNode to engine, format 16kHz mono 16-bit
// - playPCMBuffer(data: Data): convert bytes to AVAudioPCMBuffer, schedule on playerNode
// - stop(): stop playerNode, clear scheduled buffers -- INSTANT for barge-in
```

**Android native module** (`PCMAudioPlayer.java`):
```java
// Uses AudioTrack in MODE_STREAM
// - initialize(): create AudioTrack at 16kHz mono 16-bit
// - playPCMBuffer(byte[]): write to AudioTrack (WRITE_NON_BLOCKING)
// - stop(): stop + flush AudioTrack -- INSTANT for barge-in
```

**Jitter buffer** (JavaScript layer -- CRITICAL for playback correctness):

1. **Initial buffering:** Accumulate 200-400ms of audio before starting playback (prevents underruns)

2. **Hard cap: `JITTER_BUFFER_CAP_MS` (2000ms):**
   - If buffer grows beyond 2000ms, **drop oldest chunks** (not newest -- avoids discontinuity)
   - Prevents runaway memory growth on slow networks or CPU stalls
   - Log warning when cap is hit (indicates network/performance problem)

3. **Drop policy on barge-in:**
   - On receiving `tts.cleared` from server: flush **entire buffer** instantly
   - Do NOT drain remaining audio (user expects immediate silence)
   - Perceived latency: 0ms (instant stop)

4. **Adaptive buffering (Phase 1.1 -- optional):**
   - Track packet loss rate (gaps in TTS sequence)
   - If loss > 5%: increase min buffer to 400ms
   - If loss < 1%: decrease to 200ms
   - Phase 1.0: use fixed 300ms min buffer

**WS send backpressure (server→client -- prevents memory exhaustion):**

On slow mobile networks, the server may generate TTS audio faster than the client can receive it. Without backpressure handling, `socket.send()` will buffer indefinitely and crash with OOM.

**Solution:**
- Before each `socket.send(ttsBinaryChunk)`, check `socket.bufferedAmount`
- If `bufferedAmount > 64KB` (2 seconds of audio at 32KB/s):
  - **Skip** sending the current TTS chunk (don't queue it)
  - Log warning: `{ session_id, bufferedAmount, action: 'dropped_tts_chunk' }`
  - Client will hear a brief gap (~20-40ms per dropped chunk)
  - Better than unbounded memory growth → crash

**Why 64KB threshold:**
- 2 seconds of buffered audio is already excessive for real-time
- Indicates client is on very slow network (< 256 kbps) or CPU-bound
- Dropping chunks degrades quality but keeps session alive

**Phase 1.1 enhancement:** Send `server.warning` with `network_congestion` flag, client can show UI indicator.

### Task 37: Session screen UI
**`/apps/mobile/src/screens/SessionScreen.tsx`**

States: `connecting | briefing | listening | thinking | speaking | ended`

UI elements:
- **Timer**: large `mm:ss` countdown, updated from `timer.tick`
- **Push-to-talk button**: large circle, press-and-hold to record
  - On press during `speaking` state: send `client.barge_in` first (stops playback), then start capture
  - On release: send `audio.stop`, transition to `thinking`
- **Transcript area**: scrolling text, partials italic, finals normal, coach text distinguished
- **Status indicator**: Listening... / Thinking... / Coach speaking...
- **Warning banner**: appears on `timer.warning`
- **Earcon sounds**: beep on recording start, alert on timer warning, chime on session end

### Task 38: useSession hook
**`/apps/mobile/src/hooks/useSession.ts`**

Coordinates WSClient + AudioCapture + AudioPlayback + UI state. Handles all server events:
- `session.plan` → brief display → transition to briefing
- `tts.start` → transition to speaking, start playback
- `tts.chunk` → enqueue audio buffer
- `tts.end` → transition to idle
- `tts.cleared` → confirm barge-in complete
- `stt.partial` → update live transcript
- `stt.final` → update locked transcript
- `timer.tick` → update countdown
- `timer.warning` → show warning
- `timer.expired` → end session
- `server.error` → error toast
- Cleanup on unmount

### Task 39: Home screen
- Display single drill card (3-minute investor pitch)
- "Start Drill" button
- Request mic permission if needed
- **"Not for use while driving" disclaimer** (legal CYA + safety)
- Brief app description

### Task 39b: Backgrounding behavior (safety UX)
**Problem:** If the app goes to background during a session (user switches apps, takes a call, locks screen), you must NOT continue recording/playing audio. This is both a privacy issue (accidental recording) and a UX issue (timer keeps running but user can't interact).

**Solution:**
**App backgrounded during session:**
- iOS `AppState` change to `background` → pause audio capture, pause playback, send `audio.stop` if recording
- Timer keeps running on server (server-authoritative)
- On return to foreground: show "Session paused -- X seconds remaining" resume prompt
- If timer expired while backgrounded: show "Session ended" screen immediately
- Do NOT auto-resume capture/playback -- require user tap to resume (prevents accidental recording)

---

## Group 7: Testing & Documentation

### Task 40: Backend unit tests
- State machine: all legal transitions pass, illegal throw ERR_SESSION_STATE, ENDED reachable from every state
- Timer: fires expired at 180s (±50ms tolerance), warnings at correct thresholds, continues after mock disconnect, destroy prevents callbacks
- Text chunker: "Hello. World." → ["Hello.", "World."], partial buffering, flush emits remainder
- WS validator: valid events pass, malformed JSON returns error, missing fields fail

### Task 41: Backend integration tests
- Full WS lifecycle: connect → hello → auth → session.start → start_ack
- Barge-in: mock TTS adapter, verify `clear()` called, `tts.cleared` sent, no deadlock on 3x rapid barge-in
- Timer expiry: start with 2s timer, verify `timer.expired` sent, session persisted with status `ended`, WS closed

### Task 42: Schema tests
- Every JSON schema against valid and invalid examples
- Session plan rejects plans with segments exceeding total_time_ms
- Pacing decision rejects unknown enum values

### Task 43: Documentation
**PROTOCOL.md**: Full event catalog with JSON examples for every event type, binary frame format, state machine diagram (Mermaid), error code table, reconnection sequence

**ARCHITECTURE.md**: System diagram (Mermaid), data flow, component responsibilities, Redis key schema, provider adapter interfaces

**RUNBOOK.md**: Local setup steps, env var reference, manual QA checklist:
- Timer stops at exactly 180s
- Barge-in stops audio instantly
- Partials appear while speaking
- Reconnection works within 5s
- Malformed messages don't crash server

---

## Key Files

| File | Role |
|------|------|
| `/packages/shared/src/types/events.ts` | Canonical client-server contract |
| `/apps/backend/src/orchestrator/session.ts` | Central coordinator: state machine + timer + adapters |
| `/apps/backend/src/ws/handler.ts` | WebSocket connection lifecycle |
| `/apps/backend/src/adapters/tts/deepgram.ts` | TTS streaming + barge-in (most latency-sensitive) |
| `/apps/backend/src/adapters/tts/chunker.ts` | LLM token → sentence → TTS pipeline |
| `/apps/backend/src/orchestrator/coach-pipeline.ts` | LLM → chunker → TTS → client audio |
| `/apps/backend/src/adapters/llm/openai.ts` | Streaming + Structured Outputs (separate calls) |
| `/apps/mobile/src/hooks/useSession.ts` | Client-side session orchestration |
| `/apps/mobile/ios/PCMAudioPlayer.swift` | Native PCM playback for iOS |
| `/apps/mobile/android/.../PCMAudioPlayer.java` | Native PCM playback for Android |

## Latency Targets

| Metric | p50 Target | p95 Target |
|--------|-----------|-----------|
| Barge-in to silence (client) | <50ms | <150ms |
| End-of-turn → first TTS byte at client | <900ms | <1800ms |
| STT final transcript after audio.stop | <300ms | <600ms |
| LLM time-to-first-token | <200ms | <500ms |
| TTS first audio byte after Flush | <150ms | <250ms |

## Verification

### Phase 1.0 Acceptance Criteria (all must pass)

1. **Infrastructure:**
   - `docker compose -f infra/docker-compose.yml up` → Postgres + Redis + backend running
   - `GET /healthz` → 200; `GET /readyz` → 200
   - `cd apps/backend && npx vitest` → all tests pass

2. **Basic session flow:**
   - Run mobile on iOS simulator, tap "Start Drill"
   - Full session: coach speaks intro → user push-to-talk pitches → coach responds → timer counts down → hard stop at 180s
   - Session record persisted in `sessions` table with `status='ended'` and correct `actual_duration_ms`

3. **Audio chunking verification (CRITICAL -- measure on first run):**
   - Monitor server logs for incoming audio frame sizes
   - Confirm frames are 640 bytes (20ms) or close (within 10%)
   - If frames are 4096 bytes (256ms), audio chunking is broken → fails acceptance
   - Profile client CPU during audio capture: if base64 decode takes > 10ms per chunk or causes > 5% dropped frames → escalate to native module

4. **Barge-in correctness (CRITICAL -- #1 UX feature):**
   - Press push-to-talk while coach speaking → audio stops within 150ms → recording begins immediately
   - Rapid 3x barge-in (press PTT 3 times in 2 seconds) → no audio leak, no deadlock, no residual coach speech
   - Barge-in during LLM generation (before first TTS byte) → no audio plays at all
   - Server logs show: `controller.abort()` → `textChunker.reset()` → `ttsAdapter.clear()` → `cleared` confirmation → `tts.cleared` sent

5. **Timer enforcement:**
   - Timer reaches 0 exactly at 180s (±200ms tolerance)
   - Session ends with `timer.expired` event
   - Client shows "Time's up" and stops capture/playback
   - WebSocket closed cleanly with code 1000

6. **Auth + rate limiting:**
   - `POST /v1/auth/anonymous` with same `device_id` returns existing user
   - 11th request within 1 minute returns 429 (rate limit exceeded)
   - Expired JWT on WS connect returns `auth.error` and closes connection

7. **Backgrounding safety:**
   - Background app mid-session → audio capture stops, playback stops
   - Return to foreground → shows "Resume session (45s remaining)" prompt
   - Tap resume → capture/playback restart cleanly

8. **Latency targets (log raw timings, verify offline):**
   - p50 end-to-end (audio.stop → tts_first_byte_sent) < 900ms
   - p95 end-to-end < 1800ms
   - p50 barge-in (client.barge_in → audio silence) < 50ms
   - p95 barge-in < 150ms

9. **Manual QA checklist (RUNBOOK.md):**
   - Malformed JSON event → `server.error` with `ERR_BAD_EVENT_SCHEMA`, connection stays open
   - Binary frame before `audio.start` → `server.error` with `ERR_SESSION_STATE`, connection closed
   - Network disconnect during session → timer keeps running server-side
   - Reconnect within 30s → (Phase 1.0: starts new session; Phase 1.1: resumes)

### Known Limitations (acceptable for Phase 1.0)

- No full reconnect with event replay (starts new session on reconnect)
- No `/v1/metrics` endpoint (log raw timings, compute offline)
- No adaptive jitter buffer (fixed 300ms)
- No LLM-driven pacing loop (fixed time warnings at 60s + 15s)
- Base64 audio transport may add 1-2ms decode latency (acceptable if < 10ms)

---

## Appendix A: Deepgram STT/TTS API Research

### STT WebSocket API (`wss://api.deepgram.com/v1/listen`)

**Full Connection URL for coaching:**
```
wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&endpointing=500&utterance_end_ms=800&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&smart_format=true&language=en
```

**Query Parameters Reference:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `model` | `nova-2` | Low-latency, good for real-time |
| `interim_results` | `true` | Send partial transcripts as user speaks |
| `endpointing` | `500` | ms of silence before speech considered ended |
| `utterance_end_ms` | `800` | ms server waits after endpointing before `UtteranceEnd` |
| `encoding` | `linear16` | PCM 16-bit signed little-endian |
| `sample_rate` | `16000` | 16kHz |
| `channels` | `1` | Mono |
| `punctuate` | `true` | Add punctuation |
| `smart_format` | `true` | Format numbers, dates, currency |
| `language` | `en` | English |
| `search` | `["term1","term2"]` | Boost detection of specific keywords |

**Authentication:**
- Header: `Authorization: Token YOUR_API_KEY`
- Alternative: query parameter (less recommended)

**Incoming Message Formats:**

Partial transcript (`interim_results=true`):
```json
{
  "type": "Results",
  "channel": {
    "alternatives": [{
      "confidence": 0.95,
      "transcript": "I think the customer needs"
    }]
  },
  "is_final": false,
  "speech_final": false,
  "duration": 0.85,
  "start": 1.23
}
```

Final transcript:
```json
{
  "type": "Results",
  "channel": {
    "alternatives": [{
      "confidence": 0.98,
      "transcript": "I think the customer needs better pricing.",
      "words": [
        { "word": "I", "start": 1.23, "end": 1.4, "confidence": 0.99 },
        { "word": "think", "start": 1.4, "end": 1.65, "confidence": 0.98 }
      ]
    }]
  },
  "is_final": true,
  "speech_final": true,
  "duration": 2.1,
  "start": 1.23
}
```

UtteranceEnd:
```json
{ "type": "UtteranceEnd", "last_speech_time": 5.82 }
```

Metadata (sent at connection start):
```json
{
  "type": "Metadata",
  "open_time": 1234567890,
  "request_id": "abc-123-def-456",
  "channels": 1,
  "models": ["deepgram/nova-2"],
  "started": true
}
```

Error:
```json
{ "type": "Error", "error": "Invalid audio encoding", "code": 400, "request_id": "abc-123" }
```

**Understanding `speech_final` vs `is_final`:**

| Field | Meaning | Use Case |
|-------|---------|----------|
| `speech_final: true` | End of coherent speech unit (endpointing triggered) | Trigger coach to speak |
| `is_final: true` | Deepgram won't update this transcript (high confidence) | Safe to use for scoring |

**Control Messages We Send:**

| Message | Format | Purpose |
|---------|--------|---------|
| Finalize | `{ "type": "Finalize" }` | Force final transcript (on session end/stop) |
| KeepAlive | `{ "type": "KeepAlive" }` | Keep connection alive (every 30s if no audio) |
| CloseStream | `{ "type": "CloseStream" }` | Graceful close |

**Proper Close Sequence:**
1. Stop sending audio
2. Send `{ "type": "Finalize" }` to get final transcript
3. Wait for final `Results` with `is_final: true`
4. Close WebSocket: `ws.close(1000, "Normal closure")`

**Endpointing Rationale:**
- 500ms: Aggressive but responsive for coaching turn-taking
- 800ms utterance_end: Allows natural speaking rhythm
- User might resume after 500ms pause, so we wait 800ms before sending UtteranceEnd
- Tune later based on user feedback

**Rate Limits (per Deepgram plan):**
- Starter: ~5-10 concurrent connections
- Professional: 50+ concurrent
- Enterprise: unlimited
- Monthly audio minutes quota (e.g., 50,000 min/month on Pro)

**Error Codes & Reconnection:**

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Invalid API key | Check auth, don't retry |
| 403 | Quota exceeded | Wait or upgrade |
| 429 | Rate limited | Exponential backoff (2s, 4s, 8s) |
| 500 | Server error | Retry with exponential backoff |

### TTS WebSocket API (`wss://api.deepgram.com/v1/speak`)

**Full Connection URL:**
```
wss://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=raw
```

**Query Parameters:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `model` | `aura-asteria-en` | Voice model |
| `encoding` | `linear16` | PCM 16-bit |
| `sample_rate` | `16000` | Matches STT input |
| `container` | `raw` | No headers, just PCM bytes |

**Available Aura Voice Models:**

| Model | Gender | Tone | Best For |
|-------|--------|------|----------|
| `aura-asteria-en` | Female | Professional, clear | Coaching (recommended) |
| `aura-luna-en` | Female | Warm, conversational | Friendly coaching |
| `aura-stella-en` | Female | Energetic, engaging | High-energy drilling |
| `aura-athena-en` | Female | Authoritative, confident | Leadership coaching |
| `aura-hera-en` | Female | Warm, supportive | Mentoring |
| `aura-orion-en` | Male | Professional, deep | Executive coaching |
| `aura-arcas-en` | Male | Calm, measured | Analytical coaching |

All Aura models: <150ms to first audio byte.

**Control Messages:**

Speak:
```json
{ "type": "Speak", "text": "Let me give you a hint. Focus on the customer's pain point first." }
```

Flush (triggers TTS generation):
```json
{ "type": "Flush" }
```

Clear (barge-in -- cancel and stop):
```json
{ "type": "Clear" }
```

Close:
```json
{ "type": "Close" }
```

**Response Messages:**

Flush confirmation:
```json
{ "type": "UserActionResult", "action": "Flush", "result": "submitted" }
```

Clear confirmation:
```json
{ "type": "UserActionResult", "action": "Clear", "result": "submitted" }
```

Binary frames: raw PCM audio bytes (linear16, 16kHz)

**Queuing Multiple Speak Before Flush:**
```json
{"type": "Speak", "text": "Here's "}
{"type": "Speak", "text": "my feedback: "}
{"type": "Speak", "text": "strong job."}
{"type": "Flush"}
```
Server concatenates all → "Here's my feedback: strong job." → generates as one unit with proper prosody.

**Text Chunking and Prosody:**
- Full sentences produce MUCH better prosody than fragments
- Sending word-by-word sounds robotic and unnatural
- Best approach: collect LLM tokens → extract complete sentences → send to TTS
- Natural pause points (sentence boundaries) produce the most natural sound

**Latency Characteristics:**

| Scenario | Latency to First Audio Byte |
|----------|-----------------------------|
| Simple ("Yes.") | 50-100ms |
| Full sentence (10-15 words) | 100-150ms |
| Paragraph (50+ words) | 150-250ms |
| Multiple paragraphs | 250-400ms |

**Barge-In via Clear:**
1. Clear is processed ~50-100ms after received by Deepgram
2. Residual audio: 100-300ms may already be in client buffer
3. Client drops jitter buffer instantly → near-zero perceived residual
4. `clear()` returns Promise resolving on `cleared` confirmation (2s timeout fallback)

**Audio Format Math:**
- 16kHz × 16-bit × 1 channel = 32,000 bytes per second of audio
- 20ms chunk = 640 bytes
- 1 second = 50 chunks at 640 bytes each

---

## Appendix B: React Native Audio Research

### Audio Capture Libraries Evaluated

| Library | PCM Streaming | Real-time Chunks | Recommendation |
|---------|--------------|-----------------|----------------|
| `react-native-live-audio-stream` | YES (native) | YES (20ms) | **USE THIS** |
| `react-native-audio-recorder-player` | PARTIAL (file-based) | Via onProgress | Not recommended |
| `expo-av` | NO (high-level) | Limited | Only for Expo managed |
| `@react-native-community/audio-toolkit` | Deprecated | N/A | AVOID |
| `react-native-webrtc` | YES | YES | Heavier, overkill |
| Custom native module | Full control | Full control | Fallback option |

### react-native-live-audio-stream Configuration

```javascript
import LiveAudioStream from 'react-native-live-audio-stream';

LiveAudioStream.init({
  sampleRate: 16000,      // 16kHz - optimal for speech recognition
  channels: 1,            // Mono
  bitsPerSample: 16,      // 16-bit signed PCM
  audioSource: 6,         // Android: VOICE_COMMUNICATION (noise reduction)
  bufferSize: 4096        // ~256ms at 16kHz
});

LiveAudioStream.start();
LiveAudioStream.on('data', (base64: string) => {
  // Library returns base64-encoded PCM -- decode to ArrayBuffer
  const pcm = base64ToArrayBuffer(base64);
  wsClient.sendAudioChunk(pcm);
});
```

**Chunk Timing at 16kHz:**
- 20ms chunk: 320 samples × 2 bytes = 640 bytes (Int16)
- 40ms chunk: 640 samples × 2 bytes = 1280 bytes
- 256ms chunk: 4096 samples × 2 bytes = 8192 bytes (BAD -- library default, must slice)

**CRITICAL: bufferSize vs chunk size mismatch**

The library's `bufferSize` parameter controls the native buffer size, NOT the callback frequency. Common mistake:
- Set `bufferSize: 640` expecting 20ms chunks
- Actually get 40-80ms chunks (library batches multiple buffers)
- OR set `bufferSize: 4096` expecting efficient native buffering
- Get 256ms chunks (destroys turn-taking responsiveness)

**Solution:** Accept that native libraries emit whatever buffer size they want (often 128ms-256ms for efficiency). Add a **JavaScript slicer** that chops large buffers into 640-byte subframes before sending over WebSocket. This adds ~0.5-1ms of CPU overhead but preserves turn-taking latency.

### iOS Audio Session Configuration (Critical)

```swift
import AVFoundation

let session = AVAudioSession.sharedInstance()
try session.setCategory(
    .playAndRecord,             // Simultaneous input/output
    mode: .voiceChat,           // Echo cancellation, noise reduction, mic gain
    options: [
        .duckOthers,            // Lower other audio during recording
        .allowBluetooth,        // Bluetooth headsets
        .allowBluetoothA2DP,    // Wireless headphones
        .defaultToSpeaker       // Speaker if no external device
    ]
)
try session.setActive(true, options: .notifyOthersOnDeactivation)
```

**AVAudioSession Category Matrix:**
- `.playAndRecord`: CORRECT for simultaneous capture + playback
- `.record`: Output blocked
- `.play`: Input blocked
- `.default`: Not optimized for voice

**Mode `.voiceChat`:** Optimizes microphone gain, enables echo cancellation, enables noise reduction. REQUIRED for voice coaching.

**Route Change Handling (headphones plugged/unplugged):**
```swift
NotificationCenter.default.addObserver(
    forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
) { notification in
    if let reason = notification.userInfo?[AVAudioSession.routeChangeReasonKey] as? UInt {
        switch AVAudioSession.RouteChangeReason(rawValue: reason) {
        case .oldDeviceUnavailable:
            try? session.overrideOutputAudioPort(.speaker)
        default: break
        }
    }
}
```

**Interruption Handling (phone call, Siri):**
```swift
NotificationCenter.default.addObserver(
    forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
) { notification in
    guard let type = notification.userInfo?[AVAudioSession.interruptionTypeKey] as? UInt else { return }
    switch AVAudioSession.InterruptionType(rawValue: type) {
    case .began:
        LiveAudioStream.stop()       // Pause capture
    case .ended:
        if options.contains(.shouldResume) { LiveAudioStream.start() }
    default: break
    }
}
```

### Android Audio Configuration

**Permissions (AndroidManifest.xml):**
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.READ_PHONE_STATE" />
<!-- Android 14+ -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />

<service android:name=".AudioCaptureService" android:foregroundServiceType="microphone" />
```

**Runtime Permission (React Native):**
```javascript
import { PermissionsAndroid } from 'react-native';

const granted = await PermissionsAndroid.request(
  PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  { title: 'Voice Coaching App', message: 'Microphone needed for voice coaching', buttonPositive: 'Accept' }
);
```

**Android AudioRecord (native module):**
```java
int sampleRate = 16000;
int channelConfig = AudioFormat.CHANNEL_IN_MONO;
int audioFormat = AudioFormat.ENCODING_PCM_16BIT;
int bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat);

AudioRecord recorder = new AudioRecord(
    MediaRecorder.AudioSource.VOICE_COMMUNICATION,  // Built-in noise reduction
    sampleRate, channelConfig, audioFormat, bufferSize
);
recorder.startRecording();
byte[] audioBuffer = new byte[640];  // 20ms at 16kHz mono 16-bit
int readSize = recorder.read(audioBuffer, 0, 640);
```

**Foreground Service (Android 14+ required for continuous recording):**
```java
public class AudioCaptureService extends Service {
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        startAudioCapture();
        return START_STICKY;
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Voice Coaching")
            .setContentText("Recording in progress...")
            .setSmallIcon(R.drawable.ic_microphone)
            .build();
    }
}
```

### Audio Playback -- Custom Native Modules Required

React Native has NO built-in raw PCM buffer playback. Workarounds (encoding to WAV/MP3) add unacceptable latency.

**iOS: AVAudioEngine + AVAudioPlayerNode**
```swift
class PCMAudioPlayer {
    let engine = AVAudioEngine()
    let playerNode = AVAudioPlayerNode()
    var audioFormat: AVAudioFormat?

    func setupAudioEngine() throws {
        audioFormat = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: audioFormat)
        try engine.start()
        playerNode.play()
    }

    func playPCMBuffer(_ pcmData: Data) {
        guard let audioFormat = audioFormat else { return }
        let frameLength = AVAudioFrameCount(pcmData.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: audioFormat, frameCapacity: frameLength) else { return }
        buffer.frameLength = frameLength
        pcmData.withUnsafeBytes { bytes in
            memcpy(buffer.int16ChannelData![0], bytes.bindMemory(to: Int16.self).baseAddress, pcmData.count)
        }
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
    }

    func stop() {
        playerNode.stop()      // INSTANT -- clears scheduled buffers
        engine.stop()
    }
}
```

**Android: AudioTrack in MODE_STREAM**
```java
public class PCMAudioPlayer {
    private AudioTrack audioTrack;

    public void initialize() {
        int bufferSize = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        audioTrack = new AudioTrack(
            AudioManager.STREAM_VOICE_CALL, 16000,
            AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
            bufferSize, AudioTrack.MODE_STREAM
        );
        audioTrack.play();
    }

    public void playPCMBuffer(byte[] pcmData) {
        audioTrack.write(pcmData, 0, pcmData.length, AudioTrack.WRITE_NON_BLOCKING);
    }

    public void stop() {
        audioTrack.stop();     // INSTANT -- stops + flushes
        audioTrack.release();
    }
}
```

### Jitter Buffer Implementation

```javascript
class JitterBuffer {
  constructor(minBufferMs = 200, maxBufferMs = 400) {
    this.minBufferMs = minBufferMs;
    this.maxBufferMs = maxBufferMs;
    this.buffer = [];
  }

  addPacket(pcmData, sequenceNumber, timestamp) {
    this.buffer.push({ data: pcmData, seq: sequenceNumber, time: timestamp });
    this.buffer.sort((a, b) => a.time - b.time);
    this.trimBuffer();
  }

  getNextChunk(targetTime) {
    const bufferSizeMs = this.buffer.length > 0
      ? (this.buffer[this.buffer.length - 1].time - this.buffer[0].time) : 0;
    if (bufferSizeMs < this.minBufferMs) return null;  // Wait for more data
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].time <= targetTime) return this.buffer.splice(i, 1)[0]?.data;
    }
    return null;
  }

  flush() { this.buffer = []; }  // INSTANT for barge-in
}
```

**Adaptive buffering:** Increase `minBufferMs` to 400 on >5% packet loss. Decrease to 200 on <1% loss.

### WebSocket Binary Frame Support in React Native

React Native's built-in WebSocket DOES support binary frames:
```javascript
const ws = new WebSocket('ws://localhost:3000/v1/ws');
ws.binaryType = 'arraybuffer';  // CRITICAL

ws.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    // Binary TTS audio
    const pcm = new Uint8Array(event.data);
    jitterBuffer.addPacket(pcm, seq++, Date.now());
  } else {
    // JSON control message
    const msg = JSON.parse(event.data);
  }
};

// Send audio as binary
ws.send(pcmArrayBuffer);
```

**Performance at 50 msgs/sec (20ms chunks):**
- 640 bytes per message
- 32 KB/s upload + 32 KB/s download = 64 KB/s total
- WebSocket overhead: ~14 bytes/frame = 0.7 KB/s
- Processing overhead: ~2-4ms per message (negligible)
- Well within mobile network capability (1-10 Mbps on 4G/5G)

### Common Pitfalls & Solutions

| Problem | Cause | Solution |
|---------|-------|---------|
| Audio plays while mic captures | Wrong AVAudioSession category | Use `.playAndRecord` + `.voiceChat` |
| Echo during playback | No echo cancellation | iOS: voiceChat handles it |
| Choppy playback | Jitter buffer underflow | Increase minBufferMs to 300-400 |
| High battery drain | Continuous recording | Use push-to-talk |
| Permission denied crashes | Missing foreground service (Android 14+) | Wrap in startForegroundService() |
| Loss of audio on call | Interruption not handled | AVAudioSession interruption observer |
| Audio stutters on network | Missing jitter buffer | 200-400ms buffer with reordering |

---

## Appendix C: OpenAI + Fastify + Backend Research

### OpenAI Structured Outputs

**API Specification:**
```typescript
response_format: {
  type: "json_schema",
  json_schema: {
    name: "SessionPlan",
    schema: {
      type: "object",
      properties: { /* ... */ },
      required: ["all", "properties", "listed"],
      additionalProperties: false   // MANDATORY for strict: true
    },
    strict: true
  }
}
```

**Schema Restrictions (strict: true):**
- `additionalProperties: false` required on ALL objects
- ALL properties must appear in `required` array
- No `if/then/else`
- No regex patterns or complex validations
- Enums work well for constrained outputs
- Nested objects must also have `additionalProperties: false`

**Critical Finding: Structured Outputs + Streaming Incompatibility:**
- Structured Outputs do NOT work with `stream: true`
- You receive the complete JSON in one response, not partial tokens
- Architecture MUST split into two patterns:

1. **Coach speech (streaming, no Structured Outputs):**
```typescript
const controller = new AbortController();
const stream = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  stream: true,
  messages: [...],
  max_tokens: 150,
  temperature: 0.7,
  signal: controller.signal  // for barge-in abort
});

for await (const chunk of stream) {
  const token = chunk.choices[0]?.delta?.content;
  if (token) textChunker.addToken(token);
}
textChunker.flush();
```

2. **Plan/pacing (Structured Outputs, no streaming):**
```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'SessionPlan', schema: SESSION_PLAN_SCHEMA, strict: true }
  },
  messages: [...]
});
const plan: SessionPlan = JSON.parse(response.choices[0].message.content!);
```

**Stream Event Structure:**
```javascript
// First chunk
{ choices: [{ delta: { role: "assistant", content: "" } }] }
// Middle chunks
{ choices: [{ delta: { content: "This is" }, finish_reason: null }] }
// Last chunk
{ choices: [{ delta: { content: "." }, finish_reason: "stop" }] }
```

**Barge-In via AbortController:**
```typescript
controller.abort();  // Immediately stops OpenAI stream
// Catch AbortError in the streaming loop
```

**Models Supporting Structured Outputs:**
- `gpt-4o` (most capable, higher cost)
- `gpt-4o-mini` (fast, cheap -- ideal for real-time)
- NOT available on gpt-3.5-turbo

**Pricing per 3-minute coaching session (~6 turns × ~300 tokens each):**
- gpt-4o-mini: ~$0.001 per session
- gpt-4o: ~$0.02 per session

**Error Handling:**
- If model can't generate valid JSON: `finish_reason: "error"`
- Retry up to 2 times with exponential backoff
- Fall back to `PITCH_3MIN_DEFAULT_PLAN` if plan generation fails

**OpenAI SDK Configuration:**
```typescript
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
  maxRetries: 2
});
```

### Fastify WebSocket Server

**@fastify/websocket Registration:**
```typescript
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

const app = Fastify({ logger: { level: 'info' } });
await app.register(fastifyWebsocket);

app.get('/v1/ws', { websocket: true }, (socket, req) => {
  // socket IS the ws.WebSocket object directly
  socket.on('message', (data: Buffer | string) => {
    if (typeof data === 'string') {
      // JSON control message
      const msg = JSON.parse(data);
    } else {
      // Binary audio frame
      orchestrator.handleAudioChunk(data);
    }
  });
  socket.on('close', () => { /* cleanup */ });
  socket.on('error', (err) => { /* log, don't crash */ });
});
```

**Socket object is ws.WebSocket -- direct access to:**
- `socket.send(data)` -- text or binary
- `socket.close(1000, "reason")`
- `socket.ping()` -- keep-alive
- `socket.terminate()` -- force close
- `socket.readyState` -- OPEN/CLOSED/etc.

**Typed WebSocket Route:**
```typescript
interface WSQuery { session_id: string }
app.get<{ Querystring: WSQuery }>('/v1/ws', { websocket: true }, (socket, req) => {
  const sessionId = req.query.session_id;  // typed!
});
```

**Per-Connection Session Map:**
```typescript
const sessionMap = new Map<string, SessionOrchestrator>();

app.get('/v1/ws', { websocket: true }, (socket, req) => {
  const connId = uuid();
  const orchestrator = new SessionOrchestrator(/* ... */);
  sessionMap.set(connId, orchestrator);

  socket.on('close', () => {
    orchestrator.cleanup();
    sessionMap.delete(connId);
  });
});
```

**Backpressure Handling:**
```typescript
// Check socket readiness before writing
if (socket.readyState === WebSocket.OPEN) {
  socket.send(response);
}
// Monitor drain events for buffer-full scenarios
socket.on('drain', () => { /* resume sending */ });
```

**Concurrent Connection Capacity:**
- Single Node.js process: ~50,000-100,000 concurrent connections
- Limited by file descriptors (`ulimit -n`)
- Memory: ~1MB per connection (depends on buffering)
- For production: nginx/HAProxy as WebSocket proxy → multiple Node.js processes

### ioredis Session State Management

**Connection with auto-reconnect:**
```typescript
import Redis from 'ioredis';
const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => !err.message.includes('READONLY')
});
```

**Session State with TTL:**
```typescript
// Store with 15-minute TTL
async function saveSession(sessionId: string, state: LiveSessionState) {
  await redis.setex(`session:${sessionId}`, 900, JSON.stringify(state));
}

// Retrieve and refresh TTL atomically
async function getSession(sessionId: string): Promise<LiveSessionState | null> {
  const json = await redis.getex(`session:${sessionId}`, 'EX', 900);
  return json ? JSON.parse(json) : null;
}
```

**Pub/Sub for future multi-instance coordination:**
```typescript
const publisher = new Redis();
const subscriber = new Redis();
await subscriber.subscribe('session:*');
subscriber.on('message', (channel, message) => { /* handle */ });
```

### node-postgres (pg) Patterns

**Connection Pool:**
```typescript
import { Pool } from 'pg';
const pool = new Pool({
  connectionString: config.POSTGRES_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  application_name: 'coach-backend'
});
```

**Batch Insert for Event Logging:**
```typescript
async function batchInsertEvents(sessionId: string, events: Array<{ type: string; ts_ms: number; payload: any }>) {
  const values = events.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`).join(',');
  const params: any[] = [];
  events.forEach(e => params.push(sessionId, e.ts_ms, e.type, JSON.stringify(e.payload)));
  await pool.query(
    `INSERT INTO session_events (session_id, ts_ms, type, payload) VALUES ${values}`,
    params
  );
}
```

**Transaction Pattern:**
```typescript
async function transactional<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

**Pool Health Monitoring:**
```typescript
setInterval(() => {
  console.log(`Pool: ${pool.totalCount - pool.idleCount}/${pool.totalCount} in use`);
  if (pool.totalCount - pool.idleCount === pool.totalCount) console.warn('Pool exhausted!');
}, 10000);
```

**Graceful Shutdown:**
```typescript
async function shutdown() {
  await pool.end();
  await redis.quit();
  console.log('Connections closed');
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```
