import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { Db } from '../database';
import { knowledgeRepo } from '../database';
import { chunkMarkdown, type Chunk } from './chunk';
import type { EmbeddingProvider } from './embeddings';

export async function readKnowledgeDir(dir: string): Promise<Chunk[]> {
  const files = (await readdir(dir)).filter((f) => extname(f) === '.md').sort();
  const chunks: Chunk[] = [];
  for (const file of files) {
    chunks.push(
      ...chunkMarkdown(basename(file, '.md'), await readFile(resolve(dir, file), 'utf8')),
    );
  }
  return chunks;
}

/** Chunk by heading -> embed -> store (with source + updated_at). Replaces the client's old chunks. */
export async function ingestClient(
  db: Db,
  embeddings: EmbeddingProvider,
  clientId: string,
  knowledgeDir: string,
): Promise<number> {
  const chunks = await readKnowledgeDir(knowledgeDir);
  // Embed heading + content so a question that matches a heading still finds the section.
  const vectors = await embeddings.embed(chunks.map((c) => `${c.heading}\n${c.content}`));
  await knowledgeRepo.replaceChunks(
    db,
    clientId,
    chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })),
  );
  return chunks.length;
}
