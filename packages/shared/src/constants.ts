// Protocol
export const PROTOCOL_VERSION = '1.0';

// Timer -- total duration is always user-specified, not hardcoded
export const TIMER_TICK_INTERNAL_MS = 100;
export const TIMER_TICK_CLIENT_MS = 1_000;
export const TIMER_WARNING_THRESHOLDS = [120_000, 60_000, 15_000]; // 2min, 1min, 15s

// Pacing loop
export const PACING_CHECK_INTERVAL_MS = 5_000;  // evaluate topic progress every 5s
export const PACING_DEBOUNCE_MS = 15_000;        // max one server interrupt per 15s

// Content ingestion
export const MAX_CONTENT_FILE_MB = 20;
export const CONTENT_CHUNK_CHARS = 1_500;        // target chars per content chunk

// Reconnect
export const RECONNECT_BACKOFF_MS = [200, 500, 1000, 2000, 5000];

// Audio capture format
export const AUDIO_CODEC = 'pcm_s16le' as const;
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_CHUNK_MS = 20;
export const AUDIO_CHUNK_BYTES = 640; // 20ms * 16kHz * 2 bytes = 640 bytes
export const AUDIO_BYTES_PER_SECOND = 32_000; // 16kHz * 16-bit * mono

// Heartbeat
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;

// Deepgram STT -- CANONICAL values (do NOT duplicate elsewhere)
export const DEEPGRAM_STT_MODEL = 'nova-2';
export const DEEPGRAM_STT_ENDPOINTING_MS = 500;
export const DEEPGRAM_STT_UTTERANCE_END_MS = 800;
export const DEEPGRAM_STT_KEEPALIVE_INTERVAL_MS = 30_000;

// Deepgram TTS -- CANONICAL values
export const DEEPGRAM_TTS_MODEL = 'aura-asteria-en';
export const DEEPGRAM_TTS_CLEAR_TIMEOUT_MS = 2_000;

// Jitter buffer limits
export const JITTER_BUFFER_MIN_MS = 200;
export const JITTER_BUFFER_MAX_MS = 400;
export const JITTER_BUFFER_CAP_MS = 2_000;

// Server frame validation
export const AUDIO_FRAME_MAX_BYTES = 8192; // reject frames larger than this
export const AUDIO_FRAME_WARN_BYTES = 1280; // warn on frames > 40ms

// WS backpressure
export const WS_BACKPRESSURE_BYTES = 65_536; // 64KB -- drop TTS chunks above this

// Redis
export const REDIS_SESSION_TTL_S = 900; // 15 minutes

// Rate limiting
export const AUTH_RATE_LIMIT_MAX = 10;
export const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
