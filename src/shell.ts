/**
 * Shell discovery, environment construction and working-directory resolution.
 *
 * Kept free of side effects at import time so `test/shell.test.mjs` can
 * exercise it without spawning anything.
 *
 * Context that drives most of the decisions here: CloudCLI starts plugin
 * servers with a deliberately minimal environment — only PATH, HOME, NODE_ENV
 * and PLUGIN_NAME survive (see the host's `buildPluginEnv`). So `$SHELL`,
 * `$USER`, `$LANG` and friends are simply absent, and anything the interactive
 * shell needs has to be reconstructed rather than inherited.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Shells we look for when building the picker, most-preferred first. */
const POSIX_SHELL_CANDIDATES = [
  '/bin/zsh', '/usr/bin/zsh',
  '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash',
  '/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish',
  '/bin/sh', '/usr/bin/sh',
];

const WINDOWS_SHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe', 'cmd.exe'];

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Reads /etc/shells, ignoring comments. Returns [] when unavailable. */
function readEtcShells(): string[] {
  try {
    return fs.readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'));
  } catch {
    return [];
  }
}

/** The login shell recorded for this user in the passwd database, if any. */
function passwdShell(): string | null {
  try {
    const info = os.userInfo() as { shell?: string | null };
    return typeof info.shell === 'string' && info.shell.startsWith('/') ? info.shell : null;
  } catch {
    return null;
  }
}

/** Resolves the Windows shell by probing PATH for pwsh, then powershell, then cmd. */
function findWindowsShell(env: NodeJS.ProcessEnv): string {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const dirs = (pathKey ? env[pathKey] : undefined)?.split(path.delimiter).filter(Boolean) ?? [];
  for (const candidate of WINDOWS_SHELL_CANDIDATES) {
    for (const dir of dirs) {
      if (isExecutableFile(path.join(dir, candidate))) return candidate;
    }
  }
  return 'powershell.exe';
}

/**
 * Every shell we are willing to spawn, in preference order. The frontend
 * shows this list in Settings, and `resolveShell` validates requests against
 * it so a client can never turn the picker into an arbitrary-exec channel.
 */
export function listShells(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    const dirs = (pathKey ? env[pathKey] : undefined)?.split(path.delimiter).filter(Boolean) ?? [];
    const found = WINDOWS_SHELL_CANDIDATES.filter((candidate) =>
      dirs.some((dir) => isExecutableFile(path.join(dir, candidate))));
    return found.length > 0 ? found : ['powershell.exe'];
  }

  const seen = new Set<string>();
  const shells: string[] = [];
  const add = (candidate: string | null | undefined): void => {
    if (!candidate || seen.has(candidate)) return;
    if (!isExecutableFile(candidate)) return;
    seen.add(candidate);
    shells.push(candidate);
  };

  add(passwdShell());
  add(env.SHELL);
  for (const candidate of POSIX_SHELL_CANDIDATES) add(candidate);
  for (const candidate of readEtcShells()) add(candidate);

  return shells.length > 0 ? shells : ['/bin/sh'];
}

/**
 * Picks the shell to spawn.
 *
 * `requested` comes from the browser, so it is only honoured when it is one of
 * the shells we discovered — never spawned verbatim.
 */
export function resolveShell(
  requested?: string | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const available = listShells(platform, env);
  if (requested && available.includes(requested)) return requested;

  if (platform === 'win32') return findWindowsShell(env);

  // The user's real login shell beats $SHELL, which the host never forwards,
  // which in turn beats whatever we happened to find on disk.
  return passwdShell() ?? env.SHELL ?? available[0] ?? '/bin/sh';
}

/**
 * A sensible LANG when the host handed us none. Without it, anything that
 * calls setlocale() (python, less, perl, gettext) falls back to the C locale
 * and mangles every non-ASCII character the terminal is perfectly able to show.
 */
function defaultLang(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return null;
  // glibc >= 2.35 and musl always ship C.UTF-8; macOS does not, but always has en_US.UTF-8.
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

export interface ShellEnvOptions {
  shell: string;
  cwd: string;
  platform?: NodeJS.Platform;
  /** Reported as TERM_PROGRAM_VERSION so shell configs can detect us. */
  version?: string;
}

/**
 * Builds the environment for the interactive shell.
 *
 * Two host-injected variables are deliberately dropped:
 *   • NODE_ENV — CloudCLI sets it to "production" for the plugin process. Left
 *     in place it silently changes what `npm install` does in the user's
 *     terminal (devDependencies are skipped), which is a genuinely confusing
 *     way to lose an afternoon.
 *   • PLUGIN_NAME — an internal host detail with no business in a user shell.
 */
export function buildShellEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: ShellEnvOptions,
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  delete env.NODE_ENV;
  delete env.PLUGIN_NAME;

  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'cloudcli-terminal';
  if (options.version) env.TERM_PROGRAM_VERSION = options.version;
  env.PWD = options.cwd;

  if (platform !== 'win32') {
    env.SHELL = options.shell;

    let username: string | null = null;
    let home: string | null = null;
    try {
      const info = os.userInfo();
      username = info.username;
      home = info.homedir;
    } catch {
      // No passwd entry (some minimal containers) — leave the names unset
      // rather than inventing one.
    }
    if (username) {
      if (!env.USER) env.USER = username;
      if (!env.LOGNAME) env.LOGNAME = username;
    }
    if (!env.HOME && home) env.HOME = home;

    const lang = defaultLang(platform);
    if (lang && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = lang;
  }

  return env;
}

/**
 * Moves the user's own npm global bin directory ahead of everything else on
 * PATH, so a globally installed CLI beats a system-managed copy of the same
 * name. Only reorders entries that are already on PATH — never adds any.
 */
export function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey];
  if (!currentPath) return env;

  const readEnv = (key: string): string | undefined => {
    const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
    return resolvedKey ? env[resolvedKey] : undefined;
  };
  const npmPrefix = readEnv('npm_config_prefix');
  const appData = readEnv('APPDATA');
  const candidates = [
    npmPrefix,
    npmPrefix ? path.join(npmPrefix, 'bin') : undefined,
    appData ? path.join(appData, 'npm') : undefined,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter((entry): entry is string => Boolean(entry));
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalize = (entry: string): string => process.platform === 'win32' ? entry.toLowerCase() : entry;
  const preferredEntries = candidates.filter((candidate, index) =>
    candidates.findIndex((entry) => normalize(entry) === normalize(candidate)) === index
    && pathEntries.some((entry) => normalize(entry) === normalize(candidate)));

  if (preferredEntries.length === 0) return env;

  const preferred = new Set(preferredEntries.map(normalize));
  return {
    ...env,
    [pathKey]: [
      ...preferredEntries,
      ...pathEntries.filter((entry) => !preferred.has(normalize(entry))),
    ].join(path.delimiter),
  };
}

/**
 * Resolves the directory a new shell should start in.
 *
 * `requested` is the project path the browser reports, so it is checked
 * rather than trusted: a stale or deleted project path must degrade to the
 * home directory instead of failing the spawn.
 */
export function resolveCwd(requested: string | null | undefined, home?: string): string {
  const fallbacks = [home, process.env.HOME, os.homedir(), os.tmpdir()];

  if (typeof requested === 'string' && requested.trim()) {
    const candidate = path.resolve(requested.trim());
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Falls through to the home directory below.
    }
  }

  for (const fallback of fallbacks) {
    if (!fallback) continue;
    try {
      if (fs.statSync(fallback).isDirectory()) return fallback;
    } catch {
      // Try the next fallback.
    }
  }
  return process.cwd();
}
