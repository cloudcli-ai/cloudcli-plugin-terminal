/**
 * web-terminal plugin backend.
 *
 * Spawns PTYs and bridges them to the browser over a WebSocket, through the
 * CloudCLI host's `/plugin-ws/web-terminal` proxy.
 *
 * Two properties shape the design:
 *
 * 1. The host proxy connects its upstream socket to us *asynchronously*, and
 *    drops anything the browser sends before that upstream is open. So the
 *    server speaks first (`hello`) and the client only sends `init` in reply —
 *    which also lets the very first spawn use the real terminal size and the
 *    selected project directory instead of a hardcoded 80x24 in $HOME.
 *
 * 2. PTYs outlive their sockets. A dropped WiFi connection, a laptop lid, or a
 *    browser reload must not destroy a running build, so sessions are kept for
 *    a grace period with a ring buffer of their output and re-attached by id.
 */

import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION, MIN_COLS, MAX_COLS, MIN_ROWS, MAX_ROWS, clampDimension,
} from './protocol.js';
import type { ClientMessage, InitMessage, ServerMessage } from './protocol.js';
import {
  listShells, resolveShell, resolveCwd, buildShellEnv, prioritizeUserNpmGlobalBin,
} from './shell.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Tunables ──────────────────────────────────────────────────────────────────

/** How long a PTY survives with no socket attached before it is reaped. */
const DETACHED_GRACE_MS = 30 * 60 * 1000;
/** Output retained per session so a reconnecting client can catch up. */
const REPLAY_BUFFER_BYTES = 256 * 1024;
/** Ceiling on concurrent PTYs, so a runaway client cannot fork-bomb the host. */
const MAX_SESSIONS = 32;
/** If a client never answers `hello`, spawn with defaults rather than hang. */
const INIT_TIMEOUT_MS = 5000;

const PLUGIN_VERSION = readPluginVersion();

// ── Types for the runtime-resolved native deps ────────────────────────────────

interface PtyProcess {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface PtyModule {
  spawn(shell: string, args: string[], opts: Record<string, unknown>): PtyProcess;
}

interface WsModule {
  WebSocketServer: new (opts: Record<string, unknown>) => WsServer;
  WebSocket: { OPEN: number };
}

interface WsLike {
  readyState: number;
  send(data: string | Buffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
  removeAllListeners(): void;
}

interface WsServer {
  on(event: 'connection', cb: (ws: WsLike, req: http.IncomingMessage) => void): void;
  close(cb?: () => void): void;
  clients: Set<{ terminate(): void }>;
}

// ── Module resolution ─────────────────────────────────────────────────────────

/**
 * Finds `node-pty` / `ws`.
 *
 * CloudCLI installs plugin dependencies with `npm install --ignore-scripts`,
 * which means node-pty's native binding is never compiled and node-pty ships
 * prebuilds for macOS and Windows only. On Linux the plugin's own copy is
 * therefore dead on arrival, and we fall back to the host's — the host depends
 * on the very same packages for its built-in shell. `npm run build` also
 * repairs the local copy (see scripts/build.mjs); this is the safety net for
 * when that repair is not possible.
 */
function findModule(name: string): unknown {
  const attempts: string[] = [];
  const tryRequire = (specifier: string): unknown => {
    attempts.push(specifier);
    try { return require(specifier); } catch { return null; }
  };

  const direct = tryRequire(name);
  if (direct) return direct;

  const roots = [
    path.join('/opt', 'claudecodeui', 'node_modules', name),
    path.join('/usr', 'lib', 'node_modules', 'claudecodeui', 'node_modules', name),
    path.join('/usr', 'local', 'lib', 'node_modules', 'claudecodeui', 'node_modules', name),
    path.join('/workspace', 'claudecodeui', 'node_modules', name),
    path.join('/app', 'node_modules', name),
    path.join(os.homedir(), 'claudecodeui', 'node_modules', name),
  ];
  for (const candidate of roots) {
    if (!fs.existsSync(candidate)) continue;
    const loaded = tryRequire(candidate);
    if (loaded) return loaded;
  }

  // Walk up from both the plugin's own directory and the process cwd; the two
  // differ when the host launches us from somewhere other than the plugin dir.
  for (const start of [__dirname, process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 12; depth++) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(candidate)) {
        const loaded = tryRequire(candidate);
        if (loaded) return loaded;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    `[web-terminal] Cannot load '${name}'.\n` +
    `  Tried: ${attempts.join(', ')}\n` +
    `  Fix: run "npm install && npm rebuild ${name}" in ${path.dirname(__dirname)}`,
  );
}

function readPluginVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const pty = findModule('node-pty') as PtyModule;
const { WebSocketServer, WebSocket } = findModule('ws') as WsModule;

// ── Replay buffer ─────────────────────────────────────────────────────────────

/**
 * Fixed-size tail of a PTY's output. On reconnect the client says how many
 * bytes it already rendered and we hand back only the remainder, so a brief
 * network drop is invisible instead of restarting the shell.
 */
class ReplayBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** Total bytes ever produced by this PTY, not just those still retained. */
  seq = 0;

  push(chunk: Buffer): void {
    this.seq += chunk.length;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > REPLAY_BUFFER_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  /** The earliest byte offset still retained. */
  get oldestSeq(): number { return this.seq - this.bytes; }

  /** Everything retained, oldest first. */
  all(): Buffer { return Buffer.concat(this.chunks); }

  /** Bytes produced since `fromSeq`, or null when that far back is gone. */
  since(fromSeq: number): Buffer | null {
    if (fromSeq > this.seq || fromSeq < this.oldestSeq) return null;
    const skip = fromSeq - this.oldestSeq;
    return this.all().subarray(skip);
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  pty: PtyProcess;
  ws: WsLike | null;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  replay: ReplayBuffer;
  reapTimer: NodeJS.Timeout | null;
  exited: boolean;
  dispose: () => void;
}

const sessions = new Map<string, Session>();

function sendControl(ws: WsLike | null, message: ServerMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(message)); } catch { /* socket died mid-send */ }
  }
}

function sendData(ws: WsLike | null, chunk: Buffer, done: () => void): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) { done(); return; }
  try { ws.send(chunk, () => done()); } catch { done(); }
}

function detachSession(session: Session): void {
  session.ws = null;
  if (session.reapTimer) clearTimeout(session.reapTimer);
  session.reapTimer = setTimeout(() => killSession(session.id), DETACHED_GRACE_MS);
  session.reapTimer.unref?.();
  // Nothing is applying backpressure any more; the replay buffer caps memory.
  try { session.pty.resume(); } catch { /* already gone */ }
}

function killSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.reapTimer) clearTimeout(session.reapTimer);
  session.dispose();
  try { session.pty.kill(); } catch { /* already gone */ }
  try { session.ws?.close(1000, 'session closed'); } catch { /* already gone */ }
}

function createSession(options: {
  shell: string; cwd: string; cols: number; rows: number;
}): Session {
  const id = crypto.randomUUID();
  const env = buildShellEnv(prioritizeUserNpmGlobalBin(process.env), {
    shell: options.shell,
    cwd: options.cwd,
    version: PLUGIN_VERSION,
  });

  const ptyProc = pty.spawn(options.shell, [], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env,
    // 'utf8' rather than null: node-pty only enables the IUTF8 termios flag
    // when the encoding is exactly 'utf8'. Without it the tty line discipline
    // treats a multi-byte character as separate bytes, so backspacing over
    // "é" or an emoji at a shell prompt leaves mojibake behind. It also gives
    // us Node's StringDecoder, which stitches characters split across reads.
    encoding: 'utf8',
  });

  const session: Session = {
    id,
    pty: ptyProc,
    ws: null,
    shell: options.shell,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    replay: new ReplayBuffer(),
    reapTimer: null,
    exited: false,
    dispose: () => { /* replaced below */ },
  };

  const dataSub = ptyProc.onData((text: string) => {
    if (!text) return;
    const chunk = Buffer.from(text, 'utf8');
    session.replay.push(chunk);
    if (!session.ws) return;
    // Pause the PTY until the socket has drained, so a fast producer cannot
    // outrun a slow browser and balloon the send queue.
    session.pty.pause();
    sendData(session.ws, chunk, () => { try { session.pty.resume(); } catch { /* gone */ } });
  });

  const exitSub = ptyProc.onExit(({ exitCode, signal }) => {
    session.exited = true;
    sendControl(session.ws, { type: 'exit', sessionId: id, exitCode, signal });
    const ws = session.ws;
    sessions.delete(id);
    if (session.reapTimer) clearTimeout(session.reapTimer);
    session.dispose();
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'shell exited');
  });

  session.dispose = () => {
    try { dataSub.dispose(); } catch { /* ignore */ }
    try { exitSub.dispose(); } catch { /* ignore */ }
  };

  sessions.set(id, session);
  return session;
}

function attachSession(session: Session, ws: WsLike): void {
  if (session.ws && session.ws !== ws) {
    // A second tab claimed this session; the previous socket loses it.
    try { session.ws.close(4409, 'session claimed elsewhere'); } catch { /* ignore */ }
  }
  if (session.reapTimer) { clearTimeout(session.reapTimer); session.reapTimer = null; }
  session.ws = ws;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

/**
 * Rejects requests a browser page could have made directly to our ephemeral
 * port. The host proxy is a Node client and never sends an Origin header;
 * browsers always do, and cannot suppress it. Checking Host as well closes the
 * DNS-rebinding variant on the plain-HTTP routes.
 */
function isTrustedLocalRequest(req: http.IncomingMessage): boolean {
  if (req.headers.origin) return false;
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return host === '' || host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (!isTrustedLocalRequest(req)) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/info')) {
    res.end(JSON.stringify({
      name: 'web-terminal',
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      platform: process.platform,
      sessions: sessions.size,
      maxSessions: MAX_SESSIONS,
      defaultShell: resolveShell(),
      shells: listShells(),
      home: os.homedir(),
    }));
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // ~4 MiB: comfortably larger than any paste, small enough to bound memory.
  maxPayload: 4 * 1024 * 1024,
  verifyClient: (info: { req: http.IncomingMessage }) => isTrustedLocalRequest(info.req),
});

wss.on('connection', (ws: WsLike) => {
  let session: Session | null = null;
  let initialised = false;

  const fail = (message: string): void => {
    sendControl(ws, { type: 'error', message });
    try { ws.close(1011, 'terminal error'); } catch { /* ignore */ }
  };

  const start = (msg: Partial<InitMessage> = {}): void => {
    if (initialised) return;
    initialised = true;
    clearTimeout(initTimer);

    const cols = clampDimension(msg.cols, 80, MIN_COLS, MAX_COLS);
    const rows = clampDimension(msg.rows, 24, MIN_ROWS, MAX_ROWS);

    // Resume path: the client remembers a session we may still be holding.
    const wanted = typeof msg.sessionId === 'string' ? sessions.get(msg.sessionId) : undefined;
    if (wanted && !wanted.exited) {
      session = wanted;
      attachSession(session, ws);
      try { session.pty.resize(cols, rows); session.cols = cols; session.rows = rows; } catch { /* ignore */ }

      const clientSeq = typeof msg.seq === 'number' ? msg.seq : 0;
      const missed = session.replay.since(clientSeq);
      const reset = missed === null;
      const payload = reset ? session.replay.all() : missed;

      sendControl(ws, {
        type: 'ready',
        sessionId: session.id,
        shell: session.shell,
        cwd: session.cwd,
        resumed: true,
        reset,
        // Offset of the first byte in the replay that follows, so the client
        // can keep counting from here without double-counting the replay.
        seq: reset ? session.replay.oldestSeq : clientSeq,
      });
      if (payload.length > 0) sendData(ws, payload, () => { /* replay is not flow-controlled */ });
      return;
    }

    if (sessions.size >= MAX_SESSIONS) {
      fail(`Too many terminal sessions open (limit ${MAX_SESSIONS}). Close a tab and try again.`);
      return;
    }

    const shell = resolveShell(typeof msg.shell === 'string' ? msg.shell : null);
    const cwd = resolveCwd(typeof msg.cwd === 'string' ? msg.cwd : null);

    try {
      session = createSession({ shell, cwd, cols, rows });
    } catch (err) {
      fail(`Failed to start ${shell}: ${(err as Error).message}`);
      return;
    }

    attachSession(session, ws);
    sendControl(ws, {
      type: 'ready',
      sessionId: session.id,
      shell,
      cwd,
      resumed: false,
      reset: false,
      seq: 0,
    });
  };

  // If the client never replies to `hello` (an older frontend, or a stray
  // local connection) fall back to defaults rather than leaving a dead socket.
  const initTimer = setTimeout(() => start(), INIT_TIMEOUT_MS);
  initTimer.unref?.();

  sendControl(ws, {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    platform: process.platform,
    shells: listShells(),
    defaultShell: resolveShell(),
    home: os.homedir(),
  });

  ws.on('message', (raw: Buffer | string, isBinary: boolean) => {
    // Binary frames are always keystrokes; text frames are always control.
    if (isBinary) {
      if (!session || session.exited) return;
      // Written as raw bytes, never round-tripped through a string: mouse
      // reports and pasted binary would not survive a UTF-8 re-encode.
      try { session.pty.write(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')); } catch { /* gone */ }
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'init') { start(msg); return; }
    if (msg.type === 'ping') { sendControl(ws, { type: 'pong' }); return; }
    if (msg.type === 'close') {
      // The tab was closed for good (the undo window elapsed), so the PTY goes
      // now instead of lingering for the reconnect grace period.
      if (session) killSession(session.id);
      return;
    }
    if (msg.type === 'resize') {
      if (!session || session.exited) return;
      const cols = clampDimension(msg.cols, session.cols, MIN_COLS, MAX_COLS);
      const rows = clampDimension(msg.rows, session.rows, MIN_ROWS, MAX_ROWS);
      if (cols === session.cols && rows === session.rows) return;
      session.cols = cols;
      session.rows = rows;
      try { session.pty.resize(cols, rows); } catch { /* gone */ }
    }
  });

  ws.on('close', () => {
    clearTimeout(initTimer);
    // Deliberately *not* killing the PTY: a dropped connection must not take
    // a running build with it. The session is reaped after DETACHED_GRACE_MS.
    if (session && sessions.get(session.id) === session && session.ws === ws) {
      detachSession(session);
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[web-terminal] socket error:', err.message);
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

server.on('error', (err: Error) => {
  console.error('[web-terminal] server error:', err.message);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    process.stdout.write(JSON.stringify({ ready: true, port: addr.port }) + '\n');
  }
});

let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const id of [...sessions.keys()]) killSession(id);
  // Upgraded sockets hold the HTTP server open, so `server.close()` alone
  // never fires its callback and the process only ever left via the timeout.
  for (const client of wss.clients) { try { client.terminate(); } catch { /* ignore */ } }
  wss.close(() => server.close(() => process.exit(code)));
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

/**
 * Exit when the CloudCLI host does.
 *
 * The host stops plugin servers on a clean shutdown, but a crash or SIGKILL
 * leaves them running forever — every restart stacking another orphaned node
 * process, each holding live PTYs. Being re-parented away from our original
 * parent is the signal that the host is gone.
 */
const initialParentPid = process.ppid;
if (initialParentPid > 1) {
  const watchdog = setInterval(() => {
    let parentAlive = true;
    try { process.kill(initialParentPid, 0); } catch { parentAlive = false; }
    if (!parentAlive || process.ppid !== initialParentPid) {
      console.error('[web-terminal] host process exited; shutting down');
      shutdown(0);
    }
  }, 5000);
  watchdog.unref();
}

// A single unexpected throw used to take down every terminal tab at once.
process.on('uncaughtException', (err) => {
  console.error('[web-terminal] uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[web-terminal] unhandled rejection:', reason);
});
process.stdout.on('error', () => { /* host closed our pipe; the watchdog handles it */ });
