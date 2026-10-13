import { resolve } from 'node:path';
import { REPO_ROOT } from '../config/repo-root';

/** Scores how well each passage answers the question, reading both together. Higher is better. */
export interface Reranker {
  readonly name: string;
  score(question: string, passages: string[]): Promise<number[]>;
  warmUp?(): Promise<void>;
}

export const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

interface Loaded {
  tokenizer: (
    a: string[],
    o: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
  ) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
}

/**
 * A small cross-encoder (MS MARCO MiniLM, Apache-2.0, 22M parameters, int8, about 25 ms for five
 * passages on a laptop CPU). A vector search finds passages that are about the same topic; this
 * step reads the question and each passage together and pushes the one that actually answers it to
 * the top ("what time does check-in close at Karachi" prefers the sentence with the time over a
 * paragraph about the Karachi lounge). Scores below zero mean "does not answer this".
 */
export function crossEncoderReranker(
  cacheDir = resolve(REPO_ROOT, 'data', 'models-cache'),
): Reranker {
  let loaded: Promise<Loaded> | undefined;
  const load = (): Promise<Loaded> => {
    loaded ??= (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } =
        await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
        dtype: 'q8',
      });
      return { tokenizer, model } as unknown as Loaded;
    })();
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  };
  return {
    name: `${RERANK_MODEL} (local)`,
    async warmUp() {
      await load();
    },
    async score(question, passages) {
      if (passages.length === 0) return [];
      const { tokenizer, model } = await load();
      const inputs = tokenizer(Array(passages.length).fill(question), {
        text_pair: passages.map((p) => p.slice(0, 1100)),
        padding: true,
        truncation: true,
        max_length: 288,
      });
      const { logits } = await model(inputs);
      return Array.from(logits.data);
    },
  };
}
