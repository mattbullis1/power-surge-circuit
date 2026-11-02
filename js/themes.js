/**
 * Environment palettes. These are the only colour sources used by both the
 * canvas renderer and CSS custom properties, so the whole interface shifts
 * palette with the current circuit board.
 */

/**
 * Environment palettes.
 *
 * These are the only colour sources used by the canvas renderer, so the board
 * keeps a consistent identity per environment. Panels are deliberately lifted
 * well above pure black: an earlier near-black pass measured an average frame
 * luminance of ~29/255, which read as an empty screen on phones with heavy
 * black clipping in daylight.
 */
export const THEMES = Object.freeze({
  menu: {
    key: 'menu',
    name: 'STANDBY BUS',
    primary: '#4fd8ff',
    secondary: '#5b8cff',
    accent: '#d6fbff',
    danger: '#ff6b8f',
    warning: '#ffc76a',
    bg: '#050d1c',
    panel: '#122a40',
    grid: 'rgba(110, 216, 255, 0.30)',
    glow: 'rgba(79, 216, 255, 0.45)',
  },
  cpu: {
    key: 'cpu',
    name: 'CPU CORE',
    primary: '#38e8ff',
    secondary: '#3d7dff',
    accent: '#d2fcff',
    danger: '#ff5c85',
    warning: '#ffd166',
    bg: '#050e1f',
    panel: '#132a41',
    grid: 'rgba(101, 224, 255, 0.32)',
    glow: 'rgba(56, 232, 255, 0.48)',
  },
  memory: {
    key: 'memory',
    name: 'MEMORY BANKS',
    primary: '#3dffc0',
    secondary: '#12bdb4',
    accent: '#dcfff4',
    danger: '#ff6b88',
    warning: '#ffe877',
    bg: '#04161a',
    panel: '#0d3330',
    grid: 'rgba(110, 255, 214, 0.30)',
    glow: 'rgba(61, 255, 192, 0.45)',
  },
  power: {
    key: 'power',
    name: 'POWER SUPPLY',
    primary: '#ffc857',
    secondary: '#ff8b2e',
    accent: '#fff3c9',
    danger: '#ff5c6b',
    warning: '#ffc857',
    bg: '#170f04',
    panel: '#3a2a10',
    grid: 'rgba(255, 205, 110, 0.28)',
    glow: 'rgba(255, 200, 87, 0.44)',
  },
  gpu: {
    key: 'gpu',
    name: 'GRAPHICS PROCESSOR',
    primary: '#ff6ee6',
    secondary: '#a35cff',
    accent: '#ffdcfb',
    // Hazards read as deep red rather than coral so they never blur into the
    // magenta primary on this palette.
    danger: '#ff3b47',
    warning: '#ffdb7a',
    bg: '#150720',
    panel: '#361545',
    grid: 'rgba(255, 130, 235, 0.30)',
    glow: 'rgba(255, 110, 230, 0.44)',
  },
  nexus: {
    key: 'nexus',
    name: 'CIRCUIT NEXUS',
    primary: '#9cc0ff',
    secondary: '#6d7dff',
    accent: '#f0f5ff',
    danger: '#ff6b96',
    warning: '#8dffdd',
    bg: '#070e20',
    panel: '#1a2450',
    grid: 'rgba(160, 195, 255, 0.30)',
    glow: 'rgba(156, 192, 255, 0.44)',
  },
  reactor: {
    key: 'reactor',
    name: 'REACTOR CORE',
    primary: '#ff8a4d',
    secondary: '#ff4470',
    accent: '#ffe6c6',
    danger: '#ff4d63',
    warning: '#ffd97a',
    bg: '#1a0704',
    panel: '#3d150c',
    grid: 'rgba(255, 140, 95, 0.28)',
    glow: 'rgba(255, 130, 71, 0.46)',
  },
});

export function getTheme(key) {
  return THEMES[key] || THEMES.menu;
}

/** Applies a theme to the document root as CSS custom properties. */
export function applyThemeToDocument(key, root = document.documentElement) {
  const theme = getTheme(key);
  root.style.setProperty('--theme-primary', theme.primary);
  root.style.setProperty('--theme-secondary', theme.secondary);
  root.style.setProperty('--theme-accent', theme.accent);
  root.style.setProperty('--theme-danger', theme.danger);
  root.style.setProperty('--theme-warning', theme.warning);
  root.style.setProperty('--theme-bg', theme.bg);
  root.style.setProperty('--theme-panel', theme.panel);
  root.style.setProperty('--theme-glow', theme.glow);
  root.dataset.theme = theme.key;
  return theme;
}
