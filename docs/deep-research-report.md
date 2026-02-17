# MVP Roadmap for a B2C Voice-First, Time-Boxed Coaching App

## Product reframing for B2C while keeping the enterprise endgame intact

Your two docs describe a B2B-first product: a voice-first, off-screen coaching assistant that runs structured practice reps under a strict timer, grounded in playbooks and context, and outputs measurable scorecards and next drills. fileciteturn0file0 fileciteturn0file1

The B2C version should keep the exact same “moat mechanics” from the enterprise vision, but swap the inputs and buyer story:

- Enterprise input sources: company playbooks, policy docs, role history, CRM/task context. fileciteturn0file0  
- B2C input sources: user uploads (resume, job description, class notes, scripts), user profile goals, and “session intent” (what they want to practice right now). This preserves the grounding-first approach, just with consumer-owned context instead of employer-owned context. fileciteturn0file0

What must not change (because it is the real differentiator, and both docs emphasize it):

- The app is a **real-time systems product**, not “voice chat with an LLM”. Latency, turn-taking, noisy audio, and reliable time enforcement are the product. fileciteturn0file0  
- The “session plan” and pacing logic are the moat: plan end-to-end (goal → rubric → timed reps → feedback → next drill), then actively manage pacing so the rep finishes inside the time contract. fileciteturn0file1  
- Grounding and traceability are how you avoid garbage coaching: retrieval plus structured scoring outputs, plus guardrails that prevent invented “facts” about the user’s provided materials. fileciteturn0file0

B2C wedge that cleanly maps to your feature list and to eventual enterprise:

- “I have 6 minutes. Drill me on this interview / case / pitch / difficult conversation. Use my uploaded context. Cut me off if I ramble. Keep me on pace. Give me a ruthless scorecard and the next drill.” This mirrors the “walking/commuting” voice UX patterns in TechStacks, especially the explicit time contract and short repairable turns. fileciteturn0file0  

A blunt warning that matters for build planning: **hands-free always-on hotword is not a sane MVP goal** on mobile because OS microphone constraints and background execution constraints will create reliability and review/policy risk. Start push-to-talk and foreground sessions, then revisit wake word only after retention justifies it. fileciteturn0file0  

## MVP scope that satisfies the “non-negotiables” you listed

This MVP is not “a feature list.” It is one tight loop: **launch → plan → run rep (with interruptions) → score → next drill**.

### Core B2C user journeys

Journey A: timed rep while walking
1. User taps “Start a timed rep”.
2. User sets time budget (e.g., 10 minutes).
3. User chooses a rep type (Interview, Consulting case, Sales roleplay, Hard conversation).
4. User optionally attaches context (upload file OR paste prompt context).
5. App generates a structured session plan before the rep begins.
6. App runs the rep with dynamic pacing, time warnings, and cutoffs.
7. App ends with a compact scorecard and one next drill recommendation.

This is explicitly aligned with the “explicit time contract” and “one-shot summary” voice UX guidance in TechStacks. fileciteturn0file0

Journey B: context-first setup
1. User imports resume + job description (or class notes, script, deck notes).
2. App builds a “context pack” with retrieval-ready chunks and a lightweight profile.
3. User starts timed reps that automatically use the latest context pack.

This mirrors the enterprise ingestion pattern (raw docs + retrieval index) but with user-owned documents rather than tenant-owned playbooks. fileciteturn0file0

### MVP features mapped to your explicit requirements

Time control (hard constraint)
- Session timer is a first-class system variable and actively shapes prompts, difficulty, and when the app cuts the user off. This is explicitly called out as “a pacing algorithm input, not a UI decoration.” fileciteturn0file0

Context injection
- The MVP must support both:
  - File upload (PDF/text/doc) to build a retrieval index.
  - “Paste context” as plain text notes.
- Retrieval is used both for generating drills and for scoring against the user’s intended “ground truth.” fileciteturn0file0

Cutting the user off + time warnings
- The audio stack must support interruption (barge-in) patterns and short prompts with explicit “your turn” mechanics. fileciteturn0file0
- The rep can be paused/extended by voice command (“add 2 minutes”).

Structured session plan before rep
- Generate a plan that includes: objective, rubric, rep steps, expected time budget per step, and “what to tighten if we run behind.”
- This matches the “session plan orchestration” description in the market research doc. fileciteturn0file1

Dynamic shifting
- If the user struggles: switch to hints, scaffolding, smaller prompts, redo loops.
- If the user is strong: shorten feedback, increase difficulty, add a second objection or a harder follow-up.
- If time is threatened: compress the drill, skip optional steps, force concise responses, and prioritize completing the highest-signal rubric items.

Ultra-low latency
- Use on-device VAD, streaming STT partials, streaming TTS, and short turn design. fileciteturn0file0
- Design for two modes: cloud best quality, and degraded low-connectivity mode with cached drills and delayed scoring sync. fileciteturn0file0

Multiple LLMs for processing + speech output
- Separate “realtime dialogue” from “planning and scoring.”
- Modular architecture (STT + text LLM + TTS) is explicitly described as viable and often cheaper/more controllable; integrated speech-to-speech is viable for lower latency but may be more expensive. fileciteturn0file0

## Reference architecture that Claude Code can implement end-to-end

This section is written so a coding agent can directly convert it into repos, services, and APIs.

### High-level system components

Mobile app
- Push-to-talk input + barge-in capable playback.
- On-device VAD to segment speech and reduce bandwidth.
- Realtime transport over WebSocket for MVP simplicity (upgrade path to WebRTC later). fileciteturn0file0
- A minimal screen UI is fine, but the audio session management is the real work. TechStacks is explicit that low-latency audio reliability is the deciding factor in choosing native vs cross-platform. fileciteturn0file0

Backend services (MVP)
- Session Gateway
  - Auth, rate limits, WebSocket audio/transcript channel termination.
  - Emits structured events: `audio_chunk`, `partial_transcript`, `final_transcript`, `coach_audio`, `coach_event`.
- Realtime Orchestrator
  - Conversation state machine.
  - Timer enforcement and pacing.
  - Tool calls to Retrieval + Scoring.
- Speech Adapters
  - Streaming STT adapter.
  - Streaming TTS adapter.
  - Provider routing and fallback.
- Retrieval Service
  - Document chunking + embeddings + vector search.
  - Returns “context packs” with citations/metadata for traceability.
- Scoring Service
  - Produces per-turn and post-session rubric scoring.
  - Updates a simple user skill model and queues next drills.

This decomposition matches the “clean decomposition” described in TechStacks (session gateway, orchestrator, speech adapters, retrieval, scoring, data plane). fileciteturn0file0

Data plane
- Postgres for relational session/user data.
- Vector store: start with Postgres + pgvector for simplicity, then scale out later if needed. fileciteturn0file0
- Object storage for raw uploads (immutable originals), plus derived text/chunks for retrieval. This is the same two-lane ingestion model described for enterprises, adapted to consumers. fileciteturn0file0

### Multi-model routing strategy

You want multiple models because the workloads are fundamentally different:

Realtime Dialogue Model
- Goal: low latency, short outputs, controlled voice UX, safe interruption handling.
- Outputs: next prompt, time warnings, cutoffs, short feedback, and “what step we’re in.”

Planner Model
- Goal: produce the structured session plan from user intent + retrieved context.
- Runs once pre-session, can be slower.

Scorer Model
- Goal: stable rubric scoring, structured outputs, explainable feedback.
- Runs per turn (lightweight) and post-session (full summary).

This matches TechStacks’ emphasis on structured outputs and forcing schemas so scoring/drill control is not brittle. fileciteturn0file0

Concrete provider posture (pick, do not bike-shed forever)
- For text and realtime: start with entity["company","OpenAI","ai research company"] if you want integrated realtime options; pair with entity["company","Anthropic","ai research company"] for stronger offline reasoning/scoring if you prefer split workloads. TechStacks frames these “modular vs integrated” tradeoffs directly. fileciteturn0file0  
- For streaming STT: entity["company","Deepgram","speech api provider"] is a common choice in realtime agent stacks; TechStacks compares multiple streaming STT providers and emphasizes partials. fileciteturn0file0  
- For streaming TTS: entity["company","ElevenLabs","speech synthesis company"] is a typical low-latency pick; TechStacks also lists alternatives and stresses streaming support. fileciteturn0file0  

Do not overcommit to one provider. Build adapters so you can swap speech vendors without rewriting orchestration. TechStacks explicitly frames speech as “adapters + fallback routing.” fileciteturn0file0

### Latency budget and instrumentation requirements

The MVP must ship with latency observability, or you will not know what is broken.

Minimum instrumentation (per session, per turn)
- p50/p95:
  - mic capture → first STT partial
  - end of user utterance → first coach audio byte
  - end of user utterance → coach decision (text) time
  - end of user utterance → final score update
- “Barge-in success rate”: fraction of times user starts speaking while coach is talking and the coach properly yields.
- “Repair rate”: how often you ask clarifying questions due to ASR uncertainty.

TechStacks calls out a “latency dashboard (p50/p95)” as a Sprint 1 MVP deliverable and treats this as core to feasibility. fileciteturn0file0

## Session planning, timeboxing, and real-time coaching logic

This is the part most teams hand-wave. You cannot.

### The session state machine

Create a strict state machine. Example states:

- `IDLE`
- `CONFIGURING` (time budget, rep type, context selection)
- `PLANNING` (generate session plan + rubric)
- `BRIEFING` (tell user the plan in 15 to 30 seconds max)
- `RUNNING_REP` (turn loop)
- `MICRO_FEEDBACK` (fast feedback, optionally immediate redo)
- `COMPRESSING` (time is threatened, switch to speed mode)
- `WRAPPING` (final summary, next drill)
- `ENDED`

TechStacks’ “short, stateful, repairable” guidance is exactly why you need explicit states. fileciteturn0file0

### Structured session plan schema

Store the plan as JSON. The planner output must be schema-validated.

Plan fields (minimum)
- `session_goal`: one sentence
- `time_budget_sec`
- `rubric`: array of scored criteria with weights
- `steps`: ordered steps with:
  - `step_id`
  - `type` (prompt, roleplay, redo, hint, recap)
  - `target_time_sec`
  - `success_condition`
  - `fallback_if_behind` (how to compress)
- `context_citations`: ids of retrieved chunks used to build the plan

This mirrors TechStacks’ recommended production prompt layout and the need to force structured outputs. fileciteturn0file0

### Pacing and cutoff algorithm

Treat time remaining as a first-class variable and change behavior as the clock approaches zero. TechStacks explicitly describes the coach behaving differently at T minus 30 seconds than at T minus 5 minutes. fileciteturn0file0

Practical pacing loop (MVP approach)
- Maintain:
  - `time_remaining`
  - `steps_remaining`
  - user “pace signals”: WPM, pause ratio, filler rate, long silence events.
- Compute:
  - `expected_time_to_finish = sum(remaining step target times, adjusted by user pace)`
- If `expected_time_to_finish > time_remaining`:
  - Enter `COMPRESSING`:
    - shorten prompts
    - enforce concise answers (“Answer in one sentence”)
    - reduce the number of objections/follow-ups
    - switch from open-ended to multiple-choice style prompts if needed
    - give “one fix then move” feedback instead of long explanations

TechStacks explicitly recommends using hesitation and filler-rate style signals rather than risky emotion labeling, and it lists scoring features like WPM and filler counts as explainable metrics. fileciteturn0file0

Cutoff behavior rules
- User is rambling: coach interrupts with “Stop. Give me the headline in 10 seconds.”
- User is silent: coach gives a hint after a silence threshold.
- Time warning cadence:
  - “2 minutes left: one more round.”
  - “45 seconds: final answer only.”
These map to the “explicit time contract” and “one-shot summaries” guidance for off-screen sessions. fileciteturn0file0

## Context ingestion, retrieval, and safety posture for B2C

### Consumer version of the enterprise grounding model

Even in B2C, grounding is your safety layer and your differentiator.

Two-lane ingestion (directly adapted)
- Lane A: raw document store (immutable originals).
- Lane B: retrieval index (chunked text + embeddings + metadata). fileciteturn0file0

MVP supported ingestion types
- PDF, plain text, and copy-paste notes.
- Chunking strategy: simple by headings + length bounds.
- Metadata: `doc_type`, `created_at`, `user_id`, `tags`, `active_context_pack`.

Retrieval usage in the MVP
- Planning: retrieve top chunks for the rep type (resume + job description + notes).
- Live coaching: retrieve context for clarifying questions or “approved facts” about what the user provided.
- Scoring: verify whether the user actually used the right facts or structure relative to their context.

TechStacks frames RAG as “non-negotiable” for correctness and traceability, including retrieval-time filtering, generation-time constraints, and post-generation validation. fileciteturn0file0

### Privacy and legal risk defaults you should bake in early

Even though you are B2C-first, the market research doc is explicit about voice and biometric sensitivity and about driving distraction risk. fileciteturn0file1

Non-negotiable defaults
- Do not build speaker identification or “voiceprint” features.
- Treat any persistent audio embeddings as potentially biometric.
- Keep delivery features (pace, pauses, fillers) session-bound and user-visible, not hidden scoring that feels like surveillance. fileciteturn0file1  
- Explicitly discourage driving use in UX and onboarding because “commuting” marketing can drift into dangerous territory; the doc flags distracted driving as a liability risk. fileciteturn0file1  

This isn’t “enterprise compliance theater.” It is also good B2C trust posture.

### Offline and low-connectivity mode

Do not promise full offline intelligence. Ship graceful degradation.

MVP offline strategy
- Cache “drill packs” locally: prompt templates + rubrics + a small slice of approved context.
- Still run on-device VAD.
- If network drops, buffer audio and resume when reconnected, or switch to locally cached drills with delayed scoring sync.

TechStacks lays out this exact degraded mode pattern and mentions optional on-device ASR via whisper.cpp as a fallback, not a default. fileciteturn0file0

## Build roadmap with engineering tasks, acceptance criteria, and enterprise bridge

This is written as a build order Claude Code can follow.

### Phase definition

MVP target outcome (what “done” means)
- A user can complete a 3 to 10 minute timed voice rep, with live interruptions, and receive an explainable scorecard plus the next drill.
- Latency is measured and actively improved.
- Context upload works end-to-end and changes how the session behaves.

This is aligned with the TechStacks MVP definition around short drills, immediate spoken feedback, grounding, and scorecard history, while removing enterprise-only items (SSO, SCIM, manager dashboard). fileciteturn0file0

### Roadmap table

| Phase | Goal | Deliverables | Acceptance criteria |
|---|---|---|---|
| Foundation | Make audio + realtime loop work | Mobile push-to-talk, on-device VAD, streaming STT, streaming TTS, simple rep loop | A timed session completes reliably; p50/p95 latency dashboard exists; barge-in works in basic cases. fileciteturn0file0 |
| Orchestration | Enforce time contract + generate plans | Session state machine, planner output schema, timer enforcement, time warnings, “add time” voice command | Plan generated before session; coach compresses when behind; time warnings trigger based on pacing; session always ends on time unless user extends. fileciteturn0file1 |
| Context grounding | Make uploads actually matter | Upload pipeline, chunking + embeddings, retrieval API, context packs | Starting a rep with a resume/JD changes prompts and scoring; citations stored internally for traceability. fileciteturn0file0 |
| Scoring and progression | Build the “coach” loop | Rubric scoring per rep type, score history, next drill recommendation, spaced repetition queue | End-of-session scorecard shows 2 strengths + 1 fix + 1 redo line + next drill; scores trend over time for the user. fileciteturn0file0 |
| Reliability and cost | Stabilize unit economics and trust | Provider adapters + fallback routing, rate limiting, retention controls, deletion | Sessions do not fail catastrophically on STT/TTS hiccups; user can delete data; costs per minute are tracked. fileciteturn0file0 |
| Enterprise bridge backlog | Keep future optionality | Multi-tenant data model, audit-style session logs, configurable retention | You have the schema and logging patterns that later support enterprise needs without rewriting the core loop. fileciteturn0file0 |

### Sprint-level plan that maps to TechStacks and your requirements

Sprint A
- Mobile:
  - Push-to-talk foreground session (no wake word).
  - On-device VAD segmentation.
  - WebSocket streaming to backend.
- Backend:
  - WebSocket session gateway.
  - Dumb loop: user speaks → STT → fixed prompt response → TTS.
- Observability:
  - p50/p95 pipeline timings.

This is directly aligned with the TechStacks “Sprint 1” concept (audio, VAD, streaming STT/TTS, drill loop, latency dashboard). fileciteturn0file0

Sprint B
- Orchestrator:
  - Implement state machine and timer.
  - Implement “time warnings” and early compression rules.
  - Add “add time” voice command handling.
- Planner:
  - Generate a structured plan JSON and store it.
  - Enforce schema validation.

This corresponds to the “session plan orchestration” moat section and the explicit time contract behavior. fileciteturn0file1 fileciteturn0file0

Sprint C
- Context ingestion:
  - Upload endpoint + object storage.
  - Async text extraction + chunking.
  - Embeddings + pgvector index.
  - Retrieval API returns top chunks with metadata.
- Coach prompting:
  - Inject retrieved snippets into prompts.
  - Store which snippets were used.

This follows the “two-lane ingestion” and RAG prompt structure described in TechStacks. fileciteturn0file0

Sprint D
- Scoring:
  - Define 2 to 3 drill types with explicit rubrics and “gold response” patterns.
  - Implement structured scoring output.
  - Implement score history and recommended next drill.
- UX:
  - End-of-session one-shot spoken summary and optional on-screen scorecard.

This matches TechStacks’ checklist (define rubrics, build structured scoring output, store sessions, recommend next drill). fileciteturn0file0

Sprint E
- Low-connectivity mode:
  - Cache drill packs.
  - Degraded mode routing (no new retrieval, no heavy scoring).
- Trust posture:
  - Clear “do not use while driving” UX.
  - Data deletion.
  - No voiceprint storage posture documented.

This aligns with both the offline strategy in TechStacks and the legal/trust cautions in MarketResearch. fileciteturn0file0 fileciteturn0file1

## Claude Code handoff package with explicit questions to ask before coding

Claude Code will build faster and with fewer rewrites if it forces a few decisions up front. This section is intentionally written as a checklist Claude can ask you.

### Decisions Claude should force before writing the first file

Product wedge
- Which single rep type ships first: SWE interview, consulting case, sales roleplay, or “hard conversations”?
- What is the default session length: 5 minutes, 8 minutes, or user-selected from the start?

Mobile platform scope
- iOS-only MVP first, or iOS + Android concurrently?
- If both: are you willing to ship push-to-talk only (no background/hotword), consistent with TechStacks’ recommendation? fileciteturn0file0

Speech stack choice
- Modular pipeline (streaming STT + text LLM + streaming TTS) first, or integrated speech-to-speech first?
- If modular: which STT/TTS providers are the default, and what is the fallback?

Context ingestion
- Which file types are in scope at MVP: PDF only, or PDF + DOCX + text?
- Max file size and extraction approach?

Scoring philosophy
- Are you okay with scoring being “coach feedback,” not a hiring-grade evaluation?
- Do you want the scorecard to be user-only in B2C (recommended for trust), consistent with the doc’s caution about employee surveillance optics in B2B? fileciteturn0file1

### Concrete repository layout Claude Code can implement

Repo approach
- `mobile/` (iOS and/or Android client code)
- `backend/`
  - `gateway/` (WebSocket termination)
  - `orchestrator/` (state machine, timing, model router)
  - `speech/` (STT/TTS adapters)
  - `retrieval/` (chunking, embeddings, search)
  - `scoring/` (rubrics, structured scoring outputs)
- `infra/` (Postgres, object storage, secrets, deploy)
- `eval/` (transcript replay harness, rubric stability, latency/cost reports)

This decomposition mirrors the architecture breakdown in TechStacks and sets you up for enterprise hardening later without changing core logic. fileciteturn0file0

### “Build from start to finish” execution order Claude should follow

1. Implement the WebSocket session gateway and a minimal mobile push-to-talk client.
2. Add on-device VAD segmentation and streaming STT partials.
3. Add streaming TTS playback with barge-in.
4. Implement the session state machine with a hard timer and deterministic end behavior.
5. Add planner model to generate and store structured session plans.
6. Add dynamic pacing + compression mode.
7. Implement uploads → chunking → embeddings → retrieval.
8. Inject retrieval into planning and scoring.
9. Add rubrics + structured scoring outputs + score history + next drill.
10. Add degraded offline mode with cached drill packs.
11. Add deletion, retention defaults, and trust UX language.

This ordering is consistent with the “Next-step implementation checklist” and sprint sequencing in TechStacks, adapted to consumer auth and skipping enterprise SSO/SCIM for now. fileciteturn0file0

### Enterprise bridge backlog Claude should keep as explicit TODOs, not hidden hacks

Do not build these into the MVP UI, but keep the code architecture compatible:
- Tenant isolation patterns and audit-ready logs (later requirement). fileciteturn0file0  
- Grounding policy enforcement layers (retrieval filtering, generation constraints, validation). fileciteturn0file0  
- Avoid biometric “voiceprint” storage, keep delivery signals session-bound, and document it. fileciteturn0file1  

If you want this to turn into enterprise later, the biggest mistake is letting the MVP store data in a way you cannot later defend or partition.

