/**
 * JSON Schema definitions for all client event payloads.
 * All objects have additionalProperties: false per OpenAI strict mode requirements.
 */

export const clientHelloPayloadSchema = {
  type: 'object' as const,
  properties: {
    protocol_version: { type: 'string' as const },
    app_version: { type: 'string' as const },
    device_info: {
      type: 'object' as const,
      properties: {
        platform: { type: 'string' as const, enum: ['ios', 'android'] as const },
        os_version: { type: 'string' as const },
      },
      required: ['platform', 'os_version'] as const,
      additionalProperties: false,
    },
  },
  required: ['protocol_version', 'app_version', 'device_info'] as const,
  additionalProperties: false,
};

export const authAnonymousPayloadSchema = {
  type: 'object' as const,
  properties: {
    token: { type: 'string' as const },
  },
  required: ['token'] as const,
  additionalProperties: false,
};

export const clientResumePayloadSchema = {
  type: 'object' as const,
  properties: {
    resume_token: { type: 'string' as const },
    last_server_event_id: { type: 'string' as const },
  },
  required: ['resume_token', 'last_server_event_id'] as const,
  additionalProperties: false,
};

export const emptyPayloadSchema = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};
