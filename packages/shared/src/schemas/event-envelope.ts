import type { JSONSchemaType } from 'ajv';
import type { BaseEvent } from '../types/events.js';

export const eventEnvelopeSchema: JSONSchemaType<BaseEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    event_id: { type: 'string' },
    session_id: { type: 'string' },
    ts_ms: { type: 'number' },
    payload: { type: 'object', required: [], additionalProperties: true },
  },
  required: ['type', 'event_id', 'session_id', 'ts_ms', 'payload'],
  additionalProperties: false,
};
