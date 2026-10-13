import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { Db } from '../database';
import { knowledgeRepo } from '../database';
import { chunkMarkdown, type Chunk } from './chunk';
import type { EmbeddingProvider } from './embeddings';

export interface FolderDoc {
  name: string;
  hash: string;
  chunks: Chunk[];
}

export async function readKnowledgeDir(dir: string): Promise<FolderDoc[]> {
  const files = (await readdir(dir)).filter((f) => extname(f) === '.md').sort();
  const docs: FolderDoc[] = [];
  for (const file of files) {
    const text = await readFile(resolve(dir, file), 'utf8');
    const name = basename(file, '.md');
    docs.push({
      name,
      hash: createHash('sha256').update(text).digest('hex'),
      chunks: chunkMarkdown(name, text),
    });
  }
  return docs;
}

/**
 * Keeps a company's built-in policy files (markdown in its knowledge folder) in the document store.
 * A file that has not changed (same text, same embedding model) is left alone; a changed file gets a
 * new version that replaces the old one in a single step; a file that was removed from the folder
 * is removed from the store. Documents uploaded through the console are never touched.
 */
export async function ingestClient(
  db: Db,
  embeddings: EmbeddingProvider,
  clientId: string,
  knowledgeDir: string,
): Promise<number> {
  const docs = await readKnowledgeDir(knowledgeDir);
  const present = new Set(docs.map((d) => d.name));

  for (const existing of await knowledgeRepo.listDocuments(db, clientId)) {
    if (existing.origin === 'folder' && !present.has(existing.name) && existing.active) {
      await knowledgeRepo.deleteDocumentByName(db, clientId, existing.name);
    }
  }

  let total = 0;
  for (const doc of docs) {
    const live = await knowledgeRepo.activeVersion(db, clientId, doc.name);
    if (
      live &&
      live.origin === 'folder' &&
      live.contentHash === doc.hash &&
      live.embeddingModel === embeddings.name &&
      live.chunks > 0
    ) {
      total += live.chunks;
      continue;
    }
    const row = await knowledgeRepo.createDocument(db, {
      clientId,
      name: doc.name,
      origin: 'folder',
      contentHash: doc.hash,
      status: 'indexing',
    });
    // Embed heading + content so a question that matches a heading still finds the section.
    const vectors = await embeddings.embed(
      doc.chunks.map((c) => `${c.heading}\n${c.content}`),
      'document',
    );
    await knowledgeRepo.insertChunks(
      db,
      clientId,
      row,
      doc.chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })),
    );
    await knowledgeRepo.updateDocument(db, row.id, { embeddingModel: embeddings.name });
    await knowledgeRepo.promoteDocument(db, row.id, {
      chunks: doc.chunks.length,
      title: doc.chunks[0]?.heading.split(' > ')[0] ?? doc.name,
    });
    total += doc.chunks.length;
  }
  return total;
}
