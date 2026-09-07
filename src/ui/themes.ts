/** xterm.js colour schemes offered in the settings popover. */

export interface TerminalTheme {
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

export const THEMES: Record<string, TerminalTheme> = {
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
    cursorAccent: '#ffffff', selectionBackground: '#d4d9e3',
    selectionForeground: '#383a42',
    black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
    blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#fafafa',
    brightBlack: '#6b6f7c', brightRed: '#e45649', brightGreen: '#50a14f',
    brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
    brightCyan: '#0997b3', brightWhite: '#ffffff',
  },
};

/**
 * Name shown for the default preference: the terminal tracks whatever light
 * or dark mode the surrounding CloudCLI app is in. Before this existed, a
 * user in light mode still got a hardcoded near-black terminal.
 */
export const AUTO_THEME = 'Auto (match app)';

/** All selectable options, `Auto` first. */
export const THEME_NAMES = [AUTO_THEME, ...Object.keys(THEMES)];

/** Maps a stored preference plus the host's mode onto a concrete theme name. */
export function resolveThemeName(preference: string | undefined, hostTheme: 'dark' | 'light'): string {
  if (preference && preference !== AUTO_THEME && THEMES[preference]) return preference;
  return hostTheme === 'light' ? 'Light' : 'VS Dark';
}

/** True when the resolved theme is a light one, so the chrome can match it. */
export function isLightTheme(resolvedName: string): boolean {
  return resolvedName === 'Light';
}
