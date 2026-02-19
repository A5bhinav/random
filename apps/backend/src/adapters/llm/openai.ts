import OpenAI from 'openai';
import type { ContentChunk, SessionPlan, PacingDecision } from '@coach/shared';
import { sessionPlanSchema, pacingDecisionSchema } from '@coach/shared';
import {
  PLAN_SYSTEM_PROMPT,
  PACING_SYSTEM_PROMPT,
  SCORECARD_SYSTEM_PROMPT,
  buildPlanUserPrompt,
  buildCoachSystemPrompt,
  buildCoachMessages,
  buildPacingUserPrompt,
  buildScorecardUserPrompt,
  type CoachTurnMessage,
} from './prompts.js';

export interface CoachTurnContext {
  contentChunks: ContentChunk[];
  plan: SessionPlan;
  currentSegmentIndex: number;
  timeRemainingMs: number;
  history: CoachTurnMessage[];
  latestUserText: string;
}

export interface PacingContext {
  segmentName: string;
  segmentDurationMs: number;
  segmentElapsedMs: number;
  topicsDone: number;
  topicsTotal: number;
  timeRemainingMs: number;
  lastUserTranscript: string;
  currentChunkSnippet: string;
}

/**
 * OpenAI LLM adapter for the coach pipeline.
 *
 * Responsibilities:
 *   generatePlan    — Structured Outputs (non-streaming); runs once at session start
 *   streamCoachTurn — streaming chat completion; yields tokens for the TTS pipeline
 *   decidePacing    — Structured Outputs (non-streaming); runs every 5s during session
 *   generateScorecard — plain-text chat completion; runs at session end
 *
 * Key constraint (from OpenAI docs):
 *   Structured Outputs + stream: true is NOT supported.
 *   Plan/pacing use non-streaming + json_schema. Coach turns use streaming + plain text.
 */
export class OpenAILLMAdapter {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  // ── Plan generation ────────────────────────────────────────────────────────

  /**
   * Generate a session plan from content chunks.
   * Retries up to `retries` times if the response cannot be parsed.
   */
  async generatePlan(
    contentChunks: ContentChunk[],
    durationMs: number,
    retries = 2,
  ): Promise<SessionPlan> {
    const userPrompt = buildPlanUserPrompt(contentChunks, durationMs);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: 'gpt-4o-mini',
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'SessionPlan',
              // strict: false because sessionPlanSchema has an optional field (success_criteria)
              strict: false,
              schema: sessionPlanSchema as Record<string, unknown>,
            },
          },
          messages: [
            { role: 'system', content: PLAN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        });

        const raw = response.choices[0]?.message?.content;
        if (!raw) throw new Error('Empty plan response from LLM');
        return JSON.parse(raw) as SessionPlan;
      } catch (err) {
        if (attempt === retries) throw err;
        // brief pause before retry
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    throw new Error('generatePlan: all retries exhausted');
  }

  // ── Streaming coach turn ───────────────────────────────────────────────────

  /**
   * Stream a coach response turn.
   * Yields tokens as they arrive from OpenAI.
   * Callers should pipe tokens into a TextChunker and then to the TTS adapter.
   *
   * Barge-in: pass an AbortSignal; abort it to stop the stream mid-response.
   * The generator will throw an AbortError — callers should catch and ignore it.
   */
  async *streamCoachTurn(
    ctx: CoachTurnContext,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const segment = ctx.plan.segments[ctx.currentSegmentIndex];
    const currentChunkText = ctx.contentChunks
      .slice(ctx.currentSegmentIndex, ctx.currentSegmentIndex + 2)
      .map((c) => c.text)
      .join('\n\n');

    const systemPrompt = buildCoachSystemPrompt(
      segment?.name ?? 'Current Topic',
      ctx.timeRemainingMs,
      currentChunkText,
    );

    const messages = buildCoachMessages({
      systemPrompt,
      history: ctx.history,
      latestUserText: ctx.latestUserText,
    });

    const stream = await this.client.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        stream: true,
        max_tokens: 150,
        temperature: 0.7,
        messages,
      },
      { signal },
    );

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }

  // ── Pacing decision ────────────────────────────────────────────────────────

  /**
   * Ask the LLM whether to interrupt the user.
   * Non-streaming, Structured Outputs with strict: true (all fields required).
   */
  async decidePacing(ctx: PacingContext): Promise<PacingDecision> {
    const userPrompt = buildPacingUserPrompt(ctx);

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'PacingDecision',
          strict: true,
          schema: pacingDecisionSchema as Record<string, unknown>,
        },
      },
      messages: [
        { role: 'system', content: PACING_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty pacing response from LLM');
    return JSON.parse(raw) as PacingDecision;
  }

  // ── Scorecard ──────────────────────────────────────────────────────────────

  /** Generate a spoken session scorecard. Plain text, non-streaming. */
  async generateScorecard(
    contentChunks: ContentChunk[],
    plan: SessionPlan,
    transcriptSummary: string,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [
        { role: 'system', content: SCORECARD_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildScorecardUserPrompt(contentChunks, plan, transcriptSummary),
        },
      ],
    });

    return response.choices[0]?.message?.content ?? '';
  }
}
