-- =============================================================================
-- Idempotent schema (safe to re-run)
-- =============================================================================

-- ── users ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email TEXT NULL
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_select_own ON public.users;
CREATE POLICY users_select_own ON public.users
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS users_insert_own ON public.users;
CREATE POLICY users_insert_own ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Trigger/function (drop + recreate so re-runs work)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ── sessions ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  drill_id TEXT NOT NULL,
  requested_duration_ms INT NOT NULL,
  actual_duration_ms INT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ended','error')),
  error_code TEXT NULL
);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sessions_select_own ON public.sessions;
CREATE POLICY sessions_select_own ON public.sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON public.sessions(user_id);

-- ── session_events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  ts_ms BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL
);

ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_select_own ON public.session_events;
CREATE POLICY events_select_own ON public.session_events
  FOR SELECT USING (
    session_id IN (SELECT id FROM public.sessions WHERE user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_events_session ON public.session_events(session_id, ts_ms);

-- ── transcripts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.transcripts (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  turn_index INT NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('user','coach')),
  is_final BOOLEAN NOT NULL,
  text TEXT NOT NULL,
  provider TEXT NOT NULL,
  confidence REAL NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.transcripts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transcripts_select_own ON public.transcripts;
CREATE POLICY transcripts_select_own ON public.transcripts
  FOR SELECT USING (
    session_id IN (SELECT id FROM public.sessions WHERE user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_transcripts_session ON public.transcripts(session_id, turn_index);