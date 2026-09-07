/**
 * Stylesheet injection.
 *
 * xterm's own CSS is bundled in as text rather than pulled from a CDN, so the
 * terminal renders correctly on an air-gapped machine, behind a strict CSP, or
 * simply when the user is on a train.
 */

import xtermCss from '@xterm/xterm/css/xterm.css';

const STYLE_ID = 'wt-css';

const PLUGIN_CSS = `
.wt-root {
  display:flex; flex-direction:column; height:100%; min-height:0;
  background:#1e1e1e; color:#d4d4d4;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  overflow:hidden;
  --accent:#4ec9b0; --border:rgba(255,255,255,0.08);
  --toolbar-bg:rgba(0,0,0,0.3); --tab-bg:rgba(255,255,255,0.05);
  --tab-active:rgba(255,255,255,0.1); --btn:rgba(255,255,255,0.08);
  --btn-hover:rgba(255,255,255,0.15); --popover-bg:#2d2d2d;
  --danger:#f14c4c;
}
.wt-root.wt-light {
  background:#f5f5f5; color:#383a42;
  --accent:#0184bc; --border:rgba(0,0,0,0.12);
  --toolbar-bg:rgba(0,0,0,0.06); --tab-bg:rgba(0,0,0,0.04);
  --tab-active:rgba(0,0,0,0.1); --btn:rgba(0,0,0,0.06);
  --btn-hover:rgba(0,0,0,0.12); --popover-bg:#ffffff;
  --danger:#d93025;
}
.wt-root :focus-visible { outline:2px solid var(--accent); outline-offset:1px; }

.wt-toolbar {
  display:flex; align-items:center; gap:2px;
  padding:4px 6px; background:var(--toolbar-bg);
  border-bottom:1px solid var(--border); flex-shrink:0; min-height:36px;
}
.wt-tabs { display:flex; align-items:center; flex:1; overflow-x:auto; gap:2px; scrollbar-width:none; min-width:0; }
.wt-tabs::-webkit-scrollbar { display:none; }
.wt-tab {
  display:flex; align-items:center; gap:5px; padding:4px 4px 4px 10px;
  border-radius:5px; cursor:pointer; white-space:nowrap;
  background:var(--tab-bg); font-size:12px; font-weight:500;
  opacity:.8; transition:background .15s,opacity .15s;
  user-select:none; border:1px solid transparent; flex-shrink:0;
  color:inherit; font-family:inherit; max-width:220px;
}
.wt-tab:hover { opacity:1; background:var(--tab-active); }
.wt-tab[aria-selected="true"] { background:var(--tab-active); border-color:var(--accent); opacity:1; }
.wt-tab-label { overflow:hidden; text-overflow:ellipsis; max-width:150px; }
.wt-tab-dot { width:6px; height:6px; border-radius:50%; background:var(--accent); flex-shrink:0; }
.wt-tab-dot.wt-off { background:#8a8a8a; }
.wt-tab-dot.wt-warn { background:#e5a13a; }
.wt-tab-dot.wt-err { background:var(--danger); }
.wt-tab-close {
  display:flex; align-items:center; justify-content:center;
  width:20px; height:20px; border-radius:4px; border:none; background:none;
  color:inherit; cursor:pointer; opacity:.5; padding:0; flex-shrink:0;
}
.wt-tab-close svg { width:11px; height:11px; }
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

.wt-panes { flex:1; position:relative; overflow:hidden; min-height:0; }
.wt-pane { position:absolute; inset:0; display:flex; flex-direction:column; overflow:hidden; padding:4px; }
.wt-pane[hidden] { display:none; }
.wt-pane .xterm { height:100%; }
.wt-pane .xterm-viewport { overflow-y:auto !important; scrollbar-width:thin; }
.wt-pane .xterm-viewport::-webkit-scrollbar { width:10px; }
.wt-pane .xterm-viewport::-webkit-scrollbar-thumb { background:rgba(128,128,128,.45); border-radius:5px; }
.xterm .xterm-screen { outline:none !important; }

.wt-overlay {
  position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:10px;
  background:rgba(0,0,0,.6); backdrop-filter:blur(4px);
  z-index:10; text-align:center; padding:24px;
}
.wt-root.wt-light .wt-overlay { background:rgba(255,255,255,.72); }
.wt-overlay[hidden] { display:none; }
.wt-overlay-title { font-size:14px; font-weight:600; }
.wt-overlay-sub { font-size:12px; opacity:.7; max-width:34em; }
.wt-overlay-actions { display:flex; gap:8px; margin-top:6px; }
/* While reconnecting the terminal must stay readable and selectable — a
   full-screen cover hides the very output the user wants to look at. */
.wt-overlay.wt-mini {
  inset:auto 0 auto 0; flex-direction:row; flex-wrap:wrap; gap:8px;
  padding:6px 12px; background:rgba(0,0,0,.72); backdrop-filter:none;
  justify-content:center; pointer-events:none;
}
.wt-root.wt-light .wt-overlay.wt-mini { background:rgba(255,255,255,.9); }
.wt-overlay.wt-mini .wt-overlay-title { font-size:12px; }
.wt-overlay.wt-mini .wt-overlay-sub { font-size:12px; }
.wt-overlay.wt-mini .wt-overlay-actions { margin-top:0; pointer-events:auto; }
.wt-overlay.wt-mini .wt-overlay-btn { padding:3px 10px; font-size:12px; }
.wt-overlay.wt-mini .wt-spinner { width:14px; height:14px; }
.wt-overlay-btn {
  padding:7px 18px; border-radius:6px; border:none;
  background:var(--accent); color:#fff; font-size:13px; cursor:pointer; font-weight:500;
}
.wt-overlay-btn.wt-secondary { background:var(--btn); color:inherit; }
.wt-overlay-btn:hover { filter:brightness(1.15); }

.wt-settings-wrap { position:relative; }
.wt-popover {
  position:absolute; top:calc(100% + 6px); right:0; z-index:50;
  background:var(--popover-bg); border:1px solid var(--border);
  border-radius:8px; padding:12px 14px; min-width:210px; max-width:min(92vw,300px);
  box-shadow:0 8px 24px rgba(0,0,0,.4);
  display:none; flex-direction:column; gap:10px;
  max-height:min(70vh,420px); overflow-y:auto;
}
.wt-root.wt-light .wt-popover { box-shadow:0 8px 24px rgba(0,0,0,.14); }
.wt-popover.wt-open { display:flex; }
.wt-popover label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; opacity:.55; }
.wt-popover select {
  width:100%; height:28px; padding:0 6px; border-radius:5px;
  border:1px solid var(--border); background:var(--btn); color:inherit;
  font-size:12px; cursor:pointer; outline:none;
}
.wt-popover select:focus { border-color:var(--accent); }
/* Scoped under .wt-popover so it outranks the uppercase section-label rule
   above; option labels must not read as section headers. */
.wt-popover .wt-check {
  display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer;
  text-transform:none; letter-spacing:0; font-weight:400; opacity:.9;
}
.wt-check input { accent-color:var(--accent); width:14px; height:14px; cursor:pointer; }
.wt-hint { font-size:11px; opacity:.55; line-height:1.4; }
.wt-fs-row { display:flex; align-items:center; gap:8px; }
.wt-fs-row span { flex:1; text-align:center; font-size:13px; font-weight:500; }

.wt-search {
  display:none; align-items:center; gap:6px; flex-shrink:0;
  padding:5px 8px; background:var(--toolbar-bg); border-bottom:1px solid var(--border);
}
.wt-search.wt-open { display:flex; }
.wt-search input {
  flex:1; min-width:0; height:26px; padding:0 8px; border-radius:5px;
  border:1px solid var(--border); background:var(--btn); color:inherit;
  font-size:12px; outline:none; font-family:inherit;
}
.wt-search input:focus { border-color:var(--accent); }
.wt-search-count { font-size:11px; opacity:.6; min-width:5.5em; text-align:right; font-variant-numeric:tabular-nums; }

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
.wt-key:active, .wt-key.wt-active { background:var(--accent); color:#fff; border-color:var(--accent); }
.wt-key, .wt-btn, .wt-tab, .wt-tab-close, .wt-new-tab { touch-action:manipulation; }
.wt-key svg { width:16px; height:16px; }

.wt-toast {
  position:absolute; bottom:14px; left:50%; transform:translateX(-50%);
  background:rgba(0,0,0,.82); color:#fff; font-size:12px;
  padding:7px 14px; border-radius:16px; z-index:60; pointer-events:none;
  opacity:0; transition:opacity .18s;
}
.wt-toast.wt-open { opacity:1; }
.wt-toast.wt-actionable { pointer-events:auto; display:flex; align-items:center; gap:10px; }
.wt-toast-action {
  background:none; border:none; color:var(--accent); font:inherit;
  font-weight:600; cursor:pointer; padding:0;
}

.wt-fatal {
  display:flex; align-items:center; justify-content:center; height:100%;
  color:var(--danger); padding:24px; text-align:center;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
.wt-fatal-title { font-size:16px; font-weight:600; margin-bottom:8px; }
.wt-fatal-detail { font-size:12px; opacity:.75; }

@media (max-width:768px), (hover:none) and (pointer:coarse) {
  .wt-keybar { display:flex; }
  .wt-toolbar { min-height:34px; padding:3px 4px; }
  .wt-btn { height:30px; min-width:30px; }
  /* Keep the toolbar buttons reachable: without a tighter cap the tab strip
     eats the width and the last controls fall off the edge. */
  .wt-tab { font-size:11px; padding:5px 4px 5px 8px; max-width:130px; }
  .wt-tab-label { max-width:80px; }
  .wt-tab-close { width:24px; height:24px; }
  /* iOS zooms the whole page whenever a focused control is below 16px. */
  .wt-popover select, .wt-search input { font-size:16px; height:34px; }
  /* Soft keyboards shrink the visual viewport without resizing the layout
     viewport, which would otherwise leave the prompt hidden behind the keys. */
  .wt-root { max-height:var(--wt-vvh, 100%); }
}

@keyframes wt-spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
.wt-spinner { width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:wt-spin .8s linear infinite; }
@media (prefers-reduced-motion:reduce) {
  .wt-spinner { animation:none; border-top-color:var(--border); }
  .wt-tab, .wt-btn, .wt-toast { transition:none; }
}

.wt-new-tab {
  display:flex; align-items:center; justify-content:center;
  width:28px; height:28px; border-radius:5px; border:none;
  background:none; color:inherit; font-size:17px; cursor:pointer;
  opacity:.6; flex-shrink:0;
}
.wt-new-tab:hover { opacity:1; background:var(--btn-hover); }
`;

/** Injects xterm's stylesheet and the plugin's own, exactly once per page. */
export function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `${xtermCss}\n${PLUGIN_CSS}`;
  document.head.appendChild(style);
}
