import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ToolName } from './transcript/types.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { openai } from '@ai-sdk/openai';
import {
  Output,
  generateText,
  stepCountIs,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import ts from 'typescript';
import { z } from 'zod';
import type {
  AgentHarnessId,
  CheckResult,
  EvalMetadata,
  EvalSuite,
  ExperimentDisplayMetadata,
  ExperimentSuite,
  ModelProvider,
  ReasoningEffortLevel,
} from './eval-metadata.js';
import { reasoningEffortSchema } from './eval-metadata.js';
import type { AgentMetadata, AgentSandbox } from './agents/types.js';
import { isRecord } from './json.js';

// Resolved lazily on first use, not at module load: `import.meta.resolve` is a
// load-time side effect that throws under bundler SSR transforms (e.g. vitest),
// which would break every importer of this module — including ones that never
// invoke the executor (the sandbox runtime only imports `supabaseMcpServer`).
let executorBinPath: string | undefined;
const execFileAsync = promisify(execFile);
export {
  EVAL_INTERFACES,
  EVAL_PRODUCTS,
  EVAL_SUITES,
  EVAL_STAGES,
  EXPERIMENT_SUITES,
  agentHarnessIdSchema,
  checkResultSchema,
  evalInterfaceSchema,
  evalMetadataSchema,
  evalProductSchema,
  evalResultSchema,
  evalStageSchema,
  evalSuiteSchema,
  experimentSuiteSchema,
  experimentDisplayMetadataSchema,
  modelProviderSchema,
  rawEvalResultSchema,
  reasoningEffortSchema,
  skillResultSchema,
  docsResultSchema,
  docsCallSchema,
  docsPageSourceSchema,
} from './eval-metadata.js';
export { parseEvalMarkdown } from './eval-markdown.js';
export { buildSkillResult } from './skill-results.js';
export {
  buildDocsResult,
  rehydrateTruncatedDocsResults,
} from './docs-results.js';
export type { DocsResultSandbox } from './docs-results.js';
export { createCliAgent } from './agents/engine.js';
export { claudeCodeAgent } from './agents/claude-code/index.js';
export { codexAgent } from './agents/codex/index.js';
export { opencodeAgent } from './agents/opencode/index.js';
export type {
  AgentMetadata,
  AgentSandbox,
  AgentRunner,
  RunnerExecArgs,
  RunnerExecResult,
  AgentDefinition,
} from './agents/types.js';
export { createParser, supportedParsers } from './agents/registry.js';
export { adaptTranscript } from './parsers/adapt.js';
export type { AdaptedTranscript } from './parsers/adapt.js';
export type { AgentTranscriptParser } from './parsers/types.js';
export type {
  ToolName,
  TranscriptEvent,
  ParsedTranscript,
} from './transcript/types.js';
export type {
  AgentHarnessId,
  CheckResult,
  EvalInterface,
  EvalMetadata,
  EvalProduct,
  EvalResult,
  EvalSuite,
  EvalStage,
  ExperimentDisplayMetadata,
  ExperimentSuite,
  ModelProvider,
  ParsedEvalMarkdown,
  ReasoningEffortLevel,
  SkillResult,
  DocsResult,
  DocsCall,
  DocsCallPage,
  DocsPageSource,
} from './eval-metadata.js';
export interface ScoreResult {
  passed: boolean;
  checks?: CheckResult[];
}

export type TranscriptPart =
  | {
      type: 'message';
      role: 'system' | 'user' | 'assistant';
      content: string;
    }
  | {
      type: 'tool_call';
      name: string;
      input: Record<string, unknown>;
      output?: unknown;
      error?: string;
    };

export type TranscriptSerializationOptions = {
  includeToolCallInputs?: boolean;
  includeToolCallOutputs?: boolean;
};

export interface JudgeInput {
  model?: Exclude<LanguageModel, string>;
  providerOptions?: AiSdkProviderOptions;
  input: string;
  rubric: string;
}

export interface JudgeResult {
  passed: boolean;
  notes?: string;
}

export interface ToolCallRecord {
  endpoint: string;
  body: Record<string, unknown>;
  /**
   * Normalized, agent-agnostic views of common args, when the agent's parser
   * extracted them (CLI agents). Let scorers inspect a call's file path / shell
   * command / URL without knowing the harness's raw arg keys.
   */
  path?: string;
  command?: string;
  url?: string;
  /** Canonical tool category, set by CLI agent parsers; unset for ai-sdk tools which have no normalization layer. */
  name?: ToolName;
  /** Skill names loaded by this call, when the harness can identify any. */
  loadedSkills?: string[];
  result?: unknown;
  error?: string;
  ts: number;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface VitestResult extends CommandResult {
  passed?: number;
  failed?: number;
  failures?: string[];
}

export interface ProjectResult {
  build: CommandResult;
  vitest?: VitestResult;
}
export interface ToolScoringContext {
  /** The Hookdeck project this run was scored against. */
  projectId: string;
  /**
   * When the project was acquired. Scorers MUST scope event and request
   * queries to this window: a fixed project accumulates history across runs
   * and events cannot be deleted through the API.
   */
  acquiredAt: Date;
  /** Authenticated call against the Hookdeck API, scoped to this project. */
  api: <T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ) => Promise<T>;
}

export interface ToolEvalContext extends ToolScoringContext {
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  agentReport?: string;
}
export type ToolScorer = (ctx: ToolEvalContext) => Promise<ScoreResult>;
export type AgentRunArgs = {
  systemPrompt: string;
  userPrompt: string;
  tools?: ToolSet;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Execution environment for CLI agents (Claude Code, Codex, …). In-process
   * agents like `aiSdkAgent` ignore it; CLI agents need it to run their binary,
   * edit the workspace, and read back their transcript. Provided by the
   * local-stack session, or by a bare sandbox the harness boots for tools mode.
   */
  sandbox?: AgentSandbox;
  timeoutSec: number;
};

export type AgentRunResult = {
  agentReport: string;
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  steps: number;
  stoppedReason: string;
};

export type AgentHarness = {
  id: AgentHarnessId;
  modelId: string;
  metadata: AgentMetadata;
  /**
   * True when the agent itself runs *inside* the sandbox — i.e. it brings its
   * own harness (loop + tools + MCP client) and needs a container to run in, as
   * every CLI agent does. In-process agents (`aiSdkAgent`) leave this false: the
   * framework drives their loop host-side, so in tools mode no sandbox is booted.
   * (In local-stack mode a sandbox always exists regardless, for the stack.)
   */
  runsInSandbox?: boolean;
  assertReady(): void;
  run(args: AgentRunArgs): Promise<AgentRunResult>;
};

/**
 * An agent skill to install into the sandbox: its name and the host directory
 * holding its SKILL.md (and any bundled reference files).
 */
export type SkillSource = { name: string; dir: string };
export type ExperimentConfig = {
  /** Named experiment suites this experiment belongs to. */
  suite?: ExperimentSuite[];
  agent: AgentHarness;
  runtime: EvalRuntime;
  skills: string[];
  /**
   * Skip running specific evals against this experiment, e.g. a `*-no-skills`
   * experiment skipping evals whose per-eval `skills` override is already
   * `[]` — running those would just duplicate what this experiment's own
   * empty skill list already covers.
   */
  skipEval?: (ev: { id: string; metadata: EvalMetadata }) => boolean;
};

export function getExperimentDisplayMetadata(
  config: ExperimentConfig
): ExperimentDisplayMetadata {
  return config.agent.metadata;
}

export function defineExperiment(config: ExperimentConfig): ExperimentConfig {
  return config;
}

export function serializeTranscript(
  transcript: TranscriptPart[],
  options: TranscriptSerializationOptions = {}
): string {
  const parts = transcript.flatMap((event) => {
    if (event.type === 'message') {
      const content = event.content.trim();
      return content ? [`[${event.role}]\n${content}`] : [];
    }

    const lines = [`[called ${event.name}]`];
    if (options.includeToolCallInputs) {
      lines.push(`input:\n${JSON.stringify(event.input, null, 2)}`);
    }
    if (options.includeToolCallOutputs) {
      if (event.error) {
        lines.push(`error:\n${event.error}`);
      } else if (event.output !== undefined) {
        lines.push(`output:\n${JSON.stringify(event.output, null, 2)}`);
      }
    }
    return [lines.join('\n')];
  });

  return parts.join('\n\n');
}

export type AiSdkProviderOptions = Record<string, Record<string, JSONValue>>;

const judgeOutputSchema = z.object({
  passed: z.boolean(),
  notes: z.string(),
});

const DEFAULT_JUDGE_MODEL = openai('gpt-5.5');
const DEFAULT_JUDGE_PROVIDER_OPTIONS: AiSdkProviderOptions = {
  openai: {
    reasoningEffort: 'low',
    textVerbosity: 'low',
  },
};

export async function judge(args: JudgeInput): Promise<JudgeResult> {
  const model = args.model ?? DEFAULT_JUDGE_MODEL;
  const providerOptions =
    args.providerOptions ?? DEFAULT_JUDGE_PROVIDER_OPTIONS;
  assertProviderReady(model.provider);
  const { output } = await generateText({
    model,
    system:
      'You are a strict eval judge. Return only the requested structured judgment.',
    prompt: ['Rubric:', args.rubric, '', 'Input:', args.input].join('\n'),
    output: Output.object({ schema: judgeOutputSchema }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    providerOptions: withProviderDefaults(model.provider, providerOptions),
  });

  return {
    passed: output.passed,
    notes: output.notes,
  };
}

function getModelProvider(provider: string, modelId: string): ModelProvider {
  if (provider.startsWith('anthropic') || modelId.startsWith('claude-')) {
    return 'anthropic';
  }

  if (provider.startsWith('openai') || modelId.startsWith('gpt-')) {
    return 'openai';
  }

  throw new Error(`unsupported model provider for ${modelId}: ${provider}`);
}

export function aiSdkAgent(options: {
  model: Exclude<LanguageModel, string>;
  providerOptions?: AiSdkProviderOptions;
}): AgentHarness {
  const po = options.providerOptions;
  const configuredEffort = po?.anthropic?.effort ?? po?.openai?.reasoningEffort;
  const reasoningEffort =
    reasoningEffortSchema.safeParse(configuredEffort).data;
  const modelId = options.model.modelId;
  return {
    id: 'ai-sdk',
    modelId,
    metadata: {
      agent: 'ai-sdk',
      modelProvider: getModelProvider(options.model.provider, modelId),
      modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    assertReady() {
      assertProviderReady(options.model.provider);
    },
    async run(args) {
      assertProviderReady(options.model.provider);
      const mcpHandles = args.mcpServers
        ? await createAiSdkTools(args.mcpServers)
        : [];
      const toolCalls: ToolCallRecord[] = [];
      const transcript: TranscriptPart[] = [
        { type: 'message', role: 'system', content: args.systemPrompt },
        { type: 'message', role: 'user', content: args.userPrompt },
      ];
      const tools = mergeToolSets([
        ...(args.tools ? [args.tools] : []),
        ...mcpHandles.map((handle) => handle.tools),
      ]);

      try {
        const result = await generateText({
          model: options.model,
          system: args.systemPrompt,
          prompt: args.userPrompt,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeout: { totalMs: args.timeoutSec * 1000 },
          providerOptions: withProviderDefaults(
            options.model.provider,
            options.providerOptions
          ),
          experimental_onToolCallFinish: (event) => {
            const input = isRecord(event.toolCall.input)
              ? event.toolCall.input
              : {};
            const loadedSkills =
              event.toolCall.toolName === 'load_skill' &&
              typeof input.name === 'string'
                ? [input.name]
                : undefined;
            const command =
              event.toolCall.toolName.toLowerCase() === 'bash' &&
              typeof input.command === 'string'
                ? input.command
                : undefined;
            toolCalls.push({
              endpoint: event.toolCall.toolName,
              body: input,
              command,
              loadedSkills,
              result: event.output,
              ts: Date.now(),
            });
          },
        });

        // Build the transcript from every step's content so the judge sees
        // all user-facing assistant text, not just the final step's text.
        const toolOutputs = new Map<
          string,
          { output?: unknown; error?: string }
        >();
        for (const step of result.steps) {
          for (const part of step.content) {
            if (part.type === 'tool-result') {
              toolOutputs.set(part.toolCallId, { output: part.output });
            } else if (part.type === 'tool-error') {
              toolOutputs.set(part.toolCallId, {
                error:
                  part.error instanceof Error
                    ? part.error.message
                    : String(part.error),
              });
            }
          }
        }

        for (const step of result.steps) {
          for (const part of step.content) {
            if (part.type === 'text') {
              const content = part.text.trim();
              if (content) {
                transcript.push({
                  type: 'message',
                  role: 'assistant',
                  content,
                });
              }
            } else if (part.type === 'tool-call') {
              const resolved = toolOutputs.get(part.toolCallId);
              transcript.push({
                type: 'tool_call',
                name: part.toolName,
                input: isRecord(part.input) ? part.input : {},
                output: resolved?.output,
                error: resolved?.error,
              });
            }
          }
        }

        const agentReport = result.text.trim();

        return {
          agentReport,
          toolCalls,
          transcript,
          steps: result.steps.length,
          stoppedReason:
            result.steps.length >= MAX_STEPS
              ? 'max_steps'
              : result.finishReason,
        };
      } finally {
        await closeMcpHandles(mcpHandles);
      }
    },
  };
}

export type EvalRuntime = {
  id: string;
  startSession(args: EvalSessionArgs): Promise<EvalSession>;
};

export type EvalSessionArgs = {
  /**
   * The scenario's `remote/` directory, if it has one. A `seed.json` inside it
   * describes the Hookdeck project state the scenario starts from. Absent for
   * scenarios that begin from a pristine project.
   */
  remoteDir?: string;
};

export type EvalSession = {
  mcpServers: Record<string, McpServerConfig>;
  promptAddendum?: string;
  /**
   * Environment for the agent's sandbox. Carries the leased project's
   * credentials, so the agent can act on it with the CLI or the API.
   */
  sandboxEnv?: Record<string, string>;
  scoringContext: ToolScoringContext;
  close(): Promise<void>;
};
export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type ResolvedMcpServer = {
  config: McpServerConfig;
  cleanup?: () => Promise<void>;
};

type McpClientHandle = {
  tools: ToolSet;
  close(): Promise<void>;
};

/** What an MCP server needs to talk to the leased project. */
export type HookdeckMcpContext = {
  apiKey?: string;
  projectId?: string;
};

export type McpServerDefinition = {
  name: string;
  promptAddendum?: string;
  createConfig(context?: HookdeckMcpContext): Promise<ResolvedMcpServer>;
};
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('failed to allocate executor daemon port'));
      });
    });
  });
}

export const ACCESS_TOKEN = 'eval-token';
export const MCP_SERVER_VERSION = '0.8.1';
// Well-formed but inert PAT used when a Supabase MCP server is docs-only: the
// server requires a token to boot but never authenticates without a platform.
const THROWAWAY_ACCESS_TOKEN = `sbp_${'0'.repeat(40)}`;
const MAX_STEPS = 60;
const MAX_OUTPUT_TOKENS = 4096;
const RUNTIME_URL = 'http://supabase-evals.local';

function assertProviderReady(provider: string): void {
  if (provider.startsWith('openai') && !process.env.OPENAI_API_KEY) {
    throw new Error(
      'Missing OpenAI credentials. Set OPENAI_API_KEY before running OpenAI evals.'
    );
  }
  if (provider.startsWith('anthropic') && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Missing Anthropic credentials. Set ANTHROPIC_API_KEY before running Anthropic evals.'
    );
  }
}

function withProviderDefaults(
  provider: string,
  options: AiSdkProviderOptions = {}
): AiSdkProviderOptions | undefined {
  const merged = provider.startsWith('openai')
    ? { ...options, openai: withOpenAiZdrDefaults(options.openai) }
    : options;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function createAiSdkTools(
  mcpServers: Record<string, McpServerConfig>
): Promise<McpClientHandle[]> {
  const handles: McpClientHandle[] = [];

  try {
    for (const server of Object.values(mcpServers)) {
      const transport = new StdioMCPTransport({
        command: server.command,
        args: server.args,
        env: { ...definedEnv(process.env), ...server.env },
        stderr: 'ignore',
      });
      const mcp = await createMCPClient({ transport });
      const tools = await mcp.tools();
      handles.push({ tools, close: () => mcp.close() });
    }
  } catch (err) {
    await closeMcpHandles(handles);
    throw err;
  }

  return handles;
}

async function closeMcpHandles(handles: McpClientHandle[]): Promise<void> {
  const errors: unknown[] = [];
  for (const handle of handles) {
    try {
      await handle.close();
    } catch (err) {
      errors.push(err);
    }
  }
  throwIfCloseErrors(errors, 'failed to close MCP clients');
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function withOpenAiZdrDefaults(
  options: Record<string, JSONValue> = {}
): Record<string, JSONValue> {
  const rawInclude = options.include;
  const include = Array.isArray(rawInclude) ? rawInclude.filter(isString) : [];
  return {
    ...options,
    store: options.store ?? false,
    include: include.includes('reasoning.encrypted_content')
      ? include
      : [...include, 'reasoning.encrypted_content'],
  };
}
function mergeToolSets(toolSets: ToolSet[]): ToolSet | undefined {
  const merged: ToolSet = {};
  for (const toolSet of toolSets) {
    for (const [name, tool] of Object.entries(toolSet)) {
      if (name in merged) {
        throw new Error(`duplicate tool name across tool surfaces: ${name}`);
      }
      merged[name] = tool;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function throwIfCloseErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export { readEnvVariable } from './env-file.js';
