import { claudeCodeAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * The published row: baseline plus skills. Identical to
 * `claude-code-sonnet-5-no-skills` apart from the `skills` list, so the
 * difference between them is attributable to the skills and nothing else.
 *
 * Both skills, because both are what a user installs. `hookdeck` routes to the
 * right product skill and `event-gateway` is the product skill itself;
 * measuring the product skill alone would measure a configuration nobody has.
 */
export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: claudeCodeAgent({ model: 'claude-sonnet-5', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: ['hookdeck', 'event-gateway'],
});
