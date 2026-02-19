/**
 * Real-time PCM audio capture (s16le, 16 kHz, mono).
 *
 * Uses react-native-live-audio-stream which streams raw PCM data in real-time.
 * This library requires a native build — run `expo prebuild` (or `expo run:ios`
 * / `expo run:android`) before use; it cannot run in Expo Go.
 *
 * The `onChunk` callback receives an ArrayBuffer containing 20 ms of audio
 * (640 bytes) ready to send directly over the WebSocket as a binary frame.
 */

import { AUDIO_SAMPLE_RATE, AUDIO_CHUNK_BYTES } from '@coach/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LiveAudioStream = require('react-native-live-audio-stream').default as {
  init: (opts: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    bufferSize: number;
  }) => void;
  on: (event: 'data', handler: (base64: string) => void) => { remove: () => void };
  start: () => void;
  stop: () => void;
};

let removeListener: (() => void) | null = null;
let capturing = false;

/** Start streaming 20 ms PCM chunks to `onChunk`. */
export function startCapture(onChunk: (pcm: ArrayBuffer) => void): void {
  if (capturing) return;

  LiveAudioStream.init({
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    bufferSize: AUDIO_CHUNK_BYTES,
  });

  const sub = LiveAudioStream.on('data', (base64: string) => {
    const binary = atob(base64);
    const buf = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) {
      view[i] = binary.charCodeAt(i);
    }
    onChunk(buf);
  });

  removeListener = () => sub.remove();
  capturing = true;
  LiveAudioStream.start();
}

/** Stop streaming. */
export function stopCapture(): void {
  if (!capturing) return;
  LiveAudioStream.stop();
  removeListener?.();
  removeListener = null;
  capturing = false;
}

export function isCapturing(): boolean {
  return capturing;
}
