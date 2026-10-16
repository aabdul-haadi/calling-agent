import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalLlm } from '@backend/llm/local';
import { createHarness, type Harness } from '../helpers/harness';
import { approvedExamples } from './helpers';

// Runs the REAL trainer and the REAL local server end to end on a tiny base model. Skipped unless
// RUN_REAL_TRAINING=1 because it downloads a model, needs the ml/.venv install and takes minutes:
//
//   RUN_REAL_TRAINING=1 node node_modules/.bin/vitest run tests/learning/ml-real-trainer.test.ts
//
// The training examples are generated wording written through the normal capture and review path:
// this proves the pipeline, it does not produce a model worth using.

const root = resolve(__dirname, '../..');
const venvPython = [resolve(root, 'ml/.venv/Scripts/python.exe'), resolve(root, 'ml/.venv/bin/python')].find(existsSync);
const enabled = process.env.RUN_REAL_TRAINING === '1' && Boolean(venvPython);
const BASE = process.env.REAL_TRAINING_BASE ?? 'HuggingFaceTB/SmolLM2-135M-Instruct';
const PORT = 8791;

(enabled ? describe : describe.skip)('real fine-tuning end to end (tiny base model, CPU)', () => {
  let h: Harness;
  let server: ChildProcess | undefined;
  const local = createLocalLlm({ url: `http://127.0.0.1:${PORT}`, timeoutMs: 180_000 });
  const L = () => h.learning!;
  const record: Record<string, unknown> = { base: BASE };
  const save = () => {
    mkdirSync(resolve(root, 'ml', 'artifacts'), { recursive: true });
    writeFileSync(resolve(root, 'ml', 'artifacts', 'real-run.json'), JSON.stringify(record, null, 2));
  };

  beforeAll(async () => {
    h = await createHarness({ learning: { ml: { minEval: 3, minShadow: 2 }, local, training: { python: venvPython } } });
  });
  afterAll(async () => {
    server?.kill();
    await h.close();
  });

  it('trains an adapter from approved examples, serves it, compares it and records shadow answers', async () => {
    const train = await approvedExamples(h, 'skylink-air', 12, 'train', { replyOf: (i) => `For ticket variant ${i}, one checked bag is included in economy.` });
    await approvedExamples(h, 'skylink-air', 6, 'eval', { replyOf: () => 'One checked bag is included in economy.' });
    const ds = await L().buildDataset('skylink-air');
    expect(ds.meetsThreshold).toBe(true);
    expect((ds.dataset.stats as { examples: number }).examples).toBe(train.length);

    const started = await L().workflows.training.start('skylink-air', {
      datasetId: ds.dataset.id,
      by: 'maria',
      config: { base: BASE, epochs: 2, maxSteps: 10, rank: 8, batch: 2, accum: 1, valFraction: 0.2, threads: 4, maxLen: 256 },
    });
    let run = started;
    const end = Date.now() + 15 * 60_000;
    while (['queued', 'running', 'cancelling'].includes(run.status) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await L().workflows.ml.getRun('skylink-air', started.id))!;
    }
    record['training'] = { status: run.status, progress: run.progress, metrics: run.metrics, logTail: run.logTail.slice(-600) };
    save();
    expect(run.status, run.error ?? run.logTail.slice(-400)).toBe('done');
    expect(run.releaseId).toBeTruthy();
    const metrics = run.metrics as { adapterSha256: string; trainLoss: number; seconds: number; peakMemoryMb: number | null; artifactLoads: boolean };
    expect(metrics.artifactLoads).toBe(true);
    expect(Number.isFinite(metrics.trainLoss)).toBe(true);

    server = spawn(venvPython!, [resolve(root, 'ml/serve_local.py'), '--base', BASE, '--adapter', resolve(L().workflows.training.runDir(run.id), 'out', 'adapter'), '--port', String(PORT)], {
      cwd: root,
      env: { ...process.env, HF_HOME: process.env.HF_HOME ?? '' },
    });
    const up = Date.now() + 120_000;
    let health = await local.health();
    while (!health.ok && Date.now() < up) {
      await new Promise((r) => setTimeout(r, 1500));
      health = await local.health();
    }
    expect(health.ok).toBe(true);
    expect(health.adapterSha256).toBe(metrics.adapterSha256);

    const evaluated = await L().workflows.evaluateModel('skylink-air', run.releaseId!);
    const ev = evaluated.evaluation as { gates: { name: string; pass: boolean; detail: string }[]; metrics: { candidate: { p50Ms: number; p95Ms: number; failures: number; n: number } } };
    record['evaluation'] = { gates: ev.gates.map((g) => `${g.pass ? 'pass' : 'FAIL'} ${g.name}: ${g.detail}`), candidate: ev.metrics.candidate };
    save();
    expect(ev.metrics.candidate.failures).toBe(0);
    expect(ev.metrics.candidate.n).toBe(6);

    await L().workflows.startShadow('skylink-air', run.releaseId!);
    h.llm.script({ text: 'PRODUCTION answer' });
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'How many bags can I check in economy?', channel: 'chat' });
    expect(res.reply).toBe('PRODUCTION answer');
    await L().capture.drain();
    const until = Date.now() + 90_000;
    let n = 0;
    while (n < 1 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      n = (await L().workflows.ml.shadowStats('skylink-air', run.releaseId!)).n;
    }
    const report = await L().workflows.shadowReport('skylink-air', run.releaseId!);
    record['shadow'] = { stats: report.stats, sample: report.recent[0]?.candidateReply };
    save();
    expect(report.stats.n).toBeGreaterThanOrEqual(1);
    expect(report.stats.failed).toBe(0);
  }, 30 * 60_000);
});
