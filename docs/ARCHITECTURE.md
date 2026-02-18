# Architecture

## System Overview

```
Mobile (React Native) ──WS──> Backend (Fastify)
                                 ├── Deepgram STT (WS)
                                 ├── OpenAI LLM (HTTP streaming)
                                 ├── Deepgram TTS (WS)
                                 ├── PostgreSQL (persistence)
                                 └── Redis (live session state)
```

## Monorepo Layout

- `/apps/backend` - Node.js/TypeScript Fastify server
- `/apps/mobile` - React Native bare workflow
- `/packages/shared` - Types, schemas, Ajv validators, constants
- `/infra` - Docker Compose, Postgres init SQL
- `/docs` - Protocol, architecture, runbook

## Key Components

- **SessionOrchestrator** - One per active session. Owns state machine, timer, adapters.
- **SessionTimer** - Server-authoritative wall-clock timer (180s).
- **TextChunker** - Collects LLM tokens into sentences for TTS.
- **Barge-in pipeline** - 6-step cancellation sequence.
