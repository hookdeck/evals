/**
 * The agent's execution environment: the sandbox image (node, git, curl, the
 * skills CLI), the agent's tooling, and any requested skills installed for it
 * to read.
 *
 * Upstream this had two modes, tools and local-stack, and the only difference
 * was whether the Supabase local stack ran. With the local stack removed there
 * is one mode, so the `localStack` option and its branch are gone.
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSource } from '@hookdeck-evals/core';
import { DockerSandbox } from './docker-sandbox.js';
import { ensureSandboxImage } from './image.js';
import { installSkills, type SkillEntry } from './skills.js';

export interface AgentEnvironmentOptions {
  /** Host directory whose contents seed the workspace. */
  localDir?: string;
  /** Skills to install into the sandbox (the agent reads them with its file tools). */
  skills?: readonly SkillSource[];
  /**
   * Environment for every command the agent runs. This is how credentials for
   * the leased project reach the agent: the Hookdeck CLI reads
   * HOOKDECK_API_KEY, so setting it here is what makes the project actionable
   * without handing the agent a tool it would not have in real life.
   */
  env?: Record<string, string>;
}

export interface AgentEnvironment {
  /** The created sandbox (the CLI agent's working directory + tools). */
  sandbox: DockerSandbox;
  /** Skills installed in the sandbox, for the discovery prompt. */
  skills: SkillEntry[];
  /** Stop the sandbox. */
  close(): Promise<void>;
}

export async function createAgentEnvironment(
  options: AgentEnvironmentOptions = {}
): Promise<AgentEnvironment> {
  const image = await ensureSandboxImage();
  // Bridge networking: the agent reaches api.hookdeck.com over normal outbound
  // internet. Upstream used host networking only for the local stack.
  const sandbox = await DockerSandbox.create({ image });
  try {
    if (options.localDir) {
      const seeded = expandSeedPlaceholders(
        options.localDir,
        options.env ?? {}
      );
      try {
        await sandbox.copyToContainer(seeded.dir, sandbox.workdir);
      } finally {
        seeded.cleanup();
      }
    }
    if (options.env) sandbox.extraEnv = { ...options.env };
    const skills = await installSkills(sandbox, options.skills ?? []);
    return { sandbox, skills, close: () => sandbox.stop() };
  } catch (err) {
    await sandbox.stop();
    throw err;
  }
}

/** Text files small enough to be config rather than fixtures. */
const MAX_EXPANDABLE_BYTES = 64 * 1024;
const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Copy a scenario's `local/` directory, substituting `${VAR}` from the run's
 * environment.
 *
 * A seeded workspace sometimes has to carry a credential the developer in the
 * scenario would already have, and which the agent cannot obtain: Hookdeck's
 * signing secret is in the dashboard, not on the API, so a handler cannot verify
 * anything without being handed it. Committing the value is not an option, and
 * putting it only in the container environment does not work either - BM1's
 * agent looked for `HOOKDECK_WEBHOOK_SECRET` in `.env`, correctly reported that
 * it could not fetch the real one, and left a placeholder.
 *
 * So `local/.env` names the variable and the harness fills it in on the way past.
 * Unset variables are left as written rather than blanked, so a missing
 * credential reads as a missing credential instead of an empty string.
 */
function expandSeedPlaceholders(
  localDir: string,
  env: Record<string, string>
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hd-seed-'));
  cpSync(localDir, dir, { recursive: true });

  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (statSync(path).size > MAX_EXPANDABLE_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue; // not text; leave it alone
      }
      if (!text.includes('${')) continue;
      const expanded = text.replace(PLACEHOLDER, (whole, name: string) =>
        env[name] === undefined ? whole : env[name]
      );
      if (expanded !== text) writeFileSync(path, expanded);
    }
  };
  walk(dir);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const __testing = { expandSeedPlaceholders };
