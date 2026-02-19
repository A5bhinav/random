import Ajv from 'ajv';
import { eventEnvelopeSchema } from './event-envelope.js';
import {
  sessionStartPayloadSchema,
  sessionExtendPayloadSchema,
  serverInterruptPayloadSchema,
  audioStartPayloadSchema,
  sessionPlanSchema,
  pacingDecisionSchema,
} from './payloads.js';
import {
  clientHelloPayloadSchema,
  authAnonymousPayloadSchema,
  clientResumePayloadSchema,
  emptyPayloadSchema,
} from './client-payloads.js';

export {
  eventEnvelopeSchema,
  sessionStartPayloadSchema,
  sessionExtendPayloadSchema,
  serverInterruptPayloadSchema,
  audioStartPayloadSchema,
  sessionPlanSchema,
  pacingDecisionSchema,
  clientHelloPayloadSchema,
  authAnonymousPayloadSchema,
  clientResumePayloadSchema,
  emptyPayloadSchema,
};

// Pre-compiled Ajv validators (singleton -- compile once, reuse)
const ajv = new Ajv({ allErrors: true, strict: false });

export const validateEventEnvelope = ajv.compile(eventEnvelopeSchema);
export const validateSessionStartPayload = ajv.compile(sessionStartPayloadSchema);
export const validateSessionExtendPayload = ajv.compile(sessionExtendPayloadSchema);
export const validateServerInterruptPayload = ajv.compile(serverInterruptPayloadSchema);
export const validateAudioStartPayload = ajv.compile(audioStartPayloadSchema);
export const validateSessionPlan = ajv.compile(sessionPlanSchema);
export const validatePacingDecision = ajv.compile(pacingDecisionSchema);
export const validateClientHelloPayload = ajv.compile(clientHelloPayloadSchema);
export const validateAuthAnonymousPayload = ajv.compile(authAnonymousPayloadSchema);
export const validateClientResumePayload = ajv.compile(clientResumePayloadSchema);
export const validateEmptyPayload = ajv.compile(emptyPayloadSchema);

/** Map event type → payload validator for client events */
export const clientPayloadValidators: Record<string, ReturnType<typeof ajv.compile>> = {
  'client.hello': validateClientHelloPayload,
  'auth.anonymous': validateAuthAnonymousPayload,
  'session.start': validateSessionStartPayload,
  'session.extend': validateSessionExtendPayload,
  'audio.start': validateAudioStartPayload,
  'audio.stop': validateEmptyPayload,
  'client.barge_in': validateEmptyPayload,
  'client.ping': validateEmptyPayload,
  'client.resume': validateClientResumePayload,
};
