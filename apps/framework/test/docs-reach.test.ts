import { buildDocsResult, type ToolCallRecord } from '@hookdeck-evals/core';
import { docsCallSchema } from '@hookdeck-evals/core/eval-metadata';
import { describe, expect, it } from 'vitest';
import { docsReach, inferredLegacyHttpError } from '../lib/docs-reach.js';

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
        source: 'shell_fetch',
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

  it('counts a fetch that came back empty as none, not as read', () => {
    // web_fetch records the url it asked for as its page whatever came back, so
    // the page alone is not evidence that anything was read.
    expect(
      docsReach({
        pages: [{ url: 'https://hookdeck.com/docs' }],
        hasContent: true,
        resultChars: 0,
      })
    ).toBe('none');
  });

  it('counts a link-only result with no links in it as none, not as hits', () => {
    // A search_docs query that selects no `content` and matches nothing.
    expect(docsReach({ pages: [], hasContent: false, resultChars: 41 })).toBe(
      'none'
    );
  });

  it('treats a missing pages array as no pages rather than throwing', () => {
    expect(docsReach({ resultChars: 12 })).toBe('none');
  });

  it('counts a fetch that recorded an HTTP error as error, whatever hasContent says', () => {
    expect(
      docsReach({
        source: 'web_fetch',
        pages: [{ url: 'https://hookdeck.com/docs/retry' }],
        hasContent: true,
        resultChars: 215,
        httpError: 404,
      })
    ).toBe('error');
  });

  it('counts a web_search with a result and a url for a page as hits, not read', () => {
    // A row exported before the emitter learned that Claude's WebSearch answers a
    // url-shaped query with a hit list: it named the query as its page.
    expect(
      docsReach({
        source: 'web_search',
        pages: [{ url: 'https://hookdeck.com/docs/retries' }],
        resultChars: 1800,
      })
    ).toBe('hits');
  });

  it('still counts a Codex open_page as read, because it is the one web_search marked as page text', () => {
    expect(
      docsReach({
        source: 'web_search',
        pages: [{ url: 'https://hookdeck.com/docs/retries' }],
        hasContent: true,
        resultChars: 3000,
      })
    ).toBe('read');
  });
});

/**
 * Published rows exported before `httpError` existed can only be recognised by
 * the size of the error text, because the text itself is not exported.
 */
describe('inferredLegacyHttpError', () => {
  it('recognises the 215-character WebFetch 404 stub', () => {
    const call = {
      source: 'web_fetch' as const,
      pages: [{ url: 'https://hookdeck.com/docs/retry' }],
      hasContent: true,
      resultChars: 215,
    };
    expect(inferredLegacyHttpError(call)).toBe(true);
    expect(docsReach(call)).toBe('error');
  });

  it('recognises a piped curl -f whose only output was curl (22)', () => {
    const call = {
      source: 'shell_fetch' as const,
      query:
        '/bin/bash -lc "curl -fsSL https://hookdeck.com/docs/api/connections.md | sed -n \'1,260p\'"',
      pages: [{ url: 'https://hookdeck.com/docs/api/connections.md' }],
      hasContent: true,
      resultChars: 49,
    };
    expect(inferredLegacyHttpError(call)).toBe(true);
    expect(docsReach(call)).toBe('error');
  });

  it('leaves an unflagged curl of the same size alone, since its output is not known to be an error', () => {
    expect(
      inferredLegacyHttpError({
        source: 'shell_fetch',
        query: 'curl -s https://hookdeck.com/docs/x.md | grep y',
        pages: [{ url: 'https://hookdeck.com/docs/x.md' }],
        resultChars: 49,
      })
    ).toBe(false);
  });

  it('defers to a recorded httpError rather than guessing', () => {
    expect(
      inferredLegacyHttpError({
        source: 'web_fetch',
        resultChars: 215,
        httpError: 403,
      })
    ).toBe(false);
  });

  it('never infers on a fresh row, whose null httpError says the check ran', () => {
    const call = {
      source: 'web_fetch' as const,
      pages: [{ url: 'https://hookdeck.com/docs/x' }],
      hasContent: true,
      resultChars: 215,
      httpError: null,
    };
    expect(inferredLegacyHttpError(call)).toBe(false);
    expect(docsReach(call)).toBe('read');
  });

  it('reads a real 215-character page fetched today as read, and the same size on a legacy row as error', () => {
    // The reviewer's reproduction: a successful fetch has no status to record,
    // so without the null marker its length alone would call it an error.
    const page = `# Short page\n\n${'x'.repeat(215 - '# Short page\n\n'.length)}`;
    expect(page).toHaveLength(215);
    const { calls } = buildDocsResult([
      {
        endpoint: 'WebFetch',
        name: 'web_fetch',
        url: 'https://hookdeck.com/docs/short',
        body: {},
        result: page,
        ts: 0,
      },
    ]);
    expect(calls[0].resultChars).toBe(215);
    expect(calls[0].httpError).toBeNull();
    expect(docsReach(calls[0])).toBe('read');

    // The same call as exported before the check existed: no httpError key.
    const { httpError: _dropped, ...legacy } = calls[0];
    expect('httpError' in legacy).toBe(false);
    expect(docsReach(legacy)).toBe('error');
  });

  it('keeps the null marker through the export schema and JSON, which is how a published row reaches the reporter', () => {
    const { calls } = buildDocsResult([
      {
        endpoint: 'WebFetch',
        name: 'web_fetch',
        url: 'https://hookdeck.com/docs/short',
        body: {},
        result: 'y'.repeat(215),
        ts: 0,
      },
    ]);
    // The exporter whitelists each row through the schema, and a plain
    // `z.object` strips keys it does not list, so the marker has to survive it.
    const published = docsCallSchema.parse(
      JSON.parse(JSON.stringify(calls[0]))
    );
    expect(published.httpError).toBeNull();
    expect(docsReach(published)).toBe('read');
  });
});

/**
 * The emitter and the classifier are two halves of one contract: the shapes
 * below are copied from real tool calls in the raw results behind
 * `results/latest.json`, fed through `buildDocsResult`, and classified. A change
 * to either half that breaks the pair fails here rather than in a published
 * number.
 */
describe('buildDocsResult → docsReach', () => {
  function classify(call: ToolCallRecord) {
    const { calls } = buildDocsResult([call]);
    expect(calls).toHaveLength(1);
    return { call: calls[0], reach: docsReach(calls[0]) };
  }

  it("classifies Claude Code's WebFetch 404 stub as error, keeping the status and the url it guessed", () => {
    const { call, reach } = classify({
      endpoint: 'WebFetch',
      name: 'web_fetch',
      url: 'https://hookdeck.com/docs/retry',
      body: { prompt: 'How do retries work?' },
      result:
        'The server returned HTTP 404 Not Found.\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.',
      ts: 0,
    });
    expect(reach).toBe('error');
    expect(call.httpError).toBe(404);
    expect(call.resultChars).toBe(215);
    expect(call.pages).toEqual([{ url: 'https://hookdeck.com/docs/retry' }]);
  });

  it('recognises the WebFetch stub for a status other than 404', () => {
    const { call, reach } = classify({
      endpoint: 'WebFetch',
      name: 'web_fetch',
      url: 'https://hookdeck.com/docs/private',
      body: {},
      result:
        'The server returned HTTP 403 Forbidden.\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.',
      ts: 0,
    });
    expect(reach).toBe('error');
    expect(call.httpError).toBe(403);
  });

  it('keeps a real WebFetch page as read, even when it quotes a status', () => {
    const { call, reach } = classify({
      endpoint: 'WebFetch',
      name: 'web_fetch',
      url: 'https://hookdeck.com/docs/destinations',
      body: { prompt: 'What does a 404 do?' },
      result:
        'A destination that returns HTTP 404 Not Found is treated as a failed attempt and retried according to the retry rule.',
      ts: 0,
    });
    expect(reach).toBe('read');
    expect(call.httpError).toBeNull();
  });

  it("classifies Claude Code's WebSearch on a url-shaped query as hits, from its hit list", () => {
    const { call, reach } = classify({
      endpoint: 'WebSearch',
      name: 'web_search',
      body: { query: 'https://hookdeck.com/docs/retries' },
      result:
        'Web search results for query: "https://hookdeck.com/docs/retries"\n\n' +
        'Links: [{"title":"Retries | Hookdeck","url":"https://hookdeck.com/docs/retries"}]\n\nSummary.',
      ts: 0,
    });
    expect(reach).toBe('hits');
    expect(call.hasContent).toBe(false);
    expect(call.pages).toEqual([
      { url: 'https://hookdeck.com/docs/retries', title: 'Retries | Hookdeck' },
    ]);
  });

  it("classifies Codex's hosted search as unobserved", () => {
    const { reach } = classify({
      endpoint: 'web_search',
      name: 'web_search',
      body: {
        query: 'site:hookdeck.com/docs sources ElevenLabs Hookdeck',
        action: { type: 'search' },
      },
      ts: 0,
    });
    expect(reach).toBe('unobserved');
  });

  it("classifies Codex's url-shaped search with no result as unobserved", () => {
    const { reach } = classify({
      endpoint: 'web_search',
      name: 'web_search',
      body: { query: 'https://hookdeck.com/docs/outpost/llms.txt' },
      ts: 0,
    });
    expect(reach).toBe('unobserved');
  });

  it('classifies a piped curl -f that hit curl (22) as error, keeping the status', () => {
    const command =
      '/bin/bash -lc "curl -fsSL https://hookdeck.com/docs/api/connections.md | sed -n \'1,260p\'"';
    const { call, reach } = classify({
      endpoint: 'command_execution',
      name: 'shell',
      command,
      body: { command },
      result: 'curl: (22) The requested URL returned error: 404\n',
      ts: 0,
    });
    expect(reach).toBe('error');
    expect(call.httpError).toBe(404);
    expect(call.resultChars).toBe(49);
  });

  it('keeps a shell fetch that printed a page alongside a curl (22) as read, since it cannot be split per url', () => {
    const command =
      'curl -fsSL https://hookdeck.com/docs/a.md; curl -fsSL https://hookdeck.com/docs/b.md';
    const { call, reach } = classify({
      endpoint: 'command_execution',
      name: 'shell',
      command,
      body: { command },
      result:
        '# Page A\n\nReal content.\ncurl: (22) The requested URL returned error: 404\n',
      ts: 0,
    });
    expect(reach).toBe('read');
    expect(call.httpError).toBeNull();
  });
});
