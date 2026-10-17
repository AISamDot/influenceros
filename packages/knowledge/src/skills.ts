import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_NAMES, type SkillName } from '@troupe/agents';
import { findRepoRoot } from '@troupe/db';
import type { LlmCacheBlock } from '@troupe/providers';

/**
 * The studio's own skills live in `<repo>/.claude/skills/<name>/SKILL.md`. In live mode the Agent SDK loads them
 * (settingSources ['project'], shell execution disabled); this module reads the same files so a skill's method can
 * also be sent as a prompt-cached block, and validates them (our own text, no `allowed-tools`, no `!` shell lines).
 */

export function skillsDir(root = findRepoRoot()): string {
  return join(/*turbopackIgnore: true*/ root, '.claude', 'skills');
}

export function skillPath(name: SkillName, root?: string): string {
  return join(/*turbopackIgnore: true*/ skillsDir(root), name, 'SKILL.md');
}

const cache = new Map<string, string>();

/** SKILL.md text ('' when missing). */
export function readSkill(name: SkillName, root?: string): string {
  const file = skillPath(name, root);
  if (cache.has(file)) return cache.get(file)!;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  cache.set(file, text);
  return text;
}

/** The skill as a stable prompt-cache block (key carries a content hash, never a timestamp). */
export function skillBlock(name: SkillName, root?: string): LlmCacheBlock {
  const text = readSkill(name, root) || `Skill ${name}: not installed.`;
  return { key: `skill:${name}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`, text };
}

export interface SkillProblem {
  skill: string;
  problem: string;
}

/** Frontmatter `name` / `description` present, name matches the folder, no tool grants, no shell-injection lines. */
export function validateSkillText(name: string, text: string): string[] {
  const problems: string[] = [];
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!fm) return ['missing YAML frontmatter'];
  const front = fm[1]!;
  const fmName = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (fmName !== name) problems.push(`frontmatter name is "${fmName ?? ''}", expected "${name}"`);
  const desc = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '';
  if (desc.length < 40) problems.push('description is missing or too short to trigger the skill');
  if (desc.length > 1024) problems.push('description is longer than 1,024 characters');
  if (/^allowed-tools\s*:/m.test(front)) problems.push('allowed-tools is not allowed (tools are limited in code)');
  const body = text.slice(fm[0].length);
  if (/^\s*!(?!\[)/m.test(body) || /!`[^`]*`/.test(body)) problems.push('shell-execution lines (!command) are not allowed');
  if (body.trim().split(/\s+/).length < 150) problems.push('body is too thin to be useful');
  return problems;
}

export function validateSkills(root?: string): SkillProblem[] {
  const out: SkillProblem[] = [];
  for (const name of SKILL_NAMES) {
    const file = skillPath(name, root);
    if (!existsSync(file)) {
      out.push({ skill: name, problem: 'SKILL.md is missing' });
      continue;
    }
    for (const problem of validateSkillText(name, readFileSync(file, 'utf8'))) out.push({ skill: name, problem });
  }
  return out;
}
