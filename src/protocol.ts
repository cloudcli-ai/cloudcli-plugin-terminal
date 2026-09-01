/**
 * Wire protocol shared by the plugin frontend (src/index.ts) and backend
 * (src/server.ts).
 *
 * Framing rule — the single most important invariant here:
 *
 *   • WebSocket BINARY frames carry raw PTY bytes, in both directions.
 *   • WebSocket TEXT frames carry JSON control messages, in both directions.
 *
 * The previous protocol multiplexed both over text frames and guessed which
 * was which by testing whether the payload started with "{". Any program that
 * printed a lone JSON object (`cat package.json`, `jq -c`, `docker inspect`)
 * produced a frame the client parsed as a control message: the output vanished
 * and a forged `{"type":"exit"}` could even fake a "Shell exited" overlay.
 * Binary/text separation removes the ambiguity at the transport layer, so no
 * amount of crafted shell output can be mistaken for control traffic.
 */

/** Bumped when the message shapes below change incompatibly. */
export const PROTOCOL_VERSION = 2;

// ── Server → client ───────────────────────────────────────────────────────────

/** Sent the instant the socket is accepted, before any shell is spawned. */
export interface HelloMessage {
  type: 'hello';
  protocol: number;
  platform: NodeJS.Platform | string;
  /** Shells discovered on the host, offered in the settings picker. */
  shells: string[];
  defaultShell: string;
  home: string;
}

/** Sent once a PTY is attached to this socket. */
export interface ReadyMessage {
  type: 'ready';
  sessionId: string;
  shell: string;
  cwd: string;
  /** True when an existing PTY was re-attached rather than freshly spawned. */
  resumed: boolean;
  /** True when the client must clear its screen before the replay arrives. */
  reset: boolean;
  /** Byte offset of the next byte the client will receive, for resume math. */
  seq: number;
}

export interface ExitMessage {
  type: 'exit';
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | HelloMessage | ReadyMessage | ExitMessage | ErrorMessage | PongMessage;

// ── Client → server ───────────────────────────────────────────────────────────

/**
 * Sent in reply to `hello`. Waiting for `hello` is not optional: the CloudCLI
 * host proxy opens its upstream socket asynchronously and silently drops
 * anything the client sends before that upstream is connected. `hello` is the
 * client's proof that the full path is up.
 */
export interface InitMessage {
  type: 'init';
  /** Resume this session if the server still holds it; otherwise spawn anew. */
  sessionId?: string;
  /** Bytes already rendered, so the server replays only what was missed. */
  seq?: number;
  cwd?: string;
  shell?: string;
  cols: number;
  rows: number;
}

export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface PingMessage {
  type: 'ping';
}

/** Terminate this PTY now, rather than leaving it for the reconnect window. */
export interface CloseMessage {
  type: 'close';
}

export type ClientMessage = InitMessage | ResizeMessage | PingMessage | CloseMessage;

// ── Limits ────────────────────────────────────────────────────────────────────

export const MIN_COLS = 1;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;

/** Clamps a client-supplied terminal dimension into a sane range. */
export function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}
