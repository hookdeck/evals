/**
 * The agent's execution environment: the sandbox image (node, git, curl, the
 * skills CLI), the agent's tooling, and any requested skills installed for it
 * to read.
 *
 * Upstream this had two modes, tools and local-stack, and the only difference
 * was whether the Supabase local stack ran. With the local stack removed there
 * is one mode, so the `localStack` option and its branch are gone.
 */

import type { SkillSource } from '@hookdeck-evals/core';
import { DockerSandbox } from './docker-sandbox.js';
import { ensureSandboxImage } from './image.js';
import { installSkills, type SkillEntry } from './skills.js';

export interface AgentEnvironmentOptions {
  /** Host directory whose contents seed the workspace. */
  localDir?: string;
  /** Skills to install into the sandbox (the agent reads them with its file tools). */
  skills?: readonly SkillSource[];
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
      await sandbox.copyToContainer(options.localDir, sandbox.workdir);
    }
    const skills = await installSkills(sandbox, options.skills ?? []);
    return { sandbox, skills, close: () => sandbox.stop() };
  } catch (err) {
    await sandbox.stop();
    throw err;
  }
}
