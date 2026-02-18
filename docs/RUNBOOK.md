# Runbook

## Local Setup

1. `cp .env.example .env` and fill in API keys
2. `npm install` (from repo root)
3. `docker compose -f infra/docker-compose.yml up -d` (starts Postgres + Redis)
4. `cd apps/backend && npm run dev`
5. Verify: `curl http://localhost:3000/healthz` returns `{"status":"ok"}`

## Running Tests

```bash
# Shared package
cd packages/shared && npm test

# Backend
cd apps/backend && npm test

# Full monorepo typecheck
npm run typecheck
```

## Manual QA Checklist

- [ ] Timer stops at exactly 180s
- [ ] Barge-in stops audio instantly
- [ ] Partial transcripts appear while speaking
- [ ] Malformed JSON events return server.error, connection stays open
- [ ] Binary frame before audio.start returns error, connection closed
- [ ] 11th auth request within 1 minute returns 429
