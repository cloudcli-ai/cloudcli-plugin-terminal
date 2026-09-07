/** Shared helpers for the plugin's tests. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import WebSocket from 'ws';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Imports a TypeScript source file directly, by bundling it in memory. Avoids
 * shipping a build artifact that exists only so tests can reach it.
 */
export async function importTs(relativePath) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    packages: 'external',
  });
  const code = Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${code}`);
}

/**
 * Starts dist/server.js with exactly the environment CloudCLI gives a plugin —
 * PATH, HOME, NODE_ENV and PLUGIN_NAME, and nothing else. Several of the
 * behaviours under test only show up under that restriction.
 */
export function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        PLUGIN_NAME: 'web-terminal',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not report ready in 10s\n${stderr}`));
    }, 10000);

    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      try {
        const { port } = JSON.parse(chunk.toString().trim());
        resolve({ port, child, stop: () => child.kill('SIGTERM') });
      } catch (error) {
        child.kill('SIGKILL');
        reject(new Error(`bad ready line: ${chunk} (${error.message})\n${stderr}`));
      }
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}\n${stderr}`));
    });
  });
}

/**
 * A test client that records control messages and PTY output separately, which
 * is exactly the distinction the protocol is supposed to guarantee.
 */
export function connect(port, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
  const client = {
    ws,
    control: [],
    /** Text-frame payloads that were *not* valid control messages. */
    strayText: [],
    output: '',
    outputBytes: 0,
    closed: null,
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      client.outputBytes += data.length;
      client.output += data.toString('utf8');
      return;
    }
    try { client.control.push(JSON.parse(data.toString('utf8'))); }
    catch { client.strayText.push(data.toString('utf8')); }
  });
  ws.on('close', (code) => { client.closed = code; });

  client.send = (message) => ws.send(JSON.stringify(message));
  client.type = (text) => ws.send(Buffer.from(text, 'utf8'), { binary: true });
  client.close = () => ws.close();

  client.waitFor = (predicate, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const hit = predicate(client);
      if (hit) { resolve(hit); return; }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting; control=${JSON.stringify(client.control)} output=${JSON.stringify(client.output.slice(-400))}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });

  client.waitForControl = (type, timeoutMs) =>
    client.waitFor((c) => c.control.find((message) => message.type === type), timeoutMs);
  client.waitForOutput = (needle, timeoutMs) =>
    client.waitFor((c) => (c.output.includes(needle) ? c.output : null), timeoutMs);

  return client;
}

export const isWindows = process.platform === 'win32';
