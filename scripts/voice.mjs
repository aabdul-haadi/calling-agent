#!/usr/bin/env node
// Cross-platform helper for the Python voice service.
//   node scripts/voice.mjs setup      create voice-service/.venv, install packages, download models
//   node scripts/voice.mjs models     download or verify the speech models
//   node scripts/voice.mjs run        start the voice gateway (reads VOICE_* from the repo .env)
//   node scripts/voice.mjs test       run the Python tests
//   node scripts/voice.mjs bench      run the voice benchmarks (use --quick for a short run)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const service = join(root, 'voice-service');
const venvPython = join(
  service,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', cwd: service, ...opts });

/** The speech libraries ship wheels for Python 3.11 to 3.13. */
function findPython() {
  const candidates =
    process.platform === 'win32'
      ? [
          ['py', ['-3.13']],
          ['py', ['-3.12']],
          ['py', ['-3.11']],
          ['python', []],
        ]
      : [
          ['python3.13', []],
          ['python3.12', []],
          ['python3.11', []],
          ['python3', []],
        ];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8',
    });
    const v = r.status === 0 ? r.stdout.trim() : '';
    if (['3.11', '3.12', '3.13'].includes(v)) return { cmd, pre, version: v };
  }
  return undefined;
}

function needVenv() {
  if (!existsSync(venvPython)) {
    console.error('The voice service is not set up yet. Run: pnpm voice:setup');
    process.exit(1);
  }
}

const [command = 'help', ...rest] = process.argv.slice(2);
switch (command) {
  case 'setup': {
    const py = findPython();
    if (!py) {
      console.error(
        'Python 3.11, 3.12 or 3.13 is required (the speech libraries have no wheels for newer versions yet).',
      );
      process.exit(1);
    }
    console.log(`Using Python ${py.version}`);
    if (!existsSync(venvPython)) run(py.cmd, [...py.pre, '-m', 'venv', '.venv']);
    run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    const r = run(venvPython, ['-m', 'pip', 'install', '-e', '.[dev]']);
    if (r.status !== 0) process.exit(r.status ?? 1);
    process.exit(run(venvPython, ['-m', 'app.tools.download_models']).status ?? 0);
    break;
  }
  case 'models':
    needVenv();
    process.exit(run(venvPython, ['-m', 'app.tools.download_models', ...rest]).status ?? 0);
    break;
  case 'run':
    needVenv();
    process.exit(run(venvPython, ['-m', 'app.main', ...rest]).status ?? 0);
    break;
  case 'test':
    needVenv();
    process.exit(run(venvPython, ['-m', 'pytest', '-q', ...rest]).status ?? 0);
    break;
  case 'bench':
    needVenv();
    process.exit(run(venvPython, ['-m', 'evalab.turn_bench', ...rest]).status ?? 0);
    break;
  default:
    console.log('Usage: node scripts/voice.mjs <setup|models|run|test|bench>');
    process.exit(command === 'help' ? 0 : 1);
}
