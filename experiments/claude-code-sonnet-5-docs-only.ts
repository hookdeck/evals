import { claudeCodeAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * The baseline. Web access to the docs, nothing else: no MCP server, no
 * skills. Every other experiment is measured as lift over this one, and its
 * pass rate doubles as a docs-quality metric.
 *
 * "Docs-only" describes the agent's tool surface, not the environment: the
 * agent still acts on a real Hookdeck project, because every scenario asks it
 * to build or fix something there.
 */
export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: claudeCodeAgent({ model: 'claude-sonnet-5', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: [],
});
