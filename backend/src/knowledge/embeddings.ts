import { resolve } from 'node:path';
import { REPO_ROOT } from '../config/repo-root';
import { z } from 'zod';
import { isConfigured, type Env } from '../config';
import { EMBEDDING_DIMENSIONS } from '../database/schema';
import { postJson } from '../llm/http';
import { tokenize } from './text';

export type EmbedKind = 'query' | 'document';

export interface EmbeddingProvider {
  /** Shown in traces and the knowledge console. */
  readonly name: string;
  /** semantic: similarity scores mean something. lexical: only word overlap does (the offline fallback). */
  readonly profile: 'semantic' | 'lexical';
  /** Throws on failure: callers (ingest, retrieve) decide how to degrade. */
  embed(texts: string[], kind?: EmbedKind): Promise<number[][]>;
  /** Load the model now, so the first customer question does not pay for it. */
  warmUp?(): Promise<void>;
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
 * Offline "hashing trick" embedding: words and word pairs are hashed into buckets with a random
 * sign, then normalised. No download, deterministic, purely lexical (it matches words, not
 * meaning). Used by the tests and as a last-resort fallback; the semantic model is the default.
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

export const localProvider: EmbeddingProvider = {
  name: 'hashing (offline, lexical)',
  profile: 'lexical',
  embed: async (texts) => texts.map(localEmbed),
};
export const hashProvider = localProvider;

// ---------------------------------------------------------------------------------------------
// local semantic model
// ---------------------------------------------------------------------------------------------

export const SEMANTIC_MODEL = 'Xenova/bge-small-en-v1.5';
/** bge models are trained to see questions with this prefix (documents get none). */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

type Extractor = (
  texts: string[],
  opts: { pooling: 'cls'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * BGE-small (MIT, 33M parameters, 384 dimensions) running locally through ONNX (int8). It understands
 * paraphrases ("what do I pay for a second suitcase" finds "each additional checked bag costs").
 * The model file (~34 MB) is downloaded once from Hugging Face on first use and cached on disk.
 */
export function semanticProvider(
  cacheDir = resolve(REPO_ROOT, 'data', 'models-cache'),
): EmbeddingProvider {
  let extractor: Promise<Extractor> | undefined;
  const load = (): Promise<Extractor> => {
    extractor ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      return (await pipeline('feature-extraction', SEMANTIC_MODEL, {
        dtype: 'q8',
      })) as unknown as Extractor;
    })();
    // A failed load must be retried next time, not remembered.
    extractor.catch(() => {
      extractor = undefined;
    });
    return extractor;
  };
  return {
    name: `${SEMANTIC_MODEL} (local)`,
    profile: 'semantic',
    async warmUp() {
      await load();
    },
    async embed(texts, kind = 'document') {
      const model = await load();
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts
          .slice(i, i + 16)
          .map((t) => (kind === 'query' ? `${QUERY_PREFIX}${t}` : t.slice(0, 2000)));
        out.push(...(await model(batch, { pooling: 'cls', normalize: true })).tolist());
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// OpenAI (optional, needs a key)
// ---------------------------------------------------------------------------------------------

const openAiResponse = z.object({ data: z.array(z.object({ embedding: z.array(z.number()) })) });

export function openAiProvider(apiKey: string, model: string): EmbeddingProvider {
  return {
    name: `${model} (OpenAI)`,
    profile: 'semantic',
    async embed(texts) {
      const res = await postJson(
        'https://api.openai.com/v1/embeddings',
        { authorization: `Bearer ${apiKey}` },
        { model, input: texts, dimensions: EMBEDDING_DIMENSIONS },
      );
      if (!res.ok) throw new Error(res.message);
      const parsed = openAiResponse.safeParse(res.data);
      if (!parsed.success || parsed.data.data.length !== texts.length)
        throw new Error('Bad embedding response');
      return parsed.data.data.map((d) => d.embedding);
    },
  };
}

let shared: EmbeddingProvider | undefined;

export function createEmbeddingProvider(env: Env): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER === 'openai') {
    if (!isConfigured(env.OPENAI_API_KEY))
      throw new Error('EMBEDDING_PROVIDER=openai needs OPENAI_API_KEY');
    return openAiProvider(env.OPENAI_API_KEY, env.EMBEDDING_MODEL);
  }
  if (env.EMBEDDING_PROVIDER === 'hash') return hashProvider;
  // 'local' (the old name) and 'semantic' both mean the local semantic model. One shared instance:
  // the model is loaded once per process.
  shared ??= semanticProvider();
  return shared;
}
