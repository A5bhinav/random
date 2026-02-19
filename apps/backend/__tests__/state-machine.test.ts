import { describe, it, expect } from 'vitest';
import { transition, SessionStateError } from '../src/orchestrator/state-machine.js';
import { SessionState, ErrorCode } from '@coach/shared';

describe('session state machine', () => {
  describe('happy path transitions', () => {
    it('IDLE → CONFIGURING on session_start', () => {
      const result = transition(SessionState.IDLE, 'session_start');
      expect(result.newState).toBe(SessionState.CONFIGURING);
    });

    it('CONFIGURING → PLANNING on config_validated', () => {
      const result = transition(SessionState.CONFIGURING, 'config_validated');
      expect(result.newState).toBe(SessionState.PLANNING);
      expect(result.sideEffects).toContain('generate_plan');
    });

    it('PLANNING → BRIEFING on plan_ready', () => {
      const result = transition(SessionState.PLANNING, 'plan_ready');
      expect(result.newState).toBe(SessionState.BRIEFING);
      expect(result.sideEffects).toContain('start_briefing_tts');
      expect(result.sideEffects).toContain('start_timer');
    });

    it('BRIEFING → RUNNING_REP on briefing_complete', () => {
      const result = transition(SessionState.BRIEFING, 'briefing_complete');
      expect(result.newState).toBe(SessionState.RUNNING_REP);
      expect(result.sideEffects).toContain('start_stt');
    });

    it('RUNNING_REP → WRAPPING on enter_feedback', () => {
      const result = transition(SessionState.RUNNING_REP, 'enter_feedback');
      expect(result.newState).toBe(SessionState.WRAPPING);
      expect(result.sideEffects).toContain('stop_stt');
      expect(result.sideEffects).toContain('generate_coach_turn');
    });
  });

  describe('in-state transitions', () => {
    it('RUNNING_REP stays on audio_stop (triggers coach turn)', () => {
      const result = transition(SessionState.RUNNING_REP, 'audio_stop');
      expect(result.newState).toBe(SessionState.RUNNING_REP);
      expect(result.sideEffects).toContain('generate_coach_turn');
    });

    it('RUNNING_REP stays on barge_in (clears TTS)', () => {
      const result = transition(SessionState.RUNNING_REP, 'barge_in');
      expect(result.newState).toBe(SessionState.RUNNING_REP);
      expect(result.sideEffects).toContain('clear_tts');
    });

    it('WRAPPING stays on barge_in (clears TTS)', () => {
      const result = transition(SessionState.WRAPPING, 'barge_in');
      expect(result.newState).toBe(SessionState.WRAPPING);
      expect(result.sideEffects).toContain('clear_tts');
    });

    it('RUNNING_REP stays on session_extend (extend_timer + replan_remaining)', () => {
      const result = transition(SessionState.RUNNING_REP, 'session_extend');
      expect(result.newState).toBe(SessionState.RUNNING_REP);
      expect(result.sideEffects).toContain('extend_timer');
      expect(result.sideEffects).toContain('replan_remaining');
    });
  });

  describe('content_loaded transition', () => {
    it('CONFIGURING → PLANNING on content_loaded (triggers generate_plan)', () => {
      const result = transition(SessionState.CONFIGURING, 'content_loaded');
      expect(result.newState).toBe(SessionState.PLANNING);
      expect(result.sideEffects).toContain('generate_plan');
    });
  });

  describe('timer_expired', () => {
    it('BRIEFING → ENDED on timer_expired', () => {
      const result = transition(SessionState.BRIEFING, 'timer_expired');
      expect(result.newState).toBe(SessionState.ENDED);
      expect(result.sideEffects).toContain('persist_end');
      expect(result.sideEffects).toContain('stop_stt');
      expect(result.sideEffects).toContain('clear_tts');
    });

    it('RUNNING_REP → ENDED on timer_expired', () => {
      const result = transition(SessionState.RUNNING_REP, 'timer_expired');
      expect(result.newState).toBe(SessionState.ENDED);
    });

    it('WRAPPING → ENDED on timer_expired', () => {
      const result = transition(SessionState.WRAPPING, 'timer_expired');
      expect(result.newState).toBe(SessionState.ENDED);
    });

    it('throws on timer_expired from IDLE', () => {
      expect(() => transition(SessionState.IDLE, 'timer_expired')).toThrow(SessionStateError);
    });
  });

  describe('error transitions', () => {
    const activeStates = [
      SessionState.IDLE,
      SessionState.CONFIGURING,
      SessionState.PLANNING,
      SessionState.BRIEFING,
      SessionState.RUNNING_REP,
      SessionState.WRAPPING,
    ];

    for (const state of activeStates) {
      it(`${state} → ENDED on error`, () => {
        const result = transition(state, 'error');
        expect(result.newState).toBe(SessionState.ENDED);
        expect(result.sideEffects).toContain('persist_end');
      });
    }

    it('ENDED + error throws', () => {
      expect(() => transition(SessionState.ENDED, 'error')).toThrow(SessionStateError);
    });
  });

  describe('ENDED is terminal', () => {
    const events: Array<'session_start' | 'config_validated' | 'plan_ready' | 'briefing_complete' | 'timer_expired' | 'barge_in'> = [
      'session_start',
      'config_validated',
      'plan_ready',
      'briefing_complete',
      'timer_expired',
      'barge_in',
    ];

    for (const event of events) {
      it(`ENDED + ${event} throws SessionStateError`, () => {
        expect(() => transition(SessionState.ENDED, event)).toThrow(SessionStateError);
      });
    }
  });

  describe('illegal transitions throw with correct error code', () => {
    it('IDLE + briefing_complete throws', () => {
      expect(() => transition(SessionState.IDLE, 'briefing_complete')).toThrow(SessionStateError);
    });

    it('error includes ERR_SESSION_STATE code', () => {
      try {
        transition(SessionState.IDLE, 'barge_in');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionStateError);
        expect((err as SessionStateError).code).toBe(ErrorCode.ERR_SESSION_STATE);
        expect((err as SessionStateError).currentState).toBe(SessionState.IDLE);
        expect((err as SessionStateError).event).toBe('barge_in');
      }
    });
  });
});
