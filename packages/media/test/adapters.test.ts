import { createTestStudio } from '@ios/agents/testing';
import { MemoryMediaStore } from '@ios/providers';
import { describe, expect, it } from 'vitest';
import { ElevenLabsVoice, estimateCredits, type Exec, FalKlingAvatar, HiggsfieldCli, HiggsfieldSeedanceTalking, mediaLiveProviders, mp3Seconds, parseCliJson, probePrices, readJob } from '../src';

function fakeExec(responses: Array<(args: readonly string[]) => unknown>) {
  const calls: Array<{ bin: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = [];
  const exec: Exec = async (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env });
    const r = responses.shift();
    if (!r) throw new Error('unexpected CLI call');
    return { stdout: `progress…\n${JSON.stringify(r(args))}`, stderr: '' };
  };
  return { exec, calls };
}

const hf = (exec: Exec) => new HiggsfieldCli({ apiKey: 'KEY-123', apiSecret: 'SECRET-456', bin: '/opt/hf', exec });

describe('Higgsfield CLI adapter', () => {
  it('builds argv for a Seedance talking clip at 720p with --audio, keys only in the child env', async () => {
    const { exec, calls } = fakeExec([() => ({ id: 'job_1', status: 'completed', result: { url: 'https://cdn.higgsfield.ai/v.mp4' }, credits: 28, duration: 12.4 })]);
    const r = await hf(exec).talkingWithAudio({ imageUrl: 'https://cdn/a.png', audioUrl: 'https://cdn/a.mp3', durationS: 12.4 });
    expect(r).toMatchObject({ jobId: 'job_1', url: 'https://cdn.higgsfield.ai/v.mp4', credits: 28, durationS: 12.4 });
    const { args, env, bin } = calls[0]!;
    expect(bin).toBe('/opt/hf');
    expect(args.slice(0, 3)).toEqual(['generate', 'create', 'seedance2_0']);
    expect(args).toEqual(expect.arrayContaining(['--image', 'https://cdn/a.png', '--audio', 'https://cdn/a.mp3', '--resolution', '720p', '--wait', '--json']));
    expect(args.join(' ')).not.toMatch(/KEY-123|SECRET-456/);
    expect(env.HIGGSFIELD_API_KEY).toBe('KEY-123');
    expect(env.HIGGSFIELD_API_SECRET).toBe('SECRET-456');
  });

  it('refuses a talking clip over 15 s (a 30 s reel is two clips)', async () => {
    const { exec, calls } = fakeExec([]);
    await expect(hf(exec).talkingWithAudio({ imageUrl: 'https://a', audioUrl: 'https://b', durationS: 22 })).rejects.toThrow(/15 s/);
    expect(calls).toHaveLength(0);
  });

  it('falls back Kling 3.0 Turbo → Kling → Wan for image-to-video', async () => {
    const { exec, calls } = fakeExec([
      () => ({ id: 'a', status: 'failed' }),
      () => ({ id: 'b', status: 'completed', url: 'https://cdn/clip.mp4', credits: 6 }),
    ]);
    const r = await hf(exec).imageToVideo({ imageUrl: 'https://cdn/s.png', prompt: 'slow push-in', durationS: 5 });
    expect(r.url).toBe('https://cdn/clip.mp4');
    expect(calls.map((c) => c.args[2])).toEqual(['kling3_0_turbo', 'kling3_0']);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['--duration', '5', '--aspect_ratio', '9:16']));
  });

  it('trains a Soul ID from look prompts (character sheet stills first), with the credits summed', async () => {
    const { exec, calls } = fakeExec([
      () => ({ id: 's1', url: 'https://cdn/s1.png', credits: 2 }),
      () => ({ id: 's2', url: 'https://cdn/s2.png', credits: 2 }),
      () => ({ reference_id: 'soul_abc', credits: 40 }),
    ]);
    const r = await hf(exec).createSoulId({ name: 'Nora Vale', referenceImageUrls: [], prompts: ['Character sheet prompt one, long enough', 'Portrait prompt two, long enough'] });
    expect(r).toEqual({ soulId: 'soul_abc', credits: 44 });
    expect(calls[2]!.args.slice(0, 2)).toEqual(['soul-id', 'create']);
    expect(calls[2]!.args.filter((a) => a === '--image')).toHaveLength(2);
  });

  it('cost probe and upload parse the CLI JSON', async () => {
    const { exec, calls } = fakeExec([() => ({ model: 'seedance2_0', cost: 31 }), () => ({ url: 'https://cdn/uploads/voice.mp3' })]);
    const c = hf(exec);
    expect(await c.costProbe({ operation: 'talking_with_audio', durationS: 10 })).toEqual({ credits: 31 });
    expect(calls[0]!.args.slice(0, 3)).toEqual(['generate', 'cost', 'seedance2_0']);
    expect(await c.upload({ filePath: '/tmp/v.mp3' })).toEqual({ url: 'https://cdn/uploads/voice.mp3' });
    expect(calls[1]!.args).toEqual(['upload', '/tmp/v.mp3', '--json']);
  });

  it('parses CLI output shapes defensively', () => {
    expect(parseCliJson('Waiting…\n{"a":1}')).toEqual({ a: 1 });
    expect(() => parseCliJson('nothing here')).toThrow(/no JSON/);
    expect(readJob({ data: { job_id: 'x', outputs: [{ url: 'https://cdn/o.png' }] }, total_cost: '12' })).toMatchObject({ jobId: 'x', url: 'https://cdn/o.png', credits: 12 });
    expect(readJob({ id: 'y', url: 'http://insecure' }).url).toBeNull();
  });

  it('the Seedance talking provider wraps the image/video provider', async () => {
    const { exec } = fakeExec([() => ({ id: 't', url: 'https://cdn/t.mp4', credits: 30 })]);
    const r = await new HiggsfieldSeedanceTalking(hf(exec)).render({ imageUrl: 'https://a', audioUrl: 'https://b', durationS: 9 });
    expect(r).toMatchObject({ jobId: 't', url: 'https://cdn/t.mp4', credits: 30, costUsd: 0 });
  });
});

describe('cost probe → price table → governor estimates', () => {
  it('writes media_price and estimates from it', async () => {
    const t = await createTestStudio();
    const rows = await probePrices(t.services);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    const n = await t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM media_price');
    expect(n.n).toBe(rows.length);
    await t.db.query(`UPDATE media_price SET credits = 50 WHERE operation = 'talking_with_audio' AND duration_s = 15`);
    expect(await estimateCredits(t.db, { operation: 'talking_with_audio', model: 'seedance2_0', durationS: 14 })).toBe(50);
    expect(await estimateCredits(t.db, { operation: 'talking_with_audio', model: 'seedance2_0', durationS: 30 })).toBe(100);
    expect(await estimateCredits(t.db, { operation: 'still', model: 'unknown_model' })).toBe(2); // built-in fallback
  });
});

describe('ElevenLabs voice adapter', () => {
  it('synthesises into the media store, publishes an https URL, bills the Creator rate', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(new Uint8Array(32_000), { status: 200 });
    };
    const store = new MemoryMediaStore();
    const v = new ElevenLabsVoice('el-key', store, { fetch: fetchFn, publish: async () => 'https://cdn.higgsfield.ai/uploads/v.mp3' });
    const r = await v.tts({ voiceId: 'voice_abc123', text: 'Hello there, comment PLAN.' });
    expect(r.url).toBe('https://cdn.higgsfield.ai/uploads/v.mp3');
    expect(r.durationS).toBe(mp3Seconds(32_000));
    expect(r.costUsd).toBeGreaterThan(0);
    expect(seen[0]!.url).toMatch(/\/text-to-speech\/voice_abc123\?output_format=mp3_44100_128$/);
    expect(seen[0]!.headers['xi-api-key']).toBe('el-key');
    expect(seen[0]!.body).toMatchObject({ model_id: 'eleven_multilingual_v2' });
    expect([...store.objects.keys()][0]).toMatch(/^media\/voice\/voice_abc123\/[0-9a-f]{16}\.mp3$/);
  });

  it('designs a voice from a description (preview → saved voice)', async () => {
    const replies = [{ previews: [{ generated_voice_id: 'gen1' }] }, { voice_id: 'voice_saved' }];
    const v = new ElevenLabsVoice('k', new MemoryMediaStore(), { fetch: async () => Response.json(replies.shift()) });
    expect(await v.designVoice({ description: 'Warm, wry, 160 wpm' })).toEqual({ voiceId: 'voice_saved' });
  });
});

describe('fal Kling AI Avatar v2 (fallback talking provider)', () => {
  it('submits, polls and returns the video with its USD cost', async () => {
    const statuses = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];
    const fetchFn = async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Key fal-key');
      if (init?.method === 'POST') return Response.json({ request_id: 'r1', status_url: 'https://queue.fal.run/x/requests/r1/status', response_url: 'https://queue.fal.run/x/requests/r1' });
      if (url.endsWith('/status')) return Response.json({ status: statuses.shift() });
      return Response.json({ video: { url: 'https://fal.media/out.mp4' }, duration: 10 });
    };
    const r = await new FalKlingAvatar('fal-key', { fetch: fetchFn, sleep: async () => {} }).render({ imageUrl: 'https://a', audioUrl: 'https://b', durationS: 10 });
    expect(r).toMatchObject({ jobId: 'r1', url: 'https://fal.media/out.mp4', durationS: 10, credits: 0, costUsd: 0.56 });
  });
});

describe('live providers', () => {
  const penv = (live: string[]) => ({ isLive: (id: string) => live.includes(id), secret: (n: string) => `secret:${n}` });
  it('stay fake under Vitest', () => {
    expect(mediaLiveProviders(penv(['higgsfield', 'elevenlabs']), { VITEST: 'true' })).toEqual({});
  });
  it('switch on with keys: Higgsfield CLI, Seedance talking, ElevenLabs voice, local storage', () => {
    const p = mediaLiveProviders(penv(['higgsfield', 'elevenlabs']), { IOS_MEDIA_DIR: '/tmp/ios-media-live-test' });
    expect(p.imageVideo?.name).toBe('higgsfield-cli');
    expect(p.talking?.name).toBe('higgsfield-seedance');
    expect(p.voice?.name).toBe('elevenlabs');
    expect(p.storage?.name).toBe('local-media');
  });
  it('fal takes talking with IOS_TALKING_PROVIDER=fal; Higgsfield TTS with IOS_VOICE_PROVIDER=higgsfield', () => {
    const p = mediaLiveProviders(penv(['higgsfield', 'fal', 'elevenlabs']), { IOS_TALKING_PROVIDER: 'fal', IOS_VOICE_PROVIDER: 'higgsfield', IOS_MEDIA_DIR: '/tmp/x' });
    expect(p.talking?.name).toBe('fal-kling-avatar');
    expect(p.voice?.name).toBe('higgsfield-tts');
  });
  it('without keys only storage is live', () => {
    const p = mediaLiveProviders(penv([]), { IOS_MEDIA_DIR: '/tmp/x' });
    expect(Object.keys(p)).toEqual(['storage']);
  });
});
