import { describe, it, expect, beforeEach } from 'vitest';
import { initRedis, getRedis, _resetRedis } from '../src/lib/redis.js';

describe('Redis client singleton', () => {
  beforeEach(() => {
    _resetRedis();
  });

  it('getRedis throws before init', () => {
    expect(() => getRedis()).toThrow('not initialised');
  });

  it('initRedis returns a client', () => {
    const client = initRedis('redis://localhost:6379');
    expect(client).toBeDefined();
  });

  it('getRedis returns same instance after init', () => {
    const client = initRedis('redis://localhost:6379');
    expect(getRedis()).toBe(client);
  });

  it('initRedis throws on double init', () => {
    initRedis('redis://localhost:6379');
    expect(() => initRedis('redis://localhost:6379')).toThrow('already initialised');
  });

  it('_resetRedis allows re-init', () => {
    initRedis('redis://localhost:6379');
    _resetRedis();
    const client = initRedis('redis://localhost:6380');
    expect(client).toBeDefined();
    expect(getRedis()).toBe(client);
  });
});
