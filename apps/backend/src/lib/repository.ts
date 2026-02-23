import { getSupabase } from './supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContentChunk } from '@coach/shared';

/**
 * Thin persistence layer over Supabase.
 * All writes use the service-role client (bypasses RLS).
 * Functions are designed to be fire-and-forget safe -- they log errors
 * rather than throwing, so a DB failure never kills a WS connection.
 */

function log(msg: string, extra?: Record<string, unknown>) {
  // Minimal logger -- avoids coupling to Fastify's logger
  console.error(`[repository] ${msg}`, extra ?? '');
}

/** Returns the Supabase client or null if not initialised (e.g. in tests). */
function db(): SupabaseClient | null {
  try {
    return getSupabase();
  } catch {
    return null;
  }
}

// ── content_packs ────────────────────────────────────────────────────────────

export interface InsertContentPackParams {
  contentId: string;
  userId: string;
  filename: string;
  mimeType: string;
  chunks: ContentChunk[];
}

export interface ContentPackRow {
  id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  chunks: ContentChunk[];
  created_at: string;
}

/** Insert a parsed content pack. Throws on failure — callers must handle. */
export async function insertContentPack(params: InsertContentPackParams): Promise<void> {
  const client = db();
  if (!client) throw new Error('Supabase client not initialised');
  const { error } = await client
    .from('content_packs')
    .insert({
      id: params.contentId,
      user_id: params.userId,
      filename: params.filename,
      mime_type: params.mimeType,
      chunks: params.chunks,
    });
  if (error) throw new Error(`insertContentPack failed: ${error.message}`);
}

/** Fetch a content pack by ID. Returns null if not found. Throws on DB error. */
export async function getContentPack(contentId: string): Promise<ContentPackRow | null> {
  const client = db();
  if (!client) throw new Error('Supabase client not initialised');
  const { data, error } = await client
    .from('content_packs')
    .select('*')
    .eq('id', contentId)
    .single();
  if (error) {
    // PostgREST returns code PGRST116 when no row found
    if (error.code === 'PGRST116') return null;
    throw new Error(`getContentPack failed: ${error.message}`);
  }
  return data as ContentPackRow;
}

// ── sessions (read) ──────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  user_id: string;
  content_id: string;
  status: 'running' | 'ended' | 'error';
  requested_duration_ms: number;
  actual_duration_ms: number | null;
  error_code: string | null;
  created_at: string;
  ended_at: string | null;
}

/** Fetch a single session by ID. Returns null if not found. Throws on DB error. */
export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const client = db();
  if (!client) throw new Error('Supabase client not initialised');
  const { data, error } = await client
    .from('sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`getSession failed: ${error.message}`);
  }
  return data as SessionRow;
}

// ── users ───────────────────────────────────────────────────────────────────

export async function ensureUserProfile(userId: string): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const { error } = await client
      .from('users')
      .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

    if (error) log('ensureUserProfile failed', { userId, error: error.message });
  } catch (err) {
    log('ensureUserProfile threw', { userId, err: String(err) });
  }
}

// ── sessions ────────────────────────────────────────────────────────────────

export interface CreateSessionParams {
  sessionId: string;
  userId: string;
  contentId: string;
  requestedDurationMs: number;
}

export async function createSession(params: CreateSessionParams): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const { error } = await client
      .from('sessions')
      .insert({
        id: params.sessionId,
        user_id: params.userId,
        content_id: params.contentId,
        requested_duration_ms: params.requestedDurationMs,
        status: 'running',
      });

    if (error) log('createSession failed', { sessionId: params.sessionId, error: error.message });
  } catch (err) {
    log('createSession threw', { sessionId: params.sessionId, err: String(err) });
  }
}

export async function endSession(
  sessionId: string,
  status: 'ended' | 'error',
  actualDurationMs: number,
  errorCode?: string,
): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const { error } = await client
      .from('sessions')
      .update({
        ended_at: new Date().toISOString(),
        status,
        actual_duration_ms: actualDurationMs,
        ...(errorCode ? { error_code: errorCode } : {}),
      })
      .eq('id', sessionId);

    if (error) log('endSession failed', { sessionId, error: error.message });
  } catch (err) {
    log('endSession threw', { sessionId, err: String(err) });
  }
}

// ── session_events ──────────────────────────────────────────────────────────

export async function insertSessionEvent(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const { error } = await client
      .from('session_events')
      .insert({
        session_id: sessionId,
        ts_ms: Date.now(),
        type,
        payload,
      });

    if (error) log('insertSessionEvent failed', { sessionId, type, error: error.message });
  } catch (err) {
    log('insertSessionEvent threw', { sessionId, type, err: String(err) });
  }
}

export interface SessionEventRow {
  session_id: string;
  ts_ms: number;
  type: string;
  payload: Record<string, unknown>;
}

/** Batch insert multiple session events in one call. */
export async function insertSessionEvents(events: SessionEventRow[]): Promise<void> {
  if (events.length === 0) return;
  const client = db();
  if (!client) return;
  try {
    const { error } = await client.from('session_events').insert(events);
    if (error) log('insertSessionEvents failed', { count: events.length, error: error.message });
  } catch (err) {
    log('insertSessionEvents threw', { count: events.length, err: String(err) });
  }
}

// ── transcripts ─────────────────────────────────────────────────────────────

export interface InsertTranscriptParams {
  sessionId: string;
  turnIndex: number;
  speaker: 'user' | 'coach';
  isFinal: boolean;
  text: string;
  provider: string;
  confidence?: number;
}

export async function insertTranscript(params: InsertTranscriptParams): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    const { error } = await client
      .from('transcripts')
      .insert({
        session_id: params.sessionId,
        turn_index: params.turnIndex,
        speaker: params.speaker,
        is_final: params.isFinal,
        text: params.text,
        provider: params.provider,
        ...(params.confidence != null ? { confidence: params.confidence } : {}),
      });

    if (error) log('insertTranscript failed', { sessionId: params.sessionId, error: error.message });
  } catch (err) {
    log('insertTranscript threw', { sessionId: params.sessionId, err: String(err) });
  }
}
