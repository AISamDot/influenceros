import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRepoRoot } from '@ios/db';
import { EMBEDDING_DIM, type EmbeddingProvider } from '@ios/providers';

/**
 * Live EmbeddingProviders (384-d, unit length).
 *
 * LocalEmbeddings (default, no key): bge-small-en-v1.5 through transformers.js (ONNX on the CPU), downloaded once
 * from Hugging Face into `.data/models` and cached. The package is imported lazily with a non-literal specifier so
 * bundlers leave it alone; it only loads in the Node process that embeds (the worker or the dev server).
 *
 * VoyageEmbeddings (optional, IOS_EMBEDDINGS=voyage + voyage.api_key): voyage-3.5-lite at 512 dims, truncated to
 * 384 and re-normalised (Matryoshka-trained, so the prefix keeps most of the quality).
 */

export const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';

type Extractor = (texts: string[], opts: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
interface TransformersModule {
  env: { cacheDir: string | null; allowLocalModels?: boolean };
  pipeline(task: 'feature-extraction', model: string, opts?: { dtype?: string }): Promise<Extractor>;
}

/**
 * transformers.js is a dependency of @ios/knowledge only, so it is resolved from this package's folder on disk (not
 * from wherever a bundler put the compiled code) and imported at run time.
 */
async function loadTransformers(): Promise<TransformersModule> {
  const req = createRequire(join(/*turbopackIgnore: true*/ findRepoRoot(), 'packages', 'knowledge', 'package.json'));
  const href = pathToFileURL(req.resolve('@huggingface/transformers')).href;
  const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ href)) as TransformersModule & { default?: TransformersModule };
  return typeof mod.pipeline === 'function' ? mod : mod.default!;
}

export function unitize(v: readonly number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export class LocalEmbeddings implements EmbeddingProvider {
  readonly name = 'local:bge-small-en-v1.5';
  readonly dimensions = EMBEDDING_DIM;
  #extractor: Promise<Extractor> | null = null;

  constructor(private readonly opts: { cacheDir?: string; load?: () => Promise<TransformersModule> } = {}) {}

  #load(): Promise<Extractor> {
    this.#extractor ??= (async () => {
      const mod = this.opts.load ? await this.opts.load() : await loadTransformers();
      mod.env.cacheDir = this.opts.cacheDir ?? join(/*turbopackIgnore: true*/ findRepoRoot(), '.data', 'models');
      return mod.pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'q8' });
    })().catch((err) => {
      this.#extractor = null; // retry the load on the next call
      throw err;
    });
    return this.#extractor;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const extractor = await this.#load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => t.slice(0, 2000) || ' ');
      const tensor = await extractor(batch, { pooling: 'cls', normalize: true });
      out.push(...tensor.tolist().map((v) => unitize(v.slice(0, EMBEDDING_DIM))));
    }
    return out;
  }
}

export class VoyageEmbeddings implements EmbeddingProvider {
  readonly name = 'voyage:voyage-3.5-lite@384';
  readonly dimensions = EMBEDDING_DIM;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await this.fetchImpl('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'voyage-3.5-lite', input: texts.slice(i, i + 64).map((t) => t.slice(0, 8000) || ' '), output_dimension: 512 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`voyage embeddings failed: HTTP ${res.status}`);
      const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
      out.push(...body.data.sort((a, b) => a.index - b.index).map((d) => unitize(d.embedding.slice(0, EMBEDDING_DIM))));
    }
    return out;
  }
}
