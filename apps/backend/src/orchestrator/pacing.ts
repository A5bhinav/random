import { PACING_CHECK_INTERVAL_MS, PACING_DEBOUNCE_MS } from '@coach/shared';
import type { PacingDecision } from '@coach/shared';
import type { OpenAILLMAdapter, PacingContext } from '../adapters/llm/openai.js';

type PacingContextBase = Omit<PacingContext, 'lastUserTranscript'>;

interface PacingLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * PacingLoop evaluates session progress every PACING_CHECK_INTERVAL_MS (5s)
 * and calls onInterrupt() when the LLM decides an interrupt is warranted.
 *
 * Debounce: at most one interrupt per PACING_DEBOUNCE_MS (15s).
 *
 * The getContext() callback is evaluated lazily on each tick so the loop
 * always sees the latest session state. Returning null pauses evaluation
 * (e.g. when the session is not in RUNNING_REP).
 */
export class PacingLoop {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastInterruptTs = 0;
  private lastUserTranscript = '';

  constructor(
    private readonly llm: OpenAILLMAdapter,
    private readonly getContext: () => PacingContextBase | null,
    private readonly onInterrupt: (decision: PacingDecision) => void,
    private readonly logger: PacingLogger,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.evaluate().catch((err: unknown) =>
        this.logger.error({ err }, 'Pacing evaluation failed'),
      );
    }, PACING_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Called by the orchestrator when a new user transcript arrives. */
  updateTranscript(text: string): void {
    this.lastUserTranscript = text;
  }

  private async evaluate(): Promise<void> {
    const now = Date.now();
    if (now - this.lastInterruptTs < PACING_DEBOUNCE_MS) return;

    const base = this.getContext();
    if (!base) return;

    const ctx: PacingContext = {
      ...base,
      lastUserTranscript: this.lastUserTranscript || '(no transcript yet)',
    };

    const decision = await this.llm.decidePacing(ctx);
    if (decision.should_interrupt) {
      this.lastInterruptTs = now;
      this.onInterrupt(decision);
    }
  }
}
