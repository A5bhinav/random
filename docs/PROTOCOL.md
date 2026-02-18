# WebSocket Protocol v1.0

## Connection Lifecycle

```
Client                                Server
  │                                      │
  │──── connect GET /v1/ws ─────────────>│
  │<──── server.hello ──────────────────│
  │──── client.hello ──────────────────>│
  │──── auth.anonymous (JWT) ──────────>│
  │<──── auth.ok / auth.error ──────────│
  │──── session.start ─────────────────>│
  │<──── session.start_ack ─────────────│
  │<──── session.plan ──────────────────│
  │<──── timer.tick (1Hz) ──────────────│
  │                                      │
  │──── audio.start ───────────────────>│
  │──── [binary PCM frames] ───────────>│
  │<──── stt.partial ───────────────────│
  │──── audio.stop ────────────────────>│
  │<──── stt.final ─────────────────────│
  │<──── coach.text ────────────────────│
  │<──── tts.start ─────────────────────│
  │<──── [binary TTS frames] ──────────│
  │<──── tts.end ───────────────────────│
  │                                      │
  │──── client.barge_in ───────────────>│
  │<──── tts.cleared ───────────────────│
  │                                      │
  │<──── timer.expired ─────────────────│
  │<──── server.goodbye ────────────────│
  │──── close ──────────────────────────│
```

## Event Envelope

Every JSON event uses this structure:

```json
{
  "type": "event.type",
  "event_id": "uuid",
  "session_id": "uuid",
  "ts_ms": 1234567890,
  "payload": { ... }
}
```

## Client Events

| Type | Payload | Phase |
|------|---------|-------|
| `client.hello` | `{ protocol_version, app_version, device_info: { platform, os_version } }` | CONNECTED |
| `auth.anonymous` | `{ token }` | HELLO_RECEIVED |
| `session.start` | `{ requested_duration_ms, drill_id, user_goal? }` | AUTHENTICATED |
| `audio.start` | `{ codec: "pcm_s16le", sample_rate_hz: 16000, channels: 1, chunk_ms: 20 }` | SESSION_ACTIVE |
| `audio.stop` | `{}` | SESSION_ACTIVE |
| `client.barge_in` | `{}` | SESSION_ACTIVE |
| `client.ping` | `{}` | Any (heartbeat) |
| `client.resume` | `{ resume_token, last_server_event_id }` | Phase 1.1 |

## Server Events

| Type | Payload |
|------|---------|
| `server.hello` | `{ protocol_version, connection_id }` |
| `auth.ok` | `{ user_id }` |
| `auth.error` | `{ message }` |
| `session.start_ack` | `{ session_id, duration_ms, start_ts }` |
| `session.plan` | `{ plan: SessionPlan }` |
| `timer.tick` | `{ remaining_ms, segment_name }` |
| `timer.warning` | `{ remaining_ms, message }` |
| `timer.expired` | `{}` |
| `stt.partial` | `{ text, confidence }` |
| `stt.final` | `{ text, confidence, words? }` |
| `coach.text` | `{ text, turn_type }` |
| `tts.start` | `{ tts_seq }` |
| `tts.end` | `{ tts_seq }` |
| `tts.cleared` | `{}` |
| `server.error` | `{ code: ErrorCode, message }` |
| `server.goodbye` | `{ reason }` |

## Binary Framing Rules

1. **Direction distinguishes type:** Client-to-Server binary = user audio. Server-to-Client binary = TTS audio.
2. **Binary before `audio.start` is an error:** Server sends `server.error` with `ERR_SESSION_STATE` and closes connection with code 4002.
3. **Target frame size:** 640 bytes (20ms at 16kHz mono 16-bit).
4. Server accepts up to 1280 bytes with warning. Drops frames > 8192 bytes silently.
5. No interleaving binary and JSON in the same WebSocket message.
6. Jitter buffer hard cap: 2000ms. Server drops TTS if `bufferedAmount > 64KB`.

## Error Codes

| Code | Meaning |
|------|---------|
| `ERR_UNAUTHORIZED` | Invalid or expired JWT |
| `ERR_BAD_EVENT_SCHEMA` | Malformed JSON, invalid envelope, or invalid payload |
| `ERR_UNSUPPORTED_AUDIO_FORMAT` | Wrong codec/sample rate |
| `ERR_PROVIDER_STT_UNAVAILABLE` | Deepgram STT connection failed |
| `ERR_PROVIDER_TTS_UNAVAILABLE` | Deepgram TTS connection failed |
| `ERR_LLM_UNAVAILABLE` | OpenAI API error |
| `ERR_SESSION_STATE` | Event received in wrong state |
| `ERR_RATE_LIMIT` | Too many requests |

## WebSocket Close Codes

| Code | Meaning |
|------|---------|
| 1000 | Normal session end (timer expired) |
| 4001 | Unsupported protocol version |
| 4002 | Binary before audio.start |
| 4003 | Authentication failed |
| 4008 | Heartbeat timeout (no client.ping in 30s) |

## State Machine

```
IDLE → CONFIGURING → PLANNING → BRIEFING → RUNNING_REP → WRAPPING → ENDED
                                    │              │           │
                                    └──────────────┴───────────┘
                                         timer_expired / error → ENDED
```
