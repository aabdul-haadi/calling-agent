import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { KnowledgeDoc, KnowledgeStatus } from '@adk/shared';
import { REPO_ROOT } from '../config/repo-root';
import type { Db } from '../database';
import { knowledgeRepo } from '../database';
import type { DocumentRow } from '../database/repositories/knowledge';
import type { Logger } from '../logger';
import { chunkPages, DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions } from './chunk';
import type { EmbeddingProvider } from './embeddings';
import { extractPdf, PdfError, type ExtractedPdf } from './pdf';
import { instructionWarnings } from './safety';

export const MAX_ATTEMPTS = 3;

export interface KnowledgeServiceDeps {
  db: Db;
  embeddings: EmbeddingProvider;
  logger: Logger;
  /** Where uploaded files and their extracted text are kept (never in the database, never served). */
  dataDir?: string;
  chunkOptions?: Partial<ChunkOptions>;
  maxUploadBytes?: number;
  ocr?: 'auto' | 'off';
  /** Wait before retrying a failed attempt (tests set 0). */
  retryDelayMs?: number;
  /** Replace the PDF reader (tests). */
  extract?: typeof extractPdf;
}

export class UploadError extends Error {
  constructor(
    readonly code: 'TOO_LARGE' | 'NOT_PDF' | 'EMPTY_FILE' | 'BAD_NAME',
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface UploadResult {
  document: KnowledgeDoc;
  /** The same file is already the live version, so nothing new was created. */
  unchanged: boolean;
}

export interface KnowledgeService {
  upload(clientId: string, fileName: string, bytes: Buffer): Promise<UploadResult>;
  list(clientId: string): Promise<KnowledgeDoc[]>;
  get(clientId: string, id: string): Promise<KnowledgeDoc | undefined>;
  /** Rebuild the chunks of a document (e.g. after changing chunk size or the embedding model). */
  reindex(
    clientId: string,
    id: string,
    opts?: { reextract?: boolean },
  ): Promise<KnowledgeDoc | undefined>;
  /** Try a failed document again. */
  retry(clientId: string, id: string): Promise<KnowledgeDoc | undefined>;
  /** Remove a document (every version) with all of its chunks and stored files. */
  remove(clientId: string, name: string): Promise<boolean>;
  /** Pick up documents that were mid-way when the server stopped. */
  resume(): Promise<void>;
  /** Resolves when no document is waiting or being processed (for tests and the CLI). */
  idle(): Promise<void>;
  /** The stored PDF of one version (used to restore an earlier version). */
  bytesOf(clientId: string, id: string): Promise<Buffer | undefined>;
  /** Waits until a document is ready or has failed, or the time runs out. */
  waitUntilSettled(clientId: string, id: string, timeoutMs: number): Promise<KnowledgeDoc | undefined>;
}

const safeName = (raw: string): string => {
  const name = basename(raw.replace(/\\/g, '/'))
    .replace(/[^\p{L}\p{N}._ ()-]/gu, '_')
    .trim();
  return name.slice(0, 120);
};

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  const { db, embeddings, logger } = deps;
  const dataDir = deps.dataDir ?? resolve(REPO_ROOT, 'data', 'knowledge');
  const chunkOptions = { ...DEFAULT_CHUNK_OPTIONS, ...deps.chunkOptions };
  const maxBytes = deps.maxUploadBytes ?? 100 * 1024 * 1024;
  const extract = deps.extract ?? extractPdf;

  const fileOf = (clientId: string, id: string, ext: 'pdf' | 'pages.json') =>
    resolve(dataDir, clientId, `${id}.${ext}`);

  // ---- queue: one document at a time (reading and embedding use all the CPU they can get) -----
  const queue: string[] = [];
  let running = false;
  let waiters: (() => void)[] = [];
  const reindexing = new Set<string>();

  const settle = () => {
    if (!running && queue.length === 0) {
      for (const w of waiters) w();
      waiters = [];
    }
  };
  const enqueue = (id: string) => {
    if (!queue.includes(id)) queue.push(id);
    void pump();
  };
  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const id = queue.shift()!;
        await processOne(id).catch((err) =>
          logger.error(
            { err: err instanceof Error ? err.message : String(err), id },
            'document processing crashed',
          ),
        );
      }
    } finally {
      running = false;
      settle();
    }
  }

  // ---- views -------------------------------------------------------------------------------
  async function toView(row: DocumentRow, versions: DocumentRow[] = []): Promise<KnowledgeDoc> {
    const outline =
      row.status === 'ready'
        ? await knowledgeRepo.documentOutline(db, row.id)
        : { headings: [], characters: 0 };
    return {
      id: row.id,
      source: row.name,
      title: row.title,
      origin: row.origin === 'folder' ? 'folder' : 'upload',
      version: row.version,
      status: row.status as KnowledgeStatus,
      stage: row.stage,
      progress: row.progress,
      pages: row.pages,
      ocrPages: row.ocrPages,
      sizeBytes: row.sizeBytes,
      error: (row.error as KnowledgeDoc['error']) ?? null,
      warnings: (row.warnings as string[]) ?? [],
      chunks: row.chunks,
      headings: outline.headings,
      characters: outline.characters,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status as KnowledgeStatus,
        active: v.active,
        chunks: v.chunks,
        pages: v.pages,
        updatedAt: v.updatedAt.toISOString(),
      })),
    };
  }

  async function list(clientId: string): Promise<KnowledgeDoc[]> {
    const rows = await knowledgeRepo.listDocuments(db, clientId);
    const byName = new Map<string, DocumentRow[]>();
    for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    const views: KnowledgeDoc[] = [];
    for (const versions of byName.values()) {
      // Show the live version, or (while a first upload or a replacement is processing) the newest one.
      const live = versions.find((v) => v.active && v.status === 'ready');
      const newest = versions[0]!;
      const shown =
        newest.status !== 'ready' && newest.status !== 'superseded' ? newest : (live ?? newest);
      views.push(
        await toView(
          shown,
          versions.filter((v) => v.id !== shown.id),
        ),
      );
    }
    return views;
  }

  async function setProgress(
    id: string,
    status: KnowledgeStatus | undefined,
    stage: string,
    progress: number,
  ) {
    await knowledgeRepo.updateDocument(db, id, {
      ...(status ? { status } : {}),
      stage,
      progress: Math.round(progress),
    });
  }

  // ---- processing --------------------------------------------------------------------------
  async function loadPages(doc: DocumentRow, reextract: boolean): Promise<ExtractedPdf> {
    const cache = fileOf(doc.clientId, doc.id, 'pages.json');
    if (!reextract) {
      try {
        return JSON.parse(await readFile(cache, 'utf8')) as ExtractedPdf;
      } catch {
        /* not extracted yet */
      }
    }
    let last = 0;
    const result = await extract(fileOf(doc.clientId, doc.id, 'pdf'), {
      ocr: deps.ocr ?? 'auto',
      onProgress: (p) => {
        const now = Date.now();
        if (now - last < 700) return;
        last = now;
        const fraction = p.pages > 0 ? p.page / p.pages : 0;
        const done = p.stage === 'reading' ? fraction * 0.3 : 0.3 + fraction * 0.3;
        void setProgress(
          doc.id,
          undefined,
          p.stage === 'reading'
            ? `Reading page ${p.page} of ${p.pages}`
            : `Finding headings and tables (page ${p.page} of ${p.pages})`,
          done * 100,
        ).catch(() => undefined);
      },
    });
    await writeFile(cache, JSON.stringify(result));
    return result;
  }

  async function embedAll(doc: DocumentRow, chunks: Chunk[]): Promise<number[][]> {
    const out: number[][] = [];
    const batch = 24;
    for (let i = 0; i < chunks.length; i += batch) {
      const part = chunks.slice(i, i + batch);
      out.push(
        ...(await embeddings.embed(
          part.map((c) => `${c.heading}\n${c.content}`),
          'document',
        )),
      );
      await setProgress(
        doc.id,
        undefined,
        `Indexing ${Math.min(i + batch, chunks.length)} of ${chunks.length} sections`,
        60 + (35 * (i + batch)) / chunks.length,
      );
    }
    return out;
  }

  async function processOne(id: string): Promise<void> {
    const doc = await knowledgeRepo.getDocument(db, id);
    if (!doc || doc.origin !== 'upload') return;
    const wasReady = doc.status === 'ready';
    const reextract = reindexing.has(`${id}:extract`);
    reindexing.delete(`${id}:extract`);
    const attempt = doc.attempts + 1;
    await knowledgeRepo.updateDocument(db, id, {
      attempts: attempt,
      ...(wasReady ? {} : { status: 'extracting', error: null }),
      stage: 'Starting',
      progress: 1,
    });
    try {
      const pdf = await loadPages(doc, reextract);
      if (!wasReady) await setProgress(id, 'indexing', 'Splitting into sections', 60);
      const title = pdf.meta.title?.trim() || doc.name.replace(/\.pdf$/i, '');
      const chunks = chunkPages(doc.name, title, pdf.pages, chunkOptions);
      if (chunks.length === 0)
        throw new PdfError('NO_TEXT', 'No readable text was found in this document.');
      const vectors = await embedAll(doc, chunks);
      const warnings = [
        ...pdf.warnings,
        ...instructionWarnings(
          pdf.pages.map((p) => ({
            number: p.number,
            text: p.blocks.map((b) => b.text).join('\n'),
          })),
        ),
      ].slice(0, 50);
      const rows = chunks.map((c, i) => ({ ...c, embedding: vectors[i]! }));
      if (wasReady) {
        // Re-indexing a live document: swap its chunks in one step so answers never see a gap.
        await db.transaction(async (tx) => {
          await knowledgeRepo.deleteChunksOfDocument(tx as unknown as Db, id);
          await knowledgeRepo.insertChunks(tx as unknown as Db, doc.clientId, doc, rows);
        });
      } else {
        await knowledgeRepo.deleteChunksOfDocument(db, id);
        await knowledgeRepo.insertChunks(db, doc.clientId, doc, rows);
      }
      await knowledgeRepo.updateDocument(db, id, { embeddingModel: embeddings.name });
      await knowledgeRepo.promoteDocument(db, id, {
        pages: pdf.totalPages,
        chunks: chunks.length,
        ocrPages: pdf.ocrPages,
        title,
        warnings,
      });
      logger.info(
        {
          client: doc.clientId,
          doc: doc.name,
          version: doc.version,
          pages: pdf.totalPages,
          chunks: chunks.length,
          ocrPages: pdf.ocrPages,
        },
        'document indexed',
      );
    } catch (err) {
      const pdfErr = err instanceof PdfError ? err : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = pdfErr ? pdfErr.retryable : true; // an unexpected error (e.g. the embedding model) is worth another try
      logger.warn({ doc: doc.name, attempt, err: message }, 'document processing failed');
      if (retryable && attempt < MAX_ATTEMPTS) {
        await knowledgeRepo.updateDocument(db, id, {
          ...(wasReady ? {} : { status: 'queued' }),
          stage: `Attempt ${attempt} failed, trying again`,
        });
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 2000 * attempt));
        queue.push(id);
        return;
      }
      if (wasReady) {
        // A failed re-index must not take down a document that was answering questions.
        await knowledgeRepo.updateDocument(db, id, {
          stage: null,
          warnings: [`Re-indexing failed: ${message}`],
        });
        return;
      }
      await knowledgeRepo.deleteChunksOfDocument(db, id).catch(() => undefined);
      await knowledgeRepo.updateDocument(db, id, {
        status: 'failed',
        stage: null,
        progress: 0,
        error: { code: pdfErr?.code ?? 'INTERNAL', message: message.slice(0, 400) },
      });
    }
  }

  // ---- public operations ---------------------------------------------------------------------
  return {
    async upload(clientId, fileName, bytes) {
      const name = safeName(fileName);
      if (!name) throw new UploadError('BAD_NAME', 'The file needs a name.');
      if (bytes.length === 0) throw new UploadError('EMPTY_FILE', 'The file is empty.');
      if (bytes.length > maxBytes)
        throw new UploadError(
          'TOO_LARGE',
          `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
          413,
        );
      // A real PDF starts with %PDF- within its first kilobyte.
      if (!bytes.subarray(0, 1024).includes('%PDF-'))
        throw new UploadError(
          'NOT_PDF',
          'This is not a PDF file (it does not start with a PDF header).',
        );

      const hash = createHash('sha256').update(bytes).digest('hex');
      const live = await knowledgeRepo.activeVersion(db, clientId, name);
      if (live && live.contentHash === hash)
        return { document: await toView(live), unchanged: true };

      const row = await knowledgeRepo.createDocument(db, {
        clientId,
        name,
        origin: 'upload',
        sizeBytes: bytes.length,
        contentHash: hash,
      });
      await mkdir(resolve(dataDir, clientId), { recursive: true });
      await writeFile(fileOf(clientId, row.id, 'pdf'), bytes);
      enqueue(row.id);
      return { document: await toView(row), unchanged: false };
    },

    list,

    async get(clientId, id) {
      const row = await knowledgeRepo.getDocument(db, id);
      return row && row.clientId === clientId ? toView(row) : undefined;
    },

    async reindex(clientId, id, opts) {
      const row = await knowledgeRepo.getDocument(db, id);
      if (!row || row.clientId !== clientId || row.origin !== 'upload') return undefined;
      if (row.status === 'queued' || row.status === 'extracting' || row.status === 'indexing')
        return toView(row);
      if (row.status === 'superseded') return toView(row); // history only
      if (opts?.reextract) reindexing.add(`${id}:extract`);
      await knowledgeRepo.updateDocument(db, id, {
        attempts: 0,
        stage: 'Waiting to re-index',
        progress: 0,
      });
      enqueue(id);
      return toView((await knowledgeRepo.getDocument(db, id))!);
    },

    async retry(clientId, id) {
      const row = await knowledgeRepo.getDocument(db, id);
      if (!row || row.clientId !== clientId || row.status !== 'failed')
        return row && row.clientId === clientId ? toView(row) : undefined;
      await knowledgeRepo.updateDocument(db, id, {
        status: 'queued',
        attempts: 0,
        error: null,
        stage: 'Waiting',
        progress: 0,
      });
      enqueue(id);
      return toView((await knowledgeRepo.getDocument(db, id))!);
    },

    async remove(clientId, name) {
      const removed = await knowledgeRepo.deleteDocumentByName(db, clientId, name);
      for (const r of removed) {
        queue.splice(0, queue.length, ...queue.filter((q) => q !== r.id));
        await rm(fileOf(clientId, r.id, 'pdf'), { force: true });
        await rm(fileOf(clientId, r.id, 'pages.json'), { force: true });
      }
      return removed.length > 0;
    },

    async bytesOf(clientId, id) {
      const row = await knowledgeRepo.getDocument(db, id);
      if (!row || row.clientId !== clientId || row.origin !== 'upload') return undefined;
      return readFile(fileOf(clientId, id, 'pdf')).catch(() => undefined);
    },

    async waitUntilSettled(clientId, id, timeoutMs) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const row = await knowledgeRepo.getDocument(db, id);
        if (!row || row.clientId !== clientId) return undefined;
        if (row.status === 'ready' || row.status === 'failed' || row.status === 'superseded') return toView(row);
        if (Date.now() > end) return toView(row);
        await new Promise((r) => setTimeout(r, 150));
      }
    },

    async resume() {
      // Documents indexed with a different embedding model have vectors the search can no longer
      // compare with: rebuild them from the stored text (no need to read the PDF again).
      for (const d of await knowledgeRepo.listByStatus(db, ['ready'])) {
        if (d.origin === 'upload' && d.active && d.embeddingModel !== embeddings.name) {
          await knowledgeRepo.updateDocument(db, d.id, {
            stage: 'Re-indexing with the current model',
            attempts: 0,
          });
          enqueue(d.id);
        }
      }
      const stuck = await knowledgeRepo.listByStatus(db, ['queued', 'extracting', 'indexing']);
      for (const d of stuck) {
        if (d.origin !== 'upload') continue;
        await knowledgeRepo.updateDocument(db, d.id, {
          status: 'queued',
          stage: 'Resuming',
          attempts: 0,
        });
        enqueue(d.id);
      }
    },

    idle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise((r) => waiters.push(r));
    },
  };
}
