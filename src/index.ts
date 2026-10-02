/**
 * web-terminal — a full xterm.js terminal for CloudCLI, with tabs.
 *
 * The host mounts and unmounts this module every time the user moves between
 * workspace tabs, and re-imports it from a fresh Blob URL each time, so module
 * scope is not a safe place to keep anything. Live sessions therefore live on
 * `window.__wtState` and are re-attached on the next mount; the server keeps
 * the PTYs themselves, which is what lets a browser reload pick up the same
 * shells rather than starting new ones.
 */

import type { PluginAPI, PluginContext } from './types.js';
import { TerminalSession } from './session.js';
import {
  loadPrefs, savePrefs, loadStoredTabs, saveStoredTabs,
  type Prefs, type StoredTab,
} from './prefs.js';
import { injectStyles } from './ui/styles.js';
import { IC } from './ui/icons.js';
import { THEME_NAMES, isLightTheme, resolveThemeName } from './ui/themes.js';

interface GlobalState {
  sessions: Map<string, TerminalSession>;
  activeId: string | null;
  tabCounter: number;
  prefs: Prefs | null;
  /** Guards against a slow mount finishing after a newer one has started. */
  mountGen: number;
  restored: boolean;
}

declare global {
  interface Window { __wtState?: GlobalState; }
}

function globalState(): GlobalState {
  if (!window.__wtState) {
    window.__wtState = {
      sessions: new Map(), activeId: null, tabCounter: 0,
      prefs: null, mountGen: 0, restored: false,
    };
  }
  return window.__wtState;
}

// ── Small DOM helpers ─────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function iconButton(svg: string, label: string, className = 'wt-btn'): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  // Taking focus would dismiss the on-screen keyboard on every tap, which
  // makes the mobile key bar unusable. Only mousedown is cancelled — touch
  // devices synthesise mousedown too, and cancelling touchstart instead would
  // suppress the click entirely and make the button do nothing.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  const span = el('span');
  span.innerHTML = svg; // Constant markup from ui/icons.ts — never user data.
  button.appendChild(span);
  return button;
}

function selectField(labelText: string, options: Array<{ value: string; label: string }>, value: string): {
  wrapper: DocumentFragment; select: HTMLSelectElement;
} {
  const wrapper = document.createDocumentFragment();
  const select = el('select');
  const id = `wt-${labelText.toLowerCase().replace(/\W+/g, '-')}`;
  select.id = id;
  const label = el('label', undefined, labelText);
  label.htmlFor = id;
  for (const option of options) {
    const node = el('option', undefined, option.label);
    node.value = option.value;
    if (option.value === value) node.selected = true;
    select.appendChild(node);
  }
  wrapper.appendChild(label);
  wrapper.appendChild(select);
  return { wrapper, select };
}

function checkboxField(labelText: string, checked: boolean): {
  label: HTMLLabelElement; input: HTMLInputElement;
} {
  const label = el('label', 'wt-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(document.createTextNode(labelText));
  return { label, input };
}

// ── Mobile key bar ────────────────────────────────────────────────────────────

interface KeyDef {
  label: string;
  svg?: boolean;
  seq?: string;
  action?: 'ctrl' | 'alt' | 'paste' | 'keyboard';
  title?: string;
}

const MOBILE_KEYS: KeyDef[] = [
  { label: IC.keyboard, svg: true, action: 'keyboard', title: 'Show keyboard' },
  { label: IC.paste, svg: true, action: 'paste', title: 'Paste' },
  { label: 'ESC', seq: '\x1b' },
  { label: 'TAB', seq: '\t' },
  { label: 'CTRL', action: 'ctrl', title: 'Ctrl — applies to the next key you type; double-tap to lock' },
  { label: 'ALT', action: 'alt', title: 'Alt — applies to the next key you type; double-tap to lock' },
  // Ctrl+C used to be impossible from a phone: the bar had a CTRL toggle but
  // no letters for it to combine with.
  { label: '^C', seq: '\x03', title: 'Ctrl+C (interrupt)' },
  { label: '^D', seq: '\x04', title: 'Ctrl+D (end of input)' },
  { label: '^Z', seq: '\x1a', title: 'Ctrl+Z (suspend)' },
  { label: IC.up, svg: true, seq: '\x1b[A', title: 'Up' },
  { label: IC.down, svg: true, seq: '\x1b[B', title: 'Down' },
  { label: IC.left, svg: true, seq: '\x1b[D', title: 'Left' },
  { label: IC.right, svg: true, seq: '\x1b[C', title: 'Right' },
  { label: 'HOME', seq: '\x1b[H' },
  { label: 'END', seq: '\x1b[F' },
  { label: 'PGUP', seq: '\x1b[5~' },
  { label: 'PGDN', seq: '\x1b[6~' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: '_', seq: '_' },
];

/** How long a closed tab can be brought back before its shell is killed. */
const UNDO_WINDOW_MS = 8000;

// ── Mount ─────────────────────────────────────────────────────────────────────

export async function mount(container: HTMLElement, api: PluginAPI): Promise<void> {
  // A previous mount may still own this container (React StrictMode, or a fast
  // tab switch). Tear it down first so its listeners cannot outlive it.
  unmount(container);

  const state = globalState();
  const generation = ++state.mountGen;

  injectStyles();

  if (!state.prefs) state.prefs = loadPrefs();
  const prefs = state.prefs;

  let hostTheme: PluginContext['theme'] = api.context?.theme === 'light' ? 'light' : 'dark';
  const projectPath = (): string | null => api.context?.project?.path || null;

  /** Shells reported by the backend, so the picker works even with no live tab. */
  let serverInfo: { shells?: string[]; defaultShell?: string } | null = null;
  const loadServerInfo = async (): Promise<void> => {
    try { serverInfo = await api.rpc('GET', '/info') as typeof serverInfo; } catch { serverInfo = null; }
  };

  const root = el('div', 'wt-root');
  const applyChrome = (): void => {
    root.classList.toggle('wt-light', isLightTheme(resolveThemeName(prefs.theme, hostTheme)));
  };
  applyChrome();
  container.appendChild(root);

  // ── Toolbar ────────────────────────────────────────────────────────────────
  const toolbar = el('div', 'wt-toolbar');
  root.appendChild(toolbar);

  const tabBar = el('div', 'wt-tabs');
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', 'Terminal tabs');
  toolbar.appendChild(tabBar);

  const newTabButton = el('button', 'wt-new-tab', '+');
  newTabButton.type = 'button';
  newTabButton.title = 'New terminal (Ctrl+Shift+`)';
  newTabButton.setAttribute('aria-label', 'New terminal');
  toolbar.appendChild(newTabButton);

  toolbar.appendChild(el('div', 'wt-divider'));

  const searchButton = iconButton(IC.search, 'Search output (Ctrl+Shift+F)');
  const copyButton = iconButton(IC.copy, 'Copy selection');
  const clearButton = iconButton(IC.trash, 'Clear terminal');
  toolbar.appendChild(searchButton);
  toolbar.appendChild(copyButton);
  toolbar.appendChild(clearButton);

  // ── Settings popover ───────────────────────────────────────────────────────
  const settingsWrap = el('div', 'wt-settings-wrap');
  const gearButton = iconButton(IC.gear, 'Settings');
  gearButton.setAttribute('aria-haspopup', 'dialog');
  gearButton.setAttribute('aria-expanded', 'false');
  settingsWrap.appendChild(gearButton);

  const popover = el('div', 'wt-popover');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Terminal settings');

  const theme = selectField('Theme', THEME_NAMES.map((name) => ({ value: name, label: name })), prefs.theme);
  popover.appendChild(theme.wrapper);

  popover.appendChild(el('label', undefined, 'Font Size'));
  const fontRow = el('div', 'wt-fs-row');
  const fontMinus = iconButton(IC.minus, 'Decrease font size');
  const fontValue = el('span', undefined, `${prefs.fontSize}px`);
  const fontPlus = iconButton(IC.plus, 'Increase font size');
  fontRow.append(fontMinus, fontValue, fontPlus);
  popover.appendChild(fontRow);

  const cursor = selectField('Cursor', [
    { value: 'block', label: 'Block' },
    { value: 'bar', label: 'Bar' },
    { value: 'underline', label: 'Underline' },
  ], prefs.cursorStyle);
  popover.appendChild(cursor.wrapper);

  const shell = selectField('Shell (new tabs)', [{ value: '', label: 'System default' }], prefs.shell ?? '');
  popover.appendChild(shell.wrapper);

  const copyOnSelect = checkboxField('Copy on select', prefs.copyOnSelect);
  popover.appendChild(copyOnSelect.label);
  const webgl = checkboxField('GPU acceleration', prefs.webgl);
  popover.appendChild(webgl.label);
  const screenReader = checkboxField('Screen reader mode', prefs.screenReaderMode);
  popover.appendChild(screenReader.label);

  popover.appendChild(el(
    'div', 'wt-hint',
    'Ctrl+Shift+` new tab · Ctrl+Shift+F search · Ctrl+Shift+C/V copy & paste (⌘C/⌘V on macOS)',
  ));

  settingsWrap.appendChild(popover);
  toolbar.appendChild(settingsWrap);

  // ── Search bar ─────────────────────────────────────────────────────────────
  const searchBar = el('div', 'wt-search');
  const searchInput = el('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Find in terminal…';
  searchInput.setAttribute('aria-label', 'Find in terminal');
  const searchCount = el('span', 'wt-search-count');
  const searchPrev = iconButton(IC.up, 'Previous match');
  const searchNext = iconButton(IC.down, 'Next match');
  const searchClose = iconButton(IC.close, 'Close search');
  searchBar.append(searchInput, searchCount, searchPrev, searchNext, searchClose);
  root.appendChild(searchBar);

  // ── Panes + key bar ────────────────────────────────────────────────────────
  const panes = el('div', 'wt-panes');
  root.appendChild(panes);

  const toast = el('div', 'wt-toast');
  toast.setAttribute('role', 'status');
  panes.appendChild(toast);

  const keybar = el('div', 'wt-keybar');
  keybar.setAttribute('role', 'toolbar');
  keybar.setAttribute('aria-label', 'Terminal keys');
  root.appendChild(keybar);

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(message: string, action?: { label: string; run: () => void }, durationMs = 1800): void {
    toast.replaceChildren(document.createTextNode(message));
    toast.classList.toggle('wt-actionable', !!action);
    if (action) {
      const button = el('button', 'wt-toast-action', action.label);
      button.type = 'button';
      button.addEventListener('click', () => { hideToast(); action.run(); });
      toast.appendChild(button);
    }
    toast.classList.add('wt-open');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, durationMs);
  }
  function hideToast(): void {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    toast.classList.remove('wt-open');
  }

  const activeSession = (): TerminalSession | undefined =>
    state.activeId ? state.sessions.get(state.activeId) : undefined;

  // ── Tab rendering ──────────────────────────────────────────────────────────

  interface TabView { root: HTMLButtonElement; dot: HTMLElement; label: HTMLElement }
  const tabViews = new Map<string, TabView>();

  const STATUS_DOT: Record<string, string> = {
    connected: '', connecting: 'wt-off', reconnecting: 'wt-warn',
    disconnected: 'wt-off', exited: 'wt-off', error: 'wt-err',
  };

  function statusText(session: TerminalSession): string {
    switch (session.status) {
      case 'connected': return session.cwd ? `${session.title || session.label} — ${session.cwd}` : session.label;
      case 'connecting': return 'Connecting…';
      case 'reconnecting': return 'Reconnecting…';
      case 'exited': return `Shell exited (code ${session.exitCode ?? 0})`;
      case 'error': return 'Terminal error';
      default: return 'Disconnected';
    }
  }

  function syncTabView(session: TerminalSession): void {
    const view = tabViews.get(session.id);
    if (!view) return;
    const selected = session.id === state.activeId;
    view.root.setAttribute('aria-selected', String(selected));
    view.root.tabIndex = selected ? 0 : -1;
    view.label.textContent = session.label;
    view.root.title = statusText(session);
    view.dot.className = `wt-tab-dot ${bellRing.has(session.id) ? 'wt-warn' : STATUS_DOT[session.status] ?? ''}`.trim();
  }

  function renderTabs(): void {
    // Rebuild only when the set of tabs changed; otherwise patch in place so
    // the tab strip does not lose its scroll position on every status update.
    const ids = [...state.sessions.keys()];
    const same = ids.length === tabViews.size && ids.every((id) => tabViews.has(id));
    if (!same) {
      tabViews.clear();
      tabBar.replaceChildren();
      for (const session of state.sessions.values()) {
        const tab = el('button', 'wt-tab');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        const dot = el('div', 'wt-tab-dot');
        const label = el('span', 'wt-tab-label');
        const close = iconButton(IC.close, `Close ${session.label}`, 'wt-tab-close');
        close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(session.id); });
        tab.append(dot, label, close);
        tab.addEventListener('click', () => activateTab(session.id));
        tab.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          event.preventDefault();
          const order = [...state.sessions.keys()];
          const next = order[(order.indexOf(session.id) + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
          activateTab(next);
          tabViews.get(next)?.root.focus();
        });
        tabBar.appendChild(tab);
        tabViews.set(session.id, { root: tab, dot, label });
      }
    }
    for (const session of state.sessions.values()) syncTabView(session);
  }

  const bellRing = new Set<string>();
  /** Tabs closed but still recoverable; the PTY dies when the timer fires. */
  const pendingClose = new Map<string, { session: TerminalSession; timer: ReturnType<typeof setTimeout> }>();
  // Declared here, above createSession(), and not next to the code that fills
  // them: createSession() runs while mount() is still executing (restoring
  // tabs, or opening the first one), so anything it touches must already be
  // initialised or it hits the temporal dead zone.
  const searchResultSubs = new Map<string, { dispose(): void }>();
  const modifierButtons: Array<{ action: 'ctrl' | 'alt'; button: HTMLButtonElement }> = [];

  function persistTabs(): void {
    const tabs: StoredTab[] = [];
    for (const session of state.sessions.values()) {
      if (!session.serverSessionId) continue;
      tabs.push({ sessionId: session.serverSessionId, label: session.label, active: session.id === state.activeId });
    }
    saveStoredTabs(tabs);
  }

  function handleSessionChange(session: TerminalSession): void {
    syncTabView(session);
    persistTabs();
  }

  function activateTab(id: string): void {
    if (!state.sessions.has(id)) return;
    if (state.activeId && state.activeId !== id) state.sessions.get(state.activeId)?.hide();
    state.activeId = id;
    bellRing.delete(id);
    state.sessions.get(id)?.show();
    renderTabs();
    persistTabs();
  }

  function createSession(options: { resumeSessionId?: string; label?: string } = {}): TerminalSession {
    state.tabCounter += 1;
    const id = `t${state.tabCounter}`;
    const session = new TerminalSession({
      id,
      index: state.tabCounter,
      prefs,
      cwd: projectPath(),
      resumeSessionId: options.resumeSessionId ?? null,
      label: options.label,
      hostTheme,
      onChange: handleSessionChange,
      onBell: (bellSession) => {
        if (bellSession.id === state.activeId) return;
        bellRing.add(bellSession.id);
        syncTabView(bellSession);
      },
    });
    state.sessions.set(id, session);
    session.onModifiersChange = syncModifierButtons;
    watchSearchResults(session);
    session.attachTo(panes);
    return session;
  }

  function createTab(): void {
    const session = createSession();
    renderTabs();
    activateTab(session.id);
  }

  /**
   * Closing a tab is one small × away from destroying a running build, so the
   * shell is only detached at first: it keeps running server-side until the
   * undo window elapses, and Undo puts the tab straight back.
   */
  function closeTab(id: string): void {
    const session = state.sessions.get(id);
    if (!session) return;

    const wasActive = state.activeId === id;
    const neighbours = [...state.sessions.keys()].filter((key) => key !== id);
    state.sessions.delete(id);
    bellRing.delete(id);
    session.detach();
    // tabViews is deliberately left alone: renderTabs() decides whether to
    // rebuild by comparing the live sessions against it, so pruning it here
    // made the two agree and the removed tab stayed on screen.

    const undoTimer = setTimeout(() => {
      pendingClose.delete(id);
      session.terminate();
    }, UNDO_WINDOW_MS);
    pendingClose.set(id, { session, timer: undoTimer });

    if (wasActive) state.activeId = null;
    if (neighbours.length === 0) {
      createTab();
    } else {
      renderTabs();
      if (wasActive) activateTab(neighbours[neighbours.length - 1]);
      else persistTabs();
    }

    showToast(`Closed ${session.label}`, {
      label: 'Undo',
      run: () => {
        const pending = pendingClose.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingClose.delete(id);
        state.sessions.set(id, pending.session);
        pending.session.attachTo(panes);
        pending.session.onModifiersChange = syncModifierButtons;
        watchSearchResults(pending.session);
        renderTabs();
        activateTab(id);
      },
    }, UNDO_WINDOW_MS);
  }

  // ── Restore or create sessions ─────────────────────────────────────────────

  if (state.sessions.size > 0) {
    for (const session of state.sessions.values()) {
      session.attachTo(panes);
      if (session.id === state.activeId) session.show(); else session.hide();
    }
    renderTabs();
    if (!state.activeId) activateTab([...state.sessions.keys()][0]);
  } else {
    const stored = state.restored ? [] : loadStoredTabs();
    state.restored = true;
    if (stored.length > 0) {
      let activeId: string | null = null;
      for (const tab of stored) {
        const session = createSession({ resumeSessionId: tab.sessionId, label: tab.label });
        if (tab.active) activeId = session.id;
      }
      renderTabs();
      activateTab(activeId ?? [...state.sessions.keys()][0]);
    } else {
      createTab();
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  newTabButton.addEventListener('click', createTab);
  copyButton.addEventListener('click', () => {
    const session = activeSession();
    if (!session) return;
    if (!session.terminal.hasSelection()) { showToast('Nothing selected'); return; }
    session.copySelection();
    showToast('Copied');
  });
  clearButton.addEventListener('click', () => activeSession()?.clear());

  // Settings popover
  let popoverOpen = false;
  function setPopover(open: boolean): void {
    popoverOpen = open;
    popover.classList.toggle('wt-open', open);
    gearButton.setAttribute('aria-expanded', String(open));
    if (open) {
      renderShellOptions();
      theme.select.focus();
    }
  }
  function renderShellOptions(): void {
    // Prefer the live session's handshake; fall back to the plugin's own HTTP
    // endpoint through the host so the picker still works with no tab open.
    const hello = activeSession()?.hello;
    const shells = hello?.shells ?? serverInfo?.shells ?? [];
    const defaultShell = hello?.defaultShell ?? serverInfo?.defaultShell;
    shell.select.replaceChildren();
    for (const value of ['', ...shells]) {
      const option = el('option', undefined, value || `System default${defaultShell ? ` (${defaultShell})` : ''}`);
      option.value = value;
      if (value === (prefs.shell ?? '')) option.selected = true;
      shell.select.appendChild(option);
    }
  }
  gearButton.addEventListener('click', (event) => { event.stopPropagation(); setPopover(!popoverOpen); });
  void loadServerInfo().then(() => { if (popoverOpen) renderShellOptions(); });
  popover.addEventListener('click', (event) => event.stopPropagation());
  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setPopover(false); gearButton.focus(); }
  });
  const closePopoverOnOutsideClick = (): void => { if (popoverOpen) setPopover(false); };
  document.addEventListener('click', closePopoverOnOutsideClick);

  function applyPrefsToAll(): void {
    savePrefs(prefs);
    applyChrome();
    for (const session of state.sessions.values()) session.applyPrefs(prefs, hostTheme);
  }

  theme.select.addEventListener('change', () => { prefs.theme = theme.select.value; applyPrefsToAll(); });
  cursor.select.addEventListener('change', () => {
    prefs.cursorStyle = cursor.select.value as Prefs['cursorStyle'];
    applyPrefsToAll();
  });
  shell.select.addEventListener('change', () => {
    prefs.shell = shell.select.value || null;
    savePrefs(prefs);
    showToast('Applies to new tabs');
  });
  copyOnSelect.input.addEventListener('change', () => {
    prefs.copyOnSelect = copyOnSelect.input.checked;
    savePrefs(prefs);
  });
  webgl.input.addEventListener('change', () => { prefs.webgl = webgl.input.checked; applyPrefsToAll(); });
  screenReader.input.addEventListener('change', () => {
    prefs.screenReaderMode = screenReader.input.checked;
    applyPrefsToAll();
  });

  const changeFontSize = (delta: number): void => {
    prefs.fontSize = Math.max(8, Math.min(32, prefs.fontSize + delta));
    fontValue.textContent = `${prefs.fontSize}px`;
    applyPrefsToAll();
  };
  fontMinus.addEventListener('click', () => changeFontSize(-1));
  fontPlus.addEventListener('click', () => changeFontSize(1));

  // Search
  function setSearch(open: boolean): void {
    searchBar.classList.toggle('wt-open', open);
    if (open) { searchInput.focus(); searchInput.select(); }
    else {
      activeSession()?.searchAddon.clearDecorations();
      searchCount.textContent = '';
      activeSession()?.focus();
    }
  }
  const SEARCH_OPTIONS = {
    decorations: {
      matchBackground: '#5f5f00', matchBorder: '#e5e510',
      matchOverviewRuler: '#e5e510',
      activeMatchBackground: '#e5e510', activeMatchBorder: '#ffffff',
      activeMatchColorOverviewRuler: '#ffffff',
    },
  };
  function runSearch(direction: 'next' | 'prev', incremental = false): void {
    const session = activeSession();
    if (!session || !searchInput.value) { searchCount.textContent = ''; return; }
    const options = { ...SEARCH_OPTIONS, incremental };
    if (direction === 'next') session.searchAddon.findNext(searchInput.value, options);
    else session.searchAddon.findPrevious(searchInput.value, options);
  }
  searchInput.addEventListener('input', () => runSearch('next', true));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runSearch(event.shiftKey ? 'prev' : 'next'); }
    if (event.key === 'Escape') { event.preventDefault(); setSearch(false); }
  });
  searchPrev.addEventListener('click', () => runSearch('prev'));
  searchNext.addEventListener('click', () => runSearch('next'));
  searchClose.addEventListener('click', () => setSearch(false));
  searchButton.addEventListener('click', () => setSearch(!searchBar.classList.contains('wt-open')));

  function watchSearchResults(session: TerminalSession): void {
    if (searchResultSubs.has(session.id)) return;
    searchResultSubs.set(session.id, session.searchAddon.onDidChangeResults((results) => {
      if (session.id !== state.activeId) return;
      searchCount.textContent = results && results.resultCount
        ? `${results.resultIndex + 1}/${results.resultCount}`
        : (searchInput.value ? 'no results' : '');
    }));
  }

  // ── Mobile key bar ─────────────────────────────────────────────────────────
  function syncModifierButtons(): void {
    const session = activeSession();
    for (const { action, button } of modifierButtons) {
      const armed = action === 'ctrl' ? session?.pendingCtrl : session?.pendingAlt;
      const locked = action === 'ctrl' ? session?.ctrlLocked : session?.altLocked;
      button.classList.toggle('wt-active', !!armed);
      button.classList.toggle('wt-locked', !!locked);
      button.setAttribute('aria-pressed', String(!!armed));
    }
  }

  for (const key of MOBILE_KEYS) {
    const button = el('button', 'wt-key');
    button.type = 'button';
    const name = key.title ?? key.label;
    button.title = name;
    button.setAttribute('aria-label', name);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    if (key.svg) {
      const span = el('span');
      span.innerHTML = key.label; // Constant markup from ui/icons.ts.
      button.appendChild(span);
    } else {
      button.textContent = key.label;
    }

    if (key.action === 'ctrl' || key.action === 'alt') {
      const modifier = key.action;
      modifierButtons.push({ action: modifier, button });
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        const session = activeSession();
        if (!session) return;
        session.tapModifier(modifier);
        syncModifierButtons();
        session.focus();
      });
    } else if (key.action === 'paste') {
      button.addEventListener('click', () => {
        activeSession()?.paste().catch((err: Error) => showToast(err.message));
      });
    } else if (key.action === 'keyboard') {
      button.addEventListener('click', () => activeSession()?.focus());
    } else {
      button.addEventListener('click', () => activeSession()?.sendKey(key.seq!));
    }
    keybar.appendChild(button);
  }

  for (const session of state.sessions.values()) {
    session.onModifiersChange = syncModifierButtons;
    watchSearchResults(session);
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  const onKeyDown = (event: KeyboardEvent): void => {
    // Only while the terminal actually has focus, so these never fire while
    // the user is typing in chat or the editor elsewhere in the app.
    if (!root.contains(document.activeElement)) return;
    const accel = (event.ctrlKey || event.metaKey) && event.shiftKey;
    if (!accel) return;
    // Ctrl+Shift+` mirrors VS Code and, unlike Ctrl+Shift+T, is not a reserved
    // browser shortcut that the page cannot intercept.
    if (event.key === '~' || event.code === 'Backquote') { event.preventDefault(); createTab(); return; }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); setSearch(true); }
  };
  document.addEventListener('keydown', onKeyDown);

  // ── Soft-keyboard viewport ─────────────────────────────────────────────────
  const viewport = window.visualViewport;
  const onViewportResize = (): void => {
    if (!viewport) return;
    // Only clamp while a soft keyboard is actually covering the page. Clamping
    // unconditionally meant every narrow layout inherited a height cap it did
    // not need, which is a lot of risk for a case that is easy to detect.
    const keyboardOpen = window.innerHeight - viewport.height > 150;
    if (!keyboardOpen) {
      root.style.removeProperty('--wt-vvh');
      return;
    }
    // Measure from where the plugin actually starts, not the top of the page:
    // CloudCLI's own header sits above it.
    const top = root.getBoundingClientRect().top;
    root.style.setProperty('--wt-vvh', `${Math.max(120, Math.round(viewport.height - top))}px`);
    activeSession()?.show();
  };
  viewport?.addEventListener('resize', onViewportResize);
  onViewportResize();

  // ── Host context ───────────────────────────────────────────────────────────
  const unsubscribe = api.onContextChange?.((context) => {
    const nextTheme = context.theme === 'light' ? 'light' : 'dark';
    if (nextTheme !== hostTheme) {
      hostTheme = nextTheme;
      applyChrome();
      for (const session of state.sessions.values()) session.applyPrefs(prefs, hostTheme);
    }
  }) ?? null;

  renderTabs();

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = (): void => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('click', closePopoverOnOutsideClick);
    viewport?.removeEventListener('resize', onViewportResize);
    if (toastTimer) clearTimeout(toastTimer);
    for (const sub of searchResultSubs.values()) { try { sub.dispose(); } catch { /* ignore */ } }
    searchResultSubs.clear();
    // Nothing can offer Undo once the UI is gone, so honour the close now.
    for (const [, pending] of pendingClose) {
      clearTimeout(pending.timer);
      pending.session.terminate();
    }
    pendingClose.clear();
    unsubscribe?.();
    // Detach only the panes this mount put into the DOM. The sessions keep
    // running; the next mount re-attaches them.
    for (const session of state.sessions.values()) {
      if (panes.contains(session.el)) session.detach();
      session.onModifiersChange = null;
    }
    root.remove();
  };

  // A newer mount may have started while this one was setting up; if so, undo
  // this one immediately rather than leaving two live UIs on the same state.
  if (generation !== state.mountGen || !container.isConnected) {
    cleanup();
    return;
  }
  (container as HTMLElement & { _wtCleanup?: () => void })._wtCleanup = cleanup;
}

export function unmount(container: HTMLElement): void {
  const host = container as HTMLElement & { _wtCleanup?: () => void };
  if (!host._wtCleanup) return;
  const cleanup = host._wtCleanup;
  delete host._wtCleanup;
  try { cleanup(); } catch { /* already torn down */ }
}
