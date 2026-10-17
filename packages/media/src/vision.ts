import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FaceMatcher, OcrProvider } from './toolkit';
import { VISION_SWIFT } from './vision-source';

/**
 * QC vision on the Mac: Apple's Vision framework through a small Swift helper (`vision-source.ts`), compiled
 * once with the system `swiftc` and cached in the temp dir. Text recognition for Q4 caption OCR and face detection +
 * image feature prints for Q3 face similarity: local, free, no weights to license or download.
 */

function exec(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(`${bin.split('/').at(-1)}: ${(stderr || err.message).slice(0, 300)}`)) : resolve(stdout),
    ),
  );
}

let built: Promise<string> | null = null;

/** Compiles the helper once per source version. */
export function visionBinary(): Promise<string> {
  built ??= (async () => {
    const dir = join(tmpdir(), 'troupe-media');
    const out = join(dir, `troupe-vision-${createHash('sha256').update(VISION_SWIFT).digest('hex').slice(0, 12)}`);
    if (!existsSync(/*turbopackIgnore: true*/ out)) {
      await mkdir(dir, { recursive: true });
      const src = `${out}.swift`;
      await writeFile(src, VISION_SWIFT);
      await exec('/usr/bin/xcrun', ['swiftc', '-O', src, '-o', out], 300_000);
    }
    return out;
  })().catch((err) => {
    built = null;
    throw err;
  });
  return built;
}

/** Apple Vision is available on macOS with the command-line tools (swiftc). */
export const appleVisionAvailable = (): boolean => process.platform === 'darwin' && existsSync(/*turbopackIgnore: true*/ '/usr/bin/xcrun');

async function call(args: string[]): Promise<Record<string, unknown>> {
  const out = JSON.parse(await exec(await visionBinary(), args, 120_000)) as Record<string, unknown>;
  if (typeof out.error === 'string') throw new Error(`vision: ${out.error}`);
  return out;
}

export class AppleVisionOcr implements OcrProvider {
  readonly name = 'apple-vision-ocr';
  async read(imagePath: string) {
    const r = await call(['ocr', imagePath]);
    return { text: String(r.text ?? ''), confidence: Number(r.confidence ?? 0) };
  }
}

export class AppleVisionFaces implements FaceMatcher {
  readonly name = 'apple-vision-face';
  async compare(referencePath: string, imagePath: string) {
    const r = await call(['face', referencePath, imagePath]);
    return { faces: Number(r.faces ?? 0), similarity: typeof r.similarity === 'number' ? r.similarity : null };
  }
}
