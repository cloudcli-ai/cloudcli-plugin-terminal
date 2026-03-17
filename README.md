# CloudCLI Plugin — Web Terminal

A full-featured terminal plugin for [CloudCLI UI](https://github.com/cloudcli-ai/cloudcli) powered by [xterm.js](https://xtermjs.org/). Open multiple terminal tabs, pick a theme, and work directly in the browser — no SSH or external terminal needed.

## Features

- **Multi-tab support** — open multiple terminal sessions side by side
- **Persistent sessions** — PTY processes and WebSocket connections stay alive when you switch tabs
- **Themes** — VS Dark, One Dark, Dracula, Solarized Dark, and Light
- **Adjustable font size** — increase / decrease from the toolbar
- **WebGL rendering** — GPU-accelerated rendering with automatic canvas fallback
- **Clickable links** — URLs in terminal output are clickable
- **Unicode 11** — full emoji and wide-character support
- **Clipboard integration** — Ctrl+Shift+C / Ctrl+Shift+V (Cmd on macOS)
- **Flow control** — back-pressure between PTY and WebSocket prevents flooding
- **Auto-resize** — terminal reflows when the panel is resized

## Installation

**From CloudCLI UI (recommended):**
Open **Settings > Plugins**, paste this repository URL, and click **Install**. CloudCLI will clone the repo, install dependencies, and start the backend server automatically.

**Manual:**
```bash
git clone --depth 1 https://github.com/cloudcli-ai/cloudcli-plugin-terminal.git \
  ~/.claude-code-ui/plugins/web-terminal
cd ~/.claude-code-ui/plugins/web-terminal
npm install --production --ignore-scripts
```
Then restart CloudCLI UI to pick up the new plugin.

## Plugin Structure

| File | Purpose |
|---|---|
| `manifest.json` | Plugin metadata — name, version, slot, entry points |
| `index.js` | Frontend ES module — xterm.js UI, tabs, themes, keyboard |
| `server.js` | Backend subprocess — spawns PTY shells, serves WebSocket |
| `icon.svg` | Tab icon displayed in the CloudCLI sidebar |

## How It Works

**Frontend (`index.js`):**
The host imports the module and calls `mount(container, api)`. xterm.js and its addons are loaded from [esm.sh](https://esm.sh) CDN on first use. Each tab creates a WebSocket connection to the backend and attaches it to an xterm.js `Terminal` instance. Sessions are stored on `window.__wtState` so they survive mount/unmount cycles.

**Backend (`server.js`):**
A Node.js HTTP + WebSocket server that spawns a PTY process (via `node-pty`) per connection. On startup it binds to a random port on `127.0.0.1` and prints `{"ready": true, "port": N}` to stdout so the host can proxy traffic. The WebSocket endpoint at `/ws` handles `input`, `resize`, and `ping` messages.

## Dependencies

| Package | Why |
|---|---|
| `node-pty` | Spawn native pseudo-terminal processes |
| `ws` | WebSocket server for real-time terminal I/O |

xterm.js and its addons are loaded at runtime from CDN — no frontend build step required.

## Security

- Backend runs as an isolated child process with restricted environment variables
- WebSocket connections are authenticated through the CloudCLI host proxy
- No npm `postinstall` scripts

## Requirements

- CloudCLI UI **v1.0.0+**
- Node.js **18+**

## License

MIT
