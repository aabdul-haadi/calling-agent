import { z } from 'zod';
import { isConfigured, type Env } from '../config';
import { EMBEDDING_DIMENSIONS } from '../database/schema';
import { postJson } from '../llm/http';
import { tokenize } from './text';

export interface EmbeddingProvider {
  /** Throws on failure: callers (ingest, retrieve) decide how to degrade. */
  embed(texts: string[]): Promise<number[][]>;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Offline "hashing trick" embedding: words and word pairs are hashed into 256 buckets with a
 * random sign, then normalised. No API key, deterministic, good enough to demo RAG plumbing.
 * (Real semantic embeddings, e.g. OpenAI, are better; swap with EMBEDDING_PROVIDER=openai.)
 */
export function localEmbed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
  for (const f of features) {
    const h = fnv1a(f);
    vec[h % EMBEDDING_DIMENSIONS]! += h & 0x100 ? 1 : -1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export const localProvider: EmbeddingProvider = { embed: async (texts) => texts.map(localEmbed) };

const openAiResponse = z.object({ data: z.array(z.object({ embedding: z.array(z.number()) })) });

export function openAiProvider(apiKey: string, model: string): EmbeddingProvider {
  return {
    async embed(texts) {
      const res = await postJson(
        'https://api.openai.com/v1/embeddings',
        { authorization: `Bearer ${apiKey}` },
        { model, input: texts, dimensions: EMBEDDING_DIMENSIONS },
      );
      if (!res.ok) throw new Error(res.message);
      const parsed = openAiResponse.safeParse(res.data);
      if (!parsed.success || parsed.data.data.length !== texts.length) throw new Error('Bad embedding response');
      return parsed.data.data.map((d) => d.embedding);
    },
  };
}

export function createEmbeddingProvider(env: Env): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER === 'openai') {
    if (!isConfigured(env.OPENAI_API_KEY)) throw new Error('EMBEDDING_PROVIDER=openai needs OPENAI_API_KEY');
    return openAiProvider(env.OPENAI_API_KEY, env.EMBEDDING_MODEL);
  }
  return localProvider;
}
