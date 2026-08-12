import { codexAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * The weak model, with skills. The other half of the only pair that can
 * currently measure anything.
 *
 * Skills have changed no outcome on any scenario so far, but every one of those
 * comparisons was made on Claude Code, which passes everything with or without
 * them. A lift is only observable where there is something to lift, and the
 * only failures in the suite belong to `codex-gpt-5.4-mini-no-skills`: a source
 * configured with the wrong secret, a source missing `webhook_secret_key`, and
 * an unauthenticated `hookdeck listen` session.
 *
 * So this pair is the experiment that decides whether the skills programme has
 * evidence behind it. If the same model with `hookdeck` and `event-gateway`
 * installed gets authentication right, that is the delta the project has been
 * looking for. If it does not, the gap is the skill content rather than the
 * axis, and that is equally worth knowing.
 */
export default defineExperiment({
  suite: ['benchmark'],
  agent: codexAgent({ model: 'gpt-5.4-mini', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: ['hookdeck', 'event-gateway'],
});
