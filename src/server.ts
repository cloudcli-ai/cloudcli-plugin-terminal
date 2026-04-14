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
  onData(callback: (data: string) => void): void;
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

function findModuleRoot(name: string): string {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    /* continue */
  }

  const roots = [
    path.join('/opt', 'claudecodeui', 'node_modules', name),
    path.join('/workspace', 'claudecodeui', 'node_modules', name),
    path.join('/app', 'node_modules', name),
    path.join(os.homedir(), 'claudecodeui', 'node_modules', name),
  ];

  for (const p of roots) {
    if (fs.existsSync(p)) return p;
  }

  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`[web-terminal] Cannot find module root for '${name}' - run npm install in ${__dirname}`);
}

function findModule(name: string): any {
  const moduleRoot = findModuleRoot(name);
  try {
    return require(moduleRoot);
  } catch {
    throw new Error(`[web-terminal] Cannot load module '${name}' from ${moduleRoot}`);
  }
}

// ── Dependencies ──────────────────────────────────────────────────────────────

const pty = findModule('node-pty') as PtyModule;
const { WebSocketServer, WebSocket } = findModule('ws') as WsModule;

// ── State ─────────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionEntry>();
let sessionCounter = 0;

function ensureSpawnHelperExecutable(): void {
  if (process.platform !== 'darwin') return;

  try {
    const archDir = process.arch === 'arm64' ? 'darwin-arm64' : process.arch === 'x64' ? 'darwin-x64' : null;
    if (!archDir) return;

    const nodePtyRoot = findModuleRoot('node-pty');
    const spawnHelperPath = path.join(nodePtyRoot, 'prebuilds', archDir, 'spawn-helper');
    if (!fs.existsSync(spawnHelperPath)) return;

    const mode = fs.statSync(spawnHelperPath).mode & 0o777;
    if ((mode & 0o100) === 0) {
      fs.chmodSync(spawnHelperPath, mode | 0o100);
    }
  } catch (err) {
    console.warn('[web-terminal] Failed to ensure spawn-helper permissions:', (err as Error).message);
  }
}

function getShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
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
  const shell = getShell();

  let ptyProc: PtyProcess;
  try {
    ensureSpawnHelperExecutable();
    ptyProc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'web-terminal' },
    });
  } catch (err) {
    safeSend(ws, { type: 'error', message: `Failed to spawn shell: ${(err as Error).message}` });
    ws.close();
    return;
  }

  sessions.set(sessionId, { pty: ptyProc, ws });
  safeSend(ws, { type: 'ready', sessionId, shell, cwd });

  ptyProc.onData((chunk: string) => {
    ptyProc.pause();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, () => ptyProc.resume());
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
