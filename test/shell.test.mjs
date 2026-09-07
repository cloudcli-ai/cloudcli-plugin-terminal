import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { importTs, isWindows } from './helpers.mjs';

const shell = await importTs('src/shell.ts');
const protocol = await importTs('src/protocol.ts');

test('resolveCwd accepts an existing directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cwd-'));
  assert.equal(shell.resolveCwd(dir), fs.realpathSync.native ? path.resolve(dir) : dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCwd falls back to home for a missing or non-directory path', () => {
  const home = os.homedir();
  assert.equal(shell.resolveCwd('/definitely/not/a/real/path/xyzzy', home), home);
  assert.equal(shell.resolveCwd(null, home), home);
  assert.equal(shell.resolveCwd('   ', home), home);

  const file = path.join(os.tmpdir(), `wt-file-${process.pid}`);
  fs.writeFileSync(file, 'x');
  assert.equal(shell.resolveCwd(file, home), home);
  fs.rmSync(file, { force: true });
});

test('buildShellEnv drops host-only variables', () => {
  // NODE_ENV=production leaking into the user's shell silently changes what
  // `npm install` does, which is a very confusing way to lose devDependencies.
  const env = shell.buildShellEnv(
    { PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'production', PLUGIN_NAME: 'web-terminal' },
    { shell: '/bin/bash', cwd: '/home/x' },
  );
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.PLUGIN_NAME, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('buildShellEnv sets the terminal identity variables', () => {
  const env = shell.buildShellEnv({ PATH: '/usr/bin' }, {
    shell: '/bin/zsh', cwd: '/tmp/project', version: '9.9.9',
  });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.TERM_PROGRAM, 'cloudcli-terminal');
  assert.equal(env.TERM_PROGRAM_VERSION, '9.9.9');
  assert.equal(env.PWD, '/tmp/project');
  if (!isWindows) assert.equal(env.SHELL, '/bin/zsh');
});

test('buildShellEnv supplies a UTF-8 locale but never overrides one', { skip: isWindows }, () => {
  const supplied = shell.buildShellEnv({ PATH: '/usr/bin' }, { shell: '/bin/sh', cwd: '/tmp' });
  assert.match(String(supplied.LANG), /UTF-8/);

  const preserved = shell.buildShellEnv({ PATH: '/usr/bin', LANG: 'de_DE.UTF-8' }, { shell: '/bin/sh', cwd: '/tmp' });
  assert.equal(preserved.LANG, 'de_DE.UTF-8');

  const respectsLcAll = shell.buildShellEnv({ PATH: '/usr/bin', LC_ALL: 'C' }, { shell: '/bin/sh', cwd: '/tmp' });
  assert.equal(respectsLcAll.LANG, undefined);
});

test('listShells only returns shells that exist', () => {
  for (const candidate of shell.listShells()) {
    assert.equal(typeof candidate, 'string');
    assert.ok(candidate.length > 0);
    if (!isWindows) assert.ok(fs.existsSync(candidate), `${candidate} should exist`);
  }
});

test('resolveShell ignores a requested shell that is not on the discovered list', () => {
  // The request comes from the browser, so it must never become an arbitrary
  // command to execute.
  const resolved = shell.resolveShell('/tmp/evil-payload');
  assert.notEqual(resolved, '/tmp/evil-payload');
  assert.ok(shell.listShells().includes(resolved) || resolved === '/bin/sh' || isWindows);
});

test('resolveShell honours a requested shell that is on the list', () => {
  const available = shell.listShells();
  const wanted = available[available.length - 1];
  assert.equal(shell.resolveShell(wanted), wanted);
});

test('prioritizeUserNpmGlobalBin only reorders entries already on PATH', () => {
  const npmBin = path.join(os.homedir(), '.npm-global', 'bin');
  const before = ['/usr/bin', npmBin, '/bin'].join(path.delimiter);
  const after = shell.prioritizeUserNpmGlobalBin({ PATH: before }).PATH.split(path.delimiter);

  assert.equal(after[0], npmBin);
  assert.equal(after.length, 3);
  assert.deepEqual([...after].sort(), ['/usr/bin', npmBin, '/bin'].sort());
});

test('prioritizeUserNpmGlobalBin leaves an unrelated PATH untouched', () => {
  const env = { PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
  assert.equal(shell.prioritizeUserNpmGlobalBin(env).PATH, env.PATH);
});

test('clampDimension keeps terminal sizes in range', () => {
  const { clampDimension, MIN_COLS, MAX_COLS } = protocol;
  assert.equal(clampDimension(120, 80, MIN_COLS, MAX_COLS), 120);
  assert.equal(clampDimension(0, 80, MIN_COLS, MAX_COLS), MIN_COLS);
  assert.equal(clampDimension(99999, 80, MIN_COLS, MAX_COLS), MAX_COLS);
  assert.equal(clampDimension('nope', 80, MIN_COLS, MAX_COLS), 80);
  assert.equal(clampDimension(undefined, 80, MIN_COLS, MAX_COLS), 80);
  assert.equal(clampDimension(-5, 80, MIN_COLS, MAX_COLS), MIN_COLS);
});
