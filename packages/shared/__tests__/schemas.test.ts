import { describe, it, expect } from 'vitest';
import {
  validateEventEnvelope,
  validateSessionStartPayload,
  validateSessionExtendPayload,
  validateServerInterruptPayload,
  validateAudioStartPayload,
  validateSessionPlan,
  validatePacingDecision,
} from '../src/schemas/index.js';

describe('eventEnvelope schema', () => {
  it('accepts a valid envelope', () => {
    const valid = {
      type: 'client.hello',
      event_id: 'evt_1',
      session_id: 'sess_1',
      ts_ms: Date.now(),
      payload: {},
    };
    expect(validateEventEnvelope(valid)).toBe(true);
  });

  it('rejects missing type', () => {
    const invalid = {
      event_id: 'evt_1',
      session_id: 'sess_1',
      ts_ms: Date.now(),
      payload: {},
    };
    expect(validateEventEnvelope(invalid)).toBe(false);
  });

  it('rejects missing payload', () => {
    const invalid = {
      type: 'client.hello',
      event_id: 'evt_1',
      session_id: 'sess_1',
      ts_ms: Date.now(),
    };
    expect(validateEventEnvelope(invalid)).toBe(false);
  });

  it('rejects extra properties', () => {
    const invalid = {
      type: 'client.hello',
      event_id: 'evt_1',
      session_id: 'sess_1',
      ts_ms: Date.now(),
      payload: {},
      extra: 'nope',
    };
    expect(validateEventEnvelope(invalid)).toBe(false);
  });
});

describe('sessionStartPayload schema', () => {
  it('accepts valid payload', () => {
    const valid = { requested_duration_ms: 600_000, content_id: 'cnt_abc123' };
    expect(validateSessionStartPayload(valid)).toBe(true);
  });

  it('accepts payload with optional user_goal', () => {
    const valid = {
      requested_duration_ms: 600_000,
      content_id: 'cnt_abc123',
      user_goal: 'Understand chapter 3',
    };
    expect(validateSessionStartPayload(valid)).toBe(true);
  });

  it('rejects missing content_id', () => {
    const invalid = { requested_duration_ms: 600_000 };
    expect(validateSessionStartPayload(invalid)).toBe(false);
  });

  it('rejects extra properties', () => {
    const invalid = { requested_duration_ms: 600_000, content_id: 'cnt_abc123', foo: 'bar' };
    expect(validateSessionStartPayload(invalid)).toBe(false);
  });
});

describe('sessionExtendPayload schema', () => {
  it('accepts valid payload', () => {
    expect(validateSessionExtendPayload({ extra_ms: 300_000 })).toBe(true);
  });

  it('rejects missing extra_ms', () => {
    expect(validateSessionExtendPayload({})).toBe(false);
  });

  it('rejects extra properties', () => {
    expect(validateSessionExtendPayload({ extra_ms: 300_000, foo: 'bar' })).toBe(false);
  });
});

describe('serverInterruptPayload schema', () => {
  it('accepts off_topic reason', () => {
    expect(validateServerInterruptPayload({ reason: 'off_topic', message: 'Stay on track.' })).toBe(true);
  });

  it('accepts time_pressure reason', () => {
    expect(validateServerInterruptPayload({ reason: 'time_pressure', message: 'Only 2 min left.' })).toBe(true);
  });

  it('accepts move_on reason', () => {
    expect(validateServerInterruptPayload({ reason: 'move_on', message: "Let's move to the next topic." })).toBe(true);
  });

  it('rejects unknown reason', () => {
    expect(validateServerInterruptPayload({ reason: 'bored', message: 'test' })).toBe(false);
  });

  it('rejects missing message', () => {
    expect(validateServerInterruptPayload({ reason: 'off_topic' })).toBe(false);
  });
});

describe('audioStartPayload schema', () => {
  it('accepts valid payload', () => {
    const valid = {
      codec: 'pcm_s16le',
      sample_rate_hz: 16000,
      channels: 1,
      chunk_ms: 20,
    };
    expect(validateAudioStartPayload(valid)).toBe(true);
  });

  it('rejects wrong codec', () => {
    const invalid = {
      codec: 'opus',
      sample_rate_hz: 16000,
      channels: 1,
      chunk_ms: 20,
    };
    expect(validateAudioStartPayload(invalid)).toBe(false);
  });

  it('rejects wrong sample rate', () => {
    const invalid = {
      codec: 'pcm_s16le',
      sample_rate_hz: 44100,
      channels: 1,
      chunk_ms: 20,
    };
    expect(validateAudioStartPayload(invalid)).toBe(false);
  });
});

describe('sessionPlan schema', () => {
  it('accepts a valid plan', () => {
    const valid = {
      plan_version: '1.0',
      session_goal: 'Test goal',
      total_time_ms: 180000,
      segments: [
        {
          segment_id: 'intro',
          name: 'Intro',
          duration_ms: 15000,
          mode: 'coach_talk',
          coach_prompt: 'Do something',
        },
      ],
      interrupt_rules: { hard_stop_at_end: true, warn_at_ms: [60000] },
    };
    expect(validateSessionPlan(valid)).toBe(true);
  });

  it('rejects invalid segment mode', () => {
    const invalid = {
      plan_version: '1.0',
      session_goal: 'Test goal',
      total_time_ms: 180000,
      segments: [
        {
          segment_id: 'intro',
          name: 'Intro',
          duration_ms: 15000,
          mode: 'invalid_mode',
          coach_prompt: 'Do something',
        },
      ],
      interrupt_rules: { hard_stop_at_end: true, warn_at_ms: [] },
    };
    expect(validateSessionPlan(invalid)).toBe(false);
  });

  it('rejects missing segments', () => {
    const invalid = {
      plan_version: '1.0',
      session_goal: 'Test goal',
      total_time_ms: 180000,
      interrupt_rules: { hard_stop_at_end: true, warn_at_ms: [] },
    };
    expect(validateSessionPlan(invalid)).toBe(false);
  });
});

describe('pacingDecision schema', () => {
  it('accepts a valid pacing decision', () => {
    const valid = {
      should_interrupt: false,
      interrupt_reason: 'none',
      message_to_user: '',
      recommended_next_action: 'continue',
      time_remaining_ms: 120000,
    };
    expect(validatePacingDecision(valid)).toBe(true);
  });

  it('rejects invalid interrupt_reason', () => {
    const invalid = {
      should_interrupt: true,
      interrupt_reason: 'bad_reason',
      message_to_user: 'test',
      recommended_next_action: 'continue',
      time_remaining_ms: 10000,
    };
    expect(validatePacingDecision(invalid)).toBe(false);
  });

  it('rejects invalid recommended_next_action', () => {
    const invalid = {
      should_interrupt: false,
      interrupt_reason: 'none',
      message_to_user: '',
      recommended_next_action: 'explode',
      time_remaining_ms: 120000,
    };
    expect(validatePacingDecision(invalid)).toBe(false);
  });
});
