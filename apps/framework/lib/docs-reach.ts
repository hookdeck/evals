/**
 * What a documentation call actually tells us, and why that is four things
 * rather than two.
 *
 * Reporting bucketed on `pages` alone, which folded two different kinds of
 * ignorance into the same number as a real result:
 *
 * - **Codex's `web_search` is hosted.** The hits go to the model on the
 *   provider's side and the CLI receives nothing, so the call arrives with no
 *   pages, `hasContent` unknown and `resultChars` omitted. That is our blind
 *   spot, not a failed search. On the 14 September snapshot all 254 of them were
 *   unobserved: 216 counted as failures and 38 counted as successful page reads,
 *   the latter because a url-shaped query is recorded as the page it probably
 *   opened.
 * - **Claude's `WebSearch` returns hits, not pages.** Titles and urls, no page
 *   text — `docs-results.ts` sets `hasContent: false` for exactly this. Counting
 *   those as "reached the docs" credits an agent for seeing a list of links. Ten
 *   of the 46 calls that arm was credited with on the same snapshot were hit
 *   lists.
 *
 * Neither is a documentation or skills gap, and a delta that moves when either
 * moves is not a skills effect. See #83, and #61 for the number that rested on
 * the two-bucket version.
 *
 * The fields do different jobs and both are needed. `resultChars` separates "we
 * saw a result and it was empty" (`0`) from "there was no result to see"
 * (omitted). `hasContent` separates page text from a list of links.
 */
export type DocsReach = 'read' | 'hits' | 'none' | 'unobserved';

export interface DocsReachCall {
  pages?: unknown[];
  hasContent?: boolean;
  resultChars?: number;
}

export function docsReach(call: DocsReachCall): DocsReach {
  if (call.resultChars === undefined) return 'unobserved';
  if (call.hasContent === false) return 'hits';
  return (call.pages ?? []).length > 0 ? 'read' : 'none';
}

/** One line of prose per bucket, for whatever is printing them. */
export const DOCS_REACH_MEANING: Record<DocsReach, string> = {
  read: 'page text reached the agent',
  hits: 'a list of links, no page text',
  none: 'a result we saw, carrying nothing',
  unobserved: 'a hosted search whose hits never reach us',
};
