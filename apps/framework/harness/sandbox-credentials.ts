/**
 * Credentials the agent's sandbox created that the harness never injected.
 *
 * The harness redacts by value everything it puts into the sandbox, because it
 * knows those values. It does not know the key `hookdeck ci` mints: the CLI
 * exchanges the project key it was given for a CLI key of its own and writes
 * that to its config file, and an agent checking which project it is pointed
 * at reasonably `cat`s the file. The key then sits in the transcript and in no
 * env var this process can see.
 *
 * So after the agent has run, and before the container is torn down, read the
 * CLI's config files back out and treat every credential in them as a secret
 * for the rest of the cell. Each attempt has its own container and mints its
 * own key, so this runs per attempt and the values accumulate across them.
 *
 * Where the Hookdeck CLI (pinned in `packages/sandbox/src/image.ts`) keeps its
 * config, from its `getConfigPath`: `--hookdeck-config <path>`, then
 * `$HOOKDECK_CONFIG_FILE`, then `./.hookdeck/config.toml` in the working
 * directory, then `$XDG_CONFIG_HOME/hookdeck/config.toml`, defaulting to
 * `~/.config/hookdeck/config.toml`. The search below covers all but an
 * arbitrary `--hookdeck-config` path, which `redact.ts`'s assignment layer is
 * the backstop for. A profile carries `api_key` and, for a guest account,
 * `guest_url`, which is a link that claims the account.
 */
import type { AgentSandbox } from '@hookdeck-evals/core';
import type { SecretValue } from './redact.js';

/** Config keys whose value is a credential. */
const CREDENTIAL_KEY = /(?:key|token|secret|password)$|^guest_url$/i;

/** Shorter than the CLI's own minimum key length; not a credential. */
const MIN_LENGTH = 8;

/**
 * Lists every Hookdeck CLI config file in the places the CLI looks, then
 * prints them. Run as the agent user, whose `HOME` the CLI wrote under, with
 * the workspace as the working directory: a project-local `.hookdeck/` can be
 * in any subdirectory the agent ran the CLI from. `node_modules` and `.git`
 * are pruned so a workspace with a dependency tree does not turn this into a
 * crawl.
 */
export const DISCOVER_COMMAND = [
  '{',
  '  for f in "$HOME/.config/hookdeck/config.toml" "${XDG_CONFIG_HOME:-/nonexistent}/hookdeck/config.toml" "${HOOKDECK_CONFIG_FILE:-/nonexistent}"; do',
  '    [ -f "$f" ] && printf "%s\\n" "$f";',
  '  done;',
  '  find "$HOME" "$PWD" -maxdepth 6 \\( -name node_modules -o -name .git \\) -prune -o -type f -name config.toml -path "*hookdeck*" -print 2>/dev/null;',
  '} | sort -u | while IFS= read -r f; do cat "$f" 2>/dev/null; printf "\\n"; done',
].join('\n');

/**
 * Every credential assignment in TOML text, named for where it came from.
 *
 * A line parser rather than a TOML library: the CLI writes flat `key = 'value'`
 * lines under `[profile]` tables, and a parser that rejected a file the agent
 * had half-edited would return nothing at exactly the moment it mattered.
 */
export function credentialsFromConfigText(text: string): SecretValue[] {
  const out: SecretValue[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (!CREDENTIAL_KEY.test(key)) continue;
    const value = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (value.length < MIN_LENGTH || seen.has(value)) continue;
    seen.add(value);
    out.push({ name: `hookdeck-cli-config:${key}`, value });
  }
  return out;
}

/**
 * Read the sandbox's Hookdeck CLI config and return the credentials in it.
 *
 * Never throws. Discovery failing must not fail a cell the agent completed,
 * and the assignment layer in `redact.ts` still covers a config that was
 * printed. A failure is reported on stderr directly, because the runner stubs
 * `console.error` for the whole run.
 */
export async function discoverSandboxCredentials(
  sandbox: AgentSandbox
): Promise<SecretValue[]> {
  try {
    const result = await sandbox.exec(DISCOVER_COMMAND, { timeoutMs: 30_000 });
    if (!result.ok) {
      // Exit code only: stdout and stderr may hold the very values being
      // looked for, and this goes to a public job log. Whatever was printed
      // before the failure is still used.
      process.stderr.write(
        `reading the sandbox's Hookdeck CLI config for redaction did not complete ` +
          `(exit ${result.exitCode ?? 'none, likely a timeout'}); ` +
          'redacting with what was read, plus the assignment layer\n'
      );
    }
    return credentialsFromConfigText(result.stdout);
  } catch (error) {
    process.stderr.write(
      `could not read the sandbox's Hookdeck CLI config for redaction: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return [];
  }
}
