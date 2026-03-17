'use strict';

const path = require('path');
const os   = require('os');
const http = require('http');
const fs   = require('fs');

function findModule(name) {
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

const pty = findModule('node-pty');
const { WebSocketServer, WebSocket } = findModule('ws');

const sessions = new Map();
let sessionCounter = 0;

function getShell() {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
}

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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const sessionId = `s${++sessionCounter}`;
  const cwd = process.env.HOME || os.homedir();
  const shell = getShell();

  let ptyProc;
  try {
    ptyProc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'web-terminal' },
    });
  } catch (err) {
    safeSend(ws, { type: 'error', message: `Failed to spawn shell: ${err.message}` });
    ws.close();
    return;
  }

  sessions.set(sessionId, { pty: ptyProc, ws });
  safeSend(ws, { type: 'ready', sessionId, shell, cwd });

  ptyProc.onData((chunk) => {
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

  ws.on('message', (rawData) => {
    const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    if (text.charCodeAt(0) === 123) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'input' && typeof msg.data === 'string') { ptyProc.write(msg.data); return; }
        if (msg.type === 'resize') { ptyProc.resize(Math.max(1,Math.min(Number(msg.cols)||80,500)), Math.max(1,Math.min(Number(msg.rows)||24,200))); return; }
        if (msg.type === 'ping') { safeSend(ws, { type: 'pong', sessionId }); return; }
      } catch { /* fall through */ }
    }
    ptyProc.write(text);
  });

  ws.on('close', () => { sessions.delete(sessionId); try { ptyProc.kill(); } catch {} });
  ws.on('error', (err) => { console.error(`[web-terminal] ${sessionId} error:`, err.message); });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
});

function shutdown() {
  for (const [, s] of sessions) { try { s.pty.kill(); } catch {} try { s.ws.close(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
