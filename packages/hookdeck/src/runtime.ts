/**
 * The Hookdeck runtime: what an experiment gives an agent, and what a scorer
 * gets back.
 *
 * Implements `EvalRuntime`, the seam upstream used for `platformLiteRuntime()`.
 * The suite runner calls `startSession()`, hands the agent the MCP servers and
 * prompt addendum, and spreads `scoringContext` into the scorer. It never
 * looks inside the context, which is what made swapping Supabase's for ours a
 * retype rather than a rewrite.
 */

import type {
  EvalRuntime,
  EvalSession,
  McpServerConfig,
  McpServerDefinition,
  ToolScoringContext,
} from '@hookdeck-evals/core';
import type { ProjectSource } from './project-source.js';
import { applySeed, readSeed } from './seed.js';

export interface HookdeckRuntimeOptions {
  projects: ProjectSource;
  mcpServers?: McpServerDefinition[];
}

export function hookdeckRuntime(options: HookdeckRuntimeOptions): EvalRuntime {
  return {
    id: `hookdeck:${options.projects.id}`,

    async startSession(args): Promise<EvalSession> {
      const project = await options.projects.acquire();
      const mcpServers: Record<string, McpServerConfig> = {};
      const cleanups: Array<() => Promise<void>> = [];

      try {
        if (args.remoteDir) {
          const seed = readSeed(args.remoteDir);
          if (seed) await applySeed(project.client, seed);
        }

        for (const server of options.mcpServers ?? []) {
          if (server.name in mcpServers) {
            throw new Error(`duplicate MCP server name: ${server.name}`);
          }
          const resolved = await server.createConfig({
            apiKey: project.apiKey,
            projectId: project.projectId,
          });
          mcpServers[server.name] = resolved.config;
          if (resolved.cleanup) cleanups.push(resolved.cleanup);
        }

        const scoringContext: ToolScoringContext = {
          projectId: project.projectId,
          acquiredAt: project.acquiredAt,
          api: (method, path, body) =>
            project.client.request(method, path, body),
        };

        return {
          mcpServers,
          promptAddendum: [
            // The agent is told the project exists and is authenticated, and
            // nothing else. Which docs to read, and how to do the task, is what
            // the scenario measures.
            'You have a Hookdeck project. The Hookdeck CLI is installed and ' +
              'HOOKDECK_API_KEY is set in your environment, so both the CLI ' +
              'and the REST API are available to you.',
            ...(options.mcpServers ?? [])
              .map((s) => s.promptAddendum)
              .filter((p): p is string => Boolean(p)),
          ].join('\n\n'),
          sandboxEnv: {
            HOOKDECK_API_KEY: project.apiKey,
            // The secret Hookdeck signs forwarded requests with, so a handler
            // an agent writes can verify `x-hookdeck-signature`. It is
            // project-scoped and lives in the dashboard rather than on the API,
            // so there is no way to look it up at run time; without it here an
            // agent can only leave a placeholder, which is what happened on
            // BM1's first run. Passing it also lets a scorer sign a request
            // itself and check the handler directly, rather than needing a live
            // tunnel for Hookdeck to deliver through.
            ...(process.env.HOOKDECK_SIGNING_SECRET
              ? { HOOKDECK_SIGNING_SECRET: process.env.HOOKDECK_SIGNING_SECRET }
              : {}),
          },
          scoringContext,
          close: async () => {
            const errors: unknown[] = [];
            for (const cleanup of cleanups) {
              try {
                await cleanup();
              } catch (err) {
                errors.push(err);
              }
            }
            await options.projects.release(project);
            if (errors.length) {
              throw new AggregateError(errors, 'failed to close eval session');
            }
          },
        };
      } catch (err) {
        for (const cleanup of cleanups) {
          await cleanup().catch(() => {});
        }
        await options.projects.release(project);
        throw err;
      }
    },
  };
}

/**
 * The Event Gateway MCP server, which ships inside the Hookdeck CLI.
 *
 * Read-only: eleven tools covering projects, connections, sources,
 * destinations, transformations, requests, events, attempts, issues, metrics
 * and help. It cannot create or mutate anything, so expect the `+MCP`
 * experiment to lift investigate and resolve while leaving build flat. That is
 * a finding about the product, not a bug in the suite, and the methodology
 * note should say so before the first results publish.
 */
export function hookdeckMcpServer(): McpServerDefinition {
  return {
    name: 'hookdeck',
    async createConfig(context) {
      return {
        config: {
          command: 'hookdeck',
          args: ['mcp'],
          env: context?.apiKey
            ? { HOOKDECK_API_KEY: context.apiKey }
            : undefined,
        },
      };
    },
  };
}
