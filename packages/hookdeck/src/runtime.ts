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
import { OutpostClient } from './outpost-client.js';
import type { ProjectSource } from './project-source.js';
import { applyOutpostSeed, applySeed, readSeed } from './seed.js';

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

        // Present only when a key is configured, so an Outpost scenario reads
        // as skipped rather than failing inside a check on a machine that has
        // no Outpost project.
        const outpostKey = process.env.OUTPOST_API_KEY;
        const outpostClient = outpostKey
          ? new OutpostClient({ apiKey: outpostKey })
          : undefined;

        // The Outpost half of the seed, applied after the client exists.
        // Loudly rather than silently: a scenario asking for Outpost state on a
        // machine with no key would otherwise run against nothing and score the
        // agent for a setup that was never there. Scenarios needing this
        // declare `requires: [outpost]`, which skips them before they reach
        // here — so arriving without a client means the requirement is missing,
        // not that the machine is simply unconfigured.
        if (args.remoteDir) {
          const seed = readSeed(args.remoteDir);
          if (seed?.outpost) {
            if (!outpostClient) {
              throw new Error(
                'seed declares outpost state but OUTPOST_API_KEY is not set; ' +
                  'the scenario should declare `requires: [outpost]`'
              );
            }
            await applyOutpostSeed(
              (method, path, body) => outpostClient.request(method, path, body),
              seed.outpost
            );
          }
        }

        const scoringContext: ToolScoringContext = {
          projectId: project.projectId,
          acquiredAt: project.acquiredAt,
          api: (method, path, body) =>
            project.client.request(method, path, body),
          ...(outpostClient
            ? {
                outpost: <T>(
                  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
                  path: string,
                  body?: unknown
                ) => outpostClient.request<T>(method, path, body),
              }
            : {}),
        };

        return {
          mcpServers,
          promptAddendum: [
            // The agent is told what its environment contains, and nothing
            // else. Which docs to read, and how to do the task, is what the
            // scenario measures.
            'You have a Hookdeck project. The Hookdeck CLI is installed and ' +
              'HOOKDECK_API_KEY is set in your environment, so both the CLI ' +
              'and the REST API are available to you.',
            // Named because it is there.
            //
            // This sentence exists to make the one above true. The addendum's
            // job is disclosure — it already says a project exists and how it
            // is authenticated — and it was silently omitting a second project
            // that the harness injects whenever a scenario needs Outpost. That
            // is not a discovery test we designed; it is an incomplete
            // sentence, and "so both the CLI and the REST API are available to
            // you" actively reads as *this is your access*.
            //
            // Measured on 21 August, before this line existed: across twelve
            // baseline cells on four Outpost scenarios, `OUTPOST_API_KEY` was
            // used as a credential exactly zero times and every cell failed.
            // Nine of the twelve agents believed they had succeeded, having
            // built the task on `api.hookdeck.com`. Two reported, with
            // authority, that the harness had given them the wrong credential.
            // The skill was the only artefact in the sandbox naming the
            // variable, so the skills delta could not be separated from
            // credential disclosure — the run measured our own omission.
            //
            // One credential type, two projects. Both keys authenticate
            // `api.hookdeck.com` and the CLI; only the Outpost project's key
            // reaches the Outpost subdomain, and a key from another project
            // gets a `404` there rather than anything that says why (#39).
            //
            // The wording points at the API rather than the CLI deliberately,
            // and that is a statement about the pinned version rather than a
            // permanent one. Against `HOOKDECK_CLI_VERSION` 2.5.0 the Outpost
            // key authenticates the CLI and selects the Outpost project —
            // verified — but there is nothing useful to do with it there, so
            // the API is the only honest route to point at.
            //
            // `3.0.0-beta.1` is published (npm dist-tag `beta`; `latest` is
            // still 2.5.0) and adds managing an Outpost project from the CLI.
            // When that pin moves, this sentence becomes incomplete rather
            // than wrong, and the CLI becomes a legitimate answer for Outpost
            // work. A CLI bump also changes the product under test, so results
            // either side of it are not comparable — see Releases in
            // AGENTS.md.
            // A developer using Outpost knows they use it and has the key in
            // their environment; nobody learns their own credentials by
            // enumerating env vars.
            ...(outpostClient
              ? [
                  'You also have a Hookdeck Outpost project, and ' +
                    'OUTPOST_API_KEY is set in your environment. It is an ' +
                    'ordinary Hookdeck project API key scoped to that ' +
                    'project: use it for the Outpost API, which has its own ' +
                    'subdomain.',
                ]
              : []),
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
            ...(process.env.HOOKDECK_WEBHOOK_SECRET
              ? { HOOKDECK_WEBHOOK_SECRET: process.env.HOOKDECK_WEBHOOK_SECRET }
              : {}),
            // Outpost is a separate product with a separate key. An agent asked
            // to build outbound delivery needs it the same way it needs
            // HOOKDECK_API_KEY for the gateway.
            ...(outpostKey ? { OUTPOST_API_KEY: outpostKey } : {}),
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
