import type { DocsCall } from '@hookdeck-evals/core';

/**
 * What a documentation call actually tells us, and why that is five things
 * rather than two.
 *
 * Reporting bucketed on `pages` alone, which folded several kinds of ignorance
 * into the same number as a real result:
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
 * - **A fetch of a url that does not exist still names that url as its page.**
 *   Claude's `WebFetch` answers a 404 with a fixed stub, and a piped `curl -f`
 *   answers with `curl: (22)`; both were credited as page text. On the
 *   28 September snapshot that was 14 of the 36 `read` calls on
 *   `claude-code-sonnet-5-no-skills`. These get their own bucket rather than
 *   `none`, because a docs url an agent guessed and got wrong is a finding about
 *   the docs, and `--queries` lists them.
 *
 * Neither the first two nor `unobserved` is a documentation or skills gap, and a
 * delta that moves when they move is not a skills effect. See #83, and #61 for
 * the number that rested on the two-bucket version.
 *
 * The fields do different jobs. `resultChars` separates "we saw a result"
 * from "there was no result to see" (omitted). `httpError` says the result was
 * an error rather than the page. `hasContent` separates page text from a list
 * of links.
 *
 * Order matters. An observed result that is empty, or that names no docs page,
 * is `none` whatever `hasContent` says: a fetch that came back with nothing did
 * not read anything because its url was a docs url, and a hit list with no docs
 * hits is not a docs hit list. `none` deliberately does not branch on
 * `hasContent: true` first: a `search_docs` query that selected `content` and
 * matched nothing has a non-empty result and no page, and calling that a read
 * would be the original mistake again.
 */
export type DocsReach = 'read' | 'hits' | 'error' | 'none' | 'unobserved';

export type DocsReachCall = Partial<
  Pick<
    DocsCall,
    'source' | 'query' | 'pages' | 'hasContent' | 'resultChars' | 'httpError'
  >
>;

/**
 * Whether a row exported before `httpError` existed was a fetch error, from the
 * only trace of it that survived: its length.
 *
 * Published rows keep `resultChars` but not the result, so the stubs can only be
 * recognised by size. Both sizes are fixed by the text, not by the page:
 *
 * - `web_fetch` at **215** characters is the WebFetch HTTP-error stub for a
 *   13-character status phrase, which is both `404 Not Found` and
 *   `403 Forbidden`, so the status itself is not recoverable. Checked against
 *   the raw transcripts behind `results/latest.json`: 17 of 17 WebFetch results
 *   of that length were the stub. Every other WebFetch result in every snapshot
 *   in `results/` is 325 characters or longer.
 * - `shell_fetch` from a `curl -f` (so `hasContent: true`) at **49** characters
 *   is exactly `curl: (22) The requested URL returned error: NNN\n`.
 *
 * Rows that carry `httpError` never reach this, so it stops mattering as the
 * published snapshots age out.
 */
export function inferredLegacyHttpError(call: DocsReachCall): boolean {
  if (call.httpError !== undefined) return false;
  if (call.source === 'web_fetch') return call.resultChars === 215;
  if (call.source === 'shell_fetch') {
    return (
      call.hasContent === true &&
      call.resultChars === 49 &&
      /\bcurl\b/.test(call.query ?? '')
    );
  }
  return false;
}

export function docsReach(call: DocsReachCall): DocsReach {
  if (call.resultChars === undefined) return 'unobserved';
  if (call.httpError !== undefined || inferredLegacyHttpError(call))
    return 'error';
  if (call.resultChars === 0 || (call.pages ?? []).length === 0) return 'none';
  if (call.hasContent === false) return 'hits';
  // A `web_search` only puts page text in front of the agent when Codex
  // reports opening the page, which is the one case marked `hasContent: true`.
  // Anything else with a result we saw is Claude's WebSearch, whose result is
  // a hit list even when the query was a url.
  if (call.source === 'web_search' && call.hasContent !== true) return 'hits';
  return 'read';
}

/** One line of prose per bucket, for whatever is printing them. */
export const DOCS_REACH_MEANING: Record<DocsReach, string> = {
  read: 'page text reached the agent',
  hits: 'a list of links, no page text',
  error: 'a fetch that answered with an HTTP error, not the page',
  none: 'a result came back with nothing attributable to the docs',
  unobserved: 'a hosted search or page open whose result never reaches us',
};
