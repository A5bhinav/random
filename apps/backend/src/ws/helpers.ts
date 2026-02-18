import { v4 as uuid } from 'uuid';
import type { WebSocket } from 'ws';
import type { BaseEvent } from '@coach/shared';

export function sendEvent(socket: WebSocket, event: Omit<BaseEvent, 'event_id' | 'ts_ms'>): void {
  if (socket.readyState !== 1) return; // OPEN
  const full: BaseEvent = {
    ...event,
    event_id: uuid(),
    ts_ms: Date.now(),
  };
  socket.send(JSON.stringify(full));
}

export function sendError(
  socket: WebSocket,
  sessionId: string,
  code: string,
  message: string,
): void {
  sendEvent(socket, {
    type: 'server.error',
    session_id: sessionId,
    payload: { code, message },
  });
}
