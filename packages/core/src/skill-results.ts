import type { SkillResult } from './eval-metadata.js';
import type { ToolCallRecord } from './index.js';

/**
 * Skill installs an agent performed itself, as
 * `skills add <repo> --skill <name>` or `skills add <repo>/<name>`.
 *
 * The harness installs skills from the local `skills/` directory and never the
 * network, so anything matching here came from the agent reaching out during
 * the run. Both spellings appear in the wild, and the command is usually run
 * through `npx`.
 */
/** The target and the rest of the command, so flags can be read off it. */
const SELF_INSTALL = /skills\s+add\s+(\S+)([^\n"']*)/g;
const EXPLICIT_SKILL = /--skill[= ]([\w.-]+)/;

/** Builds the persisted skill activation summary for one eval run. */
export function buildSkillResult(
  available: string[],
  toolCalls: ToolCallRecord[]
): SkillResult {
  const loadedSkills = new Set<string>();
  for (const call of toolCalls) {
    for (const skill of call.loadedSkills ?? []) {
      loadedSkills.add(skill);
    }
  }
  const loaded = available.filter((skill) => loadedSkills.has(skill));
  const selfInstalled = findSelfInstalledSkills(toolCalls, available);

  return {
    available,
    loaded,
    ...(selfInstalled.length > 0 ? { selfInstalled } : {}),
  };
}

/**
 * Skills the agent installed for itself, excluding any the harness already
 * provided: re-installing something it was given is not the case worth
 * flagging.
 *
 * Reads the commands the agent ran rather than inspecting the container, so it
 * still works after the sandbox is gone and records the intent even when the
 * install failed.
 */
export function findSelfInstalledSkills(
  toolCalls: ToolCallRecord[],
  available: string[] = []
): string[] {
  const provided = new Set(available);
  const found = new Set<string>();

  for (const call of toolCalls) {
    // `command` is the normalized shell view when the agent's parser extracted
    // one; fall back to the raw body so an agent whose parser does not
    // normalize still gets checked.
    const command = call.command ?? JSON.stringify(call.body ?? '');
    SELF_INSTALL.lastIndex = 0;
    for (const [, target, rest] of command.matchAll(SELF_INSTALL)) {
      const name = skillName(target, rest);
      if (name && !provided.has(name)) found.add(name);
    }
  }

  return [...found].sort();
}

/**
 * What was installed, from the target and the flags after it.
 *
 * Three shapes, in order of how specific they are. `--skill <name>` names it
 * outright. `<owner>/<repo>/<skill>` names it in the path. `<owner>/<repo>`
 * alone installs everything the repo has, and no single skill name would be
 * honest, so the repo is recorded as-is.
 */
function skillName(target: string, rest: string): string | undefined {
  const explicit = rest.match(EXPLICIT_SKILL)?.[1];
  if (explicit) return explicit;

  const segments = target.split('/').filter(Boolean);
  if (segments.length >= 3) return segments[segments.length - 1];
  if (segments.length === 2) return target;
  return undefined;
}
