import { getSupabase } from './supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';

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
  drillId: string;
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
        drill_id: params.drillId,
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
