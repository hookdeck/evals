import { claudeCodeAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * The baseline: no skills. Identical to `claude-code-sonnet-5` in every other
 * respect, so the gap between the two is the value a skill adds and nothing
 * else. Its pass rate doubles as a documentation-quality metric, because
 * finding the right documentation is most of what the agent has to do.
 *
 * Not a bare agent. The pinned Hookdeck CLI is baked into the sandbox image and
 * `HOOKDECK_API_KEY` is in its environment, because every scenario asks it to
 * build or fix something on a real project. What it does not get is skills, and
 * the MCP server, which ships inside the CLI and is read-only.
 */
export default defineExperiment({
  suite: ['no-skills', 'regression'],
  agent: claudeCodeAgent({ model: 'claude-sonnet-5', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: [],
  // A scenario that sets `skills: []` already runs under the skills experiment
  // with the same tool surface. Running it here would score the same thing
  // twice and pay for it twice.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
