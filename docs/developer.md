You are Claude Code acting as the lead engineer for Phase 1.0 of a voice-first, time-boxed coaching app MVP.

Goal: ship a working local demo proving the realtime voice loop:
Mobile (push-to-talk) → streaming PCM to backend WS → Deepgram STT (partial+final) → OpenAI coaching (streaming tokens) → sentence chunker → Deepgram TTS streaming PCM → mobile jitter buffer playback.
Hard requirements: 
- server-authoritative hard timer (180s) with hard stop
- barge-in that truly stops the coach within 150ms
- audio chunking: 20ms frames (640 bytes at 16kHz mono 16-bit) even if capture library emits larger buffers
- ultra low latency turn-taking
- minimal persistence + auth hardening (anonymous JWT + device binding + rate limiting)

DO NOT invent scope beyond Phase 1.0.
Implement exactly the repo layout and core decisions:
- /apps/mobile: React Native bare workflow
- /apps/backend: Node+TS Fastify + @fastify/websocket (NO separate ws dependency)
- /packages/shared: types + JSON schemas + Ajv validators + constants
- /infra: docker-compose (postgres+redis)
- /docs: PROTOCOL.md ARCHITECTURE.md RUNBOOK.md
(If any conflict arises, follow this Phase 1 plan.)

Absolute non-negotiables:
1) Barge-in cancellation MUST execute ALL SIX steps in order (no exceptions):
   (1) abort OpenAI stream, (2) reset text chunker, (3) clear TTS adapter, (4) wait for cleared confirm (2s timeout), (5) send tts.cleared event, (6) client instantly flushes jitter buffer.
   Missing any step = FAIL. 
2) Audio frames: target 640 bytes. Server rejects huge frames. Client slices 4096-byte chunks into 640-byte subframes if needed. 
3) Backpressure: server must drop TTS chunks if socket.bufferedAmount > 64KB.
4) Backgrounding safety: app pauses capture/playback when backgrounded and requires user tap to resume.
5) Canonical constants: ALL Deepgram STT/TTS params must come from /packages/shared/src/constants.ts (no hardcoding).

Implementation approach:
- Work in small vertical slices that compile and run.
- Every slice ends with: typecheck + tests + lint + run a minimal smoke flow.
- You must keep the project runnable at all times.

================================================================================
WORKFLOW LOOP (MANDATORY)
================================================================================
You MUST use this iterative loop until Phase 1.0 acceptance criteria pass:

LOOP:
A) Plan the next smallest increment (1-3 files max) that moves us toward a running demo.
B) Implement that increment.
C) Run verification commands (exact commands below).
D) If anything fails, do NOT proceed. Fix until green.
E) Summarize what changed + what remains.
Repeat.

Verification commands to run after every increment (and include output summaries):
Backend:
- cd apps/backend
- npm test (vitest)
- npm run typecheck
- npm run lint
- npm run dev (or npm start) smoke: server boots, /healthz returns 200

Shared:
- cd packages/shared
- npm test
- npm run typecheck
- npm run lint

Mobile (as feasible in this environment):
- cd apps/mobile
- npm run typecheck (tsc) and lint
- ensure WS client compiles and binaryType is set to arraybuffer
(If you cannot run the simulator here, still ensure builds are correct and add a manual run section in RUNBOOK.md.)

If tests do not exist yet, create them before claiming completion.

================================================================================
PHASE 1.0 ACCEPTANCE CRITERIA (MUST PASS)
================================================================================
- docker compose up runs postgres+redis+backend
- GET /healthz and /readyz return 200
- WS lifecycle works: hello → auth → session.start → plan → timer ticks
- Push-to-talk audio: client sends binary frames only after audio.start
- Server logs confirm incoming audio frames are ~640 bytes (or sliced)
- Full voice loop: STT partial/final → coach responds → TTS audio arrives and plays
- Hard stop at 180s (timer.expired sent, session ended, WS closes cleanly)
- Barge-in works in 3 scenarios:
  1) during LLM generation (before first TTS byte) = no audio plays
  2) during TTS playback = stops within 150ms
  3) rapid 3x barge-in in 2 seconds = no audio leak, no deadlock
- Rate limit works for /v1/auth/anonymous (11th req/min per IP returns 429)
- Backgrounding stops capture/playback and requires tap to resume

================================================================================
BUILD ORDER (DO THIS EXACTLY)
================================================================================

Milestone 0: Repo + infra skeleton (green builds)
1) Create monorepo workspaces, tsconfig base, eslint/prettier configs.
2) Create packages/shared with constants.ts, types, Ajv validators + minimal tests.
3) Create infra/docker-compose.yml + postgres init.sql + redis, backend container.
4) Backend Fastify server with /healthz /readyz and typed config loader.
Verification: all unit tests pass, docker compose up works, /healthz ok.

Milestone 1: WS protocol + validation (no audio yet)
1) Shared: event union types + JSON schemas for core events (client.hello, auth.anonymous, session.start, audio.start/stop, client.barge_in, server.*).
2) Backend: /v1/ws handler using @fastify/websocket, Ajv validation, state guarding (binary before audio.start = error + close).
3) Add docs/PROTOCOL.md with event catalog + binary rules.
Verification: connect with a simple WS script, exchange hello/auth/session.start, timer ticks.

Milestone 2: Auth + persistence baseline
1) Backend: POST /v1/auth/anonymous with rate-limit and device binding in JWT.
2) Postgres queries: users, sessions, transcripts, events.
3) Session persistence strategy: must-persist vs best-effort batch as described.
Verification: create token, start session, record in DB.

Milestone 3: Deepgram STT wired (partial + final)
1) Backend: DeepgramSTTAdapter (constants-only config).
2) SessionOrchestrator: accept audio.start + binary audio chunks → send to STT; emit stt.partial/stt.final to client.
Verification: push PCM frames via WS test client, see partial and final transcripts.

Milestone 4: OpenAI + TTS streaming (coach can speak)
1) Backend: OpenAI adapter:
   - plan generation: structured outputs, non-streaming
   - coach turn: streaming tokens
2) Backend: TextChunker and DeepgramTTSAdapter (Speak/Flush/Clear).
3) Orchestrator pipeline: final transcript triggers coach response, stream → chunker → TTS → WS binary frames.
Verification: client receives tts.start/tts.chunk/tts.end and can save PCM bytes.

Milestone 5: Barge-in correctness (this is the killer feature)
1) Implement ALL SIX cancellation steps with tests.
2) Add client event client.barge_in; server responds tts.cleared; client flushes jitter buffer instantly.
3) Add a torture test: rapid 3x barge-in while speaking.
Verification: passes all barge-in tests and manual QA.

Milestone 6: React Native client (push-to-talk + playback)
1) WSClient with binaryType=arraybuffer and event router.
2) Audio capture via react-native-live-audio-stream:
   - decode base64
   - slice into 640-byte subframes
3) Native PCM player modules (iOS AVAudioEngine, Android AudioTrack) + JS jitter buffer w/ 2000ms cap.
4) Session screen with timer, PTT button, transcript view.
Verification: manual run on device/simulator completes full 180s drill.

================================================================================
CODE QUALITY RULES
================================================================================
- TypeScript strict everywhere.
- No “TODO: later” for core constraints (timer, barge-in, chunking, backpressure).
- No duplicated constants. Import from shared.
- Every server event must have a schema + validator.
- Provide unit tests for: state machine, timer, chunker, barge-in, schema validation.
- If something is uncertain, STOP and ask a single precise question, but only when truly blocked.

================================================================================
WHAT I NEED FROM YOU AS YOU WORK
================================================================================
At the start of each loop iteration, output:
1) “Next increment: …”
2) Files you will touch (max 3)
3) Commands you will run to verify

At the end of each iteration, output:
1) What changed
2) Test results summary
3) Next step

If any command fails (non-zero exit code), you must stop immediately and fix it before writing any new features.

You may modify at most 3 files per increment. If more are needed, split into another increment.