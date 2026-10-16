import { and, asc, cosineDistance, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { knowledgeChunks, knowledgeDocuments } from '../schema';

export type DocumentRow = typeof knowledgeDocuments.$inferSelect;
export type DocumentStatus =
  'queued' | 'extracting' | 'indexing' | 'ready' | 'failed' | 'superseded';

export interface ChunkRow {
  source: string;
  heading: string;
  content: string;
  page?: number | null;
  pageEnd?: number | null;
  embedding: number[];
}

// ---------------------------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------------------------

export interface NewDocument {
  clientId: string;
  name: string;
  origin: 'folder' | 'upload';
  sizeBytes?: number;
  contentHash?: string;
  status?: DocumentStatus;
}

/** Creates the next version of a document (version 1 if the name is new for this company). */
export async function createDocument(db: Db, doc: NewDocument): Promise<DocumentRow> {
  const [last] = await db
    .select({ v: sql<number>`coalesce(max(${knowledgeDocuments.version}), 0)::int` })
    .from(knowledgeDocuments)
    .where(
      and(eq(knowledgeDocuments.clientId, doc.clientId), eq(knowledgeDocuments.name, doc.name)),
    );
  const [row] = await db
    .insert(knowledgeDocuments)
    .values({
      clientId: doc.clientId,
      name: doc.name,
      origin: doc.origin,
      version: (last?.v ?? 0) + 1,
      sizeBytes: doc.sizeBytes,
      contentHash: doc.contentHash,
      status: doc.status ?? 'queued',
      // A new version does not take over until it is ready.
      active: false,
    })
    .returning();
  return row!;
}

export async function getDocument(db: Db, id: string): Promise<DocumentRow | undefined> {
  const [row] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
  return row;
}

export async function updateDocument(
  db: Db,
  id: string,
  patch: Partial<typeof knowledgeDocuments.$inferInsert>,
): Promise<DocumentRow | undefined> {
  const [row] = await db
    .update(knowledgeDocuments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, id))
    .returning();
  return row;
}

/** Every version of every document of one company, newest first. */
export async function listDocuments(db: Db, clientId: string): Promise<DocumentRow[]> {
  return db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.clientId, clientId))
    .orderBy(asc(knowledgeDocuments.name), desc(knowledgeDocuments.version));
}

export async function listByStatus(db: Db, statuses: DocumentStatus[]): Promise<DocumentRow[]> {
  return db.select().from(knowledgeDocuments).where(inArray(knowledgeDocuments.status, statuses));
}

/** The active, ready version of a named document, if any. */
export async function activeVersion(
  db: Db,
  clientId: string,
  name: string,
): Promise<DocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.clientId, clientId),
        eq(knowledgeDocuments.name, name),
        eq(knowledgeDocuments.active, true),
        eq(knowledgeDocuments.status, 'ready'),
      ),
    );
  return row;
}

/** Removes a document (all versions) and every chunk of it. Returns the removed rows. */
export async function deleteDocumentByName(
  db: Db,
  clientId: string,
  name: string,
): Promise<DocumentRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.clientId, clientId), eq(knowledgeDocuments.name, name)));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.delete(knowledgeChunks).where(inArray(knowledgeChunks.documentId, ids));
    await tx.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.id, ids));
    return rows;
  });
}

// ---------------------------------------------------------------------------------------------
// chunks
// ---------------------------------------------------------------------------------------------

export async function insertChunks(
  db: Db,
  clientId: string,
  doc: Pick<DocumentRow, 'id' | 'version'>,
  chunks: ChunkRow[],
): Promise<void> {
  const BATCH = 200;
  for (let i = 0; i < chunks.length; i += BATCH) {
    await db.insert(knowledgeChunks).values(
      chunks.slice(i, i + BATCH).map((c) => ({
        clientId,
        documentId: doc.id,
        docVersion: doc.version,
        source: c.source,
        heading: c.heading,
        content: c.content,
        page: c.page ?? null,
        pageEnd: c.pageEnd ?? null,
        embedding: c.embedding,
        updatedAt: new Date(),
      })),
    );
  }
}

export async function deleteChunksOfDocument(db: Db, documentId: string): Promise<void> {
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
}

/**
 * Makes `documentId` the live version in one step: it becomes ready and active, and every older
 * version of the same name loses its chunks and is marked superseded. Searches never see two
 * versions at once, and never see neither.
 */
export async function promoteDocument(
  db: Db,
  documentId: string,
  fields: {
    pages?: number;
    chunks: number;
    ocrPages?: number;
    title?: string | null;
    warnings?: string[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId));
    if (!doc) return;
    const older = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.clientId, doc.clientId),
          eq(knowledgeDocuments.name, doc.name),
          ne(knowledgeDocuments.id, documentId),
        ),
      );
    const olderIds = older.map((o) => o.id);
    if (olderIds.length > 0) {
      await tx.delete(knowledgeChunks).where(inArray(knowledgeChunks.documentId, olderIds));
      await tx
        .update(knowledgeDocuments)
        .set({ active: false, status: 'superseded', stage: null, updatedAt: new Date() })
        .where(
          and(inArray(knowledgeDocuments.id, olderIds), ne(knowledgeDocuments.status, 'failed')),
        );
    }
    await tx
      .update(knowledgeDocuments)
      .set({
        status: 'ready',
        active: true,
        stage: null,
        progress: 100,
        error: null,
        pages: fields.pages ?? doc.pages,
        chunks: fields.chunks,
        ocrPages: fields.ocrPages ?? 0,
        title: fields.title ?? doc.title,
        warnings: fields.warnings ?? [],
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, documentId));
  });
}

// ---------------------------------------------------------------------------------------------
// search (always scoped to one company and to live documents, in the query itself)
// ---------------------------------------------------------------------------------------------

export interface SearchHit {
  id: string;
  documentId: string | null;
  source: string;
  heading: string;
  content: string;
  page: number | null;
  pageEnd: number | null;
  version: number;
  /** Cosine similarity for vector hits, ts_rank_cd for keyword hits. */
  score: number;
}

const live = (clientId: string) =>
  and(
    eq(knowledgeChunks.clientId, clientId),
    // Chunks of a document that is still being indexed, failed, or replaced are never returned.
    sql`${knowledgeChunks.documentId} in (select id from ${knowledgeDocuments} where ${knowledgeDocuments.clientId} = ${clientId} and ${knowledgeDocuments.status} = 'ready' and ${knowledgeDocuments.active} = true)`,
  );

const hitColumns = {
  id: knowledgeChunks.id,
  documentId: knowledgeChunks.documentId,
  source: knowledgeChunks.source,
  heading: knowledgeChunks.heading,
  content: knowledgeChunks.content,
  page: knowledgeChunks.page,
  pageEnd: knowledgeChunks.pageEnd,
  version: knowledgeChunks.docVersion,
};

export async function searchVector(
  db: Db,
  clientId: string,
  embedding: number[],
  limit: number,
): Promise<SearchHit[]> {
  const score = sql<number>`1 - (${cosineDistance(knowledgeChunks.embedding, embedding)})`;
  const rows = await db
    .select({ ...hitColumns, score })
    .from(knowledgeChunks)
    .where(live(clientId))
    .orderBy(desc(score))
    .limit(limit);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** `tsQuery` is an already-sanitised OR expression such as "refund | cancel". */
export async function searchKeyword(
  db: Db,
  clientId: string,
  tsQuery: string,
  limit: number,
): Promise<SearchHit[]> {
  if (!tsQuery) return [];
  const query = sql`to_tsquery('english', ${tsQuery})`;
  const score = sql<number>`ts_rank_cd(${knowledgeChunks.tsv}, ${query}, 32)`;
  const rows = await db
    .select({ ...hitColumns, score })
    .from(knowledgeChunks)
    .where(and(live(clientId), sql`${knowledgeChunks.tsv} @@ ${query}`))
    .orderBy(desc(score))
    .limit(limit);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

export async function countChunks(db: Db, clientId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.clientId, clientId));
  return row?.n ?? 0;
}

/** Headings and size of a document's live chunks, for the document cards. */
export async function documentOutline(
  db: Db,
  documentId: string,
): Promise<{ headings: string[]; characters: number }> {
  const rows = await db
    .select({
      heading: knowledgeChunks.heading,
      n: sql<number>`length(${knowledgeChunks.content})::int`,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.documentId, documentId))
    .orderBy(asc(knowledgeChunks.page), asc(knowledgeChunks.heading));
  const seen = new Set<string>();
  let characters = 0;
  for (const r of rows) {
    characters += r.n;
    seen.add(r.heading.includes(' > ') ? r.heading.split(' > ').slice(1).join(' > ') : r.heading);
  }
  return { headings: [...seen].slice(0, 12), characters };
}

/**
 * Copies a company's live documents and their chunks into another namespace, so a candidate change
 * can be built and measured beside the live index without touching it. Returns the copied chunks.
 */
export async function cloneLiveInto(db: Db, from: string, to: string): Promise<number> {
  return db.transaction(async (tx) => {
    const docs = await tx
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.clientId, from),
          eq(knowledgeDocuments.status, 'ready'),
          eq(knowledgeDocuments.active, true),
        ),
      );
    let copied = 0;
    for (const d of docs) {
      const { id: oldId, clientId: _client, createdAt: _c, updatedAt: _u, ...rest } = d;
      void _client;
      void _c;
      void _u;
      const [copy] = await tx
        .insert(knowledgeDocuments)
        .values({ ...rest, clientId: to })
        .returning({ id: knowledgeDocuments.id });
      const chunks = await tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, oldId));
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.insert(knowledgeChunks).values(
          chunks.slice(i, i + 200).map((c) => ({
            clientId: to,
            documentId: copy!.id,
            source: c.source,
            heading: c.heading,
            content: c.content,
            page: c.page,
            pageEnd: c.pageEnd,
            docVersion: c.docVersion,
            embedding: c.embedding,
            updatedAt: new Date(),
          })),
        );
      }
      copied += chunks.length;
    }
    return copied;
  });
}

/** Deletes everything stored under one namespace (used for throwaway candidate indexes). */
export async function deleteNamespace(db: Db, clientId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.clientId, clientId));
    await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.clientId, clientId));
  });
}
