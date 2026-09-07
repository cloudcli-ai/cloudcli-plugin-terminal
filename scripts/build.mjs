#!/usr/bin/env node
/**
 * Build script — run by CloudCLI as `npm run build` right after it installs
 * the plugin, and by hand during development.
 *
 * Three jobs:
 *
 * 1. Bundle the frontend (xterm.js and its addons included) into a single ES
 *    module. Loading xterm from a CDN at runtime meant the terminal simply did
 *    not work offline, behind a strict CSP, or when esm.sh was having a bad
 *    day — for a tool that runs on localhost, that is a strange dependency.
 * 2. Bundle the backend, leaving node-pty and ws external: those are native /
 *    host-provided and are resolved at runtime by findModule().
 * 3. Repair node-pty if its native binding is missing. CloudCLI installs
 *    plugin dependencies with `npm install --ignore-scripts`, which skips
 *    node-pty's build step, and node-pty only ships prebuilt binaries for
 *    macOS and Windows — so on Linux the plugin's own copy never loads. This
 *    script runs with scripts enabled, so it is the one place that can fix it.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

// ── node-pty native binding ───────────────────────────────────────────────────

function nodePtyBindingExists() {
  const base = path.join(root, 'node_modules', 'node-pty');
  if (!fs.existsSync(base)) return true; // Not installed here; findModule() will look at the host.
  const candidates = [
    path.join(base, 'build', 'Release', 'pty.node'),
    path.join(base, 'build', 'Debug', 'pty.node'),
    path.join(base, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
    path.join(base, 'prebuilds', `${process.platform}-${process.arch}`, 'conpty.node'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function ensureNodePty() {
  if (nodePtyBindingExists()) return;
  console.log('[build] node-pty native binding missing — running "npm rebuild node-pty"');
  const result = spawnSync('npm', ['rebuild', 'node-pty'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0 || !nodePtyBindingExists()) {
    // Not fatal: the server falls back to the CloudCLI host's own node-pty,
    // which is present on every machine that can run the host at all.
    console.warn('[build] could not build node-pty locally; falling back to the host copy at runtime');
  }
}

// ── Bundles ───────────────────────────────────────────────────────────────────

/** @type {import('esbuild').BuildOptions} */
const frontend = {
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: path.join(root, 'dist', 'index.js'),
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  platform: 'browser',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  // xterm's stylesheet is inlined as a string and injected by ui/styles.ts,
  // so the plugin needs exactly one asset and no second network request.
  loader: { '.css': 'text' },
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const backend = {
  entryPoints: [path.join(root, 'src', 'server.ts')],
  outfile: path.join(root, 'dist', 'server.js'),
  bundle: true,
  format: 'esm',
  target: ['node18'],
  platform: 'node',
  // Resolved at runtime by findModule(), which can also fall back to the host's
  // copies; bundling them would defeat that.
  external: ['node-pty', 'ws'],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
};

async function main() {
  ensureNodePty();
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

  if (watch) {
    const contexts = await Promise.all([esbuild.context(frontend), esbuild.context(backend)]);
    await Promise.all(contexts.map((context) => context.watch()));
    console.log('[build] watching for changes…');
    return;
  }

  await Promise.all([esbuild.build(frontend), esbuild.build(backend)]);
  const bytes = fs.statSync(path.join(root, 'dist', 'index.js')).size;
  console.log(`[build] dist/index.js ${(bytes / 1024).toFixed(0)} kB`);
}

main().catch((error) => {
  console.error('[build] failed:', error);
  process.exit(1);
});
