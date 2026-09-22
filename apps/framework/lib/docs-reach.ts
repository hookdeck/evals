/**
 * Which of three things a documentation call tells us, and the reason there are
 * three rather than two.
 *
 * A call that carries a page is evidence the agent reached documentation. A call
 * that returned nothing is evidence it did not. Codex's `web_search` is neither:
 * the search is hosted, so the hits go to the model on the provider's side and
 * the CLI never receives them. `buildDocsResult` records that honestly — no
 * pages, `hasContent` left unknown, and `resultChars` omitted because there was
 * no result to measure — and anything downstream that buckets on `pages` alone
 * then reads our own blind spot as a finding.
 *
 * It read wrong in both directions before this existed: on the 14 September
 * snapshot, 216 unobserved searches counted as failures and a further 38 counted
 * as successful page reads, the latter because a url-shaped query is recorded as
 * the page it probably opened. See #83, and #61 for the number that rested on it.
 *
 * `resultChars` is the discriminator rather than `pages`, because it separates
 * "we saw a result and it was empty" (`0`) from "there was no result to see"
 * (omitted).
 */
export type DocsReach = 'reached' | 'empty' | 'unobserved';

export interface DocsReachCall {
  pages?: unknown[];
  resultChars?: number;
}

export function docsReach(call: DocsReachCall): DocsReach {
  if (call.resultChars === undefined) return 'unobserved';
  return (call.pages ?? []).length > 0 ? 'reached' : 'empty';
}
