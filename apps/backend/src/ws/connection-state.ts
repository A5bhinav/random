/**
 * Connection-level lifecycle states.
 * Separate from session state -- this tracks the WS handshake phase.
 */
export enum ConnectionPhase {
  /** Connection open, waiting for client.hello */
  CONNECTED = 'CONNECTED',
  /** client.hello received, waiting for auth */
  HELLO_RECEIVED = 'HELLO_RECEIVED',
  /** auth verified, waiting for session.start */
  AUTHENTICATED = 'AUTHENTICATED',
  /** session active, routing events to orchestrator */
  SESSION_ACTIVE = 'SESSION_ACTIVE',
  /** connection closing or closed */
  CLOSING = 'CLOSING',
}

export class ConnectionState {
  phase: ConnectionPhase = ConnectionPhase.CONNECTED;
  connectionId: string;
  userId: string | null = null;
  deviceId: string | null = null;
  sessionId: string | null = null;
  audioStarted = false;

  constructor(connectionId: string) {
    this.connectionId = connectionId;
  }

  expectPhase(expected: ConnectionPhase, action: string): void {
    if (this.phase !== expected) {
      throw new Error(
        `Invalid action "${action}" in phase ${this.phase} (expected ${expected})`,
      );
    }
  }

  expectMinPhase(minPhase: ConnectionPhase, action: string): void {
    const order = [
      ConnectionPhase.CONNECTED,
      ConnectionPhase.HELLO_RECEIVED,
      ConnectionPhase.AUTHENTICATED,
      ConnectionPhase.SESSION_ACTIVE,
    ];
    const currentIdx = order.indexOf(this.phase);
    const minIdx = order.indexOf(minPhase);
    if (currentIdx < minIdx) {
      throw new Error(
        `Invalid action "${action}" in phase ${this.phase} (requires at least ${minPhase})`,
      );
    }
  }
}
