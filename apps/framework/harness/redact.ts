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
 * Two layers, because each covers the other's blind spot:
 *
 * 1. **By value.** Every environment variable whose *name* looks like a secret
 *    contributes its value. Exact, and it does not care what the value looks
 *    like, which matters because provider key formats are not ours to predict.
 * 2. **By shape.** Known credential patterns, for a secret that reached the
 *    sandbox without passing through an env var we can see: a key pasted into a
 *    seed file, or one an agent read out of a config it created.
 *
 * Neither layer is sufficient alone and neither is a substitute for keeping
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
 * Replace every known secret value, then every known secret shape.
 *
 * The marker names what was removed so a transcript stays readable: an agent
 * that failed *because* it had no credential looks identical to one that had a
 * redacted credential unless the artifact says which.
 */
export function redactText(
  text: string,
  secrets: SecretValue[] = secretValues()
): string {
  let out = text;

  for (const { name, value } of secrets) {
    out = out.replace(
      new RegExp(escapeRegExp(value), 'g'),
      `<redacted:${name}>`
    );
  }

  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, `<redacted:${name}-key>`);
  }

  return out;
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
