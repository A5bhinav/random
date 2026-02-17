Below is a full MVP build roadmap you can hand directly to Claude Code.
It assumes:

We are pivoting from B2B-first → B2C-first

Target user = ambitious individual (student, founder, sales rep, job candidate)

Core wedge = voice-first, time-boxed structured reps

Enterprise is phase 2 (after traction + behavioral data)

This roadmap incorporates the technical constraints, architecture, and product patterns described in your original research docs 

TechStacks

 

MarketResearch

 but is rewritten for consumer launch first.

PRODUCT REFRAME (B2C V1)
Product Definition (B2C)

A voice-first, ultra-low-latency, time-boxed AI coach that runs structured practice reps during short real-world time windows (walking, commuting, between meetings).

User examples:

“I have 8 minutes before class. Run a discovery drill.”

“Give me a 5-minute investor pitch rep.”

“Practice handling ‘too expensive’ objection for 10 minutes.”

Core value:

Structured reps.

Strict time enforcement.

Real-time interruption.

Adaptive difficulty.

Scorecard + next drill.

Enterprise features (SSO, SCIM, audit logs, multi-tenant isolation, SOC2) are removed from V1.

CLAUDE CODE: FULL BUILD ROADMAP

Claude, you are building a complete production-ready MVP for a mobile-first, voice-native, time-boxed AI coaching app.

The system must support:

Hard time constraints

Context upload (file + chat context)

AI interruption / barge-in

Structured session plan before rep starts

Adaptive pacing + hints

Ultra low latency

Multi-model orchestration

HIGH LEVEL ARCHITECTURE

Mobile App (iOS first)
↓
Realtime Gateway (WebSocket)
↓
Realtime Orchestrator (Node/TS or Python FastAPI)
↓
Speech Layer (Streaming STT + Streaming TTS)
↓
LLM Layer (multiple models, structured output)
↓
Scoring Engine
↓
Session DB (Postgres + pgvector)

TECH STACK (V1 B2C)

Mobile:

React Native OR native Swift (if audio latency becomes hard)

WebSocket audio streaming

On-device VAD (WebRTC VAD or libfvad)

Push-to-talk only (no wake word in V1)

Backend:

Node.js (Fastify) or Python (FastAPI)

WebSocket endpoint for streaming audio + events

Postgres + pgvector

Redis (session state)

Speech:

STT: Deepgram streaming OR Google streaming STT

TTS: ElevenLabs low-latency OR Deepgram TTS

Must support barge-in (stop TTS when user speaks)

LLMs:

Fast reasoning model (small, cheap) for pacing + time logic

Stronger reasoning model for scoring + plan generation

Use structured JSON outputs

CORE SYSTEM COMPONENTS
1. SESSION INITIALIZATION ENGINE

When user says:
“I have 10 minutes to practice investor pitch”

System must:

Step 1: Parse time constraint
Step 2: Generate structured session plan BEFORE rep begins

Plan Schema:
{
session_goal: string,
total_time_seconds: number,
segments: [
{
name: "Warmup",
duration_seconds: number
},
{
name: "Main Rep",
duration_seconds: number
},
{
name: "Objection Handling",
duration_seconds: number
},
{
name: "Rapid Feedback + Redo",
duration_seconds: number
}
],
pacing_strategy: "strict" | "adaptive"
}

Claude must:

Always generate this plan first.

Store in session state.

Use it as pacing controller.

2. TIME CONTROL ENGINE (CRITICAL)

Time is a first-class variable.

System must:

Maintain global session clock.

Maintain segment clock.

Maintain expected content pace.

Every 3–5 seconds:

Evaluate: is user on track?

Predict: can remaining content fit remaining time?

If not:

AI must interrupt:
“We have 2 minutes left. Skip to close.”
OR
“Let’s compress this answer.”

If user interrupts AI:

Adjust remaining time dynamically.

This requires:

Realtime loop:
while session_active:
time_remaining = total_time - elapsed
if time_remaining <= 0:
force_close_session()

3. REALTIME INTERRUPTION SYSTEM

Must support barge-in.

When:

AI is speaking via TTS

User starts speaking

System must:

Immediately stop TTS stream

Switch to STT capture

Resume orchestration

Implementation:

Client:

Detect mic activity > threshold

Send interrupt event over WebSocket

Server:

Cancel active TTS stream

Update conversation state

4. CONTEXT INGESTION (B2C VERSION)

User must be able to:

Upload PDF

Paste text

Add quick context prompt

Backend pipeline:

Upload → Extract text → Chunk → Embed → Store in pgvector

Session plan generation must:

Retrieve relevant chunks

Inject into prompt

All claims made by AI must reference retrieved context if provided.

5. ADAPTIVE PACING ENGINE

System maintains:

Confidence signals (pauses, fillers, long silence)

ASR confidence

Completion progress

Rules:

If struggling:

Inject hint

Simplify objection

Provide structure

If performing well:

Speed up

Increase difficulty

Reduce hints

If time insufficient:

Compress final rep

Adaptive decision model:
Small fast LLM evaluates every turn:
{
user_state: "strong" | "struggling",
recommended_action: "hint" | "advance" | "compress"
}

6. MULTI-LLM ORCHESTRATION

Use different models for different tasks:

Model A (Fast + cheap):

Real-time pacing decisions

Time enforcement

Model B (Stronger reasoning):

Session plan generation

Rubric scoring

Drill generation

Model C (Optional):

Summary + improvement plan

All LLM outputs must follow strict JSON schema.

7. SCORING ENGINE

At session end:

Compute:

Speech metrics:

Words per minute

Filler rate

Pause ratio

LLM rubric scoring:
{
clarity_score: 1-10,
structure_score: 1-10,
persuasion_score: 1-10,
objection_handling_score: 1-10,
overall_score: number,
strengths: [],
weaknesses: [],
next_drill: string
}

Persist to DB.

ULTRA LOW LATENCY REQUIREMENTS

Target:

<300ms perceived response delay

Tech rules:

Streaming STT only

Streaming TTS only

Avoid blocking LLM calls

Pre-generate next buyer turn while user speaking

Use parallel orchestration:

Start LLM generation before STT finalizes when confidence high

OFFLINE / LOW CONNECTIVITY MODE (V1 LIGHT)

Cache 3 prebuilt drills locally

Use on-device VAD

If network drops:

Continue recording

Resume when reconnected

Score after

DATABASE SCHEMA (SIMPLIFIED B2C)

Users
Sessions
SessionPlans
SessionSegments
Transcripts
Scores
UserContextDocs
Embeddings

No multi-tenant isolation required for V1.

MVP BUILD PHASES
Phase 1 (2 weeks)

Push-to-talk app

Streaming STT

Streaming TTS

Simple 3-minute drill

Hard timer enforcement

Phase 2 (2 weeks)

Structured session plan generation

JSON schema outputs

Context upload + RAG

Barge-in support

Phase 3 (2 weeks)

Adaptive pacing engine

Scoring engine

Score history UI

Drill recommendation engine

After this → Closed beta launch

SUCCESS METRICS (B2C)

You are not measuring enterprise ROI.

You measure:

Sessions per user per week

Completion rate

Redo rate

7-day retention

Average session length

Self-reported confidence increase

WHAT CLAUDE CODE SHOULD ASK BEFORE BUILDING

Claude must clarify:

iOS first or cross-platform?

Which STT provider?

Which TTS provider?

Which LLM provider?

Are we storing raw audio?

Are we prioritizing cost or quality?

What vertical do we start with? (Sales, interview, founder pitch?)

Are we targeting students first?

Claude must not assume.

IMPORTANT DESIGN DECISIONS

Do NOT:

Implement wake word in V1

Implement emotion detection

Store voiceprints

Implement enterprise compliance stack

Do:

Make time control bulletproof

Make interruption seamless

Make session plan visible to user

Keep sessions short (5–10 min)

WHY THIS WINS AS B2C

Enterprise competitors are heavy, bundled, and platform-first 

MarketResearch

.

Your wedge:

Short off-screen reps

Hard time control

Real-time interruption

Adaptive compression

This behavior-first loop is not owned tightly by incumbents 

TechStacks

.

If you want next:
I can now:

Write the exact Claude Code superprompt to build Phase 1 end-to-end

Or design the database schema in full SQL

Or map out the real-time event protocol between client and server

Or cost model the entire stack per 1,000 users

Tell me which one.

Sources