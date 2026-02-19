import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the supabase module before importing repository
const mockFrom = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({
  getSupabase: () => ({ from: mockFrom }),
}));

import {
  ensureUserProfile,
  insertContentPack,
  getContentPack,
  createSession,
  endSession,
  insertSessionEvent,
  insertTranscript,
} from '../src/lib/repository.js';

/** Helper to set up a mock chain: from('table').method(...).method(...) */
function mockChain(result: { error: null | { message: string } }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.upsert = vi.fn().mockResolvedValue(result);
  chain.insert = vi.fn().mockResolvedValue(result);
  chain.update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue(result) });
  chain.eq = vi.fn().mockResolvedValue(result);
  mockFrom.mockReturnValue(chain);
  return chain;
}

describe('repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.error from fire-and-forget logging
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── insertContentPack ───────────────────────────────────────────────

  describe('insertContentPack', () => {
    it('inserts content pack with correct params', async () => {
      const chain = mockChain({ error: null });

      await insertContentPack({
        contentId: 'cnt-1',
        userId: 'user-1',
        filename: 'chapter1.pdf',
        mimeType: 'application/pdf',
        chunks: [{ index: 0, text: 'Hello world', char_count: 11 }],
      });

      expect(mockFrom).toHaveBeenCalledWith('content_packs');
      expect(chain.insert).toHaveBeenCalledWith({
        id: 'cnt-1',
        user_id: 'user-1',
        filename: 'chapter1.pdf',
        mime_type: 'application/pdf',
        chunks: [{ index: 0, text: 'Hello world', char_count: 11 }],
      });
    });

    it('throws on DB error', async () => {
      mockChain({ error: { message: 'unique violation' } });

      await expect(
        insertContentPack({
          contentId: 'cnt-1',
          userId: 'user-1',
          filename: 'test.pdf',
          mimeType: 'application/pdf',
          chunks: [],
        }),
      ).rejects.toThrow('insertContentPack failed');
    });
  });

  // ── getContentPack ──────────────────────────────────────────────────

  describe('getContentPack', () => {
    it('returns content pack when found', async () => {
      const row = {
        id: 'cnt-1',
        user_id: 'user-1',
        filename: 'chapter1.pdf',
        mime_type: 'application/pdf',
        chunks: [{ index: 0, text: 'Hello', char_count: 5 }],
        created_at: '2024-01-01T00:00:00Z',
      };
      const single = vi.fn().mockResolvedValue({ data: row, error: null });
      const eq = vi.fn().mockReturnValue({ single });
      const select = vi.fn().mockReturnValue({ eq });
      mockFrom.mockReturnValue({ select });

      const result = await getContentPack('cnt-1');

      expect(mockFrom).toHaveBeenCalledWith('content_packs');
      expect(select).toHaveBeenCalledWith('*');
      expect(eq).toHaveBeenCalledWith('id', 'cnt-1');
      expect(result).toEqual(row);
    });

    it('returns null when not found (PGRST116)', async () => {
      const single = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'No rows' } });
      const eq = vi.fn().mockReturnValue({ single });
      const select = vi.fn().mockReturnValue({ eq });
      mockFrom.mockReturnValue({ select });

      const result = await getContentPack('cnt-missing');
      expect(result).toBeNull();
    });

    it('throws on unexpected DB error', async () => {
      const single = vi.fn().mockResolvedValue({ data: null, error: { code: '42P01', message: 'table not found' } });
      const eq = vi.fn().mockReturnValue({ single });
      const select = vi.fn().mockReturnValue({ eq });
      mockFrom.mockReturnValue({ select });

      await expect(getContentPack('cnt-1')).rejects.toThrow('getContentPack failed');
    });
  });

  // ── ensureUserProfile ───────────────────────────────────────────────

  describe('ensureUserProfile', () => {
    it('upserts into users table with correct params', async () => {
      const chain = mockChain({ error: null });

      await ensureUserProfile('user-abc');

      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(chain.upsert).toHaveBeenCalledWith(
        { id: 'user-abc' },
        { onConflict: 'id', ignoreDuplicates: true },
      );
    });

    it('does not throw on DB error', async () => {
      mockChain({ error: { message: 'duplicate key' } });

      await expect(ensureUserProfile('user-abc')).resolves.toBeUndefined();
    });
  });

  // ── createSession ─────────────────────────────────────────────────

  describe('createSession', () => {
    it('inserts into sessions with status running', async () => {
      const chain = mockChain({ error: null });

      await createSession({
        sessionId: 'sess-1',
        userId: 'user-1',
        contentId: 'cnt_abc123',
        requestedDurationMs: 600_000,
      });

      expect(mockFrom).toHaveBeenCalledWith('sessions');
      expect(chain.insert).toHaveBeenCalledWith({
        id: 'sess-1',
        user_id: 'user-1',
        content_id: 'cnt_abc123',
        requested_duration_ms: 600_000,
        status: 'running',
      });
    });

    it('does not throw on DB error', async () => {
      mockChain({ error: { message: 'FK violation' } });

      await expect(
        createSession({
          sessionId: 'sess-1',
          userId: 'user-1',
          contentId: 'cnt_abc123',
          requestedDurationMs: 600_000,
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ── endSession ────────────────────────────────────────────────────

  describe('endSession', () => {
    it('updates session with ended status', async () => {
      const eqFn = vi.fn().mockResolvedValue({ error: null });
      const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
      mockFrom.mockReturnValue({ update: updateFn });

      await endSession('sess-1', 'ended', 175000);

      expect(mockFrom).toHaveBeenCalledWith('sessions');
      const updateArg = updateFn.mock.calls[0][0];
      expect(updateArg.status).toBe('ended');
      expect(updateArg.actual_duration_ms).toBe(175000);
      expect(updateArg.ended_at).toBeDefined();
      expect(eqFn).toHaveBeenCalledWith('id', 'sess-1');
    });

    it('includes error_code when provided', async () => {
      const eqFn = vi.fn().mockResolvedValue({ error: null });
      const updateFn = vi.fn().mockReturnValue({ eq: eqFn });
      mockFrom.mockReturnValue({ update: updateFn });

      await endSession('sess-1', 'error', 50000, 'disconnect');

      const updateArg = updateFn.mock.calls[0][0];
      expect(updateArg.status).toBe('error');
      expect(updateArg.error_code).toBe('disconnect');
    });

    it('does not throw on DB error', async () => {
      const eqFn = vi.fn().mockResolvedValue({ error: { message: 'not found' } });
      mockFrom.mockReturnValue({ update: vi.fn().mockReturnValue({ eq: eqFn }) });

      await expect(endSession('sess-1', 'ended', 100000)).resolves.toBeUndefined();
    });
  });

  // ── insertSessionEvent ────────────────────────────────────────────

  describe('insertSessionEvent', () => {
    it('inserts event with correct fields', async () => {
      const chain = mockChain({ error: null });

      await insertSessionEvent('sess-1', 'audio.start', { codec: 'opus' });

      expect(mockFrom).toHaveBeenCalledWith('session_events');
      const insertArg = chain.insert.mock.calls[0][0];
      expect(insertArg.session_id).toBe('sess-1');
      expect(insertArg.type).toBe('audio.start');
      expect(insertArg.payload).toEqual({ codec: 'opus' });
      expect(insertArg.ts_ms).toBeGreaterThan(0);
    });
  });

  // ── insertTranscript ──────────────────────────────────────────────

  describe('insertTranscript', () => {
    it('inserts transcript with correct fields', async () => {
      const chain = mockChain({ error: null });

      await insertTranscript({
        sessionId: 'sess-1',
        turnIndex: 0,
        speaker: 'user',
        isFinal: true,
        text: 'Hello world',
        provider: 'deepgram',
        confidence: 0.95,
      });

      expect(mockFrom).toHaveBeenCalledWith('transcripts');
      const insertArg = chain.insert.mock.calls[0][0];
      expect(insertArg.session_id).toBe('sess-1');
      expect(insertArg.turn_index).toBe(0);
      expect(insertArg.speaker).toBe('user');
      expect(insertArg.is_final).toBe(true);
      expect(insertArg.text).toBe('Hello world');
      expect(insertArg.provider).toBe('deepgram');
      expect(insertArg.confidence).toBe(0.95);
    });

    it('omits confidence when not provided', async () => {
      const chain = mockChain({ error: null });

      await insertTranscript({
        sessionId: 'sess-1',
        turnIndex: 1,
        speaker: 'coach',
        isFinal: true,
        text: 'Good job',
        provider: 'openai',
      });

      const insertArg = chain.insert.mock.calls[0][0];
      expect(insertArg).not.toHaveProperty('confidence');
    });
  });
});
