/**
 * Streaming PCM audio playback with a jitter buffer.
 *
 * The server sends raw PCM (s16le, 16 kHz, mono) as binary WebSocket frames.
 * We accumulate those frames until we have at least JITTER_BUFFER_MIN_MS of
 * audio, wrap them in a WAV header, write a temp file, and play it with
 * expo-av.  When the file finishes playing we flush any buffered chunks that
 * arrived in the meantime, creating a continuous playback chain.
 *
 * stopPlayback() cancels in-flight playback immediately (< 150 ms target).
 */

import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import {
  JITTER_BUFFER_MIN_MS,
  JITTER_BUFFER_CAP_MS,
  AUDIO_SAMPLE_RATE,
  AUDIO_BYTES_PER_SECOND,
} from '@coach/shared';

const MIN_BYTES = Math.floor((JITTER_BUFFER_MIN_MS / 1000) * AUDIO_BYTES_PER_SECOND);
const CAP_BYTES = Math.floor((JITTER_BUFFER_CAP_MS / 1000) * AUDIO_BYTES_PER_SECOND);

let buffer: Uint8Array[] = [];
let bufferedBytes = 0;
let playing = false;
let playSeq = 0;
let currentSound: Audio.Sound | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPlayback(): Promise<void> {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
  });
}

/** Push a PCM chunk received from the server into the jitter buffer. */
export function pushPCM(data: ArrayBuffer): void {
  if (bufferedBytes >= CAP_BYTES) return; // prevent runaway growth
  buffer.push(new Uint8Array(data));
  bufferedBytes += data.byteLength;

  if (!playing && bufferedBytes >= MIN_BYTES) {
    void flushBuffer();
  }
}

/**
 * Stop all playback immediately and clear the buffer.
 * Called on barge-in and tts.cleared events.
 */
export async function stopPlayback(): Promise<void> {
  playSeq++; // invalidate any in-flight flush
  playing = false;
  buffer = [];
  bufferedBytes = 0;

  if (currentSound) {
    const s = currentSound;
    currentSound = null;
    await s.stopAsync().catch(() => {});
    await s.unloadAsync().catch(() => {});
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function flushBuffer(): Promise<void> {
  if (playing || bufferedBytes === 0) return;
  playing = true;

  const seq = ++playSeq;

  // Drain the accumulated chunks
  const chunks = buffer;
  buffer = [];
  bufferedBytes = 0;

  const totalBytes = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }

  const wav = buildWav(pcm);
  const base64 = uint8ToBase64(wav);
  const uri = `${FileSystem.cacheDirectory ?? ''}tts_${seq}.wav`;

  try {
    await FileSystem.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    if (playSeq !== seq) {
      void FileSystem.deleteAsync(uri, { idempotent: true });
      return;
    }

    const { sound } = await Audio.Sound.createAsync(
      { uri },
      { shouldPlay: true },
      (status) => {
        if (!status.isLoaded) return;
        if (status.didJustFinish) {
          playing = false;
          void sound.unloadAsync().catch(() => {});
          void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});

          // Chain: if more chunks arrived while we were playing, flush them
          if (playSeq === seq && bufferedBytes >= MIN_BYTES) {
            void flushBuffer();
          }
        }
      },
    );

    if (playSeq !== seq) {
      await sound.stopAsync().catch(() => {});
      await sound.unloadAsync().catch(() => {});
      void FileSystem.deleteAsync(uri, { idempotent: true });
      return;
    }

    currentSound = sound;
  } catch {
    playing = false;
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

// ── WAV helpers ───────────────────────────────────────────────────────────────

function buildWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);

  // RIFF header
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + pcm.length, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt chunk
  wav.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);             // chunk size
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, AUDIO_SAMPLE_RATE, true);
  view.setUint32(28, AUDIO_BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);              // block align (1ch × 16-bit / 8)
  view.setUint16(34, 16, true);             // bits per sample

  // data chunk
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);

  return wav;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
