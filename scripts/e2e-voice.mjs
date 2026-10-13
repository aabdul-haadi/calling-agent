#!/usr/bin/env node
// Drives the real Voice Lab in a real Chrome/Edge with a recorded "caller" instead of a microphone,
// against the real running stack (frontend, backend, voice gateway). Needs `pnpm dev` and
// `pnpm voice` already running, and the policy PDF uploaded for the company you ask about.
//
//   node scripts/e2e-voice.mjs CALL.wav [--seconds 70] [--url http://localhost:5173/voice] [--shot out.png]
//
// The page is observed the way a person would see it: the status line, the transcript, the sources
// panel and the timing panel. Every state change is logged with the time it appeared.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const wav = args.find((a) => a.endsWith('.wav'));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (!wav || !existsSync(wav)) {
  console.error(
    'Usage: node scripts/e2e-voice.mjs CALL.wav [--seconds 70] [--url http://localhost:5173/voice] [--shot out.png]',
  );
  process.exit(1);
}
const seconds = Number(opt('seconds', 70));
const url = opt('url', 'http://localhost:5173/voice');
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error('Chrome or Edge was not found. Set CHROME_PATH.');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve(wav)}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(url, { waitUntil: 'networkidle' });
const local = page.getByRole('radio', { name: 'Local engine' });
if (await local.count()) await local.check({ force: true }).catch(() => undefined);
const t0 = Date.now();
await page.getByRole('button', { name: 'Start voice session' }).click();

const seen = [];
let lastStatus = '';
let lastTranscript = '';
let lastSources = '';
const read = () =>
  page.evaluate(() => {
    const text = (sel) =>
      document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const statusEl = [...document.querySelectorAll('[role="status"]')].find(
      (el) => el.getAttribute('aria-live') === 'polite' && el.tagName === 'P',
    );
    return {
      status: statusEl?.textContent?.trim() ?? '',
      transcript: [...document.querySelectorAll('ol[aria-label="Voice transcript"] li')].map((li) =>
        li.textContent.replace(/\s+/g, ' ').trim(),
      ),
      sources: [
        ...document.querySelectorAll('ul[aria-label="Sources for the last answer"] li'),
      ].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
      times: Object.fromEntries(
        [...document.querySelectorAll('dl[aria-label="Time per step"] > div')].map((d) => [
          d.querySelector('dt')?.textContent,
          d.querySelector('dd')?.textContent,
        ]),
      ),
      alert: text('[role="alert"]'),
    };
  });

const stop = Date.now() + seconds * 1000;
while (Date.now() < stop) {
  const state = await read();
  const at = ((Date.now() - t0) / 1000).toFixed(1);
  if (state.status !== lastStatus) {
    seen.push({ at: Number(at), status: state.status });
    lastStatus = state.status;
  }
  const tr = state.transcript.join(' | ');
  if (tr !== lastTranscript) {
    lastTranscript = tr;
    console.log(`[${at}s] transcript: ${tr.slice(-400)}`);
  }
  const src = state.sources.join(' | ');
  if (src !== lastSources) {
    lastSources = src;
    console.log(`[${at}s] sources: ${src.slice(0, 400) || '(cleared)'}`);
  }
  if (state.alert) {
    console.log(`[${at}s] ALERT: ${state.alert}`);
    break;
  }
  await page.waitForTimeout(150);
}

if (opt('shot')) await page.screenshot({ path: opt('shot'), fullPage: true });
const final = await read();
await browser.close();
console.log(
  JSON.stringify(
    {
      statusTimeline: seen,
      finalTranscript: final.transcript,
      finalSources: final.sources,
      lastTurnTimes: final.times,
      pageErrors: errors,
    },
    null,
    1,
  ),
);
