import { codexAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * Baseline plus skills on the other primary agent. See `claude-code-sonnet-5`
 * for why both skills are installed rather than the product skill alone.
 */
export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: codexAgent({ model: 'gpt-5.6', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: ['hookdeck', 'event-gateway'],
});
