/**
 * JSON Schema definitions for event payloads.
 * Used for both Ajv runtime validation and OpenAI Structured Outputs.
 * All objects have additionalProperties: false and all fields in required (OpenAI strict mode).
 */

export const sessionStartPayloadSchema = {
  type: 'object' as const,
  properties: {
    requested_duration_ms: { type: 'number' as const },
    content_id: { type: 'string' as const },
    user_goal: { type: 'string' as const, nullable: true as const },
  },
  required: ['requested_duration_ms', 'content_id'] as const,
  additionalProperties: false,
};

export const sessionExtendPayloadSchema = {
  type: 'object' as const,
  properties: {
    extra_ms: { type: 'number' as const },
  },
  required: ['extra_ms'] as const,
  additionalProperties: false,
};

export const serverInterruptPayloadSchema = {
  type: 'object' as const,
  properties: {
    reason: {
      type: 'string' as const,
      enum: ['off_topic', 'time_pressure', 'move_on'] as const,
    },
    message: { type: 'string' as const },
  },
  required: ['reason', 'message'] as const,
  additionalProperties: false,
};

export const audioStartPayloadSchema = {
  type: 'object' as const,
  properties: {
    codec: { type: 'string' as const, const: 'pcm_s16le' as const },
    sample_rate_hz: { type: 'number' as const, const: 16000 },
    channels: { type: 'number' as const, const: 1 },
    chunk_ms: { type: 'number' as const, const: 20 },
  },
  required: ['codec', 'sample_rate_hz', 'channels', 'chunk_ms'] as const,
  additionalProperties: false,
};

export const sessionPlanSchema = {
  type: 'object' as const,
  properties: {
    plan_version: { type: 'string' as const },
    session_goal: { type: 'string' as const },
    total_time_ms: { type: 'number' as const },
    segments: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          segment_id: { type: 'string' as const },
          name: { type: 'string' as const },
          duration_ms: { type: 'number' as const },
          mode: {
            type: 'string' as const,
            enum: ['coach_talk', 'user_talk', 'mixed'] as const,
          },
          coach_prompt: { type: 'string' as const },
          success_criteria: {
            type: 'array' as const,
            items: { type: 'string' as const },
            nullable: true as const,
          },
        },
        required: ['segment_id', 'name', 'duration_ms', 'mode', 'coach_prompt'] as const,
        additionalProperties: false,
      },
    },
    interrupt_rules: {
      type: 'object' as const,
      properties: {
        hard_stop_at_end: { type: 'boolean' as const },
        warn_at_ms: {
          type: 'array' as const,
          items: { type: 'number' as const },
        },
      },
      required: ['hard_stop_at_end', 'warn_at_ms'] as const,
      additionalProperties: false,
    },
  },
  required: ['plan_version', 'session_goal', 'total_time_ms', 'segments', 'interrupt_rules'] as const,
  additionalProperties: false,
};

export const pacingDecisionSchema = {
  type: 'object' as const,
  properties: {
    should_interrupt: { type: 'boolean' as const },
    interrupt_reason: {
      type: 'string' as const,
      enum: ['time_warning', 'off_topic', 'too_slow', 'too_long', 'none'] as const,
    },
    message_to_user: { type: 'string' as const },
    recommended_next_action: {
      type: 'string' as const,
      enum: ['continue', 'ask_followup', 'force_wrap_up', 'redo_first_line'] as const,
    },
    time_remaining_ms: { type: 'number' as const },
  },
  required: [
    'should_interrupt',
    'interrupt_reason',
    'message_to_user',
    'recommended_next_action',
    'time_remaining_ms',
  ] as const,
  additionalProperties: false,
};
