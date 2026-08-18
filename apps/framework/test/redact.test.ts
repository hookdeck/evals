import { describe, expect, it } from 'vitest';
import {
  redactText,
  secretValues,
  serializeRedacted,
} from '../harness/redact.js';

/**
 * The leak these guard against was real: agents run `env` while exploring an
 * unfamiliar sandbox, and the dump reached artifacts on a public repository.
 */
describe('secretValues', () => {
  it('selects env vars whose name marks them as credentials', () => {
    const found = secretValues({
      HOOKDECK_API_KEY: 'abcdefghijklmnop',
      HOOKDECK_WEBHOOK_SECRET: 'qrstuvwxyz123456',
      GH_TOKEN: 'ghp_0000000000000000',
      NODE_VERSION: '22.23.2',
      NO_COLOR: '1',
      PATH: '/usr/bin:/bin',
    });
    expect(found.map((s) => s.name).sort()).toEqual([
      'GH_TOKEN',
      'HOOKDECK_API_KEY',
      'HOOKDECK_WEBHOOK_SECRET',
    ]);
  });

  it('ignores short values, which are settings rather than secrets', () => {
    // Redacting a value of "1" would blank every digit in the artifact.
    expect(secretValues({ SOME_KEY: '1' })).toEqual([]);
  });

  it('orders longest first so a secret that prefixes another is not half-redacted', () => {
    const found = secretValues({
      SHORT_KEY: 'aaaaaaaaaaaa',
      LONG_KEY: 'aaaaaaaaaaaaBBBBBBBB',
    });
    expect(found[0].name).toBe('LONG_KEY');

    const text = redactText('value=aaaaaaaaaaaaBBBBBBBB', found);
    expect(text).not.toContain('BBBBBBBB');
  });
});

describe('redactText', () => {
  it('removes a known secret value wherever it appears', () => {
    const secrets = [{ name: 'HOOKDECK_API_KEY', value: 'supersecretvalue' }];
    const out = redactText(
      'env output: HOOKDECK_API_KEY=supersecretvalue and again supersecretvalue',
      secrets
    );
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('<redacted:HOOKDECK_API_KEY>');
  });

  it('removes credential shapes not present in the environment', () => {
    const out = redactText(`OPENAI_API_KEY=sk-${'a'.repeat(40)}`, []);
    expect(out).not.toContain('a'.repeat(40));
    expect(out).toContain('<redacted:openai-key>');
  });

  it('leaves ordinary transcript prose alone', () => {
    const prose = 'The agent created a Stripe source and routed it to orders.';
    expect(redactText(prose, [])).toBe(prose);
  });
});

describe('serializeRedacted', () => {
  it('reaches secrets nested anywhere in the artifact', () => {
    const secrets = [{ name: 'HOOKDECK_API_KEY', value: 'supersecretvalue' }];
    const artifact = {
      experiment: 'claude-code-sonnet-5',
      toolCalls: [
        {
          body: { command: 'env' },
          stdout: 'HOOKDECK_API_KEY=supersecretvalue',
        },
      ],
      transcript: [{ text: 'I found supersecretvalue in the environment' }],
    };
    const out = serializeRedacted(artifact, secrets);
    expect(out).not.toContain('supersecretvalue');
    expect(JSON.parse(out).experiment).toBe('claude-code-sonnet-5');
  });

  it('produces parseable JSON', () => {
    const out = serializeRedacted(
      { a: 'keepme', b: ['x', { c: 'secretsecret' }] },
      [{ name: 'K', value: 'secretsecret' }]
    );
    expect(JSON.parse(out)).toEqual({
      a: 'keepme',
      b: ['x', { c: '<redacted:K>' }],
    });
  });
});
