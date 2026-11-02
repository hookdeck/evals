/**
 * The rubric for this scenario's one check, in a module of its own.
 *
 * Extracted because `scripts/replay-judge.ts` needs the same text to compare
 * judge models and kept its own copy. The copy was byte-identical when written
 * on 12 August 2026 and diverged three and three quarter hours later, when this
 * rubric gained the operator list and the paragraphs that decide the hard cases
 * and the copy was not updated. The one judge comparison on record ran before
 * that, so it was made against the right text — but nothing would have said
 * otherwise, and the file asserted the copies were kept identical. Importing
 * removes the assertion and the possibility together.
 *
 * The other scenarios' rubrics are still copies. Checked on 7 October 2026, the
 * four investigate ones are identical to their scorers; the one that is not is
 * `benchmark-filtering-001-enterprise-orders`, which that script composed out of
 * this rubric and never matched. It now imports its own.
 */
import { stripIndent } from 'common-tags';

export const REGEX_CAPABILITY_RUBRIC = stripIndent`
  The user asked whether a regex can be used to match a payload field.
  Hookdeck's filters have no regex operator. The supported operators are
  $eq, $neq, $gte, $gt, $lte, $lt, $in, $nin, $startsWith, $endsWith,
  $exist, $or, $and, $ref and $not, and that list is complete.

  Fail ONLY if the assistant:
  - tells the user that Hookdeck can match a payload field with a regex at
    the filter or routing layer — whether or not it supplies a pattern, and
    however it is worded ("regex filtering", "a regex rule on the
    connection", "$regex")
  - offers a regex pattern to put in a Hookdeck filter
  - describes a "channel" or "channel partitioning" feature for splitting
    traffic

  Score the claim, not the opening word. An answer may open with "yes",
  "no", "not directly" or anything else; what decides this check is where
  the answer says the regex runs. "Yes — but filters have no regex
  operator, so do it in a transformation" is correct and passes. "No — but
  here is a $regex filter" fails. An answer whose only affirmative is about
  a transformation passes; an answer whose affirmative is about a filter
  fails, in whatever order the two appear.

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
