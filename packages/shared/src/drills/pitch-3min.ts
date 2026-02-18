import type { SessionPlan } from '../types/session.js';

export const PITCH_3MIN_DRILL = {
  drill_id: 'pitch_3min_v1',
  name: '3-Minute Investor Pitch',
  default_duration_ms: 180_000,
  description: 'Practice your investor pitch under time pressure.',
} as const;

export const PITCH_3MIN_DEFAULT_PLAN: SessionPlan = {
  plan_version: '1.0',
  session_goal: 'Deliver a compelling 3-minute investor pitch',
  total_time_ms: 180_000,
  segments: [
    {
      segment_id: 'intro',
      name: 'Coach sets context',
      duration_ms: 15_000,
      mode: 'coach_talk',
      coach_prompt:
        'Set the scene: you are a VC hearing this pitch. Explain the format in 2 sentences.',
    },
    {
      segment_id: 'pitch',
      name: 'User pitch rep',
      duration_ms: 120_000,
      mode: 'mixed',
      coach_prompt:
        'Listen to the pitch. Interrupt with one tough question at the 60s mark.',
      success_criteria: ['Clear problem statement', 'Market size', 'Ask articulated'],
    },
    {
      segment_id: 'feedback',
      name: 'Coach feedback',
      duration_ms: 45_000,
      mode: 'coach_talk',
      coach_prompt:
        'Give exactly 2 specific strength bullets, 1 improvement, and 1 redo line. Be direct.',
    },
  ],
  interrupt_rules: { hard_stop_at_end: true, warn_at_ms: [60_000, 15_000] },
};
