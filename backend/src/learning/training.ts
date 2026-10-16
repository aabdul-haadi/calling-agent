import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Logger } from '../logger';
import type { MlStore, RunRow } from './ml-store';
import type { Registry } from './registry';
import type { LearningStore } from './store';

// Runs the trainer as a separate process and keeps its state in the database, so a browser refresh or
// a server restart loses nothing and a run can be cancelled and resumed. A run only becomes a
// candidate model if it is a real training run on a frozen dataset that passed every check.

export interface TrainingConfig {
  base: string;
  epochs: number;
  seed: number;
  lr: number;
  rank: number;
  maxLen: number;
  batch: number;
  accum: number;
  valFraction: number;
  maxSteps: number;
  threads?: number | undefined;
}

export const DEFAULT_TRAINING: TrainingConfig = {
  base: 'Qwen/Qwen2.5-0.5B-Instruct',
  epochs: 2,
  seed: 7,
  lr: 2e-4,
  rank: 16,
  maxLen: 768,
  batch: 2,
  accum: 4,
  valFraction: 0.1,
  maxSteps: 0,
};

export interface TrainingDeps {
  store: LearningStore;
  ml: MlStore;
  releases: Registry;
  logger: Logger;
  /** Repository root; the trainer lives in <root>/ml. */
  root: string;
  /** Where run folders (dataset copies, checkpoints, adapters) are written. */
  dataDir: string;
  python?: string | undefined;
  trainer?: string | undefined;
  /** Builds the files for a dataset version: the training file, its manifest and the held-out evaluation file. */
  exportDataset(clientId: string, datasetId: string): Promise<{ train: string; evalSet: string; minExamples: number } | undefined>;
  spawnFn?: typeof spawn;
}

const TAIL = 4000;

export function createTraining(deps: TrainingDeps) {
  const { ml, logger } = deps;
  const spawnFn = deps.spawnFn ?? spawn;
  const trainer = deps.trainer ?? resolve(deps.root, 'ml', 'train_sft.py');
  const python =
    deps.python ??
    [resolve(deps.root, 'ml', '.venv', 'Scripts', 'python.exe'), resolve(deps.root, 'ml', '.venv', 'bin', 'python')].find(existsSync) ??
    'python';
  const children = new Map<string, ChildProcess>();

  const runDir = (id: string) => resolve(deps.dataDir, 'learning', 'runs', id);

  /** Runs the trainer for a short answer (hardware, check) and returns its output. */
  function oneShot(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((res) => {
      const p = spawnFn(python, [trainer, ...args], { cwd: deps.root, windowsHide: true });
      let stdout = '';
      let stderr = '';
      p.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      p.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      p.on('error', (e) => res({ code: 127, stdout, stderr: String(e) }));
      p.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
    });
  }

  async function hardware(base = DEFAULT_TRAINING.base): Promise<Record<string, unknown>> {
    const r = await oneShot(['hardware', '--base', base]);
    try {
      return JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      return { verdict: 'not_ready', reason: `The trainer could not run: ${r.stderr.slice(0, 200) || 'no output'}` };
    }
  }

  const alive = (pid: number | null) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function finish(run: RunRow, code: number | null): Promise<void> {
    children.delete(run.id);
    const fresh = (await ml.getRunById(run.id))!;
    const dir = runDir(run.id);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await readFile(resolve(dir, 'out', 'training.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      // no training.json: the run did not finish
    }
    const cancelling = fresh.status === 'cancelling';
    let status: RunRow['status'];
    let error: string | null = null;
    if (meta['status'] === 'done' && code === 0) status = 'done';
    else if (cancelling || existsSync(resolve(dir, 'cancel'))) status = 'cancelled';
    else {
      status = 'failed';
      error = `The trainer stopped with code ${code}. ${fresh.logTail.split('\n').slice(-3).join(' ').slice(0, 300)}`;
    }
    let releaseId: string | null = null;
    if (status === 'done' && run.kind === 'train' && run.datasetId) {
      const cfg = run.config as { training: TrainingConfig };
      const rel = await deps.releases.propose(
        run.clientId,
        'llm_adapter',
        'both',
        { base: cfg.training.base, adapterDir: resolve(dir, 'out', 'adapter'), adapterSha256: meta['adapterSha256'], runId: run.id, datasetId: run.datasetId },
        { datasetId: run.datasetId, note: `LoRA on ${meta['examples']} examples, validation loss ${meta['validationLoss']}`, createdBy: run.createdBy ?? 'trainer' },
      );
      releaseId = rel.id;
    }
    await ml.updateRun(run.id, { status, metrics: meta, error, pid: null, releaseId, finishedAt: new Date() });
    logger.info({ run: run.id, status, releaseId }, 'training run finished');
  }

  function launch(run: RunRow, args: string[]): void {
    const child = spawnFn(python, [trainer, ...args], { cwd: deps.root, windowsHide: true });
    children.set(run.id, child);
    let buffer = '';
    let lastWrite = 0;
    let tail = run.logTail;
    let progress = run.progress as Record<string, unknown>;
    const push = async (force = false) => {
      if (!force && Date.now() - lastWrite < 1000) return;
      lastWrite = Date.now();
      await ml.updateRun(run.id, { progress, logTail: tail.slice(-TAIL) }).catch(() => undefined);
    };
    const onData = (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        tail += `${line}\n`;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev['event'] === 'step' || ev['event'] === 'start' || ev['event'] === 'done') progress = { ...progress, ...ev };
        } catch {
          // plain log line
        }
      }
      void push();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => {
      tail += `${String(e)}\n`;
    });
    child.on('close', (code) => {
      void push(true).then(() => finish(run, code));
    });
  }

  async function start(
    clientId: string,
    opts: { datasetId?: string | undefined; smoke?: boolean; config?: Partial<TrainingConfig>; by: string },
  ): Promise<RunRow> {
    const active = (await ml.runsWithStatus(['queued', 'running', 'cancelling'])).filter((r) => alive(r.pid) || children.has(r.id));
    if (active.length > 0)
      throw new TrainingError('BUSY', 'A training run is already in progress. Training one at a time keeps the machine usable.');
    const training: TrainingConfig = { ...DEFAULT_TRAINING, ...opts.config };
    if (opts.smoke) {
      const run = await ml.insertRun({ clientId, kind: 'smoke', base: training.base, config: { training }, status: 'running', createdBy: opts.by });
      await mkdir(runDir(run.id), { recursive: true });
      launch(run, ['smoke', '--base', training.base, ...(training.threads ? ['--threads', String(training.threads)] : [])]);
      return (await ml.updateRun(run.id, { pid: children.get(run.id)?.pid ?? null }))!;
    }
    if (!opts.datasetId) throw new TrainingError('INVALID', 'Choose a frozen dataset version to train on');
    const exported = await deps.exportDataset(clientId, opts.datasetId);
    if (!exported) throw new TrainingError('NOT_FOUND', 'Dataset not found for this company');
    const run = await ml.insertRun({ clientId, datasetId: opts.datasetId, kind: 'train', base: training.base, config: { training }, status: 'queued', createdBy: opts.by });
    const dir = runDir(run.id);
    await mkdir(resolve(dir, 'out'), { recursive: true });
    const trainFile = resolve(dir, 'train.jsonl');
    const evalFile = resolve(dir, 'eval.jsonl');
    const manifest = resolve(dir, 'manifest.json');
    await writeFile(trainFile, exported.train, 'utf8');
    await writeFile(evalFile, exported.evalSet, 'utf8');
    await writeFile(manifest, JSON.stringify({ sha256: createHash('sha256').update(exported.train).digest('hex'), minExamples: exported.minExamples }), 'utf8');
    const checked = await oneShot(['check', trainFile, '--manifest', manifest, '--eval', evalFile]);
    if (checked.code !== 0) {
      let problems = checked.stdout || checked.stderr;
      try {
        problems = (JSON.parse(checked.stdout) as { problems: string[] }).problems.slice(0, 5).join('; ');
      } catch {
        // keep raw output
      }
      return (await ml.updateRun(run.id, { status: 'refused', error: `Not trained: ${problems}`, finishedAt: new Date() }))!;
    }
    const args = [
      'train', trainFile, '--manifest', manifest, '--eval', evalFile, '--out', resolve(dir, 'out'),
      '--base', training.base, '--epochs', String(training.epochs), '--seed', String(training.seed), '--lr', String(training.lr),
      '--rank', String(training.rank), '--max-len', String(training.maxLen), '--batch', String(training.batch), '--accum', String(training.accum),
      '--val-fraction', String(training.valFraction), '--max-steps', String(training.maxSteps), '--progress', resolve(dir, 'progress.jsonl'),
      '--cancel-file', resolve(dir, 'cancel'),
      ...(training.threads ? ['--threads', String(training.threads)] : []),
    ];
    await ml.updateRun(run.id, { status: 'running', outDir: resolve(dir, 'out') });
    launch(run, args);
    return (await ml.updateRun(run.id, { pid: children.get(run.id)?.pid ?? null }))!;
  }

  async function cancel(clientId: string, id: string): Promise<RunRow> {
    const run = await ml.getRun(clientId, id);
    if (!run) throw new TrainingError('NOT_FOUND', 'Run not found');
    if (!['running', 'queued'].includes(run.status)) throw new TrainingError('INVALID', `A ${run.status} run cannot be cancelled`);
    await writeFile(resolve(runDir(id), 'cancel'), 'stop', 'utf8').catch(() => undefined);
    // The trainer stops at the next step and saves a checkpoint. If it does not, it is stopped after a grace period.
    setTimeout(() => children.get(id)?.kill(), 90_000).unref?.();
    return (await ml.updateRun(id, { status: 'cancelling' }))!;
  }

  async function resume(clientId: string, id: string, by: string): Promise<RunRow> {
    const run = await ml.getRun(clientId, id);
    if (!run) throw new TrainingError('NOT_FOUND', 'Run not found');
    if (run.kind !== 'train' || !['cancelled', 'interrupted', 'failed'].includes(run.status))
      throw new TrainingError('INVALID', 'Only a cancelled, interrupted or failed training run can be resumed');
    if ((await ml.runsWithStatus(['running', 'cancelling'])).some((r) => alive(r.pid) || children.has(r.id)))
      throw new TrainingError('BUSY', 'A training run is already in progress');
    const dir = runDir(id);
    await writeFile(resolve(dir, 'cancel'), '', 'utf8').catch(() => undefined);
    const { rm } = await import('node:fs/promises');
    await rm(resolve(dir, 'cancel'), { force: true });
    const cfg = (run.config as { training: TrainingConfig }).training;
    const args = [
      'train', resolve(dir, 'train.jsonl'), '--manifest', resolve(dir, 'manifest.json'), '--eval', resolve(dir, 'eval.jsonl'), '--out', resolve(dir, 'out'),
      '--base', cfg.base, '--epochs', String(cfg.epochs), '--seed', String(cfg.seed), '--lr', String(cfg.lr), '--rank', String(cfg.rank),
      '--max-len', String(cfg.maxLen), '--batch', String(cfg.batch), '--accum', String(cfg.accum), '--val-fraction', String(cfg.valFraction),
      '--max-steps', String(cfg.maxSteps), '--progress', resolve(dir, 'progress.jsonl'), '--cancel-file', resolve(dir, 'cancel'), '--resume',
    ];
    const updated = (await ml.updateRun(id, { status: 'running', error: null, finishedAt: null, createdBy: by }))!;
    launch(updated, args);
    return (await ml.updateRun(id, { pid: children.get(id)?.pid ?? null }))!;
  }

  /** At startup: a run the server lost track of (it restarted while training) is marked resumable. */
  async function recover(): Promise<number> {
    let n = 0;
    for (const r of await ml.runsWithStatus(['running', 'cancelling', 'queued'])) {
      if (children.has(r.id) || alive(r.pid)) continue;
      await ml.updateRun(r.id, { status: 'interrupted', pid: null, error: 'The server restarted while this run was in progress. It can be resumed from its last checkpoint.' });
      n++;
    }
    return n;
  }

  return { hardware, start, cancel, resume, recover, runDir, oneShot };
}

export class TrainingError extends Error {
  constructor(
    public readonly code: 'BUSY' | 'INVALID' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export type TrainingService = ReturnType<typeof createTraining>;
