import { claudeCodeAgent, defineExperiment } from '@hookdeck-evals/core';
import { docsOnlyRuntime } from '@hookdeck-evals/hookdeck';

/**
 * The baseline. Web access to the docs, nothing else: no MCP server, no
 * skills. Every other experiment is measured as lift over this one, and the
 * docs-only pass rate doubles as a docs-quality metric.
 */
export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: claudeCodeAgent({ model: 'claude-sonnet-5', reasoningEffort: 'high' }),
  runtime: docsOnlyRuntime(),
  skills: [],
});
