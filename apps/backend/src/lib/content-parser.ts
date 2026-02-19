import pdfParse from 'pdf-parse';
import { parseOfficeAsync } from 'officeparser';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { ContentChunk } from '@coach/shared';
import { CONTENT_CHUNK_CHARS } from '@coach/shared';

// ── Supported types ──────────────────────────────────────────────────────────

export const SUPPORTED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
] as const;

export type SupportedMime = (typeof SUPPORTED_MIMES)[number];

export function isSupportedMime(mime: string): mime is SupportedMime {
  return (SUPPORTED_MIMES as readonly string[]).includes(mime);
}

// ── Text extraction ──────────────────────────────────────────────────────────

async function extractFromPdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer);
  return result.text;
}

async function extractFromOffice(buffer: Buffer, ext: '.pptx' | '.ppt'): Promise<string> {
  const tmpPath = join(tmpdir(), `coach-${randomBytes(8).toString('hex')}${ext}`);
  try {
    await writeFile(tmpPath, buffer);
    return await parseOfficeAsync(tmpPath, { outputErrorToConsole: false });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function extractText(buffer: Buffer, mimeType: SupportedMime): Promise<string> {
  if (mimeType === 'application/pdf') {
    return extractFromPdf(buffer);
  }
  const ext = mimeType === 'application/vnd.ms-powerpoint' ? '.ppt' : '.pptx';
  return extractFromOffice(buffer, ext);
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split text into chunks of approximately `chunkSize` characters,
 * breaking on whitespace boundaries where possible.
 */
export function chunkText(text: string, chunkSize = CONTENT_CHUNK_CHARS): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return chunks;

  let pos = 0;
  let index = 0;

  while (pos < normalized.length) {
    let end = Math.min(pos + chunkSize, normalized.length);

    if (end < normalized.length) {
      // Find the last whitespace in the candidate slice to avoid mid-word splits
      const slice = normalized.slice(pos, end);
      const spaceIdx = slice.lastIndexOf(' ');
      const newlineIdx = slice.lastIndexOf('\n');
      const tabIdx = slice.lastIndexOf('\t');
      const breakAt = Math.max(spaceIdx, newlineIdx, tabIdx);
      if (breakAt > 0) end = pos + breakAt;
      // If no whitespace found, fall back to hard split at chunkSize
    }

    const segment = normalized.slice(pos, end).trim();
    if (segment.length > 0) {
      chunks.push({ index, text: segment, char_count: segment.length });
      index++;
    }

    // Advance past the split point and any following whitespace
    pos = end;
    while (pos < normalized.length && /\s/.test(normalized[pos])) pos++;
  }

  return chunks;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function parseContent(
  buffer: Buffer,
  mimeType: SupportedMime,
): Promise<ContentChunk[]> {
  const text = await extractText(buffer, mimeType);
  return chunkText(text);
}
