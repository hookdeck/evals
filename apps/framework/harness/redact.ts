/**
 * Strip secrets out of a run artifact before it is written.
 *
 * Agents explore. A perfectly reasonable first move in an unfamiliar sandbox is
 * `env`, or `env | grep -i stripe`, and the whole environment then lands in the
 * transcript we capture and upload. On 18 August 2026 a scan of 110 artifacts
 * found live values for `HOOKDECK_WEBHOOK_SECRET` (65 files),
 * `HOOKDECK_API_KEY` (46), `OUTPOST_API_KEY` (3) and `OPENAI_API_KEY` (2),
 * sitting in artifacts on a public repository. Every GitHub account could
 * download them.
 *
 * This runs on the serialized artifact rather than on the object graph. A
 * transcript is deeply nested and shaped differently per provider, so walking it
 * means keeping a list of the fields that might hold command output, and being
 * wrong about that list is how a secret escapes. Redacting the finished string
 * has no such list: if the value is anywhere in the file, it goes.
 *
 * Three layers, because each covers another's blind spot:
 *
 * 1. **By value.** Every environment variable whose *name* looks like a secret
 *    contributes its value. Exact, and it does not care what the value looks
 *    like, which matters because provider key formats are not ours to predict.
 * 2. **By shape.** Known credential patterns, for a secret that reached the
 *    sandbox without passing through an env var we can see: a key pasted into a
 *    seed file, or one an agent read out of a config it created.
 * 3. **By assignment.** A credential the harness never held at all: the key
 *    `hookdeck ci` mints inside the sandbox and writes to
 *    `~/.config/hookdeck/config.toml`, which an agent then `cat`s. It has no
 *    vendor prefix — the CLI validates only that a key is at least twelve
 *    characters — so there is no shape to match, and it is in no env var this
 *    process can see. What it does have is context: `api_key = '…'`. Any value
 *    assigned to a name that marks it as a credential is collected and then
 *    redacted *everywhere* in the artifact, so the same key pasted bare into a
 *    later `curl` goes too.
 *
 * The harness also reads the CLI's config files out of each sandbox before it
 * is torn down and adds what it finds to the by-value layer
 * (`sandbox-credentials.ts`), which catches a minted key however it was later
 * printed. Layer 3 is the backstop for when that read fails or the agent put a
 * key somewhere it does not look.
 *
 * No layer is sufficient alone and none is a substitute for keeping
 * secrets out of the sandbox in the first place. An agent configuring a Hookdeck
 * integration has no use for `OPENAI_API_KEY`, and the narrower that environment
 * gets, the less this file has to catch.
 */

/** Env vars whose name marks the value as a credential. */
const SECRET_NAME = /(_KEY|_SECRET|_TOKEN|_PASSWORD)$/;

/**
 * Values this short are not credentials, and redacting them would corrupt the
 * artifact: an env var set to `1` or `true` would blank every digit in the file.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Credential shapes, as a backstop for values that never appeared in an env var
 * this process can see. Deliberately conservative: each anchors on a vendor
 * prefix, so it cannot match ordinary prose in a transcript.
 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'github', pattern: /\bgh[psoru]_[A-Za-z0-9]{20,}/g },
  { name: 'aws', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
];

/**
 * Credential-bearing text characters. No `.`, `$`, `{`, `<` or quotes, so
 * `process.env.HOOKDECK_API_KEY`, `${HOOKDECK_API_KEY}`, `$KEY` and a redaction
 * marker are never mistaken for a value.
 */
const VALUE = '[A-Za-z0-9_\\-+/=]{16,}';
/** An optional quote, JSON-escaped any number of times (`'`, `"`, `\"`). */
const QUOTE = `(?:\\\\*["'])?`;

/**
 * A value assigned to a name that marks it as a credential.
 *
 * Matched against the *serialized* artifact, so a TOML line the agent `cat`ed
 * arrives as `api_key = '…'` or `api_key = \"…\"`. The value is the second
 * group; it is collected and replaced as a literal, never by rewriting the
 * match. Its character class holds no quote or backslash, so a replacement
 * cannot break the JSON it sits in. Each pattern anchors on the *end* of the
 * name, with no unbounded prefix, so a long identifier-like run cannot make
 * the scan quadratic.
 *
 * - `=` (TOML, INI, env, shell): any name ending in key/token/secret/password.
 *   `api_key`, `HOOKDECK_API_KEY`, `client_secret`, `access_token`.
 * - `:` (JSON, YAML): narrower, because `"key": "x-hookdeck-signature"` is a
 *   header name and not a credential. Plain `key` is left out.
 * - `--flag value`: `hookdeck ci --api-key …`.
 * - `Bearer …`: a curl the agent wrote with the literal key in it.
 */
const ASSIGNMENT_PATTERNS: RegExp[] = [
  new RegExp(
    `((?:key|token|secret|password)${QUOTE}[ \\t]*=[ \\t]*${QUOTE})(${VALUE})`,
    'gi'
  ),
  new RegExp(
    `((?:api[_-]?key|secret|token|password)${QUOTE}[ \\t]*:[ \\t]*${QUOTE})(${VALUE})`,
    'gi'
  ),
  new RegExp(
    `(--[A-Za-z0-9-]{0,64}(?:key|token|secret|password)(?:[ \\t]+|=)${QUOTE})(${VALUE})`,
    'gi'
  ),
  // `.` and `~` are allowed here because a bearer token may be a JWT.
  /(\bBearer[ \t]+)([A-Za-z0-9_\-+/=.~]{16,})/g,
];

/**
 * Whether an assigned value is plausibly a credential rather than a word.
 *
 * Requiring a letter and a digit keeps `your_api_key_here` and
 * `REPLACE_WITH_YOUR_SECRET` readable. A random 50-character key with no digit
 * is about a one-in-ten-million event, and the by-value layer still has it.
 */
function looksLikeCredential(value: string): boolean {
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/** The marker name for a value found by assignment rather than by name. */
export const ASSIGNED_CREDENTIAL = 'assigned-credential';

export interface SecretValue {
  name: string;
  value: string;
}

/**
 * The secrets visible to this process, newest-longest first.
 *
 * Sorted by length descending so that when one secret is a prefix of another,
 * the longer match is replaced first. Replacing the shorter one first would
 * leave the remaining tail of the longer secret in the file, which reads as
 * redacted while still leaking most of the value.
 */
export function secretValues(
  env: NodeJS.ProcessEnv = process.env
): SecretValue[] {
  return Object.entries(env)
    .filter(([name, value]) => {
      if (!value || value.length < MIN_SECRET_LENGTH) return false;
      return SECRET_NAME.test(name);
    })
    .map(([name, value]) => ({ name, value: value as string }))
    .sort((a, b) => b.value.length - a.value.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Values assigned to a credential-marking name anywhere in `text`, longest
 * first. Exported for the tests.
 */
export function assignedCredentialValues(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of ASSIGNMENT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[2];
      if (looksLikeCredential(value)) found.add(value);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** Longest first and deduplicated by value, whatever order the caller used. */
function orderSecrets(secrets: SecretValue[]): SecretValue[] {
  const seen = new Set<string>();
  return [...secrets]
    .filter(({ value }) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.value.length - a.value.length)
    .filter(({ value }) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function redactCounting(
  text: string,
  secrets: SecretValue[]
): { text: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const replaceAll = (
    source: string,
    pattern: RegExp,
    name: string,
    marker = name
  ) =>
    source.replace(pattern, () => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return `<redacted:${marker}>`;
    });

  let out = text;

  // 1. By value: the environment's, and whatever the harness read out of the
  //    sandbox before tearing it down.
  for (const { name, value } of orderSecrets(secrets)) {
    out = replaceAll(out, new RegExp(escapeRegExp(value), 'g'), name);
  }

  // 2. By shape. Before assignment, so `OPENAI_API_KEY=sk-…` is labelled as the
  //    vendor key it is rather than as a generic assignment.
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = replaceAll(out, pattern, `${name}-key`);
  }

  // 3. By assignment. Harvested and then replaced as literals, so a key seen
  //    once in `api_key = '…'` is also removed where it later appears bare.
  //    Numbered by first appearance, so the transcript still shows whether
  //    two places held the same value: an agent that configured a source with
  //    the wrong secret is a failure this benchmark exists to catch, and one
  //    marker for every value would hide it.
  const assigned = assignedCredentialValues(out);
  const number = new Map(
    [...assigned]
      .sort((a, b) => out.indexOf(a) - out.indexOf(b))
      .map((value, i) => [value, i + 1])
  );
  for (const value of assigned) {
    out = replaceAll(
      out,
      new RegExp(escapeRegExp(value), 'g'),
      ASSIGNED_CREDENTIAL,
      `${ASSIGNED_CREDENTIAL}-${number.get(value)}`
    );
  }

  return { text: out, counts };
}

/**
 * Replace every known secret value, then every known secret shape, then every
 * value assigned to a credential-marking name.
 *
 * The marker names what was removed so a transcript stays readable: an agent
 * that failed *because* it had no credential looks identical to one that had a
 * redacted credential unless the artifact says which.
 */
export function redactText(
  text: string,
  secrets: SecretValue[] = secretValues()
): string {
  return redactCounting(text, secrets).text;
}

/**
 * What redaction would still remove from `text`, by kind and count.
 *
 * For checking a file that should already have been redacted: anything found
 * means a write path bypassed `serializeRedacted`, or a pattern has changed
 * since it ran. Names and counts only, so a caller can report a failure
 * without printing the credential it found.
 */
export function findUnredacted(
  text: string,
  secrets: SecretValue[] = secretValues()
): Array<{ name: string; count: number }> {
  return [...redactCounting(text, secrets).counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Serialize an artifact with secrets removed.
 *
 * Returns the JSON text to write. Redaction happens after serialization and the
 * result is re-parsed and re-serialized, so a redaction that broke the JSON
 * would throw here rather than producing a file nothing can read. That has not
 * happened, because the marker contains no character JSON escapes, but the
 * check is cheap and this is the last gate before a secret reaches disk.
 */
export function serializeRedacted(
  value: unknown,
  secrets: SecretValue[] = secretValues()
): string {
  const redacted = redactText(JSON.stringify(value, null, 2), secrets);
  return JSON.stringify(JSON.parse(redacted), null, 2);
}
