/**
 * One terminal tab: an xterm.js instance plus the socket that feeds it.
 *
 * The socket is deliberately resilient. It reconnects on its own with
 * exponential backoff, retries immediately when the browser comes back online
 * or the tab becomes visible again, and resumes the *same* server-side PTY by
 * id — so a lost connection no longer means a lost shell.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';

import { SCROLLBACK, type Prefs } from './prefs.js';
import { THEMES, resolveThemeName } from './ui/themes.js';
import type { HelloMessage, ServerMessage } from './protocol.js';

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited' | 'error';

/** Give up on a handshake that never completes rather than spin forever. */
const CONNECT_TIMEOUT_MS = 12000;
const MAX_RECONNECT_DELAY_MS = 15000;
const PING_INTERVAL_MS = 25000;

const encoder = new TextEncoder();

export interface SessionOptions {
  id: string;
  index: number;
  prefs: Prefs;
  /** Project directory for the first spawn; null falls back to $HOME. */
  cwd: string | null;
  /** Server session id to resume, when restoring tabs after a reload. */
  resumeSessionId?: string | null;
  label?: string;
  hostTheme: 'dark' | 'light';
  onChange: (session: TerminalSession) => void;
  onBell?: (session: TerminalSession) => void;
}

/** Builds the proxy URL, reading the auth token fresh on every attempt. */
function buildWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Read at connect time, not at module load: CloudCLI rotates this token, and
  // a cached copy made every reconnect after a rotation fail authentication.
  let token = '';
  try { token = localStorage.getItem('auth-token') || ''; } catch { /* blocked storage */ }
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${location.host}/plugin-ws/web-terminal${query}`;
}

function isMac(): boolean {
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export class TerminalSession {
  readonly id: string;
  readonly el: HTMLElement;
  readonly terminal: Terminal;
  readonly searchAddon: SearchAddon;

  label: string;
  title = '';
  status: SessionStatus = 'connecting';
  /** Server-side session id, once the handshake has completed at least once. */
  serverSessionId: string | null = null;
  cwd: string | null;
  shell: string | null = null;
  /** Capabilities advertised by the backend in its `hello` frame. */
  hello: HelloMessage | null = null;
  exitCode: number | null = null;
  /** Set while a modifier key from the mobile bar is armed for the next press. */
  pendingCtrl = false;
  pendingAlt = false;
  onModifiersChange: (() => void) | null = null;

  private readonly overlayEl: HTMLElement;
  private readonly fitAddon: FitAddon;
  private readonly prefs: Prefs;
  private readonly onChange: (session: TerminalSession) => void;
  private readonly onBell?: (session: TerminalSession) => void;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly resizeObserver: ResizeObserver;

  private ws: WebSocket | null = null;
  private webgl: WebglAddon | null = null;
  private destroyed = false;
  private everConnected = false;
  /** Bytes rendered so far — the resume cursor sent back to the server. */
  private seq = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingsAwaitingPong = 0;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCols = 0;
  private lastRows = 0;
  private pendingResume: string | null;
  /** Set while restart() is in flight, so the fresh shell is not reported as an expiry. */
  private restarting = false;

  private readonly onOnline = (): void => { if (this.status === 'reconnecting') this.connect(true); };
  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible' && this.status === 'reconnecting') this.connect(true);
  };

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.prefs = options.prefs;
    this.cwd = options.cwd;
    this.label = options.label || `shell ${options.index}`;
    this.onChange = options.onChange;
    this.onBell = options.onBell;
    this.pendingResume = options.resumeSessionId ?? null;

    this.el = document.createElement('div');
    this.el.className = 'wt-pane';
    this.el.hidden = true;

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'wt-overlay';
    this.el.appendChild(this.overlayEl);

    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: options.prefs.cursorStyle,
      fontSize: options.prefs.fontSize,
      fontFamily: options.prefs.fontFamily,
      allowProposedApi: true,
      scrollback: SCROLLBACK,
      tabStopWidth: 8,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      screenReaderMode: options.prefs.screenReaderMode,
      // No `convertEol`: the PTY's line discipline already applies ONLCR, and
      // forcing it a second time corrupts full-screen apps (vim, htop, less)
      // that move the cursor themselves.
      theme: THEMES[resolveThemeName(options.prefs.theme, options.hostTheme)],
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    try {
      const unicode = new Unicode11Addon();
      this.terminal.loadAddon(unicode);
      this.terminal.unicode.activeVersion = '11';
    } catch { /* wide-character widths fall back to Unicode 6 */ }
    try { this.terminal.loadAddon(new ClipboardAddon()); } catch { /* OSC 52 unsupported */ }

    this.terminal.open(this.el);
    this.applyWebgl(options.prefs.webgl);

    this.disposables.push(this.terminal.onData((data) => this.handleInput(data)));
    this.disposables.push(this.terminal.onBinary((data) => this.sendBytes(latin1ToBytes(data))));
    this.disposables.push(this.terminal.onTitleChange((title) => this.handleTitle(title)));
    this.disposables.push(this.terminal.onBell(() => this.onBell?.(this)));
    this.disposables.push(this.terminal.onSelectionChange(() => {
      if (this.prefs.copyOnSelect && this.terminal.hasSelection()) this.copySelection();
    }));

    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.el);
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);

    this.showOverlay('connecting', 'Connecting…', 'Starting shell session');
    this.connect();
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  private connect(immediate = false): void {
    if (this.destroyed) return;
    this.clearTimers();

    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      stale.onopen = null; stale.onclose = null; stale.onerror = null; stale.onmessage = null;
      try { stale.close(); } catch { /* already closed */ }
    }

    this.setStatus(this.everConnected && !immediate ? 'reconnecting' : 'connecting');
    this.showOverlay(
      'connecting',
      this.everConnected ? 'Reconnecting…' : 'Connecting…',
      this.everConnected ? 'Restoring your shell session' : 'Starting shell session',
    );

    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl());
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    // A socket that opens but never completes the handshake (hung proxy, host
    // mid-restart) used to sit on a spinner forever with no way out.
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && this.status !== 'connected') {
        try { ws.close(); } catch { /* ignore */ }
        this.scheduleReconnect('Timed out waiting for the terminal server');
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onmessage = (event: MessageEvent) => this.handleMessage(ws, event);
    ws.onclose = (event: CloseEvent) => {
      if (this.destroyed || this.ws !== ws) return;
      if (this.status === 'exited') return;
      this.stopPing();
      if (event.code === 4409) {
        // Another browser tab restored the same stored session and took the
        // PTY. Reconnecting to it would just take it back, and the two tabs
        // would trade it forever — so this tab starts its own shell instead.
        this.serverSessionId = null;
        this.pendingResume = null;
        this.seq = 0;
        this.restarting = true;
        this.terminal.reset();
      }
      this.scheduleReconnect(closeReason(event));
    };
    ws.onerror = () => { /* onclose always follows; it owns the retry */ };
  }

  private handleMessage(ws: WebSocket, event: MessageEvent): void {
    if (this.ws !== ws) return;

    // Binary frames are PTY output; text frames are control messages. The
    // transport keeps them apart, so shell output that happens to be JSON can
    // never be mistaken for a command.
    if (typeof event.data !== 'string') {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      this.seq += bytes.byteLength;
      this.terminal.write(bytes);
      return;
    }

    let message: ServerMessage;
    try { message = JSON.parse(event.data); } catch { return; }

    switch (message.type) {
      case 'hello': {
        this.hello = message;
        this.fit(true);
        this.send({
          type: 'init',
          sessionId: this.pendingResume ?? this.serverSessionId ?? undefined,
          seq: this.seq,
          cwd: this.cwd ?? undefined,
          shell: this.prefs.shell ?? undefined,
          cols: this.terminal.cols,
          rows: this.terminal.rows,
        });
        break;
      }
      case 'ready': {
        const isNewShell = !message.resumed && this.everConnected && !this.restarting;
        this.restarting = false;
        if (message.reset || isNewShell) this.terminal.reset();
        this.seq = message.seq;
        this.serverSessionId = message.sessionId;
        this.pendingResume = null;
        this.shell = message.shell;
        this.cwd = message.cwd;
        this.exitCode = null;
        this.reconnectAttempts = 0;
        this.everConnected = true;
        this.clearTimer('connectTimer');
        this.hideOverlay();
        this.setStatus('connected');
        this.startPing();
        if (isNewShell) {
          this.writeNotice('Previous session expired — started a new shell.');
        }
        // Let the pane finish laying out before measuring it.
        setTimeout(() => { this.fit(true); this.focus(); }, 30);
        break;
      }
      case 'exit': {
        this.exitCode = message.exitCode;
        this.serverSessionId = null;
        this.setStatus('exited');
        this.stopPing();
        this.clearTimers();
        this.showOverlay('exited', 'Shell exited', `Exit code ${message.exitCode}`);
        break;
      }
      case 'error': {
        this.setStatus('error');
        this.showOverlay('error', 'Terminal error', message.message);
        break;
      }
      case 'pong':
        this.pingsAwaitingPong = 0;
        break;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.destroyed || this.status === 'exited') return;
    this.clearTimers();
    this.setStatus('reconnecting');

    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    let remaining = Math.ceil(delay / 1000);

    const render = (): void => {
      this.showOverlay(
        'reconnecting',
        'Connection lost',
        `${reason} — retrying in ${remaining}s (attempt ${this.reconnectAttempts})`,
      );
    };
    render();
    this.countdownTimer = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      render();
    }, 1000);
    this.reconnectTimer = setTimeout(() => this.connect(true), delay);
  }

  /** Retry now, cancelling any pending backoff. */
  reconnectNow(): void {
    this.reconnectAttempts = 0;
    this.connect(true);
  }

  /** Abandon the old PTY and start a fresh shell in this tab. */
  restart(): void {
    this.restarting = true;
    this.serverSessionId = null;
    this.pendingResume = null;
    this.seq = 0;
    this.exitCode = null;
    this.reconnectAttempts = 0;
    this.terminal.reset();
    this.connect(true);
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  private send(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(message)); } catch { /* closing */ }
    }
  }

  private sendBytes(bytes: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(bytes); } catch { /* closing */ }
    }
  }

  private handleInput(data: string): void {
    // A modifier armed from the on-screen key bar applies to the next
    // character the soft keyboard produces, which is the only way to type
    // Ctrl+C on a phone.
    if ((this.pendingCtrl || this.pendingAlt) && data.length === 1) {
      let out = data;
      if (this.pendingCtrl) {
        const code = out.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) out = String.fromCharCode(code - 96);
        else if (code >= 64 && code <= 95) out = String.fromCharCode(code - 64);
      }
      if (this.pendingAlt) out = `\x1b${out}`;
      this.pendingCtrl = false;
      this.pendingAlt = false;
      this.onModifiersChange?.();
      this.sendBytes(encoder.encode(out));
      return;
    }
    this.sendBytes(encoder.encode(data));
  }

  /** Types a literal sequence, as the mobile key bar and paste button do. */
  sendKey(sequence: string): void {
    this.sendBytes(encoder.encode(sequence));
    this.focus();
  }

  async paste(): Promise<void> {
    let text: string | undefined;
    try {
      text = await navigator.clipboard?.readText?.();
    } catch {
      // Denied permission, or a non-secure origin (plain http over the LAN),
      // where the async clipboard API simply is not available.
      throw new Error('Clipboard blocked — use Ctrl+Shift+V or your browser paste');
    }
    if (!text) return;
    // terminal.paste() applies bracketed-paste wrapping and \r\n → \r
    // normalisation. Writing to the socket directly skips both, which makes
    // multi-line pastes execute line by line in any shell that expects it.
    this.terminal.paste(text);
    this.focus();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  /**
   * Returns false to swallow a key. Everything not listed here reaches the
   * shell, including plain Ctrl+C and Ctrl+V — the old handler stole both,
   * which broke SIGINT whenever text happened to be selected and made Ctrl+V
   * unusable in vim, emacs and tmux.
   */
  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();
    const mac = isMac();
    const accel = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey;
    if (!accel) return true;

    if (key === 'c' && this.terminal.hasSelection()) {
      event.preventDefault();
      this.copySelection();
      return false;
    }
    if (key === 'v') {
      event.preventDefault();
      void this.paste().catch(() => { /* surfaced by the toolbar button instead */ });
      return false;
    }
    if (key === 'a' && mac) {
      event.preventDefault();
      this.terminal.selectAll();
      return false;
    }
    return true;
  }

  // ── Display ─────────────────────────────────────────────────────────────────

  private handleTitle(title: string): void {
    const clean = title.trim();
    if (!clean) return;
    this.title = clean;
    // Shells set the title to "user@host: /path"; the trailing path is the
    // part that actually tells tabs apart.
    const tail = clean.includes(': ') ? clean.slice(clean.lastIndexOf(': ') + 2) : clean;
    const base = tail.split('/').filter(Boolean).pop() || tail;
    this.label = base.length > 20 ? `${base.slice(0, 19)}…` : base;
    this.onChange(this);
  }

  private applyWebgl(enabled: boolean): void {
    if (!enabled) {
      if (this.webgl) { try { this.webgl.dispose(); } catch { /* ignore */ } this.webgl = null; }
      return;
    }
    if (this.webgl) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        try { addon.dispose(); } catch { /* ignore */ }
        if (this.webgl === addon) this.webgl = null;
      });
      this.terminal.loadAddon(addon);
      this.webgl = addon;
    } catch {
      // No WebGL (software rendering, blocked driver) — the DOM renderer stays.
      this.webgl = null;
    }
  }

  private writeNotice(text: string): void {
    this.terminal.write(`\r\n\x1b[2m--- ${text} ---\x1b[0m\r\n`);
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onChange(this);
  }

  private showOverlay(kind: SessionStatus | 'reconnecting', title: string, detail?: string): void {
    this.overlayEl.replaceChildren();
    this.overlayEl.hidden = false;
    // Once there is something on screen worth reading, drop to a slim banner
    // rather than covering it.
    this.overlayEl.classList.toggle('wt-mini', this.everConnected);

    if (kind === 'connecting') {
      const spinner = document.createElement('div');
      spinner.className = 'wt-spinner';
      this.overlayEl.appendChild(spinner);
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'wt-overlay-title';
    titleEl.textContent = title;
    this.overlayEl.appendChild(titleEl);

    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'wt-overlay-sub';
      detailEl.textContent = detail;
      this.overlayEl.appendChild(detailEl);
    }

    const actions = document.createElement('div');
    actions.className = 'wt-overlay-actions';

    if (kind === 'exited' || kind === 'error') {
      actions.appendChild(this.overlayButton('Start new shell', () => this.restart()));
    } else {
      // Even while connecting: a hung handshake needs a visible way out.
      actions.appendChild(this.overlayButton('Reconnect now', () => this.reconnectNow()));
    }
    this.overlayEl.appendChild(actions);
  }

  private overlayButton(label: string, onClick: () => void, secondary = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `wt-overlay-btn${secondary ? ' wt-secondary' : ''}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  private hideOverlay(): void {
    this.overlayEl.hidden = true;
    this.overlayEl.replaceChildren();
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  private scheduleFit(): void {
    if (this.fitTimer) clearTimeout(this.fitTimer);
    // Dragging a splitter fires ResizeObserver on every frame; one fit per
    // settled layout is enough and avoids a resize storm on the PTY.
    this.fitTimer = setTimeout(() => this.fit(), 60);
  }

  private fit(force = false): void {
    if (this.destroyed || this.el.hidden || !this.el.isConnected) return;
    try {
      // A pane can measure as zero-sized mid-reflow (narrow layouts, a panel
      // being revealed). Fitting to that leaves xterm with a degenerate
      // geometry and a blank screen, so the fit is skipped until it is real.
      const proposed = this.fitAddon.proposeDimensions();
      if (!proposed) return;
      if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
      if (proposed.cols < 2 || proposed.rows < 1) return;
      this.fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = this.terminal;
    if (!force && cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    this.send({ type: 'resize', cols, rows });
  }

  focus(): void { try { this.terminal.focus(); } catch { /* not attached */ } }

  show(): void {
    this.el.hidden = false;
    setTimeout(() => { this.fit(true); this.focus(); }, 20);
  }

  hide(): void { this.el.hidden = true; }

  attachTo(container: HTMLElement): void {
    container.appendChild(this.el);
    setTimeout(() => {
      if (this.destroyed) return;
      try { this.terminal.refresh(0, this.terminal.rows - 1); } catch { /* disposed */ }
      this.fit(true);
    }, 30);
  }

  detach(): void { this.el.remove(); }

  clear(): void {
    this.terminal.clear();
    this.focus();
  }

  copySelection(): void {
    const text = this.terminal.getSelection();
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  // ── Preferences ─────────────────────────────────────────────────────────────

  applyPrefs(prefs: Prefs, hostTheme: 'dark' | 'light'): void {
    this.terminal.options.fontSize = prefs.fontSize;
    this.terminal.options.fontFamily = prefs.fontFamily;
    this.terminal.options.cursorStyle = prefs.cursorStyle;
    this.terminal.options.screenReaderMode = prefs.screenReaderMode;
    this.terminal.options.theme = THEMES[resolveThemeName(prefs.theme, hostTheme)];
    this.applyWebgl(prefs.webgl);
    this.fit(true);
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingsAwaitingPong = 0;
    this.pingTimer = setInterval(() => {
      // A TCP connection can go half-open without either side noticing: the
      // socket stays "open" and the terminal silently stops responding. Two
      // unanswered pings means the peer is gone, so force a reconnect.
      if (this.pingsAwaitingPong >= 2) {
        this.stopPing();
        try { this.ws?.close(); } catch { /* already closing */ }
        this.scheduleReconnect('Terminal server stopped responding');
        return;
      }
      this.pingsAwaitingPong += 1;
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.pingsAwaitingPong = 0;
  }

  private clearTimer(name: 'reconnectTimer' | 'connectTimer'): void {
    const timer = this[name];
    if (timer) { clearTimeout(timer); this[name] = null; }
  }

  private clearTimers(): void {
    this.clearTimer('reconnectTimer');
    this.clearTimer('connectTimer');
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
  }

  /** Close the tab for good: the PTY is killed instead of being kept warm. */
  terminate(): void {
    this.send({ type: 'close' });
    this.destroy();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimers();
    this.stopPing();
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.resizeObserver.disconnect();
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    for (const disposable of this.disposables) {
      try { disposable.dispose(); } catch { /* already disposed */ }
    }
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(1000, 'tab closed'); } catch { /* ignore */ }
      this.ws = null;
    }
    try { this.terminal.dispose(); } catch { /* ignore */ }
    this.el.remove();
  }
}

/** xterm's onBinary hands back a latin1 string; the wire wants those bytes. */
function latin1ToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return bytes;
}

function fallbackCopy(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;top:-9999px';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch { /* nothing else to try */ }
  area.remove();
}

function closeReason(event: CloseEvent): string {
  if (event.code === 4404) return 'Terminal server is not running';
  if (event.code === 4409) return 'This session was opened in another tab';
  if (event.code === 4502) return 'Terminal server is unreachable';
  if (event.code === 1006) return 'Connection dropped';
  return event.reason || 'Connection closed';
}
