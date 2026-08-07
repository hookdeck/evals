import { codexAgent, defineExperiment } from '@hookdeck-evals/core';
import { docsOnlyRuntime } from '@hookdeck-evals/hookdeck';

/** The docs-only baseline on the other primary agent. */
export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: codexAgent({ model: 'gpt-5.6', reasoningEffort: 'high' }),
  runtime: docsOnlyRuntime(),
  skills: [],
});
