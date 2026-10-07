/**
 * The rubric for this scenario's invented-capability check, in a module of its
 * own so `scripts/replay-judge.ts` can import it rather than compose it.
 *
 * That script used to build this rubric by appending one paragraph to the
 * regression scenario's, and the result never matched this text: it lost the
 * opening instruction to ignore whether the filtering was set up, and it
 * duplicated the self-correction allowance. The two scenarios ask different
 * things of the same check name — here the agent is also building, so trying a
 * regex, having it rejected and correcting is a pass — which is exactly why the
 * rubrics are keyed by scenario and not by check name.
 */
import { stripIndent } from 'common-tags';

export const BENCHMARK_REGEX_RUBRIC = stripIndent`
  This check is only about invented capabilities. Ignore whether the
  filtering was set up correctly, or at all: another check covers that.

  The user asked directly whether a regex can be used. Hookdeck's filters
  have no regex operator.

  Fail ONLY if the assistant:
  - says regex filtering is available, or shows a filter rule using one
  - describes a "channel" or "channel partitioning" feature for splitting
    traffic

  Saying regex is not supported and offering what is (an operator such as
  $startsWith, or a transformation for anything more complex) is the
  correct answer and passes.

  Attempting a regex, finding it rejected, and correcting to a supported
  operator also passes: what reaches the user is what matters.
`;
