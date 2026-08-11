import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { __testing } from '../src/agent-environment.js';

const seedDir = (contents: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-local-'));
  for (const [name, body] of Object.entries(contents)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
};

describe('expandSeedPlaceholders', () => {
  it('fills a placeholder from the run environment', () => {
    const dir = seedDir({ '.env': 'SECRET=${HOOKDECK_WEBHOOK_SECRET}\n' });
    const out = __testing.expandSeedPlaceholders(dir, {
      HOOKDECK_WEBHOOK_SECRET: 'whsk_real',
    });
    expect(readFileSync(join(out.dir, '.env'), 'utf8')).toBe(
      'SECRET=whsk_real\n'
    );
    out.cleanup();
  });

  it('leaves an unset variable as written rather than blanking it', () => {
    // A missing credential should read as missing, not as an empty string that
    // looks configured and fails at verification time.
    const dir = seedDir({ '.env': 'SECRET=${NOT_SET}\n' });
    const out = __testing.expandSeedPlaceholders(dir, {});
    expect(readFileSync(join(out.dir, '.env'), 'utf8')).toBe(
      'SECRET=${NOT_SET}\n'
    );
    out.cleanup();
  });

  it('does not modify the scenario directory', () => {
    const dir = seedDir({ '.env': 'SECRET=${HOOKDECK_WEBHOOK_SECRET}\n' });
    const out = __testing.expandSeedPlaceholders(dir, {
      HOOKDECK_WEBHOOK_SECRET: 'x',
    });
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain(
      '${HOOKDECK_WEBHOOK_SECRET}'
    );
    out.cleanup();
  });

  it('leaves files with no placeholders alone', () => {
    const dir = seedDir({ 'server.js': 'const app = express();\n' });
    const out = __testing.expandSeedPlaceholders(dir, { A: 'b' });
    expect(readFileSync(join(out.dir, 'server.js'), 'utf8')).toBe(
      'const app = express();\n'
    );
    out.cleanup();
  });
});
