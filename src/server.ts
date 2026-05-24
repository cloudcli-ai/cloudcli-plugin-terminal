import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(callback: (data: string | Buffer) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  spawn(shell: string, args: string[], opts: any): PtyProcess;
}

interface PtyModule {
  spawn(shell: string, args: string[], opts: any): PtyProcess;
}

interface WsModule {
  WebSocketServer: any;
  WebSocket: { OPEN: number };
}

interface SessionEntry {
  pty: PtyProcess;
  ws: any;
}

interface WsMessage {
  type: string;
  data?: string;
  cols?: number;
  rows?: number;
}

// ── Module finder ─────────────────────────────────────────────────────────────

function findModule(name: string): any {
  try { return require(name); } catch { /* continue */ }

  const roots = [
    path.join('/opt', 'claudecodeui', 'node_modules', name),
    path.join('/workspace', 'claudecodeui', 'node_modules', name),
    path.join('/app', 'node_modules', name),
    path.join(os.homedir(), 'claudecodeui', 'node_modules', name),
  ];

  for (const p of roots) {
    if (fs.existsSync(p)) {
      try { return require(p); } catch { /* continue */ }
    }
  }

  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(candidate)) {
      try { return require(candidate); } catch { /* continue */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`[web-terminal] Cannot find module '${name}' - run npm install in ${__dirname}`);
}

// ── Dependencies ──────────────────────────────────────────────────────────────

const pty = findModule('node-pty') as PtyModule;
const { WebSocketServer, WebSocket } = findModule('ws') as WsModule;

// ── State ─────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionEntry>();
let sessionCounter = 0;

function getShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

// Session persistence wrapper. When WEB_TERMINAL_SESSION_BACKEND=tmux|dtach,
// the shell is launched inside a detachable multiplexer so WebSocket close
// (browser refresh, network blip) does not SIGHUP the running program.
function buildShellCommand(): { command: string; args: string[] } {
  const shell = getShell();
  if (process.platform === 'win32') return { command: shell, args: [] };

  const backend = (process.env.WEB_TERMINAL_SESSION_BACKEND || 'none').toLowerCase();
  const sessionName = process.env.WEB_TERMINAL_SESSION_NAME || 'main';

  if (backend === 'tmux') {
    return {
      command: 'tmux',
      args: ['-L', 'web', '-u', 'new-session', '-A', '-s', sessionName, shell, '-l'],
    };
  }
  if (backend === 'dtach') {
    const socket = process.env.WEB_TERMINAL_DTACH_SOCKET || `/tmp/web-terminal-${sessionName}.sock`;
    return { command: 'dtach', args: ['-A', socket, '-z', shell, '-l'] };
  }
  return { command: shell, args: [] };
}

function safeSend(ws: any, obj: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && (req.url === '/info' || req.url === '/')) {
    res.end(JSON.stringify({ name: 'web-terminal', sessions: sessions.size, platform: process.platform, shell: getShell() }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: any) => {
  const sessionId = `s${++sessionCounter}`;
  const cwd = process.env.HOME || os.homedir();
  const { command, args } = buildShellCommand();
  const shell = command;

  let ptyProc: PtyProcess;
  try {
    ptyProc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'web-terminal' },
      encoding: null,
    });
  } catch (err) {
    safeSend(ws, { type: 'error', message: `Failed to spawn shell: ${(err as Error).message}` });
    ws.close();
    return;
  }

  sessions.set(sessionId, { pty: ptyProc, ws });
  safeSend(ws, { type: 'ready', sessionId, shell, cwd });

  // Streaming UTF-8 decode: node-pty emits raw Buffer chunks, but a multi-byte
  // codepoint can land split across two chunks. TextDecoder with {stream:true}
  // buffers trailing incomplete bytes until the next call, so the string we
  // forward over the WebSocket always contains only complete codepoints. This
  // eliminates the "smeared border / wrong-width character" glitch that
  // appears when emoji or box-drawing chars cross a chunk boundary.
  const decoder = new TextDecoder('utf-8', { fatal: false });
  ptyProc.onData((chunk: Buffer | string) => {
    ptyProc.pause();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const text = decoder.decode(bytes, { stream: true });
    if (!text) { ptyProc.resume(); return; }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text, () => ptyProc.resume());
    } else {
      ptyProc.resume();
    }
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    sessions.delete(sessionId);
    safeSend(ws, { type: 'exit', sessionId, exitCode, signal });
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'shell exited');
  });

  ws.on('message', (rawData: Buffer | string) => {
    const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    if (text.charCodeAt(0) === 123) {
      try {
        const msg: WsMessage = JSON.parse(text);
        if (msg.type === 'input' && typeof msg.data === 'string') { ptyProc.write(msg.data); return; }
        if (msg.type === 'resize') { ptyProc.resize(Math.max(1, Math.min(Number(msg.cols) || 80, 500)), Math.max(1, Math.min(Number(msg.rows) || 24, 200))); return; }
        if (msg.type === 'ping') { safeSend(ws, { type: 'pong', sessionId }); return; }
      } catch { /* fall through */ }
    }
    ptyProc.write(text);
  });

  ws.on('close', () => { sessions.delete(sessionId); try { ptyProc.kill(); } catch { /* ignore */ } });
  ws.on('error', (err: Error) => { console.error(`[web-terminal] ${sessionId} error:`, err.message); });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    process.stdout.write(JSON.stringify({ ready: true, port: addr.port }) + '\n');
  }
});

function shutdown(): void {
  for (const [, s] of sessions) { try { s.pty.kill(); } catch { /* ignore */ } try { s.ws.close(); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
