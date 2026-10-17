/**
 * Extracts the parts of the Zernio OpenAPI spec the adapter depends on into a small committed fixture
 * (test/fixtures/zernio-spec.json): the property names and types of each *PlatformData schema the adapter writes, and
 * every /v1 path. The spec conformance tests read that fixture, so a renamed field or a moved path fails them.
 *
 *   pnpm --filter @troupe/distribution exec tsx scripts/extract-zernio-spec.ts <openapi.yaml> [out.json]
 *
 * A line scanner, not a YAML parser: the spec is block-style YAML with two-space indents (components.schemas at 4,
 * a schema's properties at 8, paths at 2).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMAS = ['TikTokPlatformData', 'InstagramPlatformData', 'YouTubePlatformData', 'PinterestPlatformData', 'FacebookPlatformData'] as const;

const indent = (l: string) => l.length - l.trimStart().length;

export function extract(yaml: string) {
  const lines = yaml.split('\n');
  const version = /^\s{2}version:\s*"?([^"\s]+)"?/m.exec(yaml)?.[1] ?? null;
  const paths = lines.map((l) => /^ {2}(\/v1\/[^:\s]+):\s*$/.exec(l)?.[1]).filter((p): p is string => !!p).sort();
  const schemas: Record<string, Record<string, string>> = {};
  for (const name of SCHEMAS) {
    const start = lines.findIndex((l) => l === `    ${name}:`);
    if (start < 0) throw new Error(`schema ${name} not found`);
    let end = start + 1;
    while (end < lines.length && (lines[end]!.trim() === '' || indent(lines[end]!) > 4)) end += 1;
    const block = lines.slice(start + 1, end);
    const p = block.findIndex((l) => l === '      properties:');
    if (p < 0) throw new Error(`schema ${name} has no properties`);
    const props: Record<string, string> = {};
    for (let i = p + 1; i < block.length; i += 1) {
      const l = block[i]!;
      if (l.trim() === '') continue;
      if (indent(l) < 8) break;
      const m = /^ {8}([A-Za-z_][\w]*):\s*(.*)$/.exec(l);
      if (!m) continue;
      const inline = /type:\s*\[?\s*"?(\w+)/.exec(m[2] ?? '')?.[1];
      let type = inline ?? (m[2]?.includes('$ref') ? 'ref' : '');
      for (let j = i + 1; !type && j < block.length && indent(block[j]!) > 8; j += 1) {
        const t = /^ {10}(?:type:\s*\[?\s*"?(\w+)|(\$ref|oneOf|anyOf|allOf):)/.exec(block[j]!);
        if (t) type = t[1] ?? 'ref';
      }
      props[m[1]!] = type || 'unknown';
    }
    schemas[name] = props;
  }
  return { version, schemas, paths };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [src, out = fileURLToPath(new URL('../test/fixtures/zernio-spec.json', import.meta.url))] = process.argv.slice(2);
  if (!src) throw new Error('usage: extract-zernio-spec.ts <openapi.yaml> [out.json]');
  const data = extract(readFileSync(src, 'utf8'));
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`zernio spec ${data.version}: ${Object.keys(data.schemas).length} schemas, ${data.paths.length} paths -> ${out}`);
}
