import { posix } from 'node:path';
import type { AgentSandbox } from '@supabase-evals/core';
import type { DockerSandbox } from './docker-sandbox.js';

/**
 * Adapt the Docker sandbox to the minimal `AgentSandbox` surface a CLI agent
 * needs: run a command in the workspace and read files back out.
 *
 * Extracted from local-stack-runtime.ts, which was otherwise deleted with the
 * Supabase local stack. bare-sandbox.ts (which we keep) depended on it.
 */
export function toAgentSandbox(sandbox: DockerSandbox): AgentSandbox {
  return {
    workspace: sandbox.workdir,
    exec: (command, options) => sandbox.runShell(command, options),
    readFile: (path) => sandbox.readFile(path),
  };
}

const MAX_TOOL_OUTPUT_CHARS = 16_000;

/**
 * Resolve a user-supplied path against the workspace, rejecting absolute
 * paths and anything escaping it. Extracted from local-stack-runtime.ts.
 */
export function resolveSandboxPath(userPath: string): string {
  if (!userPath || userPath.startsWith('/') || userPath.includes('\0')) {
    throw new Error('path must be relative to the workspace');
  }
  const normalized = posix.normalize(userPath);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('path escapes workspace');
  }
  return normalized;
}

/** Head-and-tail truncation for oversized tool output. */
export function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const head = output.slice(0, MAX_TOOL_OUTPUT_CHARS - 4000);
  const tail = output.slice(-3000);
  return `${head}\n...[truncated ${output.length - head.length - tail.length} chars]...\n${tail}`;
}
