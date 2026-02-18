export enum SessionState {
  IDLE = 'IDLE',
  CONFIGURING = 'CONFIGURING',
  PLANNING = 'PLANNING',
  BRIEFING = 'BRIEFING',
  RUNNING_REP = 'RUNNING_REP',
  WRAPPING = 'WRAPPING',
  ENDED = 'ENDED',
}

export interface SessionPlan {
  plan_version: string;
  session_goal: string;
  total_time_ms: number;
  segments: SessionSegment[];
  interrupt_rules: {
    hard_stop_at_end: boolean;
    warn_at_ms: number[];
  };
}

export interface SessionSegment {
  segment_id: string;
  name: string;
  duration_ms: number;
  mode: 'coach_talk' | 'user_talk' | 'mixed';
  coach_prompt: string;
  success_criteria?: string[];
}

export interface PacingDecision {
  should_interrupt: boolean;
  interrupt_reason: 'time_warning' | 'off_topic' | 'too_slow' | 'too_long' | 'none';
  message_to_user: string;
  recommended_next_action: 'continue' | 'ask_followup' | 'force_wrap_up' | 'redo_first_line';
  time_remaining_ms: number;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}
