// `pnpm production <command>`: stream K's CLI (docs/IOS-5-CONTRACTS.md). Pure commands only: they never open a
// database (with local PGlite only one process may open the data dir; use a scratch PGLITE_DIR for anything else).
import { CAMERA_STYLES, type CameraStyle, NO_CAPTIONS } from '@ios/agents';
import { fillTemplate, templatesFor } from '@ios/content';
import { POST_FORMATS, type PostFormat } from '@ios/core';
import { CAMERA_SPEC } from './camera';
import { checkVideoPrompt, compileImage, compileVideo, type CompileContext } from './compiler';
import { nicheFilter } from './niche';
import { bopaPlan, characterSheetPrompt, coreRefPrompts, detailStripPrompt, identityStackPrompts } from './sheet';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

const SAMPLE: CompileContext = {
  personaId: 'sample',
  name: 'Nora Vale',
  identity: 'silver bob, round tortoiseshell glasses, a small scar through the left eyebrow',
  outfits: ['a moss-green cardigan over a cream tee'],
  settings: ['a small terraced-house kitchen'],
  stylisation: 'Photoreal, soft natural light',
  framing: 'chest-up',
  accent: 'Yorkshire',
  cameraStyles: ['handheld', 'selfie', 'propped_phone'],
  identityRefs: [],
  location: null,
};

function usage(): void {
  console.log(`Usage: pnpm production <command>
  compile-image --scene "…" [--camera ${CAMERA_STYLES.join('|')}]     five image blocks for a sample persona
  compile-video --action "…" [--line "…"] [--duration 8]           five video blocks + the Owner-rule checks
  sheet                                                            character sheet, detail strip, identity stack, core refs, BOPA
  niche --niche "…" [--premise "…"] [--mechanic "…"]               the five-question niche filter
  hooks [--format ${POST_FORMATS.join('|')}] [--topic "…"]           the hook-template library
  cameras                                                          the realism camera styles`);
}

switch (cmd) {
  case 'compile-image': {
    const c = compileImage({ personaId: 'sample', scene: flag('scene') ?? 'making tea, looking up mid-laugh', camera: (flag('camera') as CameraStyle | null) ?? null }, SAMPLE);
    console.log(JSON.stringify(c, null, 2));
    break;
  }
  case 'compile-video': {
    const line = flag('line');
    const c = compileVideo({ personaId: 'sample', startFrame: 'Nora at the kitchen counter', action: flag('action') ?? 'turns to the camera', line, durationS: Number(flag('duration') ?? 5) }, SAMPLE);
    console.log(JSON.stringify({ ...c, checks: checkVideoPrompt(c, { line }), noCaptions: c.text.includes(NO_CAPTIONS) }, null, 2));
    break;
  }
  case 'sheet': {
    const brief = { name: SAMPLE.name, age: 68, anchors: SAMPLE.identity.split(', '), wardrobe: SAMPLE.outfits, settings: [...SAMPLE.settings, 'a corner allotment', 'a bus stop in the rain'] };
    console.log(JSON.stringify({ sheet: characterSheetPrompt(brief), detail: detailStripPrompt(brief), identity: identityStackPrompts(brief), core: coreRefPrompts(brief), bopa: bopaPlan(brief) }, null, 2));
    break;
  }
  case 'niche':
    console.log(JSON.stringify(nicheFilter({ niche: flag('niche') ?? 'personal finance', premise: flag('premise'), mechanic: flag('mechanic') }), null, 2));
    break;
  case 'hooks': {
    const format = (flag('format') as PostFormat | null) ?? 'talking';
    const topic = flag('topic');
    for (const t of templatesFor(format)) console.log(`${t.formats.includes(format) ? '*' : ' '} ${t.name.padEnd(20)} ${topic ? fillTemplate(t, topic) : t.example}`);
    break;
  }
  case 'cameras':
    for (const s of CAMERA_STYLES) console.log(`${s.padEnd(14)} ${CAMERA_SPEC[s].label}${CAMERA_SPEC[s].talking ? ' (talking)' : ''}`);
    break;
  default:
    usage();
}
