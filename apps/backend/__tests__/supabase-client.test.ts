import { describe, it, expect, beforeEach } from 'vitest';
import { initSupabase, getSupabase, _resetSupabase } from '../src/lib/supabase.js';

describe('Supabase client singleton', () => {
  beforeEach(() => {
    _resetSupabase();
  });

  it('getSupabase throws before init', () => {
    expect(() => getSupabase()).toThrow('not initialised');
  });

  it('initSupabase returns a client', () => {
    const client = initSupabase('https://test.supabase.co', 'fake-key');
    expect(client).toBeDefined();
  });

  it('getSupabase returns same instance after init', () => {
    const client = initSupabase('https://test.supabase.co', 'fake-key');
    expect(getSupabase()).toBe(client);
  });

  it('initSupabase throws on double init', () => {
    initSupabase('https://test.supabase.co', 'fake-key');
    expect(() => initSupabase('https://test.supabase.co', 'fake-key')).toThrow('already initialised');
  });

  it('_resetSupabase allows re-init', () => {
    initSupabase('https://test.supabase.co', 'fake-key');
    _resetSupabase();
    const client = initSupabase('https://test2.supabase.co', 'fake-key-2');
    expect(client).toBeDefined();
    expect(getSupabase()).toBe(client);
  });
});
