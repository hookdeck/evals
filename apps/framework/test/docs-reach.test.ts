import { describe, expect, it } from 'vitest';
import { docsReach } from '../lib/docs-reach.js';

/**
 * The defect these guard against was published: two buckets read our own blind
 * spot as a measurement, and #61 built a headline on it. Codex's hosted search
 * returns its hits to the model rather than to the CLI, so those calls arrive
 * with no result — which is not the same fact as a search that came back empty.
 */
describe('docsReach', () => {
  it('counts a call that carries a page as reached', () => {
    expect(
      docsReach({
        pages: [{ url: 'https://hookdeck.com/docs' }],
        resultChars: 4208,
      })
    ).toBe('reached');
  });

  it('counts an observed result with no pages as empty', () => {
    expect(docsReach({ pages: [], resultChars: 0 })).toBe('empty');
  });

  it('counts a call with no result recorded as unobserved, not empty', () => {
    expect(docsReach({ pages: [] })).toBe('unobserved');
  });

  it('counts a url-shaped query with no result as unobserved, not as a page read', () => {
    // The 38 calls on the 14 September snapshot that were credited as docs
    // reads: the "page" is the query the agent typed, not anything we saw come
    // back.
    expect(
      docsReach({
        pages: [{ url: 'https://hookdeck.com/docs/outpost/llms.txt' }],
      })
    ).toBe('unobserved');
  });

  it('treats a missing pages array as no pages rather than throwing', () => {
    expect(docsReach({ resultChars: 12 })).toBe('empty');
  });
});
