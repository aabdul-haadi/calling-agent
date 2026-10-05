import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG AA check of the real design tokens in index.css (jsdom cannot compute colours, so we do the maths).
const css = readFileSync(resolve(__dirname, '../styles/index.css'), 'utf8');

function tokens(selector: string): Record<string, string> {
  const block = css.split(selector + ' {')[1]?.split('}')[0] ?? '';
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

function hslToRgb(hsl: string): [number, number, number] {
  const [h, s, l] = hsl.match(/[\d.]+/g)!.map(Number) as [number, number, number];
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const lum = ([r, g, b]: [number, number, number]) => {
  const c = [r, g, b].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};

const ratio = (a: string, b: string) => {
  const [x, y] = [lum(hslToRgb(a)), lum(hslToRgb(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const themes: Record<string, Record<string, string>> = {
  'light + sky': { ...tokens(':root') },
  'light + violet': { ...tokens(':root'), ...tokens("[data-accent='violet']") },
  'dark + sky': { ...tokens(':root'), ...tokens('.dark') },
  'dark + violet': { ...tokens(':root'), ...tokens('.dark'), ...tokens(".dark[data-accent='violet'],\n.dark [data-accent='violet']") },
};

describe('colour contrast meets WCAG AA (4.5:1)', () => {
  for (const [name, t] of Object.entries(themes)) {
    it.each([
      ['foreground', 'background'],
      ['foreground', 'card'],
      ['muted-foreground', 'card'],
      ['muted-foreground', 'background'],
      ['muted-foreground', 'muted'],
      ['accent-foreground', 'accent'],
      ['foreground', 'accent-soft'],
      ['ok', 'card'],
      ['warn', 'card'],
      ['danger', 'card'],
      ['accent', 'card'],
    ])(`${name}: %s on %s`, (fg, bg) => {
      expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
