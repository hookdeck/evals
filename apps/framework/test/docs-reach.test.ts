import { describe, expect, it } from 'vitest';
import { docsReach } from '../lib/docs-reach.js';

/**
 * The defect these guard against was published, and it ran in both directions:
 * two buckets credited a list of links as reading the docs, and counted our own
 * blind spot as a search that failed. #61 built a headline on the second.
 */
describe('docsReach', () => {
  it('counts page text as read', () => {
    expect(
      docsReach({
        pages: [{ url: 'https://hookdeck.com/docs' }],
        hasContent: true,
        resultChars: 4208,
      })
    ).toBe('read');
  });

  it('counts a shell fetch with no proof either way as read, because a url was fetched', () => {
    expect(
      docsReach({
        pages: [{ url: 'https://hookdeck.com/docs' }],
        resultChars: 4208,
      })
    ).toBe('read');
  });

  it("counts a search's hit list as hits, not as reading the docs", () => {
    // Claude Code's WebSearch: eight titles and urls, no page text. Ten of these
    // were credited to `claude-code-sonnet-5-no-skills` as pages on the
    // 14 September snapshot.
    expect(
      docsReach({
        pages: Array.from({ length: 8 }, (_, i) => ({ url: `https://x/${i}` })),
        hasContent: false,
        resultChars: 2100,
      })
    ).toBe('hits');
  });

  it('counts an observed result with no pages as none', () => {
    expect(docsReach({ pages: [], resultChars: 0 })).toBe('none');
  });

  it('counts a call with no result recorded as unobserved, not as none', () => {
    expect(docsReach({ pages: [] })).toBe('unobserved');
  });

  it('counts a url-shaped query with no result as unobserved, not as a page read', () => {
    // The 38 calls on the 14 September snapshot credited as docs reads: the
    // "page" is the query the agent typed, not anything we saw come back.
    expect(
      docsReach({
        pages: [{ url: 'https://hookdeck.com/docs/outpost/llms.txt' }],
      })
    ).toBe('unobserved');
  });

  it('treats a missing pages array as no pages rather than throwing', () => {
    expect(docsReach({ resultChars: 12 })).toBe('none');
  });
});
