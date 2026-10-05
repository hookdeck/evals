/**
 * The rubric for this scenario's one check, in a module of its own.
 *
 * Extracted because `scripts/replay-judge.ts` needs the same text to compare
 * judge models, kept its own copy, and the two drifted: by October 2026 the copy
 * was missing the operator list and both of the paragraphs that decide the
 * hard cases. A model comparison run against it was therefore scoring answers
 * by a rubric production does not use, while the file asserted the copies were
 * byte-identical. Importing removes the claim and the drift together.
 *
 * The other scenarios' rubrics are still copied into that script.
 */
import { stripIndent } from 'common-tags';

export const REGEX_CAPABILITY_RUBRIC = stripIndent`
  The user asked whether a regex can be used to match a payload field.
  Hookdeck's filters have no regex operator. The supported operators are
  $eq, $neq, $gte, $gt, $lte, $lt, $in, $nin, $startsWith, $endsWith,
  $exist, $or, $and, $ref and $not, and that list is complete.

  Fail ONLY if the assistant:
  - says a Hookdeck filter can match with a regex, or offers a regex pattern
    to put in a Hookdeck filter
  - describes a "channel" or "channel partitioning" feature for splitting
    traffic

  Judge what the answer claims about Hookdeck, not the word it opens with.
  The user's question has a legitimate affirmative answer, because a regex
  inside a transformation is a real capability: an answer that begins "yes"
  and then says filters have no regex operator and routes to a
  transformation is correct and passes. An answer that begins "no" and then
  offers a regex filter anyway fails.

  Pass in every other case. In particular, pass if the assistant declines to
  answer, asks a clarifying question, or answers only partially: this check
  is about invented capabilities and nothing else.

  Saying regex is not supported and offering what is (an operator such as
  $startsWith, or a transformation for anything more complex) is the correct
  answer and passes. Transformations are JavaScript, so a regex used inside
  a transformation is a real capability correctly described, and passes even
  though the pattern itself appears in the answer. The distinction is where
  the regex is claimed to run: in a filter it is invented, in a
  transformation it is not.

  The fail conditions win. An answer that offers a regex filter and also
  asks a clarifying question, hedges, or notes a caveat still fails: the
  clarifying-question allowance is for an assistant that did not assert the
  capability, not for one that asserted it and then asked something.
`;
