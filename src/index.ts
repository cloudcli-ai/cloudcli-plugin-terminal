/**
 * web-terminal plugin — full xterm.js terminal with multi-tab support.
 *
 * Sessions persist across mount/unmount (tab switching). WebSocket connections
 * and PTY processes stay alive when the user navigates to other tabs.
 */

import type { PluginAPI } from './types.js';

// ── CDN version pins ──────────────────────────────────────────────────────────
const CDN = 'https://esm.sh';
const XTERM_VER     = '5.5.0';
const FIT_VER       = '0.10.0';
const WEBLINKS_VER  = '0.11.0';
const WEBGL_VER     = '0.18.0';
const CLIPBOARD_VER = '0.1.0';
const UNICODE11_VER = '0.8.0';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

interface Prefs {
  theme: string;
  fontSize: number;
  fontFamily?: string;
}

interface XtermModules {
  Terminal: any;
  FitAddon: any;
  WebLinksAddon: any;
  WebglAddon: any;
  ClipboardAddon: any;
  Unicode11Addon: any;
}

interface GlobalState {
  modules: XtermModules | null;
  sessions: Map<string, TerminalSession>;
  prefs: Prefs | null;
  tabCounter: number;
  activeId: string | null;
}

interface MobileKey {
  label: string;
  seq?: string;
  modifier?: string;
  svg?: boolean;
}

// ── Terminal themes ───────────────────────────────────────────────────────────
const THEMES: Record<string, TerminalTheme> = {
  'VS Dark': {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff',
    cursorAccent: '#1e1e1e', selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
    blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
    brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
    brightCyan: '#29b8db', brightWhite: '#ffffff',
  },
  'One Dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff',
    cursorAccent: '#282c34', selectionBackground: '#3e4451',
    selectionForeground: '#abb2bf',
    black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#4f5666', brightRed: '#ff7b86', brightGreen: '#a5e075',
    brightYellow: '#f0d197', brightBlue: '#6db3f2', brightMagenta: '#d886f3',
    brightCyan: '#4cd1e0', brightWhite: '#ffffff',
  },
  'Dracula': {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
    cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'Solarized Dark': {
    background: '#002b36', foreground: '#839496', cursor: '#839496',
    cursorAccent: '#002b36', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'Light': {
    background: '#ffffff', foreground: '#383a42', cursor: '#383a42',
    cursorAccent: '#ffffff', selectionBackground: '#e5e5e6',
    black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
    blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#fafafa',
    brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
    brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
    brightCyan: '#0997b3', brightWhite: '#ffffff',
  },
};

// ── Persistent prefs ──────────────────────────────────────────────────────────
const PREFS_KEY = 'web-terminal-prefs';
function loadPrefs(): Partial<Prefs> { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } }
function savePrefs(p: Prefs): void { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

// ── Global state — stored on window to survive Blob URL re-imports ────────────
declare global {
  interface Window { __wtState?: GlobalState; }
}

if (!window.__wtState) {
  window.__wtState = { modules: null, sessions: new Map(), prefs: null, tabCounter: 0, activeId: null };
}
const _G: GlobalState = window.__wtState;

// ── Safe DOM helpers ──────────────────────────────────────────────────────────
function el(tag: string, cls?: string | null, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svgBtn(svgMarkup: string, title?: string): HTMLButtonElement {
  const b = el('button', 'wt-btn') as HTMLButtonElement;
  b.title = title || '';
  const span = el('span');
  span.innerHTML = svgMarkup; // eslint-disable-line -- trusted constant
  b.appendChild(span);
  return b;
}

function divider(): HTMLElement { return el('div', 'wt-divider'); }

// ── CSS ───────────────────────────────────────────────────────────────────────
function injectStyles(): void {
  if (document.getElementById('wt-css')) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${CDN}/@xterm/xterm@${XTERM_VER}/css/xterm.css`;
  document.head.appendChild(link);

  const s = document.createElement('style');
  s.id = 'wt-css';
  s.textContent = `
    .wt-root {
      display:flex; flex-direction:column; height:100%;
      background:#1e1e1e; color:#d4d4d4;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      overflow:hidden;
      --accent:#4ec9b0; --border:rgba(255,255,255,0.08);
      --toolbar-bg:rgba(0,0,0,0.3); --tab-bg:rgba(255,255,255,0.05);
      --tab-active:rgba(255,255,255,0.1); --btn:rgba(255,255,255,0.08);
      --btn-hover:rgba(255,255,255,0.15);
    }
    .wt-root.wt-light {
      background:#f5f5f5; color:#383a42;
      --accent:#0184bc; --border:rgba(0,0,0,0.12);
      --toolbar-bg:rgba(0,0,0,0.06); --tab-bg:rgba(0,0,0,0.04);
      --tab-active:rgba(0,0,0,0.1); --btn:rgba(0,0,0,0.06);
      --btn-hover:rgba(0,0,0,0.12);
    }
    .wt-toolbar {
      display:flex; align-items:center; gap:2px;
      padding:4px 6px; background:var(--toolbar-bg);
      border-bottom:1px solid var(--border); flex-shrink:0; min-height:36px;
    }
    .wt-tabs { display:flex; align-items:center; flex:1; overflow-x:auto; gap:2px; scrollbar-width:none; }
    .wt-tabs::-webkit-scrollbar { display:none; }
    .wt-tab {
      display:flex; align-items:center; gap:5px; padding:4px 8px 4px 10px;
      border-radius:5px; cursor:pointer; white-space:nowrap;
      background:var(--tab-bg); font-size:12px; font-weight:500;
      opacity:.7; transition:background .15s,opacity .15s;
      user-select:none; border:1px solid transparent; flex-shrink:0;
    }
    .wt-tab:hover { opacity:.9; background:var(--tab-active); }
    .wt-tab.active { background:var(--tab-active); border-color:var(--accent); opacity:1; }
    .wt-tab-dot { width:6px; height:6px; border-radius:50%; background:var(--accent); flex-shrink:0; }
    .wt-tab-dot.off { background:#666; }
    .wt-tab-close {
      display:flex; align-items:center; justify-content:center;
      width:16px; height:16px; border-radius:3px; border:none; background:none;
      color:inherit; cursor:pointer; opacity:.4; font-size:13px; padding:0;
    }
    .wt-tab-close:hover { opacity:1; background:rgba(255,70,70,.3); }
    .wt-btn {
      display:flex; align-items:center; justify-content:center;
      height:28px; min-width:28px; padding:0 6px; border-radius:5px;
      border:none; background:var(--btn); color:inherit; font-size:12px;
      cursor:pointer; flex-shrink:0; transition:background .15s;
    }
    .wt-btn:hover { background:var(--btn-hover); }
    .wt-btn span { display:flex; align-items:center; }
    .wt-btn svg { width:14px; height:14px; }
    .wt-divider { width:1px; height:18px; background:var(--border); margin:0 3px; flex-shrink:0; }
    .wt-panes { flex:1; position:relative; overflow:hidden; }
    .wt-pane { position:absolute; inset:0; display:flex; flex-direction:column; overflow:hidden; padding:4px; }
    .wt-pane.hidden { display:none; }
    .wt-pane .xterm { height:100%; }
    .wt-pane .xterm-viewport { overflow-y:auto !important; }
    .xterm .xterm-screen { outline:none !important; }
    .wt-overlay {
      position:absolute; inset:0; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:10px;
      background:rgba(0,0,0,.6); backdrop-filter:blur(4px);
      z-index:10; text-align:center; padding:24px;
    }
    .wt-overlay-title { font-size:14px; font-weight:600; }
    .wt-overlay-sub { font-size:12px; opacity:.6; }
    .wt-overlay-btn {
      margin-top:6px; padding:7px 18px; border-radius:6px; border:none;
      background:var(--accent); color:#fff; font-size:13px; cursor:pointer; font-weight:500;
    }
    .wt-overlay-btn:hover { filter:brightness(1.15); }
    .wt-settings-wrap { position:relative; }
    .wt-popover {
      position:absolute; top:calc(100% + 6px); right:0; z-index:50;
      background:#2d2d2d; border:1px solid rgba(255,255,255,.12);
      border-radius:8px; padding:12px 14px; min-width:180px;
      box-shadow:0 8px 24px rgba(0,0,0,.4);
      display:none; flex-direction:column; gap:10px;
    }
    .wt-root.wt-light .wt-popover { background:#fff; border-color:rgba(0,0,0,.12); box-shadow:0 8px 24px rgba(0,0,0,.12); }
    .wt-popover.open { display:flex; }
    .wt-popover label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; opacity:.5; }
    .wt-popover select {
      width:100%; height:28px; padding:0 6px; border-radius:5px;
      border:1px solid var(--border); background:var(--btn); color:inherit;
      font-size:12px; cursor:pointer; outline:none;
    }
    .wt-popover select:focus { border-color:var(--accent); }
    .wt-fs-row { display:flex; align-items:center; gap:8px; }
    .wt-fs-row span { flex:1; text-align:center; font-size:13px; font-weight:500; }
    .wt-keybar {
      display:none; flex-shrink:0; overflow-x:auto; flex-wrap:nowrap;
      gap:4px; padding:5px 6px; background:var(--toolbar-bg);
      border-top:1px solid var(--border); scrollbar-width:none;
      -webkit-overflow-scrolling:touch;
    }
    .wt-keybar::-webkit-scrollbar { display:none; }
    .wt-key {
      flex-shrink:0; height:34px; min-width:38px; padding:0 10px;
      border-radius:6px; border:1px solid var(--border);
      background:var(--btn); color:inherit; font-size:12px;
      font-family:inherit; font-weight:500; cursor:pointer;
      display:flex; align-items:center; justify-content:center;
      user-select:none; -webkit-tap-highlight-color:transparent;
    }
    .wt-key:active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .wt-key.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .wt-key svg { width:16px; height:16px; }
    @media (max-width:768px), (hover:none) and (pointer:coarse) {
      .wt-keybar { display:flex; }
      .wt-toolbar { min-height:34px; padding:3px 4px; }
      .wt-btn { height:26px; min-width:26px; }
      .wt-tab { font-size:11px; padding:3px 6px 3px 8px; }
    }
    @keyframes wt-spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
    .wt-spinner { width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:wt-spin .8s linear infinite; }
    .wt-new-tab {
      display:flex; align-items:center; justify-content:center;
      width:26px; height:26px; border-radius:5px; border:none;
      background:none; color:inherit; font-size:17px; cursor:pointer;
      opacity:.5; flex-shrink:0;
    }
    .wt-new-tab:hover { opacity:1; background:var(--btn-hover); }
  `;
  document.head.appendChild(s);
}

// ── SVG icon constants ────────────────────────────────────────────────────────
const IC: Record<string, string> = {
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M6.8 1.5h2.4l.3 1.9 1.1.5 1.5-1 1.7 1.7-1 1.5.5 1.1 1.9.3v2.4l-1.9.3-1.1.5 1 1.5-1.7 1.7-1.5-1-1.1.5-.3 1.9H6.8l-.3-1.9-1.1-.5-1.5 1-1.7-1.7 1-1.5-.5-1.1-1.9-.3V6.1l1.9-.3.5-1.1-1-1.5L4.9 2l1.5 1 1.1-.5z"/><circle cx="8" cy="8" r="2"/></svg>',
  minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>',
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
  left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4l-4 4 4 4"/></svg>',
  right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
  paste: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="8" height="11" rx="1"/><path d="M3 12V3a1 1 0 011-1h5"/><path d="M8 6h3M8 8.5h3M8 11h2"/></svg>',
};

// ── WebSocket URL ─────────────────────────────────────────────────────────────
function buildWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('auth-token') || '';
  const qs = token ? '?token=' + encodeURIComponent(token) : '';
  const basePath = (window as any).__CLOUDCLI_BASE_PATH__ || '';
  return proto + '//' + location.host + basePath + '/plugin-ws/web-terminal' + qs;
}

// ── Terminal session ──────────────────────────────────────────────────────────
interface SessionOptions {
  id: string; label: string;
  Terminal: any; FitAddon: any; WebLinksAddon: any; WebglAddon: any;
  ClipboardAddon: any; Unicode11Addon: any;
  prefs: Prefs;
  onChange: (id: string, status: string) => void;
}

class TerminalSession {
  id: string;
  label: string;
  status: string;
  onChange: (id: string, status: string) => void;
  prefs: Prefs;
  el: HTMLElement;
  overlayEl: HTMLElement;
  terminal: any;
  fitAddon: any;
  ws: WebSocket | null;

  private _destroyed: boolean;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null;
  private _reconnectAttempts: number;
  private _pingInterval: ReturnType<typeof setInterval> | null;
  private _needsReconnect: boolean;
  private _hasConnectedBefore: boolean;
  private _dataDisposable: { dispose(): void } | null;
  private _ro: ResizeObserver;

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.status = 'connecting';
    this.onChange = opts.onChange;
    this.prefs = opts.prefs;
    this._destroyed = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._pingInterval = null;

    this.el = el('div', 'wt-pane hidden');
    this.overlayEl = el('div', 'wt-overlay');
    this.el.appendChild(this.overlayEl);
    this._showOverlay('connecting', 'Connecting...', 'Starting shell session');

    this.terminal = new opts.Terminal({
      cursorBlink: true,
      fontSize: opts.prefs.fontSize || 14,
      fontFamily: opts.prefs.fontFamily || "Menlo, Monaco, 'Courier New', monospace",
      allowProposedApi: true, convertEol: true, scrollback: 10000,
      tabStopWidth: 4, macOptionIsMeta: true, macOptionClickForcesSelection: true,
      theme: THEMES[opts.prefs.theme || 'VS Dark'],
    });

    this.fitAddon = new opts.FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new opts.WebLinksAddon());

    if (opts.Unicode11Addon) { try { const u = new opts.Unicode11Addon(); this.terminal.loadAddon(u); this.terminal.unicode.activeVersion = '11'; } catch { /* ignore */ } }
    if (opts.ClipboardAddon) { try { this.terminal.loadAddon(new opts.ClipboardAddon()); } catch { /* ignore */ } }

    this.terminal.open(this.el);

    try {
      const webgl = new opts.WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* ignore */ } });
      this.terminal.loadAddon(webgl);
    } catch { /* ignore */ }

    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'c' && this.terminal.hasSelection()) {
        e.preventDefault();
        this._copyText(this.terminal.getSelection());
        return false;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        navigator.clipboard?.readText?.().then((t: string) => t && this._send(t)).catch(() => {});
        return false;
      }
      return true;
    });

    this._dataDisposable = this.terminal.onData((d: string) => this._send(d));
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(this.el);

    this.ws = null;
    this._needsReconnect = false;
    this._hasConnectedBefore = false;
    this._connect();
  }

  private _connect(): void {
    if (this._destroyed) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingInterval) clearInterval(this._pingInterval);

    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onclose = null; old.onerror = null; old.onmessage = null;
      try { old.close(); } catch { /* ignore */ }
    }

    this._setStatus('connecting');
    if (this.el.parentNode) {
      this._showOverlay('connecting', 'Connecting...', 'Starting shell session');
    }

    let ws: WebSocket;
    try { ws = new WebSocket(buildWsUrl()); } catch (e) {
      this._setStatus('error');
      if (this.el.parentNode) this._showOverlay('error', 'Connection failed', (e as Error).message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (ev: MessageEvent) => {
      let d = ev.data;
      // Decode binary frames to text (happens when behind reverse proxies)
      if (d instanceof ArrayBuffer) {
        d = new TextDecoder().decode(d);
      }
      if (typeof d === 'string' && d.charCodeAt(0) === 123) {
        try {
          const m = JSON.parse(d);
          if (m.type === 'ready') {
            this._setStatus('connected');
            this.overlayEl.style.display = 'none';
            this._reconnectAttempts = 0;
            this._startPing();
            if (this._hasConnectedBefore) {
              this.terminal.write('\r\n\x1b[2m--- reconnected ---\x1b[0m\r\n');
            }
            this._hasConnectedBefore = true;
            setTimeout(() => { this._fit(); this.terminal.focus(); }, 60);
            return;
          }
          if (m.type === 'exit') {
            this.terminal.write('\r\n\x1b[33mShell exited (code ' + (m.exitCode ?? 0) + ')\x1b[0m\r\n');
            this._setStatus('disconnected');
            this._showOverlay('disconnected', 'Shell exited', 'Exit code: ' + (m.exitCode ?? 0));
            return;
          }
          if (m.type === 'error') {
            this.terminal.write('\r\n\x1b[31mError: ' + (m.message || 'unknown') + '\x1b[0m\r\n');
            this._setStatus('error');
            this._showOverlay('error', 'Shell error', String(m.message || 'Unknown error'));
            return;
          }
          if (m.type === 'pong') return;
        } catch { /* ignore */ }
      }
      this.terminal.write(typeof d === 'string' ? d : new Uint8Array(d));
    };

    ws.onclose = () => {
      if (this._pingInterval) clearInterval(this._pingInterval);
      if (this._destroyed || this.ws !== ws) return;
      this._setStatus('disconnected');
      this._needsReconnect = true;
      if (this.el.parentNode) this._showOverlay('disconnected', 'Disconnected', 'Connection lost');
    };

    ws.onerror = () => {
      if (this._destroyed || this.ws !== ws) return;
      this._setStatus('error');
      this._needsReconnect = true;
      if (this.el.parentNode) this._showOverlay('error', 'Connection error', 'Failed to reach terminal server');
    };
  }

  private _startPing(): void {
    if (this._pingInterval) clearInterval(this._pingInterval);
    this._pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  private _send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  sendKey(seq: string): void { this._send(seq); this.terminal.focus(); }

  private _fit(): void {
    if (!this.fitAddon || this.el.classList.contains('hidden') || !this.el.parentNode) return;
    try {
      this.fitAddon.fit();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows }));
      }
    } catch { /* ignore */ }
  }

  private _setStatus(s: string): void { this.status = s; if (this.onChange) this.onChange(this.id, s); }

  private _showOverlay(type: string, title: string, sub?: string): void {
    while (this.overlayEl.firstChild) this.overlayEl.removeChild(this.overlayEl.firstChild);
    this.overlayEl.style.display = 'flex';
    if (type === 'connecting') this.overlayEl.appendChild(el('div', 'wt-spinner'));
    this.overlayEl.appendChild(el('div', 'wt-overlay-title', title));
    if (sub) this.overlayEl.appendChild(el('div', 'wt-overlay-sub', sub));
    if (type !== 'connecting') {
      const btn = el('button', 'wt-overlay-btn', 'Reconnect');
      btn.addEventListener('click', () => { this._reconnectAttempts = 0; this._connect(); });
      this.overlayEl.appendChild(btn);
    }
  }

  private _copyText(text: string): void {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => this._fallbackCopy(text));
    } else { this._fallbackCopy(text); }
  }

  private _fallbackCopy(text: string): void {
    const t = document.createElement('textarea');
    t.value = text; t.style.cssText = 'position:fixed;top:-9999px';
    document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t);
  }

  show(): void {
    this.el.classList.remove('hidden');
    if (this.status === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.overlayEl.style.display = 'none';
      setTimeout(() => { this._fit(); this.terminal.focus(); }, 30);
    } else if (this.status === 'connecting' && this.ws) {
      setTimeout(() => { this._fit(); }, 30);
    } else {
      this._needsReconnect = false;
      this._connect();
    }
  }

  hide(): void { this.el.classList.add('hidden'); }
  clear(): void { this.terminal.clear(); this.terminal.write('\x1b[2J\x1b[H'); }
  copySelection(): void { this._copyText(this.terminal.getSelection()); }

  reconnect(): void {
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.terminal.clear();
    this._reconnectAttempts = 0;
    this._connect();
  }

  updateFontSize(sz: number): void { this.terminal.options.fontSize = sz; this._fit(); }
  updateTheme(name: string): void { const t = THEMES[name]; if (t) this.terminal.options.theme = t; }

  detach(): void { if (this.el.parentNode) this.el.remove(); }

  attachTo(container: HTMLElement): void {
    container.appendChild(this.el);
    setTimeout(() => {
      try { this.terminal.refresh(0, this.terminal.rows - 1); this._fit(); } catch { /* ignore */ }
    }, 50);
  }

  destroy(): void {
    this._destroyed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingInterval) clearInterval(this._pingInterval);
    this._ro.disconnect();
    if (this._dataDisposable) this._dataDisposable.dispose();
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    try { this.terminal.dispose(); } catch { /* ignore */ }
    this.el.remove();
  }
}

// ── Module loader (cached) ────────────────────────────────────────────────────
async function loadModules(): Promise<XtermModules> {
  if (_G.modules) return _G.modules;
  const results = await Promise.all([
    import(CDN + '/@xterm/xterm@' + XTERM_VER),
    import(CDN + '/@xterm/addon-fit@' + FIT_VER),
    import(CDN + '/@xterm/addon-web-links@' + WEBLINKS_VER),
    import(CDN + '/@xterm/addon-webgl@' + WEBGL_VER),
    import(CDN + '/@xterm/addon-clipboard@' + CLIPBOARD_VER).catch(() => ({ ClipboardAddon: null })),
    import(CDN + '/@xterm/addon-unicode11@' + UNICODE11_VER).catch(() => ({ Unicode11Addon: null })),
  ]);
  _G.modules = {
    Terminal: results[0].Terminal, FitAddon: results[1].FitAddon,
    WebLinksAddon: results[2].WebLinksAddon, WebglAddon: results[3].WebglAddon,
    ClipboardAddon: results[4].ClipboardAddon, Unicode11Addon: results[5].Unicode11Addon,
  };
  return _G.modules;
}

// ── Mount ─────────────────────────────────────────────────────────────────────
export async function mount(container: HTMLElement, api: PluginAPI): Promise<void> {
  injectStyles();

  let mods: XtermModules;
  try {
    mods = await loadModules();
  } catch (err) {
    const errDiv = el('div');
    errDiv.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#f14c4c;padding:24px;text-align:center;font-family:sans-serif';
    const inner = el('div');
    inner.appendChild(el('div', null, 'Failed to load xterm.js'));
    (inner.firstChild as HTMLElement).style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px';
    const detail = el('div', null, (err as Error).message);
    detail.style.cssText = 'font-size:12px;opacity:.7';
    inner.appendChild(detail);
    errDiv.appendChild(inner);
    container.appendChild(errDiv);
    return;
  }

  if (!_G.prefs) {
    _G.prefs = loadPrefs() as Prefs;
    _G.prefs.theme = _G.prefs.theme || 'VS Dark';
    _G.prefs.fontSize = _G.prefs.fontSize || 14;
  }
  const prefs = _G.prefs;
  const isLight = (): boolean => prefs.theme === 'Light';

  const root = el('div', 'wt-root' + (isLight() ? ' wt-light' : ''));
  container.appendChild(root);

  const toolbar = el('div', 'wt-toolbar');
  root.appendChild(toolbar);
  const tabBar = el('div', 'wt-tabs');
  toolbar.appendChild(tabBar);
  const newBtn = el('button', 'wt-new-tab', '+');
  newBtn.title = 'New tab';
  toolbar.appendChild(newBtn);
  toolbar.appendChild(divider());

  const settingsWrap = el('div', 'wt-settings-wrap');
  const gearBtn = svgBtn(IC.gear, 'Settings');
  settingsWrap.appendChild(gearBtn);
  const popover = el('div', 'wt-popover');

  popover.appendChild(el('label', null, 'Theme'));
  const themeSel = document.createElement('select');
  Object.keys(THEMES).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if (name === prefs.theme) opt.selected = true;
    themeSel.appendChild(opt);
  });
  popover.appendChild(themeSel);

  popover.appendChild(el('label', null, 'Font Size'));
  const fsRow = el('div', 'wt-fs-row');
  const fsMinus = svgBtn(IC.minus, 'Decrease');
  const fsVal = el('span', null, prefs.fontSize + 'px');
  const fsPlus = svgBtn(IC.plus, 'Increase');
  fsRow.appendChild(fsMinus); fsRow.appendChild(fsVal); fsRow.appendChild(fsPlus);
  popover.appendChild(fsRow);
  settingsWrap.appendChild(popover);
  toolbar.appendChild(settingsWrap);

  const panesEl = el('div', 'wt-panes');
  root.appendChild(panesEl);

  const keybar = el('div', 'wt-keybar');
  root.appendChild(keybar);

  const MOBILE_KEYS: MobileKey[] = [
    { label: IC.paste, seq: '__paste__', svg: true },
    { label: 'ESC', seq: '\x1b' }, { label: 'TAB', seq: '\t' },
    { label: 'CTRL', modifier: 'ctrl' }, { label: 'ALT', modifier: 'alt' },
    { label: IC.up, seq: '\x1b[A', svg: true }, { label: IC.down, seq: '\x1b[B', svg: true },
    { label: IC.left, seq: '\x1b[D', svg: true }, { label: IC.right, seq: '\x1b[C', svg: true },
    { label: '|', seq: '|' }, { label: '~', seq: '~' }, { label: '/', seq: '/' },
    { label: '-', seq: '-' }, { label: '_', seq: '_' },
  ];

  let ctrlActive = false, altActive = false;
  let ctrlKeyEl: HTMLElement | null = null, altKeyEl: HTMLElement | null = null;

  MOBILE_KEYS.forEach(k => {
    const btn = el('button', 'wt-key');
    if (k.svg) {
      const span = el('span');
      span.innerHTML = k.label; // eslint-disable-line -- trusted SVG constant
      btn.appendChild(span);
    } else {
      btn.textContent = k.label;
    }

    if (k.modifier === 'ctrl') {
      ctrlKeyEl = btn;
      btn.addEventListener('click', () => {
        ctrlActive = !ctrlActive; btn.classList.toggle('active', ctrlActive);
        activeSession()?.terminal.focus();
      });
    } else if (k.modifier === 'alt') {
      altKeyEl = btn;
      btn.addEventListener('click', () => {
        altActive = !altActive; btn.classList.toggle('active', altActive);
        activeSession()?.terminal.focus();
      });
    } else if (k.seq === '__paste__') {
      btn.addEventListener('click', () => {
        const sess = activeSession();
        if (!sess) return;
        navigator.clipboard?.readText?.().then((t: string) => {
          if (t) sess.sendKey(t);
        }).catch(() => {});
      });
    } else {
      btn.addEventListener('click', () => {
        const sess = activeSession();
        if (!sess) return;
        let seq = k.seq!;
        if (ctrlActive && seq.length === 1) {
          const code = seq.toLowerCase().charCodeAt(0);
          if (code >= 97 && code <= 122) seq = String.fromCharCode(code - 96);
          ctrlActive = false;
          if (ctrlKeyEl) ctrlKeyEl.classList.remove('active');
        }
        if (altActive && seq.length === 1) {
          seq = '\x1b' + seq;
          altActive = false;
          if (altKeyEl) altKeyEl.classList.remove('active');
        }
        sess.sendKey(seq);
      });
    }
    keybar.appendChild(btn);
  });

  function activeSession(): TerminalSession | undefined { return _G.sessions.get(_G.activeId!); }

  function renderTabs(): void {
    while (tabBar.firstChild) tabBar.removeChild(tabBar.firstChild);
    for (const [id, sess] of _G.sessions) {
      const tab = el('div', 'wt-tab' + (id === _G.activeId ? ' active' : ''));
      const dot = el('div', 'wt-tab-dot' + (sess.status !== 'connected' ? ' off' : ''));
      const lbl = el('span', null, sess.label);
      const closeEl = el('button', 'wt-tab-close');
      closeEl.textContent = '\u00d7'; closeEl.title = 'Close';
      closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
      tab.appendChild(dot); tab.appendChild(lbl); tab.appendChild(closeEl);
      tab.addEventListener('click', () => activateTab(id));
      tabBar.appendChild(tab);
    }
  }

  function activateTab(id: string): void {
    if (_G.activeId === id) return;
    const prev = _G.sessions.get(_G.activeId!);
    if (prev) prev.hide();
    _G.activeId = id;
    const sess = _G.sessions.get(id);
    if (sess) sess.show();
    renderTabs();
  }

  function createTab(): void {
    _G.tabCounter++;
    const id = 't' + _G.tabCounter;
    const sess = new TerminalSession({
      id, label: 'shell ' + _G.tabCounter,
      Terminal: mods.Terminal, FitAddon: mods.FitAddon,
      WebLinksAddon: mods.WebLinksAddon, WebglAddon: mods.WebglAddon,
      ClipboardAddon: mods.ClipboardAddon, Unicode11Addon: mods.Unicode11Addon,
      prefs, onChange() { renderTabs(); },
    });
    _G.sessions.set(id, sess);
    sess.attachTo(panesEl);
    activateTab(id);
    renderTabs();
  }

  function closeTab(id: string): void {
    const sess = _G.sessions.get(id);
    if (!sess) return;
    sess.destroy(); _G.sessions.delete(id);
    if (_G.sessions.size === 0) { _G.activeId = null; createTab(); return; }
    if (_G.activeId === id) activateTab([..._G.sessions.keys()].pop()!);
    renderTabs();
  }

  if (_G.sessions.size > 0) {
    for (const sess of _G.sessions.values()) {
      sess.attachTo(panesEl);
      sess.onChange = function() { renderTabs(); };
      if (sess.id === _G.activeId) sess.show(); else sess.hide();
    }
    renderTabs();
  } else {
    createTab();
  }

  newBtn.addEventListener('click', createTab);

  let popoverOpen = false;
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation(); popoverOpen = !popoverOpen;
    popover.classList.toggle('open', popoverOpen);
  });
  const closePopover = (): void => { popoverOpen = false; popover.classList.remove('open'); };
  document.addEventListener('click', closePopover);
  popover.addEventListener('click', (e) => e.stopPropagation());

  themeSel.addEventListener('change', () => {
    prefs.theme = themeSel.value; savePrefs(prefs);
    root.classList.toggle('wt-light', isLight());
    for (const s of _G.sessions.values()) s.updateTheme(prefs.theme);
  });
  fsMinus.addEventListener('click', () => {
    prefs.fontSize = Math.max(8, prefs.fontSize - 1);
    fsVal.textContent = prefs.fontSize + 'px'; savePrefs(prefs);
    for (const s of _G.sessions.values()) s.updateFontSize(prefs.fontSize);
  });
  fsPlus.addEventListener('click', () => {
    prefs.fontSize = Math.min(32, prefs.fontSize + 1);
    fsVal.textContent = prefs.fontSize + 'px'; savePrefs(prefs);
    for (const s of _G.sessions.values()) s.updateFontSize(prefs.fontSize);
  });

  const onKey = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault(); createTab();
    }
  };
  document.addEventListener('keydown', onKey);
  const unsubCtx = api.onContextChange ? api.onContextChange(() => {}) : null;

  (container as any)._wtCleanup = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', closePopover);
    if (unsubCtx) unsubCtx();
    for (const sess of _G.sessions.values()) sess.detach();
    root.remove();
  };
}

export function unmount(container: HTMLElement): void {
  if ((container as any)._wtCleanup) {
    (container as any)._wtCleanup();
    delete (container as any)._wtCleanup;
  }
}
