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
