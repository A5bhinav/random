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

/** A parsed chunk of user-uploaded content (PDF/PPTX). */
export interface ContentChunk {
  index: number;
  text: string;
  char_count: number;
}

/** Metadata and parsed content from a user-uploaded file. */
export interface ContentPack {
  content_id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  chunks: ContentChunk[];
  created_at: string;
}

/** Per-topic coverage state tracked during a session. */
export interface TopicCoverage {
  /** Index into SessionPlan.segments */
  segment_index: number;
  segment_id: string;
  status: 'pending' | 'active' | 'done' | 'skipped';
  /** ISO timestamp when the topic became active */
  started_at?: string;
  /** ISO timestamp when the topic was marked done or skipped */
  ended_at?: string;
}

/** Serializable session state cached in Redis (15-min TTL). */
export interface LiveSessionState {
  session_id: string;
  user_id: string;
  content_id: string;
  state: SessionState;
  plan: SessionPlan | null;
  start_ts: number;
  elapsed_ms: number;
  current_segment_index: number;
  current_topic_index: number;
  topics_coverage: TopicCoverage[];
  turn_index: number;
  last_client_audio_seq: number;
  last_server_tts_seq: number;
}
