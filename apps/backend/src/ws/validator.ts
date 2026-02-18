import {
  validateEventEnvelope,
  clientPayloadValidators,
  type BaseEvent,
  ErrorCode,
} from '@coach/shared';

export type ValidationResult =
  | { valid: true; event: BaseEvent }
  | { valid: false; errorCode: ErrorCode; message: string };

/**
 * Validates an incoming JSON message:
 * 1. Parse JSON
 * 2. Validate event envelope structure
 * 3. Validate payload against event-type-specific schema
 */
export function validateClientMessage(raw: string): ValidationResult {
  // Step 1: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      errorCode: ErrorCode.ERR_BAD_EVENT_SCHEMA,
      message: 'Invalid JSON',
    };
  }

  // Step 2: Validate envelope
  if (!validateEventEnvelope(parsed)) {
    return {
      valid: false,
      errorCode: ErrorCode.ERR_BAD_EVENT_SCHEMA,
      message: `Invalid event envelope: ${formatErrors(validateEventEnvelope.errors)}`,
    };
  }

  const event = parsed as BaseEvent;

  // Step 3: Validate payload for this event type
  const payloadValidator = clientPayloadValidators[event.type];
  if (!payloadValidator) {
    return {
      valid: false,
      errorCode: ErrorCode.ERR_BAD_EVENT_SCHEMA,
      message: `Unknown event type: ${event.type}`,
    };
  }

  if (!payloadValidator(event.payload)) {
    return {
      valid: false,
      errorCode: ErrorCode.ERR_BAD_EVENT_SCHEMA,
      message: `Invalid payload for ${event.type}: ${formatErrors(payloadValidator.errors)}`,
    };
  }

  return { valid: true, event };
}

function formatErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return 'unknown error';
  return errors
    .map((e: { instancePath?: string; message?: string }) =>
      `${e.instancePath || '/'}: ${e.message || 'unknown'}`,
    )
    .join('; ');
}
