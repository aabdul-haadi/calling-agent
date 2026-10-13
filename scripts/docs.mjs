#!/usr/bin/env node
// Cross-platform helper for the PDF reader (docproc/, Python).
//   node scripts/docs.mjs setup    create docproc/.venv and install the packages (about 150 MB, includes OCR models)
//   node scripts/docs.mjs corpus   build the test PDFs (docproc/tests/corpus)
//   node scripts/docs.mjs test     run the Python tests
//   node scripts/docs.mjs read FILE.pdf   print what the reader finds in a PDF (events, one per line)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'docproc');
const venvPython = join(
  pkg,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: pkg, ...opts });

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

const needVenv = () => {
  if (!existsSync(venvPython)) {
    console.error('The PDF reader is not set up yet. Run: pnpm docs:setup');
    process.exit(1);
  }
};

const [command = 'help', ...rest] = process.argv.slice(2);
switch (command) {
  case 'setup': {
    const py = findPython();
    if (!py) {
      console.error('Python 3.11, 3.12 or 3.13 is required.');
      process.exit(1);
    }
    console.log(`Using Python ${py.version}`);
    if (!existsSync(venvPython)) run(py.cmd, [...py.pre, '-m', 'venv', '.venv']);
    run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    process.exit(run(venvPython, ['-m', 'pip', 'install', '-e', '.[dev]']).status ?? 0);
    break;
  }
  case 'corpus':
    needVenv();
    process.exit(run(venvPython, ['-m', 'tests.corpus']).status ?? 0);
    break;
  case 'test':
    needVenv();
    process.exit(run(venvPython, ['-m', 'pytest', ...rest]).status ?? 0);
    break;
  case 'read':
    needVenv();
    process.exit(
      run(venvPython, ['-m', 'docproc', 'extract', ...rest.map((f) => resolve(process.cwd(), f))])
        .status ?? 0,
    );
    break;
  default:
    console.log('Usage: node scripts/docs.mjs setup | corpus | test | read FILE.pdf');
}
