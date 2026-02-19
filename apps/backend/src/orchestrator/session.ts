import { SessionState, TIMER_WARNING_THRESHOLDS } from '@coach/shared';
import type {
  LiveSessionState,
  SessionPlan,
  ContentChunk,
  PacingDecision,
} from '@coach/shared';
import type { BaseEvent } from '@coach/shared';
import type { STTAdapter, STTPartialEvent, STTFinalEvent } from '../adapters/stt/types.js';
import type { TTSAdapter } from '../adapters/tts/types.js';
import type { AdapterFactory } from '../adapters/factory.js';
import type { CoachTurnMessage } from '../adapters/llm/prompts.js';
import { CoachPipeline } from './coach-pipeline.js';
import { PacingLoop } from './pacing.js';
import { SessionTimer } from './timer.js';
import { EventBatcher } from '../lib/event-batch.js';
import { getContentPack, insertTranscript, endSession } from '../lib/repository.js';
import { saveSessionState, deleteSessionState } from '../lib/session-store.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrchestratorLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface OrchestratorParams {
  sessionId: string;
  userId: string;
  contentId: string;
  durationMs: number;
  startTs: number;
  factory: AdapterFactory;
  send: (event: Omit<BaseEvent, 'event_id' | 'ts_ms'>) => void;
  sendBinary: (buf: Buffer) => void;
  logger: OrchestratorLogger;
}

// ── Fallback plan ─────────────────────────────────────────────────────────────

function makeFallbackPlan(chunks: ContentChunk[], durationMs: number): SessionPlan {
  const numSegments = Math.min(5, Math.max(1, Math.ceil(chunks.length / 3)));
  const timePerSegment = Math.floor(durationMs / numSegments);

  return {
    plan_version: '1.0',
    session_goal: 'Review and understand the uploaded material',
    total_time_ms: durationMs,
    segments: Array.from({ length: numSegments }, (_, i) => ({
      segment_id: `topic_${i}`,
      name: `Topic ${i + 1}`,
      duration_ms: timePerSegment,
      mode: 'mixed' as const,
      coach_prompt: 'Ask the user to explain the key concepts from this section in their own words.',
      success_criteria: ['Can explain key concepts in own words'],
    })),
    interrupt_rules: {
      hard_stop_at_end: true,
      warn_at_ms: TIMER_WARNING_THRESHOLDS,
    },
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * SessionOrchestrator owns everything that lives for the duration of one session:
 *   - Server-authoritative timer
 *   - Deepgram STT + TTS adapters
 *   - OpenAI coach pipeline and pacing loop
 *   - Event batcher for DB persistence
 *   - Conversation history
 *
 * Lifecycle (called from ws/handler.ts):
 *   1. new SessionOrchestrator(params)
 *   2. orchestrator.start()          ← synchronous: starts timer, begins async init
 *   3. orchestrator.handleAudioStart/Chunk/Stop/BargeIn/Extend  ← during session
 *   4. orchestrator.destroy()        ← on WS close
 */
export class SessionOrchestrator {
  // Session state
  private state: SessionState = SessionState.IDLE;
  private contentChunks: ContentChunk[] = [];
  private plan: SessionPlan | null = null;
  private currentSegmentIndex = 0;
  private currentSegmentStartTs = 0;
  private conversationHistory: CoachTurnMessage[] = [];
  private turnIndex = 0;
  private isProcessingTurn = false;

  // TTS sequencing
  private ttsSeq = 0;
  private ttsAudioStarted = false;

  // Infrastructure
  private readonly timer: SessionTimer;
  private readonly batcher: EventBatcher;
  private stt: STTAdapter | null = null;
  private tts: TTSAdapter | null = null;
  private pipeline: CoachPipeline | null = null;
  private pacing: PacingLoop | null = null;

  constructor(private readonly params: OrchestratorParams) {
    this.batcher = new EventBatcher(params.sessionId);

    this.timer = new SessionTimer(params.durationMs, {
      onTick: (remaining) => {
        const segmentName = this.plan?.segments[this.currentSegmentIndex]?.name ?? 'Session';
        this.params.send({
          type: 'timer.tick',
          session_id: this.params.sessionId,
          payload: { remaining_ms: remaining, segment_name: segmentName },
        });
      },
      onWarning: (remaining) => {
        const seconds = Math.round(remaining / 1000);
        this.params.send({
          type: 'timer.warning',
          session_id: this.params.sessionId,
          payload: { remaining_ms: remaining, message: `${seconds} seconds remaining` },
        });
      },
      onExpired: () => this.onTimerExpired(),
    });
  }

  /**
   * Start the orchestrator.
   * Synchronously starts the timer, then kicks off async initialization
   * (content fetch → plan generation → adapter setup → opening question).
   * Errors during initialization are logged but do not crash the session.
   */
  start(): void {
    this.state = SessionState.CONFIGURING;
    this.batcher.queue('session.start', {
      content_id: this.params.contentId,
      requested_duration_ms: this.params.durationMs,
    });
    this.timer.start();

    this.initialize().catch((err: unknown) => {
      this.params.logger.error({ err }, 'Session initialization failed — timer still running');
    });
  }

  // ── Audio handlers ──────────────────────────────────────────────────────────

  handleAudioStart(): void {
    // STT is connected during initialize(); this is a no-op unless called before init completes
    this.params.logger.info({ sessionId: this.params.sessionId }, 'Audio started');
  }

  handleAudioChunk(buf: Buffer): void {
    this.stt?.sendAudio(buf);
  }

  handleAudioStop(): void {
    // Finalize STT — the 'final' event will trigger the coach turn
    this.stt?.finalize();
    this.params.logger.info({ sessionId: this.params.sessionId }, 'Audio stopped, STT finalized');
  }

  handleBargeIn(): void {
    this.pipeline?.cancel();
    this.tts?.clear().catch(() => {});
    this.params.logger.info({ sessionId: this.params.sessionId }, 'Barge-in handled');
  }

  handleExtend(extraMs: number): void {
    this.timer.extend(extraMs);
    this.batcher.queue('session.extend', { extra_ms: extraMs });

    this.params.send({
      type: 'timer.tick',
      session_id: this.params.sessionId,
      payload: {
        remaining_ms: this.timer.getRemaining(),
        segment_name: this.plan?.segments[this.currentSegmentIndex]?.name ?? 'Session',
      },
    });

    // Best-effort replan of remaining topics
    if (this.plan && this.contentChunks.length > 0) {
      this.replanRemaining().catch((err: unknown) =>
        this.params.logger.warn({ err }, 'Replan after extend failed'),
      );
    }
  }

  /** Called on WS close (abnormal or normal). */
  destroy(): void {
    this.pacing?.stop();
    this.pipeline?.cancel();
    this.stt?.close();
    this.tts?.close();
    this.timer.destroy();

    if (this.state !== SessionState.ENDED) {
      const actualMs = Date.now() - this.params.startTs;
      this.batcher.queue('session.end', { reason: 'disconnect', actual_duration_ms: actualMs });
      this.batcher.flush().catch(() => {});
      endSession(this.params.sessionId, 'error', actualMs, 'disconnect').catch(() => {});
      deleteSessionState(this.params.sessionId).catch(() => {});
    } else {
      this.batcher.destroy();
    }
  }

  // ── Async initialization ────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    // 1. Fetch content from DB
    const pack = await getContentPack(this.params.contentId);
    if (!pack) {
      this.params.logger.warn(
        { sessionId: this.params.sessionId, contentId: this.params.contentId },
        'Content not found — session running without AI features',
      );
      return;
    }
    this.contentChunks = pack.chunks;

    // 2. Generate session plan (LLM or fallback)
    this.state = SessionState.PLANNING;
    try {
      this.plan = await this.params.factory
        .getLLMAdapter()
        .generatePlan(this.contentChunks, this.params.durationMs);
    } catch (err) {
      this.params.logger.warn({ err }, 'Plan generation failed, using fallback');
      this.plan = makeFallbackPlan(this.contentChunks, this.params.durationMs);
    }

    // 3. Send plan to client
    this.params.send({
      type: 'session.plan',
      session_id: this.params.sessionId,
      payload: { plan: this.plan },
    });

    // 4. Connect TTS adapter and set up listeners
    this.tts = this.params.factory.createTTSAdapter();
    this.tts.on('audio', (chunk) => this.onTTSAudio(chunk));
    this.tts.on('flushed', () => this.onTTSFlushed());
    this.tts.on('cleared', () => this.onTTSCleared());
    await this.tts.connect();

    // 5. Create coach pipeline
    this.pipeline = new CoachPipeline(this.tts, this.params.factory.getLLMAdapter());

    // 6. Send opening question via TTS (BRIEFING phase)
    this.state = SessionState.BRIEFING;
    await this.runOpeningQuestion();

    // 7. Connect STT adapter
    this.stt = this.params.factory.createSTTAdapter();
    this.stt.on('partial', (e: STTPartialEvent) => this.onSTTPartial(e));
    this.stt.on('final', (e: STTFinalEvent) => this.onSTTFinal(e));
    this.stt.on('utterance_end', () => this.onSTTUtteranceEnd());
    await this.stt.connect({ sampleRateHz: 16000, channels: 1 });

    // 8. Transition to RUNNING_REP
    this.state = SessionState.RUNNING_REP;
    this.currentSegmentStartTs = Date.now();

    // 9. Start pacing loop
    this.pacing = new PacingLoop(
      this.params.factory.getLLMAdapter(),
      () => this.getPacingContextBase(),
      (decision) => this.onPacingDecision(decision),
      this.params.logger,
    );
    this.pacing.start();

    // 10. Persist initial state to Redis
    await saveSessionState(this.params.sessionId, this.buildLiveState());

    this.params.logger.info({ sessionId: this.params.sessionId }, 'Session initialized');
  }

  // ── Opening question ────────────────────────────────────────────────────────

  private async runOpeningQuestion(): Promise<void> {
    if (!this.pipeline || !this.plan) return;

    this.ttsSeq++;
    this.ttsAudioStarted = false;

    const ctx = {
      contentChunks: this.contentChunks,
      plan: this.plan,
      currentSegmentIndex: 0,
      timeRemainingMs: this.timer.getRemaining(),
      history: [] as CoachTurnMessage[],
      // Prompt the LLM to open the session rather than respond to user speech
      latestUserText:
        'Please start the session. Briefly introduce what we will cover and ask your first question.',
    };

    const coachText = await this.pipeline.run(ctx);
    if (coachText) {
      this.conversationHistory.push({ role: 'assistant', content: coachText });
      this.turnIndex++;
    }
  }

  // ── STT event handlers ──────────────────────────────────────────────────────

  private onSTTPartial(event: STTPartialEvent): void {
    this.params.send({
      type: 'stt.partial',
      session_id: this.params.sessionId,
      payload: { text: event.text, confidence: event.confidence },
    });
  }

  private onSTTFinal(event: STTFinalEvent): void {
    if (this.state !== SessionState.RUNNING_REP && this.state !== SessionState.WRAPPING) return;
    if (this.isProcessingTurn) return;
    if (!event.text.trim()) return;

    this.pacing?.updateTranscript(event.text);

    this.startCoachTurn(event.text).catch((err: unknown) => {
      this.params.logger.error({ err }, 'Coach turn failed');
      this.isProcessingTurn = false;
    });
  }

  private onSTTUtteranceEnd(): void {
    // Backup boundary — speech_final usually fires first; log and ignore for MVP
    this.params.logger.info({ sessionId: this.params.sessionId }, 'STT utterance_end');
  }

  // ── Coach turn ──────────────────────────────────────────────────────────────

  private async startCoachTurn(userText: string): Promise<void> {
    if (this.isProcessingTurn || !this.pipeline || !this.plan) return;
    this.isProcessingTurn = true;

    try {
      this.conversationHistory.push({ role: 'user', content: userText });
      this.turnIndex++;

      // Persist user transcript (fire-and-forget)
      insertTranscript({
        sessionId: this.params.sessionId,
        turnIndex: this.turnIndex,
        speaker: 'user',
        isFinal: true,
        text: userText,
        provider: 'deepgram',
      }).catch(() => {});

      // Notify client of final STT transcript
      this.params.send({
        type: 'stt.final',
        session_id: this.params.sessionId,
        payload: { text: userText, confidence: 1 },
      });

      const ctx = {
        contentChunks: this.contentChunks,
        plan: this.plan,
        currentSegmentIndex: this.currentSegmentIndex,
        timeRemainingMs: this.timer.getRemaining(),
        history: this.conversationHistory,
        latestUserText: userText,
      };

      this.ttsSeq++;
      this.ttsAudioStarted = false;

      const coachText = await this.pipeline.run(ctx);

      if (coachText) {
        this.conversationHistory.push({ role: 'assistant', content: coachText });

        // Persist coach transcript (fire-and-forget)
        insertTranscript({
          sessionId: this.params.sessionId,
          turnIndex: this.turnIndex,
          speaker: 'coach',
          isFinal: true,
          text: coachText,
          provider: 'openai',
        }).catch(() => {});

        // Send coach text event for captions
        this.params.send({
          type: 'coach.text',
          session_id: this.params.sessionId,
          payload: { text: coachText, turn_type: 'response' },
        });
      }
    } finally {
      this.isProcessingTurn = false;
    }
  }

  // ── TTS event handlers ──────────────────────────────────────────────────────

  private onTTSAudio(chunk: Buffer): void {
    if (!this.ttsAudioStarted) {
      this.ttsAudioStarted = true;
      this.params.send({
        type: 'tts.start',
        session_id: this.params.sessionId,
        payload: { tts_seq: this.ttsSeq },
      });
    }
    this.params.sendBinary(chunk);
  }

  private onTTSFlushed(): void {
    this.params.send({
      type: 'tts.end',
      session_id: this.params.sessionId,
      payload: { tts_seq: this.ttsSeq },
    });
  }

  private onTTSCleared(): void {
    this.params.send({
      type: 'tts.cleared',
      session_id: this.params.sessionId,
      payload: {},
    });
  }

  // ── Timer expiry ────────────────────────────────────────────────────────────

  private onTimerExpired(): void {
    this.state = SessionState.ENDED;
    this.pacing?.stop();
    this.pipeline?.cancel();
    this.stt?.close();
    this.tts?.close();

    const actualMs = Date.now() - this.params.startTs;

    // Generate scorecard (best-effort async, before sending goodbye)
    if (this.plan && this.contentChunks.length > 0) {
      const transcriptSummary = this.conversationHistory
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      this.params.factory
        .getLLMAdapter()
        .generateScorecard(this.contentChunks, this.plan, transcriptSummary)
        .then((scorecard) => {
          if (scorecard) {
            this.params.send({
              type: 'coach.text',
              session_id: this.params.sessionId,
              payload: { text: scorecard, turn_type: 'scorecard' },
            });
          }
        })
        .catch(() => {});
    }

    // Persist
    this.batcher.queue('session.end', { reason: 'timer_expired', actual_duration_ms: actualMs });
    this.batcher.flush().catch(() => {});
    endSession(this.params.sessionId, 'ended', actualMs).catch(() => {});
    deleteSessionState(this.params.sessionId).catch(() => {});

    // Notify client
    this.params.send({
      type: 'timer.expired',
      session_id: this.params.sessionId,
      payload: {},
    });
    this.params.send({
      type: 'server.goodbye',
      session_id: this.params.sessionId,
      payload: { reason: 'Timer expired' },
    });
  }

  // ── Pacing ──────────────────────────────────────────────────────────────────

  private getPacingContextBase() {
    if (this.state !== SessionState.RUNNING_REP || !this.plan) return null;
    const segment = this.plan.segments[this.currentSegmentIndex];
    if (!segment) return null;

    return {
      segmentName: segment.name,
      segmentDurationMs: segment.duration_ms,
      segmentElapsedMs: Date.now() - this.currentSegmentStartTs,
      topicsDone: this.currentSegmentIndex,
      topicsTotal: this.plan.segments.length,
      timeRemainingMs: this.timer.getRemaining(),
      currentChunkSnippet: this.contentChunks[this.currentSegmentIndex]?.text.slice(0, 300) ?? '',
    };
  }

  private onPacingDecision(decision: PacingDecision): void {
    if (!decision.should_interrupt) return;

    // Cancel current coach response if running
    this.pipeline?.cancel();

    // Send interrupt event to client
    const reason =
      decision.interrupt_reason === 'off_topic'
        ? 'off_topic'
        : decision.interrupt_reason === 'too_slow'
          ? 'time_pressure'
          : 'move_on';

    this.params.send({
      type: 'server.interrupt',
      session_id: this.params.sessionId,
      payload: { reason, message: decision.message_to_user },
    });

    // Speak the interrupt message via TTS
    this.tts
      ?.clear()
      .then(() => {
        if (this.tts) {
          this.ttsSeq++;
          this.ttsAudioStarted = false;
          this.tts.speak(decision.message_to_user);
          this.tts.flush();
        }
      })
      .catch(() => {});

    // Advance segment if the pacing engine decided to move on
    if (
      decision.recommended_next_action === 'force_wrap_up' ||
      decision.interrupt_reason === 'too_slow'
    ) {
      this.advanceSegment();
    }
  }

  private advanceSegment(): void {
    if (!this.plan) return;
    if (this.currentSegmentIndex < this.plan.segments.length - 1) {
      this.currentSegmentIndex++;
      this.currentSegmentStartTs = Date.now();
      this.params.logger.info(
        { sessionId: this.params.sessionId, segment: this.currentSegmentIndex },
        'Advanced to next segment',
      );
    } else {
      this.state = SessionState.WRAPPING;
    }
  }

  // ── Replan after extend ─────────────────────────────────────────────────────

  private async replanRemaining(): Promise<void> {
    if (!this.plan) return;
    const remainingChunks = this.contentChunks.slice(
      Math.floor(
        (this.currentSegmentIndex / this.plan.segments.length) * this.contentChunks.length,
      ),
    );
    if (remainingChunks.length === 0) return;

    const newRemaining = this.timer.getRemaining();
    const newPlan = await this.params.factory
      .getLLMAdapter()
      .generatePlan(remainingChunks, newRemaining);

    // Splice regenerated segments into current plan
    this.plan = {
      ...this.plan,
      segments: [
        ...this.plan.segments.slice(0, this.currentSegmentIndex),
        ...newPlan.segments,
      ],
    };

    // Notify client of updated plan
    this.params.send({
      type: 'session.plan',
      session_id: this.params.sessionId,
      payload: { plan: this.plan },
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private buildLiveState(): LiveSessionState {
    return {
      session_id: this.params.sessionId,
      user_id: this.params.userId,
      content_id: this.params.contentId,
      state: this.state,
      plan: this.plan,
      start_ts: this.params.startTs,
      elapsed_ms: this.params.durationMs - this.timer.getRemaining(),
      current_segment_index: this.currentSegmentIndex,
      current_topic_index: this.currentSegmentIndex,
      topics_coverage:
        this.plan?.segments.map((s, i) => ({
          segment_index: i,
          segment_id: s.segment_id,
          status:
            i < this.currentSegmentIndex
              ? ('done' as const)
              : i === this.currentSegmentIndex
                ? ('active' as const)
                : ('pending' as const),
        })) ?? [],
      turn_index: this.turnIndex,
      last_client_audio_seq: 0,
      last_server_tts_seq: this.ttsSeq,
    };
  }
}
