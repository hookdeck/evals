import { readFileSync } from 'node:fs';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_DOCKERFILE_PATH } from '../src/image.js';
import {
  resolveSandboxPath,
  truncateOutput,
} from '../src/agent-sandbox.js';
import type { DockerSandbox } from '../src/docker-sandbox.js';
import {
  SKILLS_CLI_VERSION,
  SKILLS_INSTALL_DIR,
  buildSkillsPrompt,
  frontmatterDescription,
} from '../src/skills.js';
import { ALL_SUPABASE_SERVICES } from '../src/types.js';

describe('sandbox Dockerfile', () => {
  it('is a CLI-free base image carrying the common agent tooling', () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');
    expect(dockerfile).toContain('FROM node:22-slim');
    // Common tooling shared by both eval modes.
    expect(dockerfile).toContain('postgresql-client');
    expect(dockerfile).toContain('docker.io');
    // The Supabase CLI is NOT baked in — it's a local-stack component installed
    // at setup time (installSupabaseCli), so tools-mode sandboxes genuinely lack
    // it. The base image is therefore shared across modes and CLI versions.
    expect(dockerfile).not.toContain('ARG CLI_VERSION');
    expect(dockerfile).not.toContain('supabase.deb');
  });

  it("bakes in Vercel's skills CLI pinned via build arg", () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');
    expect(dockerfile).toContain('ARG SKILLS_CLI_VERSION');
    expect(dockerfile).toContain(
      'npm install -g "skills@${SKILLS_CLI_VERSION}"'
    );
  });

});

describe('frontmatterDescription', () => {
  it('reads a quoted description containing colons', () => {
    const md = [
      '---',
      'name: supabase',
      'description: "Use when doing X. Triggers: a, b, c."',
      'metadata:',
      '  author: supabase',
      '---',
      '',
      '# Body',
    ].join('\n');
    expect(frontmatterDescription(md)).toBe(
      'Use when doing X. Triggers: a, b, c.'
    );
  });

  it('reads an unquoted single-line description', () => {
    expect(
      frontmatterDescription(
        '---\nname: pg\ndescription: Postgres tips.\n---\nbody'
      )
    ).toBe('Postgres tips.');
  });

  it('returns empty without frontmatter or without a description', () => {
    expect(frontmatterDescription('# Just a body')).toBe('');
    expect(frontmatterDescription('---\nname: solo\n---\nbody')).toBe('');
  });
});

describe('buildSkillsPrompt', () => {
  it('is empty when no skills are installed', () => {
    expect(buildSkillsPrompt([])).toBe('');
  });

  it('lists name+description and points at the install dir for files_read', () => {
    const prompt = buildSkillsPrompt([
      { name: 'supabase', description: 'Use for Supabase tasks.', dir: 'x' },
      { name: 'pg', description: 'Postgres tips.', dir: 'y' },
    ]);
    expect(prompt).toContain(SKILLS_INSTALL_DIR);
    expect(prompt).toContain('files_read');
    expect(prompt).toContain('SKILL.md');
    expect(prompt).toContain('- supabase: Use for Supabase tasks.');
    expect(prompt).toContain('- pg: Postgres tips.');
    // Discovery only — the full body must not be inlined here.
    expect(prompt).not.toContain('# Body');
  });
});

describe('SKILLS_CLI_VERSION', () => {
  it('is a pinned semver string', () => {
    expect(SKILLS_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});


describe('cliVersion frontmatter', () => {
  it('accepts a pinned semantic version', () => {
    const { metadata } = parseEvalMarkdown(
      [
        '---',
        'stage: resolve',
        'suite: regression',
        'interface: cli',
        'cliVersion: 2.109.1',
        'product: database',
        'topic: migrations',
        '---',
        'Fix it.',
      ].join('\n')
    );

    expect(metadata.cliVersion).toBe('2.109.1');
  });

  it('rejects a non-semver CLI version', () => {
    expect(() =>
      parseEvalMarkdown(
        [
          '---',
          'stage: resolve',
          'suite: regression',
          'interface: cli',
          'cliVersion: latest',
          'product: database',
          'topic: migrations',
          '---',
          'Fix it.',
        ].join('\n')
      )
    ).toThrow();
  });
});

describe('skills frontmatter', () => {
  const buildMarkdown = (extra: string) =>
    [
      '---',
      'stage: build',
      'suite: regression',
      'interface: cli',
      'product: [database]',
      'topic: [sdk]',
      extra,
      '---',
      'body',
    ].join('\n');

  it('preserves hyphenated skill directory names', () => {
    const { metadata } = parseEvalMarkdown(
      buildMarkdown('skills: [supabase, supabase-postgres-best-practices]')
    );
    expect(metadata.skills).toEqual([
      'supabase',
      'supabase-postgres-best-practices',
    ]);
  });

  it('parses an empty override distinctly from an omitted key', () => {
    const overridden = parseEvalMarkdown(buildMarkdown('skills: []'));
    expect(overridden.metadata.skills).toEqual([]);

    const omitted = parseEvalMarkdown(buildMarkdown(''));
    expect(omitted.metadata.skills).toBeUndefined();
  });
});

describe('skipCliInstall frontmatter', () => {
  const buildMarkdown = (extra: string) =>
    [
      '---',
      'stage: build',
      'suite: regression',
      'interface: cli',
      'product: [database]',
      'topic: [sdk]',
      extra,
      '---',
      'body',
    ].join('\n');

  it('accepts a real boolean and a quoted string form', () => {
    expect(
      parseEvalMarkdown(buildMarkdown('skipCliInstall: true')).metadata
        .skipCliInstall
    ).toBe(true);
    expect(
      parseEvalMarkdown(buildMarkdown('skipCliInstall: "true"')).metadata
        .skipCliInstall
    ).toBe(true);
  });

  it('defaults to undefined when omitted', () => {
    expect(
      parseEvalMarkdown(buildMarkdown('')).metadata.skipCliInstall
    ).toBeUndefined();
  });
});

describe('resolveSandboxPath', () => {
  it('accepts and normalizes relative paths', () => {
    expect(resolveSandboxPath('a/b.txt')).toBe('a/b.txt');
    expect(resolveSandboxPath('./a//b.txt')).toBe('a/b.txt');
    expect(resolveSandboxPath('a/../b.txt')).toBe('b.txt');
  });

  it('rejects absolute, empty, and escaping paths', () => {
    expect(() => resolveSandboxPath('/etc/passwd')).toThrowError(/relative/);
    expect(() => resolveSandboxPath('')).toThrowError(/relative/);
    expect(() => resolveSandboxPath('..')).toThrowError(/escapes/);
    expect(() => resolveSandboxPath('../x')).toThrowError(/escapes/);
    expect(() => resolveSandboxPath('a/../../x')).toThrowError(/escapes/);
  });
});

describe('truncateOutput', () => {
  it('passes short output through untouched', () => {
    expect(truncateOutput('hello')).toBe('hello');
  });

  it('keeps head and tail of oversized output with a marker', () => {
    const output = `${'a'.repeat(20_000)}TAIL`;
    const truncated = truncateOutput(output);
    expect(truncated.length).toBeLessThan(output.length);
    expect(truncated.startsWith('aaa')).toBe(true);
    expect(truncated.endsWith('TAIL')).toBe(true);
    expect(truncated).toContain('...[truncated');
  });
});

