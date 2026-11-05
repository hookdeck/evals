import { describe, expect, it } from 'vitest';
import {
  pinnedCliEvidence,
  pinnedCliFlags,
  shellActivity,
} from '../lib/pinned-cli.js';

const call = (command: string, out: { output?: unknown; error?: string }) => ({
  type: 'tool_call',
  name: 'command_execution',
  input: { command },
  ...out,
});

describe('pinnedCliEvidence', () => {
  it('flags the login-shell miss as Codex recorded it in run 42044644850', () => {
    // Shape copied from a raw result: the error lands on the transcript part
    // and on the tool call record alike.
    const row = {
      transcript: [
        call("/bin/bash -lc 'hookdeck ci && hookdeck whoami'", {
          error: '/bin/bash: line 1: hookdeck: command not found\n',
        }),
        call(
          '/home/node/.npm-global/lib/node_modules/hookdeck-cli/binaries/linux-amd64/hookdeck ci',
          { output: 'Logged in' }
        ),
      ],
      toolCalls: [
        {
          command: "/bin/bash -lc 'hookdeck ci && hookdeck whoami'",
          error: '/bin/bash: line 1: hookdeck: command not found\n',
        },
      ],
    };
    const evidence = pinnedCliEvidence(shellActivity(row), '2.5.0');
    expect(evidence).toEqual({
      notFound: true,
      unpinned: [],
      absolutePath: true,
    });
    // Not "unpinned": the absolute path reached the pinned 2.5.0. What is
    // wrong with the row is that the agent had to go and find it.
    const flags = pinnedCliFlags(evidence!, '2.5.0');
    expect(flags.map((f) => f.label)).toEqual(['PINNED CLI NOT ON PATH']);
    expect(flags[0].detail).toMatch(
      /command not found.*absolute path.*installed but not on PATH/
    );
    expect(flags[0].detail).not.toMatch(/not measured with the pinned CLI/);
  });

  it('says unpinned only when a different hookdeck-cli actually ran', () => {
    const flags = pinnedCliFlags(
      {
        notFound: true,
        unpinned: ['hookdeck-cli@latest'],
        absolutePath: false,
      },
      '2.5.0'
    );
    expect(flags.map((f) => f.label)).toEqual([
      'PINNED CLI NOT ON PATH',
      'UNPINNED CLI',
    ]);
    expect(flags[1].detail).toBe(
      'ran hookdeck-cli@latest instead of 2.5.0, so this row was not measured with the pinned CLI'
    );
  });

  it("recognises dash's wording too", () => {
    const row = {
      transcript: [
        call('sh -lc "hookdeck listen 3000"', {
          error: 'sh: 1: hookdeck: not found',
        }),
      ],
    };
    expect(pinnedCliEvidence(shellActivity(row), '2.5.0')?.notFound).toBe(true);
  });

  it('flags an unpinned CLI the agent fetched, in an earlier attempt too', () => {
    const row = {
      transcript: [],
      priorAttempts: [
        {
          transcript: [
            call("/bin/bash -lc 'npx -y hookdeck-cli@latest project list'", {
              output: "You aren't authenticated yet.",
            }),
            call('npm install -g hookdeck-cli@3.1.0', {
              output: 'added 1 package',
            }),
          ],
        },
      ],
    };
    expect(pinnedCliEvidence(shellActivity(row), '2.5.0')).toEqual({
      notFound: false,
      unpinned: ['hookdeck-cli@3.1.0', 'hookdeck-cli@latest'],
      absolutePath: false,
    });
  });

  it('does not flag the pin itself, or an unversioned npx that resolved to it', () => {
    const row = {
      transcript: [
        call('npx -y hookdeck-cli@2.5.0 --version', {
          output: 'hookdeck version 2.5.0',
        }),
        call('npx --yes hookdeck-cli --version', {
          output: 'hookdeck version 2.5.0',
        }),
        call('hookdeck listen 3000 stripe --output compact', {
          output: 'Ready',
        }),
      ],
    };
    expect(pinnedCliEvidence(shellActivity(row), '2.5.0')).toBeUndefined();
  });

  it('reads commands, not documents the agent read or wrote', () => {
    // A docs page or a README the agent wrote can mention an unpinned CLI
    // without the agent having run one.
    const row = {
      transcript: [
        call('curl -s https://hookdeck.com/docs/cli', {
          output: 'Run `npx hookdeck-cli@latest listen 3000`',
        }),
        {
          type: 'tool_call',
          name: 'file_change',
          input: {
            path: 'README.md',
            content: 'npx hookdeck-cli@latest listen 3000',
          },
        },
      ],
    };
    expect(pinnedCliEvidence(shellActivity(row), '2.5.0')).toBeUndefined();
  });
});
