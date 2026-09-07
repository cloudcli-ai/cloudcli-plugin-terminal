/** User preferences, persisted in localStorage and shared by every tab. */

import { AUTO_THEME, THEMES } from './ui/themes.js';

const PREFS_KEY = 'web-terminal-prefs';
/** Pre-1.1 escape hatch; folded into the GPU acceleration checkbox. */
const LEGACY_WEBGL_KEY = 'web-terminal-disable-webgl';

export const DEFAULT_FONT_FAMILY =
  '"Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", '
  + '"Noto Sans Mono CJK JP", "Noto Sans CJK JP", "Microsoft YaHei", "MS Gothic", Meiryo, '
  + '"PingFang SC", "Hiragino Sans GB", "Noto Color Emoji", Menlo, Monaco, "Courier New", monospace';

/** Lines of history kept per terminal. */
export const SCROLLBACK = 10000;

export type CursorStyle = 'block' | 'bar' | 'underline';

export interface Prefs {
  theme: string;
  fontSize: number;
  fontFamily: string;
  cursorStyle: CursorStyle;
  copyOnSelect: boolean;
  webgl: boolean;
  /** xterm's accessibility tree; off by default because it costs performance. */
  screenReaderMode: boolean;
  /** Absolute path of the shell to spawn, or null for the host default. */
  shell: string | null;
}

export const DEFAULT_PREFS: Prefs = {
  theme: AUTO_THEME,
  fontSize: 14,
  fontFamily: DEFAULT_FONT_FAMILY,
  cursorStyle: 'block',
  copyOnSelect: false,
  webgl: true,
  screenReaderMode: false,
  shell: null,
};

function readLegacyWebglFlag(): boolean {
  try { return localStorage.getItem(LEGACY_WEBGL_KEY) !== 'true'; } catch { return true; }
}

/** Reads prefs, repairing anything a hand-edited or stale entry got wrong. */
export function loadPrefs(): Prefs {
  let stored: Partial<Prefs> = {};
  try { stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>; } catch { /* corrupt */ }

  const theme = typeof stored.theme === 'string' && (stored.theme === AUTO_THEME || THEMES[stored.theme])
    ? stored.theme
    : DEFAULT_PREFS.theme;
  const fontSize = Number.isFinite(stored.fontSize)
    ? Math.max(8, Math.min(32, Math.round(stored.fontSize as number)))
    : DEFAULT_PREFS.fontSize;
  const cursorStyle: CursorStyle =
    stored.cursorStyle === 'bar' || stored.cursorStyle === 'underline' || stored.cursorStyle === 'block'
      ? stored.cursorStyle
      : DEFAULT_PREFS.cursorStyle;

  return {
    theme,
    fontSize,
    fontFamily: typeof stored.fontFamily === 'string' && stored.fontFamily
      ? stored.fontFamily
      : DEFAULT_PREFS.fontFamily,
    cursorStyle,
    copyOnSelect: stored.copyOnSelect === true,
    webgl: typeof stored.webgl === 'boolean' ? stored.webgl : readLegacyWebglFlag(),
    screenReaderMode: stored.screenReaderMode === true,
    shell: typeof stored.shell === 'string' && stored.shell ? stored.shell : null,
  };
}

export function savePrefs(prefs: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// ── Tab persistence ───────────────────────────────────────────────────────────

const TABS_KEY = 'web-terminal-tabs';

export interface StoredTab {
  sessionId: string;
  label: string;
  active: boolean;
}

/**
 * Reloading the browser used to throw away every terminal: the in-memory tab
 * list lived on `window`. Remembering the server-side session ids lets the
 * shells (and whatever was running in them) be picked straight back up.
 */
export function loadStoredTabs(): StoredTab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((tab): tab is StoredTab => !!tab && typeof tab.sessionId === 'string')
      .slice(0, 32)
      .map((tab) => ({
        sessionId: tab.sessionId,
        label: typeof tab.label === 'string' ? tab.label : 'shell',
        active: tab.active === true,
      }));
  } catch {
    return [];
  }
}

export function saveStoredTabs(tabs: StoredTab[]): void {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* private mode */ }
}
