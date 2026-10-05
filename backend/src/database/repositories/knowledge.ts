import { cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { knowledgeChunks } from '../schema';

export interface ChunkRow {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

/** Re-ingesting replaces a client's chunks so the table always matches the policy files on disk. */
export async function replaceChunks(db: Db, clientId: string, chunks: ChunkRow[]): Promise<void> {
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.clientId, clientId));
  if (chunks.length === 0) return;
  await db
    .insert(knowledgeChunks)
    .values(chunks.map((c) => ({ clientId, ...c, updatedAt: new Date() })));
}

export interface SearchHit {
  source: string;
  heading: string;
  content: string;
  /** Cosine similarity, 1 = identical direction. */
  similarity: number;
}

export async function searchChunks(
  db: Db,
  clientId: string,
  embedding: number[],
  limit: number,
): Promise<SearchHit[]> {
  const similarity = sql<number>`1 - (${cosineDistance(knowledgeChunks.embedding, embedding)})`;
  const rows = await db
    .select({
      source: knowledgeChunks.source,
      heading: knowledgeChunks.heading,
      content: knowledgeChunks.content,
      similarity,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.clientId, clientId))
    .orderBy(desc(similarity))
    .limit(limit);
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

export async function countChunks(db: Db, clientId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.clientId, clientId));
  return row?.n ?? 0;
}
