/**
 * Codex runner. Headless via `codex exec --json` (newline-delimited thread/turn/
 * item events on stdout; see ./parser.ts). Like Claude Code, it runs in
 * both modes: the sandbox carries its shell/file tools in either case, and tools
 * mode just drops the Supabase CLI + local stack so Supabase access goes through
 * MCP (`~/.codex/config.toml`). Runs under `--dangerously-bypass-approvals-and-
 * sandbox` — the eval sandbox is the isolation boundary.
 */

import type { ChatModel } from 'openai/resources/shared';
import type { McpServerConfig } from '../../index.js';
import { parseJsonlRecords } from '../../json.js';
import type { AgentRunner } from '../types.js';
import {
  npmGlobalBin,
  npmInstallGlobal,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from '../shared.js';

// ChatModel is a closed union; widen so newer/codex-specific ids still type.
export type CodexModel = ChatModel | (string & {});

const CODEX_CONFIG_PATH = '"$HOME/.codex/config.toml"';

export const codexRunner: AgentRunner<CodexModel> = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  cliPackage: '@openai/codex',
  // Pinned: Codex's --json event schema evolves; bump deliberately and re-check
  // the parser. See ./parser.ts.
  defaultCliVersion: '0.138.0',
  defaultModel: 'gpt-5.4',

  async install(sandbox, version, apiKey) {
    await npmInstallGlobal(
      sandbox,
      `${this.cliPackage}@${version}`,
      this.displayName
    );
    // Persist API-key auth to ~/.codex/auth.json (read the key from stdin so it
    // never lands in argv or the process table).
    const codex = npmGlobalBin('codex');
    const login = await sandbox.exec(
      `printenv OPENAI_API_KEY | ${codex} login --with-api-key`,
      {
        env: { OPENAI_API_KEY: apiKey },
      }
    );
    if (!login.ok) {
      throw new Error(`Codex login failed: ${login.stderr || login.stdout}`);
    }
  },

  async exec({
    sandbox,
    model,
    apiKey,
    systemPromptPath,
    userPromptPath,
    mcpServers,
    reasoningEffort,
    timeoutSec,
  }) {
    const codex = npmGlobalBin('codex');
    if (Object.keys(mcpServers).length > 0) {
      await sandbox.exec(`mkdir -p "$HOME/.codex"`);
      await writeSandboxFile(
        sandbox,
        CODEX_CONFIG_PATH,
        buildCodexConfig(mcpServers)
      );
    }

    const flags = [
      'exec',
      '--json',
      // The workspace may not be a git repo; don't refuse to run.
      '--skip-git-repo-check',
      // The sandbox is the isolation boundary — let Codex run commands freely.
      '--dangerously-bypass-approvals-and-sandbox',
      `-m ${shellQuote(model)}`,
      // Reasoning effort via config override; omitted leaves Codex's default.
      // The value is parsed as TOML, so pass it as a quoted TOML string.
      ...(reasoningEffort
        ? [`-c ${shellQuote(`model_reasoning_effort="${reasoningEffort}"`)}`]
        : []),
      // Read the prompt from stdin.
      '-',
    ].join(' ');

    // Codex has no system-prompt flag; prepend the system prompt to the task,
    // both staged as files, fed on stdin.
    // No `OPENAI_API_KEY` here, deliberately. `install` above already persisted
    // auth to `~/.codex/auth.json`, so passing the key again only adds it to the
    // agent's own environment — and an agent exploring an unfamiliar sandbox
    // runs `env`, which put a live provider key into the transcript we upload
    // from a public repository. See #20.
    //
    // This narrows exposure rather than removing it: the key is still present
    // during `install`, and `HOOKDECK_API_KEY` has to stay because the task
    // genuinely needs it. Redaction remains the control for those.
    const command = await sandbox.exec(
      `{ cat ${systemPromptPath}; printf '\\n\\n'; cat ${userPromptPath}; } | ${codex} ${flags}`,
      { timeoutMs: timeoutSec * 1000 }
    );
    return { command, raw: command.stdout };
  },

  deriveUsage(raw) {
    // Codex reports token counts on `turn.completed`, not a cost, so the cost
    // stays undefined rather than guessed.
    //
    // Pricing these counts is not the small job it looks. `gpt-5.6` resolves to
    // one of several variants, each priced differently, each with a short and a
    // long context tier, and cached input runs about a tenth of fresh input. A
    // measured run reported 361k input tokens against 4k output: on an agentic
    // loop that is mostly the conversation being resent, so almost all of it
    // should price as cache hits. Pricing it as fresh input would overstate the
    // run by roughly an order of magnitude and publish a confident wrong number
    // next to Claude Code's real one.
    //
    // `cached_input_tokens` is read here so the next run tells us whether the
    // CLI separates it out. That is the missing input for a price table.
    if (!raw) return undefined;
    let input: number | undefined;
    let output: number | undefined;
    let cached: number | undefined;
    for (const line of raw.split('\n')) {
      if (!line.includes('turn.completed')) continue;
      try {
        const usage = (JSON.parse(line) as { usage?: Record<string, unknown> })
          .usage;
        if (typeof usage?.input_tokens === 'number') input = usage.input_tokens;
        if (typeof usage?.output_tokens === 'number')
          output = usage.output_tokens;
        // Name unconfirmed against a live payload; both spellings seen in the wild.
        const cachedRaw =
          usage?.cached_input_tokens ?? usage?.cache_read_tokens;
        if (typeof cachedRaw === 'number') cached = cachedRaw;
      } catch {
        // a non-JSON line is not a usage record
      }
    }
    if (input === undefined && output === undefined) return undefined;
    return {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
    };
  },

  deriveStopReason(raw, command) {
    // `codex exec` exits 0 even when a turn fails, so the process result alone
    // can't tell a clean stop from an agent-level failure. Trust the terminal
    // stream event: `turn.completed` = clean stop, `turn.failed`/`error` =
    // failure. Only when there's no terminal event (crash / kill / timeout) do
    // we fall back to the process-exit heuristic.
    switch (terminalOutcome(raw)) {
      case 'completed':
        return 'stop';
      case 'failed':
        return 'error';
      default:
        return processStopReason(command);
    }
  },
};

/** The last turn-level outcome in a `codex exec --json` stream, if any. */
function terminalOutcome(
  raw: string | undefined
): 'completed' | 'failed' | undefined {
  if (!raw) return undefined;
  const { records } = parseJsonlRecords(raw);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const type = records[i].type;
    if (type === 'turn.completed') return 'completed';
    if (type === 'turn.failed' || type === 'error') return 'failed';
  }
  return undefined;
}

/**
 * Codex's `~/.codex/config.toml` MCP schema:
 *   [mcp_servers.<name>]
 *   command = "npx"
 *   args = ["…"]
 *   env = { KEY = "val" }
 */
function buildCodexConfig(servers: Record<string, McpServerConfig>): string {
  const blocks: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const lines = [
      `[mcp_servers.${tomlKey(name)}]`,
      `command = ${tomlString(server.command)}`,
    ];
    if (server.args?.length) {
      lines.push(`args = [${server.args.map(tomlString).join(', ')}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      const entries = Object.entries(server.env)
        .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
        .join(', ');
      lines.push(`env = { ${entries} }`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

/** TOML basic string — JSON string escaping is a valid subset. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A bare TOML key if safe, else a quoted key. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
