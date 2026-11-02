import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, getTheme } from '../js/themes.js';
import { ACHIEVEMENTS } from '../js/achievements.js';

function parseHex(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const int = parseInt(full, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(parseHex(a));
  const l2 = relativeLuminance(parseHex(b));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test('every environment theme exposes the full palette', () => {
  const keys = ['menu', 'cpu', 'memory', 'power', 'gpu', 'nexus', 'reactor'];
  for (const key of keys) {
    const theme = THEMES[key];
    assert.ok(theme, `theme ${key} is missing`);
    for (const field of ['primary', 'secondary', 'accent', 'danger', 'warning', 'bg', 'panel', 'grid', 'glow']) {
      assert.ok(theme[field], `theme ${key} is missing ${field}`);
    }
    assert.equal(theme.key, key);
    assert.ok(theme.name.length > 0);
    assert.match(theme.primary, /^#[0-9a-f]{6}$/i, `${key}.primary must be a 6-digit hex colour`);
    assert.match(theme.panel, /^#[0-9a-f]{6}$/i, `${key}.panel must be a 6-digit hex colour`);
    assert.match(theme.bg, /^#[0-9a-f]{6}$/i, `${key}.bg must be a 6-digit hex colour`);
  }
});

test('unknown theme keys fall back to the default instead of throwing', () => {
  assert.equal(getTheme('nonsense').key, 'menu');
  assert.equal(getTheme(undefined).key, 'menu');
  assert.equal(getTheme(null).key, 'menu');
});

/**
 * Regression guard: an early build used near-black panels, which measured an
 * average frame luminance of ~29/255 and read as a blank screen on phones with
 * aggressive black clipping. Panels must stay well above that floor.
 */
test('board panels are bright enough to read as a playfield', () => {
  for (const [key, theme] of Object.entries(THEMES)) {
    const panel = relativeLuminance(parseHex(theme.panel));
    const background = relativeLuminance(parseHex(theme.bg));
    // A panel luminance of ~0.008 corresponds to roughly the old failing build.
    assert.ok(panel > 0.012, `${key} panel luminance ${panel.toFixed(4)} is too dark`);
    assert.ok(panel > background * 1.6, `${key} panel does not separate from its background`);
  }
});

test('surge and energy colours contrast strongly against the board panel', () => {
  for (const [key, theme] of Object.entries(THEMES)) {
    const accentContrast = contrastRatio(theme.accent, theme.panel);
    const primaryContrast = contrastRatio(theme.primary, theme.panel);
    assert.ok(
      accentContrast >= 4.5,
      `${key} accent/panel contrast ${accentContrast.toFixed(2)} should be at least 4.5:1`,
    );
    assert.ok(
      primaryContrast >= 2.8,
      `${key} primary/panel contrast ${primaryContrast.toFixed(2)} should be at least 2.8:1`,
    );
    // Hazards must be distinguishable from safe accents.
    const dangerVsPrimary = contrastRatio(theme.danger, theme.primary);
    assert.ok(dangerVsPrimary > 1.05, `${key} danger and primary are too similar`);
  }
});

test('grid lines are visible against the panel', () => {
  for (const [key, theme] of Object.entries(THEMES)) {
    const match = theme.grid.match(/rgba?\(([^)]+)\)/);
    assert.ok(match, `${key} grid colour must be an rgba() value`);
    const [r, g, b, a] = match[1].split(',').map((value) => Number(value.trim()));
    assert.ok(
      a >= 0.25,
      `${key} grid alpha ${a} is too faint to read on the new brighter panels`,
    );
    assert.ok([r, g, b].every((channel) => Number.isFinite(channel)));
  }
});

test('themes are all visually distinct from one another', () => {
  const primaries = Object.values(THEMES).map((theme) => theme.primary.toLowerCase());
  assert.equal(new Set(primaries).size, primaries.length, 'two themes share a primary colour');
});

test('achievement tier metadata is renderable', () => {
  const tiers = new Set(ACHIEVEMENTS.map((achievement) => achievement.tier));
  for (const tier of tiers) {
    assert.ok(['bronze', 'silver', 'gold'].includes(tier));
  }
  assert.equal(tiers.size, 3, 'all three tiers should be represented');
});
