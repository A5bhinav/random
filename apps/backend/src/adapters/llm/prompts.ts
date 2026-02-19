import type { ContentChunk, SessionPlan } from '@coach/shared';

// ── Plan generation ───────────────────────────────────────────────────────────

export const PLAN_SYSTEM_PROMPT = `\
You are an expert Socratic learning coach designing a time-boxed study session.
The user has uploaded their own material (lecture slides or PDF) and wants to be tested on it within a fixed time budget.

Your job: generate a structured session plan where you (the AI coach) ask probing questions topic by topic, the user explains their understanding, and you dig deeper with follow-ups.

Rules:
- Identify 3-7 logical topics from the provided content chunks
- Allocate time proportionally to content density (longer/denser chunks get more time)
- Each segment uses mode "mixed": coach asks questions, user responds, coach probes
- All segment duration_ms values must sum to exactly total_time_ms
- plan_version must be "1.0"
- coach_prompt describes what the coach should focus on in that segment (one sentence)
- success_criteria: 2-3 things the user should be able to explain by segment end
- No segment should be shorter than 60000ms (1 minute) or longer than total_time_ms / 2
- The last segment should always include a brief wrap-up / "what did we miss?" check`;

export function buildPlanUserPrompt(
  contentChunks: ContentChunk[],
  durationMs: number,
): string {
  const totalChars = contentChunks.reduce((sum, c) => sum + c.char_count, 0);
  const contentText = contentChunks
    .map((c) => `[Chunk ${c.index}]\n${c.text}`)
    .join('\n\n---\n\n');

  return `\
Content material (${contentChunks.length} chunks, ${totalChars} total chars):

${contentText}

Session duration: ${Math.round(durationMs / 1000)} seconds (${Math.round(durationMs / 60000)} minutes).

Generate a session plan covering all major topics in the content. Divide the material into logical segments. Allocate time proportionally to content density.`;
}

// ── Coach turn (streaming) ────────────────────────────────────────────────────

export function buildCoachSystemPrompt(
  segmentName: string,
  timeRemainingMs: number,
  currentChunkText: string,
): string {
  const timeRemainingSec = Math.round(timeRemainingMs / 1000);
  const isWrapping = timeRemainingMs < 30_000;

  return `\
You are a sharp Socratic study coach conducting a live voice learning session.
You ask one probing question at a time, then follow up based on the user's answer.

Rules:
- Maximum 2 sentences per response — this is spoken aloud, be concise
- No markdown, no lists, no bullet points, no emojis
- Focus on understanding, not recitation: ask "why", "how", "what happens if..."
- Current topic: ${segmentName}
- Time remaining in session: ${timeRemainingSec} seconds
${isWrapping ? '- This is the final wrap-up — ask the user to summarize one key takeaway in their own words.' : ''}

Relevant content for the current topic:
${currentChunkText}`;
}

export interface CoachTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function buildCoachMessages(opts: {
  systemPrompt: string;
  history: CoachTurnMessage[];
  latestUserText: string;
}): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return [
    { role: 'system', content: opts.systemPrompt },
    ...opts.history,
    { role: 'user', content: opts.latestUserText },
  ];
}

// ── Pacing decision ───────────────────────────────────────────────────────────

export const PACING_SYSTEM_PROMPT = `\
You are a session pacing engine evaluating whether to interrupt the user during a voice learning session.

Evaluate these signals:
1. Time remaining vs. topics remaining — are we behind schedule?
2. The user's last transcript — are they on-topic or rambling?
3. How long the current topic has been active

Respond with a structured pacing decision. Be conservative with interrupts — only fire if clearly needed.
message_to_user must be a single spoken sentence the coach will say aloud (no markdown).`;

export function buildPacingUserPrompt(opts: {
  segmentName: string;
  segmentDurationMs: number;
  segmentElapsedMs: number;
  topicsDone: number;
  topicsTotal: number;
  timeRemainingMs: number;
  lastUserTranscript: string;
  currentChunkSnippet: string;
}): string {
  const timeRemainingSec = Math.round(opts.timeRemainingMs / 1000);
  const segmentOverrunMs = Math.max(0, opts.segmentElapsedMs - opts.segmentDurationMs);

  return `\
Current topic: "${opts.segmentName}"
Topic budget: ${Math.round(opts.segmentDurationMs / 1000)}s | Elapsed: ${Math.round(opts.segmentElapsedMs / 1000)}s | Overrun: ${Math.round(segmentOverrunMs / 1000)}s
Topics done: ${opts.topicsDone} / ${opts.topicsTotal}
Session time remaining: ${timeRemainingSec}s

Last user transcript:
"${opts.lastUserTranscript}"

Expected topic content:
${opts.currentChunkSnippet}`;
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

export const SCORECARD_SYSTEM_PROMPT = `\
You are a learning coach generating a post-session scorecard.
Be specific and constructive. Reference actual content from the session.
Format: plain text, no markdown, 3-5 sentences total. Spoken-word friendly.`;

export function buildScorecardUserPrompt(
  contentChunks: ContentChunk[],
  plan: SessionPlan,
  transcriptSummary: string,
): string {
  const topicNames = plan.segments.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  const contentOverview = contentChunks
    .slice(0, 3)
    .map((c) => c.text.slice(0, 200))
    .join(' ... ');

  return `\
Session topics:
${topicNames}

Content overview:
${contentOverview}

What the user said (transcript summary):
${transcriptSummary}

Generate a 3-5 sentence spoken scorecard: what they demonstrated well, one specific gap, and one thing to review next time.`;
}
