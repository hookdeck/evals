/**
 * Hookdeck docs URLs in skill files.
 *
 * A dead link in a skill is worse than none: an agent that follows it gets a
 * 404 and falls back to search, a guess or memory (#104, #100). The check is
 * every `hookdeck.com/docs` URL in the pinned skills, because those are the
 * links we can fix; third-party links are someone else's to keep alive.
 */

const DOCS_URL = /https?:\/\/(?:www\.)?hookdeck\.com\/docs[^\s)\]>"'`<|]*/g;

/** Punctuation that ends a sentence, not a URL. */
const TRAILING = /[.,;:!?*_]+$/;

/**
 * A root-relative docs path, as skills write them in tables: `` `/docs/x.md` ``
 * or `[x](/docs/x.md)`. #104's dead links in `referencing-docs.md` are this
 * form, and the file tells the agent they are hookdeck.com paths, so they are
 * checked as such.
 */
const RELATIVE_DOCS = /`(\/docs\/[^`\s]*)`|\]\((\/docs\/[^)\s]*)\)/g;

export const DOCS_ORIGIN = 'https://hookdeck.com';

/**
 * Every docs URL in the text, absolute or root-relative, in order of first
 * appearance, deduplicated. Relative paths come back absolute.
 */
export function extractDocsUrls(text: string): string[] {
  const found: Array<{ index: number; url: string }> = [];
  for (const m of text.matchAll(DOCS_URL)) {
    found.push({ index: m.index ?? 0, url: m[0].replace(TRAILING, '') });
  }
  for (const m of text.matchAll(RELATIVE_DOCS)) {
    const path = (m[1] ?? m[2] ?? '').replace(TRAILING, '');
    found.push({ index: m.index ?? 0, url: `${DOCS_ORIGIN}${path}` });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { url } of found) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** The URL a request goes to: a fragment is never sent to the server. */
export function fetchableUrl(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

export interface LinkOccurrence {
  url: string;
  files: string[];
}

/** Group URLs across files by what is actually fetched. */
export function collectLinks(
  files: Array<{ path: string; text: string }>
): LinkOccurrence[] {
  const byUrl = new Map<string, Set<string>>();
  for (const file of files) {
    for (const url of extractDocsUrls(file.text)) {
      const key = fetchableUrl(url);
      const set = byUrl.get(key) ?? new Set<string>();
      set.add(file.path);
      byUrl.set(key, set);
    }
  }
  return [...byUrl]
    .map(([url, set]) => ({ url, files: [...set].sort() }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Which skills a list of changed paths touches, for the skills-pin decision.
 * `skills/<name>/...` in hookdeck/agent-skills.
 */
export function changedSkills(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const m = /^skills\/([^/]+)\//.exec(p);
    if (m) out.add(m[1] as string);
  }
  return [...out].sort();
}

export interface LinkCheck {
  url: string;
  /** The final status, after redirects. 0 when nothing answered. */
  status: number;
  /** Where a redirect ended, when it did not end at `url`. */
  finalUrl?: string;
}

/**
 * Fetch a docs URL the way an agent would, following redirects.
 *
 * A redirect that ends in 200 still works for an agent, but the skill points
 * at a moved page, so the caller reports the final URL. A 429 is the site
 * asking us to slow down, not a dead link: wait and try once more before
 * calling it a failure. A dropped connection gets one retry too.
 */
export async function checkLink(
  fetchFn: typeof fetch,
  url: string,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<LinkCheck> {
  let last: LinkCheck = { url, status: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      continue;
    }
    await res.body?.cancel().catch(() => undefined);
    // A trailing-slash redirect is the site's canonical form, not a moved page.
    const bare = (u: string) => u.replace(/\/+$/, '');
    const finalUrl =
      res.redirected && res.url && bare(res.url) !== bare(url)
        ? res.url
        : undefined;
    last = { url, status: res.status, ...(finalUrl ? { finalUrl } : {}) };
    if (res.status !== 429) return last;
    if (attempt === 0) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 30) * 1000
          : 5_000
      );
    }
  }
  return last;
}
