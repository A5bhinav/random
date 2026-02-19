import { SessionState, ErrorCode } from '@coach/shared';

export type SideEffect =
  | 'start_timer'
  | 'generate_plan'
  | 'start_briefing_tts'
  | 'start_stt'
  | 'stop_stt'
  | 'generate_coach_turn'
  | 'start_tts'
  | 'clear_tts'
  | 'persist_end'
  | 'extend_timer'
  | 'replan_remaining';

export type SessionEvent =
  | 'session_start'
  | 'config_validated'
  | 'content_loaded'
  | 'plan_ready'
  | 'briefing_complete'
  | 'enter_feedback'
  | 'session_extend'
  | 'timer_expired'
  | 'error'
  | 'audio_start'
  | 'audio_stop'
  | 'barge_in';

export interface TransitionResult {
  newState: SessionState;
  sideEffects: SideEffect[];
}

interface TransitionEntry {
  to: SessionState;
  sideEffects: SideEffect[];
}

const TRANSITIONS: Record<string, TransitionEntry> = {
  [`${SessionState.IDLE}:session_start`]: {
    to: SessionState.CONFIGURING,
    sideEffects: [],
  },
  [`${SessionState.CONFIGURING}:config_validated`]: {
    to: SessionState.PLANNING,
    sideEffects: ['generate_plan'],
  },
  [`${SessionState.CONFIGURING}:content_loaded`]: {
    to: SessionState.PLANNING,
    sideEffects: ['generate_plan'],
  },
  [`${SessionState.PLANNING}:plan_ready`]: {
    to: SessionState.BRIEFING,
    sideEffects: ['start_briefing_tts', 'start_timer'],
  },
  [`${SessionState.BRIEFING}:briefing_complete`]: {
    to: SessionState.RUNNING_REP,
    sideEffects: ['start_stt'],
  },
  [`${SessionState.RUNNING_REP}:enter_feedback`]: {
    to: SessionState.WRAPPING,
    sideEffects: ['stop_stt', 'generate_coach_turn'],
  },
  [`${SessionState.RUNNING_REP}:audio_stop`]: {
    to: SessionState.RUNNING_REP,
    sideEffects: ['generate_coach_turn'],
  },
  [`${SessionState.RUNNING_REP}:barge_in`]: {
    to: SessionState.RUNNING_REP,
    sideEffects: ['clear_tts'],
  },
  [`${SessionState.RUNNING_REP}:session_extend`]: {
    to: SessionState.RUNNING_REP,
    sideEffects: ['extend_timer', 'replan_remaining'],
  },
  [`${SessionState.WRAPPING}:barge_in`]: {
    to: SessionState.WRAPPING,
    sideEffects: ['clear_tts'],
  },
};

// Timer expired can happen from any active state
const TIMER_EXPIRED_STATES = new Set([
  SessionState.BRIEFING,
  SessionState.RUNNING_REP,
  SessionState.WRAPPING,
]);

// Error can happen from any non-ENDED state
const ERROR_STATES = new Set([
  SessionState.IDLE,
  SessionState.CONFIGURING,
  SessionState.PLANNING,
  SessionState.BRIEFING,
  SessionState.RUNNING_REP,
  SessionState.WRAPPING,
]);

export function transition(current: SessionState, event: SessionEvent): TransitionResult {
  // Timer expired: special case -- reachable from multiple active states
  if (event === 'timer_expired') {
    if (TIMER_EXPIRED_STATES.has(current)) {
      return {
        newState: SessionState.ENDED,
        sideEffects: ['stop_stt', 'clear_tts', 'persist_end'],
      };
    }
    throw new SessionStateError(current, event);
  }

  // Error: reachable from any non-ENDED state
  if (event === 'error') {
    if (ERROR_STATES.has(current)) {
      return {
        newState: SessionState.ENDED,
        sideEffects: ['persist_end'],
      };
    }
    throw new SessionStateError(current, event);
  }

  // Look up in transition table
  const key = `${current}:${event}`;
  const entry = TRANSITIONS[key];

  if (!entry) {
    throw new SessionStateError(current, event);
  }

  return {
    newState: entry.to,
    sideEffects: [...entry.sideEffects],
  };
}

export class SessionStateError extends Error {
  public readonly code = ErrorCode.ERR_SESSION_STATE;

  constructor(
    public readonly currentState: SessionState,
    public readonly event: SessionEvent,
  ) {
    super(`Invalid transition: ${currentState} + ${event}`);
    this.name = 'SessionStateError';
  }
}
