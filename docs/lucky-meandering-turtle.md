# Phase 1 Detailed Build Plan: Voice-First Time-Boxed AI Coaching App

## Context

Building a B2C voice-first coaching app: "I have 3 minutes -- drill me on my investor pitch." Phase 1 proves the real-time audio pipeline works with hard timer enforcement, barge-in, and streaming STT/TTS. Enterprise features come later.

**Confirmed decisions:** React Native, Deepgram STT+TTS, OpenAI (Structured Outputs), 3-minute investor pitch drill, server-authoritative timer.

### Phase 1.0 vs 1.1 Scope Split

**Phase 1.0 (ship now -- proves the product):**
- Full voice loop: STT → LLM → TTS → client playback
- Server-authoritative hard timer (180s)
- Barge-in cancel (full pipeline: OpenAI stream + chunker + TTS + client buffer)
- Push-to-talk with live transcripts
- Session persistence (start/end, transcripts, errors)
- Anonymous auth with device binding

**Phase 1.1 (polish next -- not blocking the demo):**
- Redis resume token + full reconnect with `last_server_event_id` replay
- `/v1/metrics` percentile computation (Phase 1.0 logs raw timings only)
- Pacing loop (LLM-driven interrupts every 5s)
- Adaptive jitter buffer sizing

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
  - `fastify`, `@fastify/websocket`, `@fastify/cors` (NO separate `ws` dep -- `@fastify/websocket` exposes `ws.WebSocket` directly)
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
1. **Direction distinguishes type:** Client→Server binary = user audio. Server→Client binary = TTS audio. No ambiguity.
2. **Binary before `audio.start` is an error:** Server MUST reject binary frames received before a valid `audio.start` event. Send `server.error` with `ERR_SESSION_STATE`.
3. **Sequence numbers are implicit:** Frames arrive in WebSocket order (TCP guarantees). `last_client_audio_seq` / `last_server_tts_seq` in Redis are monotonic counters incremented per frame, used for resumption bookkeeping only (Phase 1.1).
4. **Max frame size:** 640 bytes (20ms at 16kHz mono 16-bit). Server logs warning if frame > 1280 bytes (>40ms), drops if > 8192 bytes.
5. **No interleaving:** Client must not send binary and JSON in the same WebSocket message. One frame = one type.

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
export const DEEPGRAM_STT_MODEL = 'nova-2';
export const DEEPGRAM_STT_ENDPOINTING_MS = 500;
export const DEEPGRAM_STT_UTTERANCE_END_MS = 800;  // NOT 1000. Standardized.
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

**Persistence crash strategy:**
- **Must-persist events (write immediately, not batched):** `session.start`, `session.end`, `server.error` with severity >= ERROR. These use individual `INSERT` statements, not the batch buffer.
- **Batch event insert failure:** If batch `INSERT` fails, retry once after 200ms. If retry fails, log to pino (structured JSON) and continue session -- do NOT block the voice loop for DB writes. Events are lost but session continues.
- **Session end persistence:** On `timer.expired` or `server.goodbye`, flush the event batch buffer synchronously before closing the WS. Use a 2-second timeout -- if flush times out, close anyway and log the lost events.

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

**Auth hardening (Phase 1.0):**
- **Rate limit `/v1/auth/anonymous`:** max 10 requests per minute per IP (use Fastify `@fastify/rate-limit` or simple in-memory counter). Prevents token-farming.
- **Device binding on resume:** JWT contains `device_id` claim. On WS `client.resume`, verify `device_id` from JWT matches the original session's `device_id` in Redis. Reject mismatches with `ERR_UNAUTHORIZED`.
- **Token expiry:** 24h. No refresh flow in Phase 1.0 -- user gets a new anonymous token on next app open.

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
```typescript
const url = `wss://api.deepgram.com/v1/listen?model=${DEEPGRAM_STT_MODEL}`
  + `&interim_results=true`
  + `&endpointing=${DEEPGRAM_STT_ENDPOINTING_MS}`
  + `&utterance_end_ms=${DEEPGRAM_STT_UTTERANCE_END_MS}`
  + `&encoding=${AUDIO_CODEC}&sample_rate=${AUDIO_SAMPLE_RATE}&channels=${AUDIO_CHANNELS}`
  + `&punctuate=true&smart_format=true`;
```

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

**Cancellation (FULL pipeline -- missing ANY step makes coach "keep talking"):**
If `handleBargeIn()` called mid-pipeline, ALL of these must fire:
1. `controller.abort()` → stops OpenAI stream immediately (catch `AbortError`)
2. `textChunker.reset()` → drop all buffered tokens and queued sentences
3. `ttsAdapter.clear()` → sends `{ type: "Clear" }` to Deepgram, returns Promise
4. Wait for `cleared` confirmation (with 2s timeout fallback)
5. Send `tts.cleared` to client WS
6. Client drops jitter buffer instantly on receiving `tts.cleared`

**If any step is skipped:** The coach will resume speaking ~500ms-2s later. This is the #1 UX-breaking bug to test for.

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
```typescript
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

**IMPORTANT: bufferSize vs chunk size mismatch fix.**
The library's `bufferSize` controls the native buffer, NOT the JS callback frequency. `bufferSize: 4096` emits ~256ms chunks (4096 bytes). We need 20ms chunks (640 bytes) for responsive turn-taking. Solution: accept larger native buffers, then **slice in JS** before sending over WebSocket.

```typescript
import LiveAudioStream from 'react-native-live-audio-stream';
import { AUDIO_CHUNK_BYTES } from '@coach/shared';

LiveAudioStream.init({
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6,  // Android: VOICE_COMMUNICATION (noise reduction)
  bufferSize: 4096  // Native buffer. JS slicer handles 640-byte subframes below.
});

LiveAudioStream.start();
LiveAudioStream.on('data', (base64: string) => {
  // PERFORMANCE NOTE: base64 decode adds CPU + GC pressure on mobile.
  // Measure dropped frames early. If problematic, write a native module
  // that emits raw ArrayBuffer directly (no base64 round-trip).
  const pcmBytes = base64ToArrayBuffer(base64);

  // Slice into 640-byte (20ms) subframes before sending
  for (let offset = 0; offset < pcmBytes.byteLength; offset += AUDIO_CHUNK_BYTES) {
    const chunk = pcmBytes.slice(offset, Math.min(offset + AUDIO_CHUNK_BYTES, pcmBytes.byteLength));
    wsClient.sendBinary(chunk);  // Send as binary frame, NOT JSON
  }
});
```

**Base64 transport risk:** The library emits base64 strings. Decoding adds ~1-2ms per chunk plus GC pressure. For Phase 1.0 this is acceptable for the demo. If CPU profiling shows >5% dropped frames, escalate to a custom native module that bridges raw `ArrayBuffer` directly (no base64 encoding at the native layer).

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

**Jitter buffer** (JavaScript layer):
- Buffer 200-400ms of audio before starting playback
- On barge-in: `stopPlayback()` drops entire buffer instantly (0ms perceived)
- **Hard cap: `JITTER_BUFFER_CAP_MS` (2000ms).** If buffer grows beyond cap, drop oldest chunks. Prevents runaway memory on slow networks.
- **Drop policy on barge-in:** flush entire buffer immediately, do NOT drain remaining audio.

**WS send backpressure (server→client):** If `socket.bufferedAmount` exceeds 64KB, skip sending current TTS chunk (log warning). Client hears a brief gap but won't accumulate unbounded memory.

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
- "Not for use while driving" disclaimer
- Brief app description

### Task 39b: Backgrounding behavior (safety UX)
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

1. `docker compose -f infra/docker-compose.yml up` → Postgres + Redis + backend running
2. `GET /healthz` → 200; `GET /readyz` → 200
3. Run mobile on iOS simulator, tap "Start Drill"
4. Full session: coach speaks intro → user push-to-talk pitches → coach responds → timer counts down → hard stop at 180s
5. Barge-in: press push-to-talk while coach speaking → audio stops instantly → recording begins
6. `GET /v1/metrics` → p50/p95 latency data present
7. `cd apps/backend && npx vitest` → all tests pass
8. Manual QA per RUNBOOK.md checklist

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
- 20ms chunk: 320 samples = 640 bytes (as Int16)
- 40ms chunk: 640 samples = 1280 bytes
- This matches WebSocket performance sweet spot

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
