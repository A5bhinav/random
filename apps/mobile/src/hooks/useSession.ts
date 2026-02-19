import { useEffect, useReducer, useRef, useCallback } from 'react';
import type { SessionPlan } from '@coach/shared';
import { WSClient } from '../services/wsClient';
import { startCapture, stopCapture } from '../services/audioCapture';
import { initPlayback, pushPCM, stopPlayback } from '../services/audioPlayback';

// ── State ─────────────────────────────────────────────────────────────────────

type Phase = 'connecting' | 'authenticating' | 'ready' | 'active' | 'ended' | 'error';

interface SessionState {
  phase: Phase;
  timeRemainingMs: number;
  plan: SessionPlan | null;
  currentSegmentIndex: number;
  /** Current in-progress user transcript (resets each turn). */
  transcript: string;
  coachCaption: string;
  isAISpeaking: boolean;
  isUserSpeaking: boolean;
  /** Server-initiated interrupt is in progress. */
  isInterrupting: boolean;
  interruptMessage: string;
  scorecard: string | null;
  error: string | null;
}

const initialState: SessionState = {
  phase: 'connecting',
  timeRemainingMs: 0,
  plan: null,
  currentSegmentIndex: 0,
  transcript: '',
  coachCaption: '',
  isAISpeaking: false,
  isUserSpeaking: false,
  isInterrupting: false,
  interruptMessage: '',
  scorecard: null,
  error: null,
};

// ── Actions ───────────────────────────────────────────────────────────────────

type Action =
  | { type: 'AUTH_OK' }
  | { type: 'SESSION_STARTED'; durationMs: number }
  | { type: 'PLAN'; plan: SessionPlan }
  | { type: 'TICK'; remainingMs: number; segmentName: string }
  | { type: 'TTS_START' }
  | { type: 'TTS_END' }
  | { type: 'TTS_CLEARED' }
  | { type: 'STT_PARTIAL'; text: string }
  | { type: 'STT_FINAL' }
  | { type: 'COACH_TEXT'; text: string; turnType: string }
  | { type: 'INTERRUPT'; message: string }
  | { type: 'INTERRUPT_DONE' }
  | { type: 'ENDED' }
  | { type: 'ERROR'; message: string }
  | { type: 'USER_SPEAKING' }
  | { type: 'USER_STOPPED_SPEAKING' };

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'AUTH_OK':
      return { ...state, phase: 'authenticating' };

    case 'SESSION_STARTED':
      return { ...state, phase: 'active', timeRemainingMs: action.durationMs };

    case 'PLAN':
      return { ...state, plan: action.plan };

    case 'TICK': {
      // Derive current segment index from the segment name in the tick payload
      const idx = state.plan?.segments.findIndex((s) => s.name === action.segmentName) ?? -1;
      return {
        ...state,
        timeRemainingMs: action.remainingMs,
        currentSegmentIndex: idx !== -1 ? idx : state.currentSegmentIndex,
      };
    }

    case 'TTS_START':
      return { ...state, isAISpeaking: true, coachCaption: '' };

    case 'TTS_END':
      return { ...state, isAISpeaking: false };

    case 'TTS_CLEARED':
      return { ...state, isAISpeaking: false };

    case 'STT_PARTIAL':
      return { ...state, transcript: action.text };

    case 'STT_FINAL':
      return { ...state, isUserSpeaking: false };

    case 'COACH_TEXT':
      if (action.turnType === 'scorecard') {
        return { ...state, scorecard: action.text };
      }
      return { ...state, coachCaption: action.text };

    case 'INTERRUPT':
      return { ...state, isInterrupting: true, isAISpeaking: false, interruptMessage: action.message };

    case 'INTERRUPT_DONE':
      return { ...state, isInterrupting: false };

    case 'ENDED':
      return { ...state, phase: 'ended', isAISpeaking: false, isUserSpeaking: false };

    case 'ERROR':
      return { ...state, phase: 'error', error: action.message };

    case 'USER_SPEAKING':
      return { ...state, isUserSpeaking: true, transcript: '' };

    case 'USER_STOPPED_SPEAKING':
      return { ...state, isUserSpeaking: false };

    default:
      return state;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface SessionActions {
  startSpeaking: () => void;
  stopSpeaking: () => void;
  bargeIn: () => Promise<void>;
  extend: (extraMs: number) => void;
}

export function useSession(
  contentId: string,
  durationMs: number,
): SessionState & SessionActions {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clientRef = useRef<WSClient | null>(null);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void initPlayback();

    const client = new WSClient();
    clientRef.current = client;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      client.on('auth.ok', () => {
        dispatch({ type: 'AUTH_OK' });
        // Start the session immediately after authentication
        client.startSession(contentId, durationMs);
      }),
    );

    unsubs.push(
      client.on<{ session_id: string; duration_ms: number }>('session.start_ack', (p) => {
        dispatch({ type: 'SESSION_STARTED', durationMs: p.duration_ms });
      }),
    );

    unsubs.push(
      client.on<{ plan: SessionPlan }>('session.plan', (p) => {
        dispatch({ type: 'PLAN', plan: p.plan });
      }),
    );

    unsubs.push(
      client.on<{ remaining_ms: number; segment_name: string }>('timer.tick', (p) => {
        dispatch({ type: 'TICK', remainingMs: p.remaining_ms, segmentName: p.segment_name });
      }),
    );

    unsubs.push(client.on('tts.start', () => dispatch({ type: 'TTS_START' })));
    unsubs.push(client.on('tts.end', () => dispatch({ type: 'TTS_END' })));
    unsubs.push(client.on('tts.cleared', () => dispatch({ type: 'TTS_CLEARED' })));

    unsubs.push(
      client.on<{ text: string }>('stt.partial', (p) => {
        dispatch({ type: 'STT_PARTIAL', text: p.text });
      }),
    );

    unsubs.push(client.on('stt.final', () => dispatch({ type: 'STT_FINAL' })));

    unsubs.push(
      client.on<{ text: string; turn_type: string }>('coach.text', (p) => {
        dispatch({ type: 'COACH_TEXT', text: p.text, turnType: p.turn_type });
      }),
    );

    unsubs.push(
      client.on<{ reason: string; message: string }>('server.interrupt', (p) => {
        dispatch({ type: 'INTERRUPT', message: p.message });
        // Stop any ongoing capture so the user doesn't accidentally send audio
        stopCapture();
        void stopPlayback();
        // Clear the interrupt banner after 3 s (the AI will speak the message via TTS)
        if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
        interruptTimerRef.current = setTimeout(
          () => dispatch({ type: 'INTERRUPT_DONE' }),
          3000,
        );
      }),
    );

    unsubs.push(
      client.on<ArrayBuffer>('binary', (data) => {
        pushPCM(data);
      }),
    );

    unsubs.push(
      client.on('timer.expired', () => {
        stopCapture();
        void stopPlayback();
        dispatch({ type: 'ENDED' });
      }),
    );

    unsubs.push(client.on('server.goodbye', () => dispatch({ type: 'ENDED' })));

    unsubs.push(
      client.on<{ code: string; message: string }>('server.error', (p) => {
        dispatch({ type: 'ERROR', message: p.message });
      }),
    );

    client.connect();

    return () => {
      unsubs.forEach((fn) => fn());
      if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
      stopCapture();
      void stopPlayback();
      client.destroy();
    };
  }, [contentId, durationMs]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const startSpeaking = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    dispatch({ type: 'USER_SPEAKING' });
    client.audioStart();
    startCapture((chunk) => client.sendBinary(chunk));
  }, []);

  const stopSpeaking = useCallback(() => {
    stopCapture();
    dispatch({ type: 'USER_STOPPED_SPEAKING' });
    clientRef.current?.audioStop();
  }, []);

  const bargeIn = useCallback(async () => {
    clientRef.current?.bargeIn();
    await stopPlayback();
    dispatch({ type: 'TTS_CLEARED' });
  }, []);

  const extend = useCallback((extraMs: number) => {
    clientRef.current?.extend(extraMs);
  }, []);

  return { ...state, startSpeaking, stopSpeaking, bargeIn, extend };
}
