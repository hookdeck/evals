import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findSelfInstalledSkills } from './skill-results.js';
import type { ToolCallRecord } from './index.js';

const call = (command: string): ToolCallRecord =>
  ({ endpoint: 'shell', body: { command }, command, ts: 0 }) as ToolCallRecord;

describe('findSelfInstalledSkills', () => {
  it('finds a --skill install', () => {
    expect(
      findSelfInstalledSkills([
        call(
          'npx skills add hookdeck/webhook-skills --skill stripe-webhooks -y -g'
        ),
      ])
    ).toEqual(['stripe-webhooks']);
  });

  it('finds an owner/repo/skill install', () => {
    expect(
      findSelfInstalledSkills([
        call('npx skills add hookdeck/webhook-skills/shopify-webhooks'),
      ])
    ).toEqual(['shopify-webhooks']);
  });

  it('records the repo when a whole repo is installed', () => {
    // No single skill name would be honest: this installs everything it has.
    expect(
      findSelfInstalledSkills([call('npx skills add hookdeck/webhook-skills')])
    ).toEqual(['hookdeck/webhook-skills']);
  });

  it('ignores a skill the harness already provided', () => {
    // Re-installing what it was given is not the contamination case.
    expect(
      findSelfInstalledSkills(
        [call('npx skills add hookdeck/agent-skills --skill event-gateway')],
        ['hookdeck', 'event-gateway']
      )
    ).toEqual([]);
  });

  it('returns nothing when the agent installed nothing', () => {
    expect(findSelfInstalledSkills([call('npm install express')])).toEqual([]);
  });

  it('reads the raw body when the parser did not normalize a command', () => {
    const raw = {
      endpoint: 'shell',
      body: {
        cmd: 'npx skills add hookdeck/webhook-skills --skill stripe-webhooks',
      },
      ts: 0,
    } as unknown as ToolCallRecord;
    expect(findSelfInstalledSkills([raw])).toEqual(['stripe-webhooks']);
  });

  it('finds the install in the run that prompted this check', () => {
    // Regression against the real transcript: BM1's first run installed a
    // provider skill mid-run, which is how this was discovered at all.
    const path = new URL(
      '../../../results/claude-code-sonnet-5/benchmark-verification-001-stripe-express.json',
      import.meta.url
    );
    const result = JSON.parse(readFileSync(path, 'utf8')) as {
      toolCalls: ToolCallRecord[];
    };
    expect(
      findSelfInstalledSkills(result.toolCalls, ['hookdeck', 'event-gateway'])
    ).toContain('stripe-webhooks');
  });
});
