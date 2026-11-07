/**
 * Agent registry: the single list of CLI agents the harness knows about.
 *
 * Each agent module contributes one `AgentDefinition` (runner + parser). The
 * registry derives the supported-agent list and the transcript-parser lookup
 * from it, so adding an agent is one import + one array entry here (plus the
 * agent's own `<agent>/` module). The run-time factories (`claudeCodeAgent`,
 * `codexAgent`) are exported directly from those modules for use in experiments.
 */

import type { AgentDefinition } from './types.js';
import type { AgentHarnessId } from '../eval-metadata.js';
import type { AgentTranscriptParser } from '../parsers/types.js';
import { claudeCodeDefinition } from './claude-code/index.js';
import { codexDefinition } from './codex/index.js';
import { opencodeDefinition } from './opencode/index.js';

const AGENTS: AgentDefinition[] = [
  claudeCodeDefinition,
  codexDefinition,
  opencodeDefinition,
];

const byId = new Map(AGENTS.map((agent) => [agent.runner.id, agent]));

/** Agent ids with a registered transcript parser. */
export function supportedParsers(): string[] {
  return [...byId.keys()];
}

/** Look up a parser by agent id, or throw with the supported list. */
export function createParser(agent: AgentHarnessId): AgentTranscriptParser {
  const definition = byId.get(agent);
  if (!definition) {
    throw new Error(
      `Unknown agent parser: "${agent}". Supported: ${supportedParsers().join(', ')}`
    );
  }
  return definition.parser;
}

/**
 * What each registered agent installs and which key it reads, without the
 * runner's behaviour. For `preflight`, which compares the pins against npm and
 * the keys against the repository's secrets, and should read both from the
 * objects a run uses rather than from a copy that drifts.
 */
export function registeredAgentPins(): Array<{
  id: AgentHarnessId;
  displayName: string;
  cliPackage: string;
  defaultCliVersion: string;
  apiKeyEnvVar: string;
}> {
  return AGENTS.map(({ runner }) => ({
    id: runner.id,
    displayName: runner.displayName,
    cliPackage: runner.cliPackage,
    defaultCliVersion: runner.defaultCliVersion,
    apiKeyEnvVar: runner.apiKeyEnvVar,
  }));
}
