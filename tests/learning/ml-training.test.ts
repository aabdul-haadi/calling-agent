import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, type Harness } from '../helpers/harness';
import { approvedExamples } from './helpers';

const FAKE = resolve(__dirname, '../fixtures/fake_trainer.py');
let h: Harness;
const L = () => h.learning!;
const api = (path: string) => `/clients/skylink-air/learning${path}`;
const python = process.platform === 'win32' ? 'python' : 'python3';

async function settle(runId: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const run = (await L().workflows.ml.getRun('skylink-air', runId))!;
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`run still ${run.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  process.env.FAKE_STEP_SECONDS = '0.15';
  process.env.FAKE_STEPS = '6';
  h = await createHarness({ ingestKnowledge: false, learning: { training: { trainer: FAKE, python } } });
});
afterAll(() => h.close());

describe('training data gate', () => {
  it('stops with a clear reason when there are not enough approved examples, and trains nothing', async () => {
    const ds = await L().buildDataset('skylink-air'); // nothing approved yet
    expect(ds.meetsThreshold).toBe(false);
    const run = await L().workflows.training.start('skylink-air', { datasetId: ds.dataset.id, by: 'maria' });
    expect(run.status).toBe('refused');
    expect(run.error).toMatch(/only 0 examples|minimum/);
    expect(run.releaseId).toBeNull();
    expect(await L().store.listReleases('skylink-air')).toHaveLength(0);
  });

  it('unreviewed, rejected and held-out examples never reach the training file', async () => {
    const train = await approvedExamples(h, 'skylink-air', 4, 'train');
    const held = await approvedExamples(h, 'skylink-air', 2, 'eval');
    const ds = await L().buildDataset('skylink-air');
    const exported = await (async () => {
      const text = await L().renderDataset('skylink-air', ds.dataset.id);
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { metadata: { id: string } });
    })();
    const ids = new Set(exported.map((e) => e.metadata.id));
    for (const e of train) expect(ids.has(e.id)).toBe(true);
    for (const e of held) expect(ids.has(e.id)).toBe(false);
    expect(ds.meetsThreshold).toBe(true);
  });
});

describe('training job lifecycle', () => {
  it('runs a job, shows real progress, and registers the artifact as a candidate (never as live)', async () => {
    const ds = (await L().store.listDatasets('skylink-air'))[0]!;
    const res = await request(h.app).post(api('/training/runs')).set('x-reviewer', 'maria').send({ datasetId: ds.id });
    expect(res.status).toBe(202);
    const run = await settle(res.body.data.id);
    expect(run.status).toBe('done');
    expect((run.progress as { step: number }).step).toBeGreaterThan(0);
    expect(run.logTail).toMatch(/"event": "done"/);
    expect(run.releaseId).toBeTruthy();
    const rel = (await L().store.getRelease('skylink-air', run.releaseId!))!;
    expect(rel).toMatchObject({ kind: 'llm_adapter', status: 'candidate' });
    const cfg = (rel.params as { config: { adapterSha256: string; datasetId: string } }).config;
    expect(cfg.datasetId).toBe(ds.id);
    expect(cfg.adapterSha256).toMatch(/^[0-9a-f]{64}$/);
    // nothing about production changed
    expect(await L().store.activeRelease('skylink-air', 'llm_adapter', 'chat')).toBeUndefined();
    // the run's own files record the exact data and the held-out set that were used
    const dir = L().workflows.training.runDir(run.id);
    const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')) as { sha256: string };
    expect(manifest.sha256).toBe(ds.sha256);
    const evalText = await readFile(resolve(dir, 'eval.jsonl'), 'utf8');
    expect(evalText.split('\n').filter(Boolean).length).toBe(2);
  });

  it('a smoke run proves the toolchain but can never become a candidate', async () => {
    const run = await settle((await L().workflows.training.start('skylink-air', { smoke: true, by: 'maria' })).id);
    expect(run.kind).toBe('smoke');
    expect(run.releaseId).toBeNull();
    expect((await L().store.listReleases('skylink-air')).filter((r) => r.kind === 'llm_adapter')).toHaveLength(1);
  });

  it('refuses to start two runs at once', async () => {
    const ds = (await L().store.listDatasets('skylink-air'))[0]!;
    const first = await L().workflows.training.start('skylink-air', { datasetId: ds.id, by: 'maria' });
    const second = await request(h.app).post(api('/training/runs')).set('x-reviewer', 'maria').send({ datasetId: ds.id });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BUSY');
    await settle(first.id);
  });

  it('can be cancelled safely and resumed from where it stopped', async () => {
    const ds = (await L().store.listDatasets('skylink-air'))[0]!;
    const started = await L().workflows.training.start('skylink-air', { datasetId: ds.id, by: 'maria' });
    await new Promise((r) => setTimeout(r, 350));
    await request(h.app).post(api(`/training/runs/${started.id}/cancel`)).expect(200);
    const cancelled = await settle(started.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.releaseId).toBeNull(); // a half-trained model is never offered
    const before = (cancelled.progress as { step?: number }).step ?? 0;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(6);
    const resumed = await request(h.app).post(api(`/training/runs/${started.id}/resume`)).set('x-reviewer', 'maria');
    expect(resumed.status).toBe(202);
    const done = await settle(started.id);
    expect(done.status).toBe('done');
    expect((done.progress as { resumedFrom?: number }).resumedFrom ?? 0).toBeGreaterThanOrEqual(before);
    expect(done.releaseId).toBeTruthy();
  });

  it('marks a run the server lost track of as interrupted and resumable, not as running forever', async () => {
    const stale = await L().workflows.ml.insertRun({ clientId: 'skylink-air', datasetId: null, kind: 'train', base: 'fake/base', config: { training: {} }, status: 'running', pid: 999_999 });
    expect(await L().workflows.training.recover()).toBeGreaterThanOrEqual(1);
    const row = (await L().workflows.ml.getRun('skylink-air', stale.id))!;
    expect(row.status).toBe('interrupted');
    expect(row.error).toMatch(/restarted/);
  });

  it('keeps one company\'s runs and datasets out of another\'s', async () => {
    const ds = (await L().store.listDatasets('skylink-air'))[0]!;
    const res = await request(h.app).post('/clients/novatel/learning/training/runs').set('x-reviewer', 'maria').send({ datasetId: ds.id });
    expect(res.status).toBe(404);
    const runs = await request(h.app).get('/clients/novatel/learning/training/runs');
    expect(runs.body.data).toEqual([]);
  });

  it('reports the hardware verdict honestly', async () => {
    const res = await request(h.app).get(api('/training/hardware'));
    expect(res.status).toBe(200);
    expect(['gpu', 'cpu_slow', 'not_ready']).toContain(res.body.data.verdict);
    expect(res.body.data.ramGb).toBeGreaterThan(0);
  });
});
