/**
 * End-to-end tests against the real plugin server: a real PTY, a real
 * WebSocket, and the same stripped-down environment CloudCLI provides.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { startServer, connect, isWindows } from './helpers.mjs';

let server;

before(async () => { server = await startServer(); });
after(() => { server?.stop(); });

/** Completes the hello/init handshake and returns the ready message. */
async function handshake(overrides = {}) {
  const client = connect(server.port);
  const hello = await client.waitForControl('hello');
  client.send({ type: 'init', cols: 80, rows: 24, ...overrides });
  const ready = await client.waitForControl('ready');
  return { client, hello, ready };
}

test('the server greets first, so the client never has to guess when the proxy is up', async () => {
  const client = connect(server.port);
  const hello = await client.waitForControl('hello');
  assert.equal(hello.type, 'hello');
  assert.ok(Array.isArray(hello.shells) && hello.shells.length > 0);
  assert.ok(hello.defaultShell);
  assert.equal(hello.platform, process.platform);
  client.close();
});

test('init chooses the working directory, and a bad one degrades to home', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-proj-'));
  const good = await handshake({ cwd: dir });
  assert.equal(good.ready.cwd, fs.realpathSync(dir));
  good.client.close();

  const bad = await handshake({ cwd: '/no/such/project/dir' });
  assert.equal(bad.ready.cwd, os.homedir());
  bad.client.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shell starts at the requested size, not a hardcoded 80x24', { skip: isWindows }, async () => {
  const { client } = await handshake({ cols: 132, rows: 43 });
  client.type('printf "SIZE=%sx%s\\n" "$(tput cols)" "$(tput lines)"\n');
  const output = await client.waitForOutput('SIZE=132x43');
  assert.match(output, /SIZE=132x43/);
  client.close();
});

test('the shell environment is usable: SHELL, USER and a UTF-8 locale are set', { skip: isWindows }, async () => {
  // The tag is built from a variable so it only appears in the command's
  // output, never in the terminal's echo of the command itself.
  const { client } = await handshake();
  client.type('T=wtenv; printf "$T:%s:%s:%s:\\n" "$SHELL" "$USER" "$LANG"\n');
  const output = await client.waitForOutput('wtenv:');
  const match = /wtenv:([^:]*):([^:]*):([^:]*):/.exec(output);
  assert.ok(match, `no env line in ${JSON.stringify(output.slice(-300))}`);
  assert.ok(match[1].length > 0, 'SHELL should be set');
  assert.ok(match[2].length > 0, 'USER should be set');
  assert.match(match[3], /UTF-8/i);
  client.close();
});

test('NODE_ENV from the host does not leak into the user shell', { skip: isWindows }, async () => {
  // Left in place it silently turns `npm install` into a production install.
  const { client } = await handshake();
  client.type('T=wtnode; printf "$T:[%s]:\\n" "$NODE_ENV"\n');
  const output = await client.waitForOutput('wtnode:');
  assert.match(output, /wtnode:\[\]:/);
  client.close();
});

test('shell output that is valid JSON stays output and is never read as a command', { skip: isWindows }, async () => {
  // The old text-only protocol guessed by looking for a leading "{", so a lone
  // JSON line from `jq -c` or `cat package.json` was swallowed — and could
  // forge an "exit" that faked a dead shell.
  const { client } = await handshake();
  const payload = '{"type":"exit","exitCode":42}';
  client.type(`printf '%s' '${payload}'; sleep 1.2\n`);
  await client.waitForOutput(payload);

  const exits = client.control.filter((message) => message.type === 'exit');
  assert.deepEqual(exits, [], 'JSON output must not surface as a control message');
  assert.deepEqual(client.strayText, [], 'PTY output must never arrive on a text frame');
  client.close();
});

test('a dropped connection keeps the shell alive and replays what was missed', async () => {
  const first = await handshake();
  const sessionId = first.ready.sessionId;

  first.client.type('MARKER=alpha\n');
  await first.client.waitForOutput('MARKER=alpha');
  const seenBytes = first.client.outputBytes;

  // Simulate the network going away rather than the user closing the tab.
  first.client.ws.terminate();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const second = connect(server.port);
  await second.waitForControl('hello');
  second.send({ type: 'init', sessionId, seq: seenBytes, cols: 80, rows: 24 });
  const resumed = await second.waitForControl('ready');

  assert.equal(resumed.resumed, true, 'the same PTY should be re-attached');
  assert.equal(resumed.sessionId, sessionId);

  // The shell variable set before the drop must still be there.
  second.type('printf "STILL=%sEND\\n" "$MARKER"\n');
  const output = await second.waitForOutput('END');
  assert.match(output, /STILL=alphaEND/);
  second.close();
});

test('an unknown session id yields a fresh shell instead of an error', async () => {
  const client = connect(server.port);
  await client.waitForControl('hello');
  client.send({ type: 'init', sessionId: 'does-not-exist', seq: 999, cols: 80, rows: 24 });
  const ready = await client.waitForControl('ready');
  assert.equal(ready.resumed, false);
  assert.equal(ready.seq, 0);
  client.close();
});

test('resize reaches the PTY', { skip: isWindows }, async () => {
  const { client } = await handshake({ cols: 80, rows: 24 });
  client.send({ type: 'resize', cols: 100, rows: 30 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  client.type('printf "SIZE2=%sx%s\\n" "$(tput cols)" "$(tput lines)"\n');
  const output = await client.waitForOutput('SIZE2=');
  assert.match(output, /SIZE2=100x30/);
  client.close();
});

test('ping is answered', async () => {
  const { client } = await handshake();
  client.send({ type: 'ping' });
  const pong = await client.waitForControl('pong');
  assert.equal(pong.type, 'pong');
  client.close();
});

test('a connection carrying an Origin header is refused', async () => {
  // WebSocket is not subject to the same-origin policy: any page the user
  // visits could otherwise open a shell on our loopback port. Browsers always
  // send Origin and cannot suppress it; the host proxy never sends one.
  const client = connect(server.port, { origin: 'https://evil.example' });
  const outcome = await new Promise((resolve) => {
    client.ws.on('open', () => { client.ws.close(); resolve('opened'); });
    client.ws.on('unexpected-response', (_request, response) => resolve(`http-${response.statusCode}`));
    client.ws.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  assert.notEqual(outcome, 'opened', 'a browser-originated socket must not get a shell');
  assert.equal(client.control.length, 0, 'a refused socket must never receive hello');
});

test('HTTP /info reports the shells the picker offers', async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/info`);
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.name, 'web-terminal');
  assert.equal(info.platform, process.platform);
  assert.ok(Array.isArray(info.shells) && info.shells.length > 0);
  assert.ok(info.defaultShell);
});

test('HTTP requests carrying a browser Origin are refused', async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/info`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
});
