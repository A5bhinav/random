import { describe, it, expect } from 'vitest';
import {
  validateClientHelloPayload,
  validateAuthAnonymousPayload,
  validateClientResumePayload,
  validateEmptyPayload,
  clientPayloadValidators,
} from '../src/schemas/index.js';

describe('clientHelloPayload schema', () => {
  it('accepts valid payload', () => {
    const valid = {
      protocol_version: '1.0',
      app_version: '0.0.1',
      device_info: { platform: 'ios', os_version: '17.0' },
    };
    expect(validateClientHelloPayload(valid)).toBe(true);
  });

  it('rejects missing protocol_version', () => {
    const invalid = {
      app_version: '0.0.1',
      device_info: { platform: 'ios', os_version: '17.0' },
    };
    expect(validateClientHelloPayload(invalid)).toBe(false);
  });

  it('rejects invalid platform', () => {
    const invalid = {
      protocol_version: '1.0',
      app_version: '0.0.1',
      device_info: { platform: 'windows', os_version: '11' },
    };
    expect(validateClientHelloPayload(invalid)).toBe(false);
  });

  it('rejects extra properties in device_info', () => {
    const invalid = {
      protocol_version: '1.0',
      app_version: '0.0.1',
      device_info: { platform: 'ios', os_version: '17.0', extra: true },
    };
    expect(validateClientHelloPayload(invalid)).toBe(false);
  });
});

describe('authAnonymousPayload schema', () => {
  it('accepts valid payload', () => {
    expect(validateAuthAnonymousPayload({ token: 'jwt.token.here' })).toBe(true);
  });

  it('rejects missing token', () => {
    expect(validateAuthAnonymousPayload({})).toBe(false);
  });

  it('rejects non-string token', () => {
    expect(validateAuthAnonymousPayload({ token: 123 })).toBe(false);
  });
});

describe('clientResumePayload schema', () => {
  it('accepts valid payload', () => {
    const valid = { resume_token: 'tok_123', last_server_event_id: 'evt_456' };
    expect(validateClientResumePayload(valid)).toBe(true);
  });

  it('rejects missing last_server_event_id', () => {
    expect(validateClientResumePayload({ resume_token: 'tok_123' })).toBe(false);
  });
});

describe('emptyPayload schema', () => {
  it('accepts empty object', () => {
    expect(validateEmptyPayload({})).toBe(true);
  });

  it('rejects object with properties', () => {
    expect(validateEmptyPayload({ foo: 'bar' })).toBe(false);
  });
});

describe('clientPayloadValidators map', () => {
  it('has a validator for every client event type', () => {
    const expectedTypes = [
      'client.hello',
      'auth.anonymous',
      'session.start',
      'session.extend',
      'audio.start',
      'audio.stop',
      'client.barge_in',
      'client.ping',
      'client.resume',
    ];
    for (const type of expectedTypes) {
      expect(clientPayloadValidators[type]).toBeDefined();
    }
  });
});
