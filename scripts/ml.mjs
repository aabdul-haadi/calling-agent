#!/usr/bin/env node
// Commands for the local fine-tuning toolchain (see docs/MACHINE_LEARNING.md).
//
//   node scripts/ml.mjs setup              create ml/.venv and install the CPU libraries (about 1.5 GB)
//   node scripts/ml.mjs hardware [--base MODEL]
//   node scripts/ml.mjs smoke [--base MODEL] [--steps N]     a few training steps on a tiny fixture; never a candidate
//   node scripts/ml.mjs check DATASET.jsonl --manifest MANIFEST.json [--eval EVAL.jsonl]
//   node scripts/ml.mjs train DATASET.jsonl --manifest MANIFEST.json --out DIR [options]   (the console runs this for you)
//   node scripts/ml.mjs serve --adapter DIR [--base MODEL] [--port 8790]   serve a trained adapter on this machine only
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const venv = resolve(root, 'ml', '.venv');
const venvPython = [resolve(venv, 'Scripts', 'python.exe'), resolve(venv, 'bin', 'python')].find(existsSync);
const [cmd, ...rest] = process.argv.slice(2);

const run = (exe, args, env = {}) => {
  const r = spawnSync(exe, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
  process.exit(r.status ?? 1);
};

if (cmd === 'setup') {
  const base = process.platform === 'win32' ? 'python' : 'python3';
  const mk = spawnSync(base, ['-m', 'venv', venv], { stdio: 'inherit', cwd: root });
  if (mk.status !== 0) process.exit(mk.status ?? 1);
  const py = [resolve(venv, 'Scripts', 'python.exe'), resolve(venv, 'bin', 'python')].find(existsSync);
  console.log('Installing the CPU build of PyTorch and the training libraries. This downloads about 1.5 GB.');
  console.log('If your system drive is nearly full, point TMP, TEMP, PIP_CACHE_DIR and HF_HOME at a drive with space first.');
  const a = spawnSync(py, ['-m', 'pip', 'install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu'], { stdio: 'inherit', cwd: root });
  if (a.status !== 0) process.exit(a.status ?? 1);
  run(py, ['-m', 'pip', 'install', 'transformers', 'peft', 'datasets', 'accelerate', 'fastapi', 'uvicorn', 'psutil']);
} else if (['hardware', 'smoke', 'check', 'train'].includes(cmd ?? '')) {
  run(venvPython ?? 'python', [resolve(root, 'ml', 'train_sft.py'), cmd, ...rest]);
} else if (cmd === 'serve') {
  if (!venvPython) {
    console.error('The training environment is missing. Run: node scripts/ml.mjs setup');
    process.exit(1);
  }
  run(venvPython, [resolve(root, 'ml', 'serve_local.py'), ...rest]);
} else {
  console.error('Usage: node scripts/ml.mjs setup | hardware | smoke | check | train | serve');
  process.exit(1);
}
