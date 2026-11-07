/**
 * What `eval-refresh.yml` reads and does, parsed from the workflow itself.
 *
 * The workflow is the source of truth for which secrets and variables a run
 * uses and for how its provider preflight is made, so this reads them out of
 * the YAML rather than keeping a second list. A list kept here would be the
 * mistake AGENTS.md describes: `OUTPOST_API_KEY` was documented as a secret
 * before it existed, and the first full matrix scored `outpost-001` as six
 * agent failures because of it.
 *
 * Text parsing rather than a YAML library, because what is wanted is inside
 * shell scripts in `run:` blocks, which YAML returns as one opaque string
 * anyway. The tests run these parsers against the real workflow, so a change to
 * its shape fails a test rather than quietly emptying a list.
 */

/** Lines that are not YAML comments. A `secrets.X` in prose is not a read. */
function codeLines(yaml: string): string[] {
  return yaml.split('\n').filter((line) => !/^\s*#/.test(line));
}

function referenced(yaml: string, namespace: 'secrets' | 'vars'): string[] {
  const out = new Set<string>();
  const re = new RegExp(`\\b${namespace}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  for (const line of codeLines(yaml)) {
    for (const m of line.matchAll(re)) out.add(m[1] as string);
  }
  return [...out].sort();
}

/**
 * Every `secrets.NAME` the workflow reads. `GITHUB_TOKEN` is excluded: GitHub
 * provides it, so it never appears in `gh secret list` and is never missing.
 */
export function workflowSecrets(yaml: string): string[] {
  return referenced(yaml, 'secrets').filter((s) => s !== 'GITHUB_TOKEN');
}

/** Every `vars.NAME` the workflow reads. */
export function workflowVariables(yaml: string): string[] {
  return referenced(yaml, 'vars');
}

export interface ProviderProbe {
  /** The API host, which is how the two probes are told apart. */
  host: string;
  provider: 'openai' | 'anthropic' | 'unknown';
  url: string;
  /** Header templates, with `${VAR}` left in for the caller to fill. */
  headers: Record<string, string>;
  body: string;
  model?: string;
}

/** The `run:` script of a step, by its exact name. */
export function stepScript(yaml: string, stepName: string): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex(
    (l) =>
      l.trim() === `- name: ${stepName}` || l.trim() === `name: ${stepName}`
  );
  if (start < 0) return undefined;
  const indent = (lines[start] as string).search(/\S/);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineIndent = line.search(/\S/);
    // The next step at the same indent, or the end of this job, ends the step.
    if (lineIndent >= 0 && lineIndent <= indent && line.trim() !== '') break;
    out.push(line);
  }
  return out.join('\n');
}

export const PROVIDER_PREFLIGHT_STEP = 'Check provider keys are live';

/**
 * The provider requests the workflow's preflight makes, so a local preflight
 * makes the same ones: same endpoint, same model, same body.
 *
 * #42 asks for this check to run locally and suggests moving it into the run
 * path. Until it moves, the workflow holds the one copy, and this reads it.
 */
export function providerProbes(yaml: string): ProviderProbe[] {
  const script = stepScript(yaml, PROVIDER_PREFLIGHT_STEP);
  if (!script) return [];
  const probes: ProviderProbe[] = [];
  // Each probe is one `curl ... || echo 000` invocation, continued with `\`.
  const invocations = codeLines(script)
    .join('\n')
    .split(/\bcurl\b/)
    .slice(1);
  for (const invocation of invocations) {
    const text = invocation.split('|| echo')[0] ?? invocation;
    const url = /-X\s+POST\s+(https:\/\/[^\s\\"']+)/.exec(text)?.[1];
    if (!url) continue;
    const headers: Record<string, string> = {};
    for (const m of text.matchAll(/-H\s+"([^"]+)"/g)) {
      const raw = m[1] as string;
      const colon = raw.indexOf(':');
      if (colon < 0) continue;
      headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
    const body = /-d\s+'([^']*)'/.exec(text)?.[1] ?? '';
    let model: string | undefined;
    try {
      model = (JSON.parse(body) as { model?: string }).model;
    } catch {
      model = undefined;
    }
    const host = new URL(url).host;
    probes.push({
      host,
      provider: host.endsWith('openai.com')
        ? 'openai'
        : host.endsWith('anthropic.com')
          ? 'anthropic'
          : 'unknown',
      url,
      headers,
      body,
      model,
    });
  }
  return probes;
}

/**
 * Fill `${VAR}` placeholders from the environment. Returns the names that were
 * missing rather than sending a request with an empty key, which a provider
 * answers with a 401 that reads like a revoked key.
 */
export function fillTemplate(
  template: string,
  env: Record<string, string | undefined>
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => {
      const v = env[name];
      if (!v) {
        missing.push(name);
        return '';
      }
      return v;
    }
  );
  return { value, missing };
}

/**
 * The pattern the workflow uses to recognise a provider refusing requests
 * (credit, quota, auth), so a failed probe is described in the same words the
 * run would use to cancel itself.
 */
export function refusalPattern(yaml: string): RegExp | undefined {
  const m = /refusals="([^"]+)"/.exec(yaml);
  return m ? new RegExp(m[1] as string, 'i') : undefined;
}

/** Statuses `gh run list` reports for a run that has not finished. */
const UNFINISHED = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested',
]);

export function unfinishedRuns<T extends { status?: string }>(runs: T[]): T[] {
  return runs.filter((r) => UNFINISHED.has(String(r.status)));
}
