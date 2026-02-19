import { describe, it, expect } from 'vitest';
import { chunkText, isSupportedMime, SUPPORTED_MIMES } from '../src/lib/content-parser.js';
import { CONTENT_CHUNK_CHARS } from '@coach/shared';

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('Hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, text: 'Hello world', char_count: 11 });
  });

  it('returns empty array for empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('returns empty array for whitespace-only text', () => {
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('assigns sequential zero-based indices', () => {
    // 3 * CONTENT_CHUNK_CHARS chars of text will produce multiple chunks
    const text = 'word '.repeat(Math.ceil((CONTENT_CHUNK_CHARS * 3) / 5));
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
    });
  });

  it('each chunk does not exceed the target size', () => {
    const text = 'word '.repeat(2000); // ~10 000 chars
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.char_count).toBeLessThanOrEqual(CONTENT_CHUNK_CHARS);
    }
  });

  it('char_count equals text.length for every chunk', () => {
    const text = 'Hello world this is test content. '.repeat(200);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.char_count).toBe(chunk.text.length);
    }
  });

  it('no chunk starts or ends with whitespace', () => {
    const text = 'a '.repeat(1500) + '\n' + 'b '.repeat(1500);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.text[0]).not.toMatch(/\s/);
      expect(chunk.text[chunk.text.length - 1]).not.toMatch(/\s/);
    }
  });

  it('preserves all non-whitespace content across chunks', () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkText(text);
    const reconstructed = chunks.map((c) => c.text).join(' ');
    // Every original word should appear in the reconstructed text
    for (const word of words) {
      expect(reconstructed).toContain(word);
    }
  });

  it('handles paragraph breaks (newlines) without producing empty chunks', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('respects a custom chunk size', () => {
    const chunks = chunkText('Hello world foo bar baz', 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.char_count).toBeLessThanOrEqual(10);
    }
  });

  it('hard-splits a single word longer than chunkSize', () => {
    const longWord = 'x'.repeat(100);
    const chunks = chunkText(longWord, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.char_count).toBeLessThanOrEqual(30);
    }
  });
});

describe('isSupportedMime', () => {
  it('accepts application/pdf', () => {
    expect(isSupportedMime('application/pdf')).toBe(true);
  });

  it('accepts PPTX mime type', () => {
    expect(
      isSupportedMime(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe(true);
  });

  it('accepts PPT mime type', () => {
    expect(isSupportedMime('application/vnd.ms-powerpoint')).toBe(true);
  });

  it('rejects image/jpeg', () => {
    expect(isSupportedMime('image/jpeg')).toBe(false);
  });

  it('rejects application/octet-stream', () => {
    expect(isSupportedMime('application/octet-stream')).toBe(false);
  });

  it('rejects text/plain', () => {
    expect(isSupportedMime('text/plain')).toBe(false);
  });

  it('every entry in SUPPORTED_MIMES passes isSupportedMime', () => {
    for (const mime of SUPPORTED_MIMES) {
      expect(isSupportedMime(mime)).toBe(true);
    }
  });
});
