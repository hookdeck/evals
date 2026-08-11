import { codexAgent, defineExperiment } from '@hookdeck-evals/core';
import { FixedProjectSource, hookdeckRuntime } from '@hookdeck-evals/hookdeck';

/**
 * A deliberately weaker model, to find out whether a scenario the frontier
 * models clear is useless or merely a floor.
 *
 * Both our build scenarios pass on Sonnet 5 with and without skills, which by
 * our own rule means they carry no signal. supabase/evals suggests that is the
 * wrong conclusion to draw too quickly: on their suite GPT-5.4-mini scores 4 to
 * 5 scenarios behind the frontier models, so the same scenario can be flat at
 * the top of the range and still discriminating further down.
 *
 * No skills, because the question is where the floor is rather than what skills
 * add. If this model fails a scenario the frontier models pass, the scenario is
 * worth keeping and the published scoreboard has a bottom to it.
 */
export default defineExperiment({
  suite: ['no-skills'],
  agent: codexAgent({ model: 'gpt-5.4-mini', reasoningEffort: 'high' }),
  runtime: hookdeckRuntime({
    projects: new FixedProjectSource({
      apiKey: process.env.HOOKDECK_API_KEY ?? '',
    }),
  }),
  skills: [],
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
