import { codexAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * The no-skills baseline on the other primary agent. See
 * `claude-code-sonnet-5-no-skills` for what the baseline does and does not
 * include; the two differ only in the agent driving them.
 */
export default defineExperiment({
  suite: ['no-skills', 'regression'],
  agent: codexAgent({ model: 'gpt-5.6', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: [],
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
