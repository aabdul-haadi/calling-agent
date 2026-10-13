import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { REPO_ROOT } from '../config/repo-root';
import type { ExtractedPage } from './chunk';

/** Why a PDF could not be used. `retryable` errors are worth trying again; the rest need a new file. */
export class PdfError extends Error {
  constructor(
    readonly code:
      | 'PASSWORD_PROTECTED'
      | 'CORRUPTED'
      | 'EMPTY'
      | 'NO_TEXT'
      | 'NOT_FOUND'
      | 'EXTRACTOR_MISSING'
      | 'INTERNAL'
      | 'TIMEOUT',
    message: string,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.code === 'INTERNAL' || this.code === 'TIMEOUT';
  }
}

export interface PdfMeta {
  title: string | null;
  author: string | null;
}

export interface ExtractProgress {
  stage: 'reading' | 'structuring';
  page: number;
  pages: number;
}

export interface ExtractedPdf {
  meta: PdfMeta;
  totalPages: number;
  ocrPages: number;
  emptyPages: number;
  warnings: string[];
  pages: ExtractedPage[];
}

export interface ExtractOptions {
  ocr?: 'auto' | 'off' | 'force';
  maxPages?: number;
  /** Give up after this long (a stuck extractor must not block the queue forever). */
  timeoutMs?: number;
  onProgress?: (p: ExtractProgress) => void;
  signal?: AbortSignal;
}

/** The Python interpreter of the extractor package, or undefined when it has not been set up. */
export function extractorPython(): string | undefined {
  const fromEnv = process.env.DOCPROC_PYTHON;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const venv = resolve(
    REPO_ROOT,
    'docproc',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  return existsSync(venv) ? venv : undefined;
}

/**
 * Reads a PDF with the docproc package (a small Python program: text layer, headings, tables, and
 * OCR for scanned pages) and returns its pages. Progress is reported while it works.
 */
export function extractPdf(path: string, opts: ExtractOptions = {}): Promise<ExtractedPdf> {
  const python = extractorPython();
  if (!python) {
    return Promise.reject(
      new PdfError(
        'EXTRACTOR_MISSING',
        'The PDF reader is not installed. Run: pnpm docs:setup (needs Python 3.11 to 3.13).',
      ),
    );
  }
  return new Promise((resolvePdf, reject) => {
    const args = ['-m', 'docproc', 'extract', path, '--ocr', opts.ocr ?? 'auto'];
    if (opts.maxPages) args.push('--max-pages', String(opts.maxPages));
    const child = spawn(python, args, {
      cwd: resolve(REPO_ROOT, 'docproc'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pages: ExtractedPage[] = [];
    const result: ExtractedPdf = {
      meta: { title: null, author: null },
      totalPages: 0,
      ocrPages: 0,
      emptyPages: 0,
      warnings: [],
      pages,
    };
    let failure: PdfError | undefined;
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });

    const timer = setTimeout(
      () => {
        failure = new PdfError('TIMEOUT', 'Reading the PDF took too long and was stopped.');
        child.kill();
      },
      opts.timeoutMs ?? 30 * 60_000,
    );
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout }).on('line', (line) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // a stray line from a library: ignore
      }
      switch (e.type) {
        case 'start': {
          const meta = (e.meta ?? {}) as Record<string, string | null>;
          result.meta = { title: meta.title ?? null, author: meta.author ?? null };
          result.totalPages = Number(e.pages ?? 0);
          break;
        }
        case 'progress':
          opts.onProgress?.({
            stage: e.stage === 'structuring' ? 'structuring' : 'reading',
            page: Number(e.page),
            pages: Number(e.pages),
          });
          break;
        case 'page': {
          pages.push({
            number: Number(e.number),
            label: (e.label as string | null) ?? null,
            blocks: (e.blocks as ExtractedPage['blocks']) ?? [],
          });
          for (const w of (e.warnings as string[]) ?? []) {
            const note = `page ${String(e.number)}: ${w}`;
            if (result.warnings.length < 50) result.warnings.push(note);
          }
          break;
        }
        case 'done':
          result.ocrPages = Number(e.ocrPages ?? 0);
          result.emptyPages = Number(e.emptyPages ?? 0);
          break;
        case 'error':
          failure = new PdfError(
            (['PASSWORD_PROTECTED', 'CORRUPTED', 'EMPTY', 'NO_TEXT', 'NOT_FOUND'].includes(
              String(e.code),
            )
              ? e.code
              : 'INTERNAL') as PdfError['code'],
            String(e.message ?? 'The PDF could not be read.'),
          );
          break;
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new PdfError('EXTRACTOR_MISSING', `The PDF reader could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(
          new PdfError(
            'INTERNAL',
            `The PDF reader stopped unexpectedly. ${stderr.trim().slice(-300)}`,
          ),
        );
      resolvePdf(result);
    });
  });
}
