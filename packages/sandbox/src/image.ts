/**
 * Sandbox image build. Extracted from supabase.ts, which was deleted with the
 * Supabase local stack.
 *
 * The base image was already product-agnostic upstream: it carries node, git,
 * curl, docker, psql, and the Vercel skills CLI, and the Supabase CLI was
 * installed separately per local-stack session. So this is a rename plus the
 * retry helper, with no Supabase-specific logic to strip.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dockerCli } from './docker-sandbox.js';
import { SKILLS_CLI_VERSION } from './skills.js';

const SANDBOX_IMAGE_REPOSITORY = 'hookdeck-evals-sandbox';
/**
 * Pinned so benchmark runs stay comparable across CLI releases.
 *
 * Bumping is a deliberate act, not maintenance: it changes the product under
 * test, so results either side of a bump are not directly comparable for any
 * scenario that touches the CLI. Record the bump alongside the re-run.
 *
 * 2.3.1 to 2.5.0 on 14 August. 2.5.0 carries "make the CLI safe to run without
 * a terminal", which addresses the failure shape this benchmark surfaced: the
 * CLI silently doing something other than what was asked, with missing traffic
 * as the first symptom rather than an error. At 2.3.1 `listen` did not read
 * `HOOKDECK_API_KEY` at all, so an agent that never ran `hookdeck ci` was
 * working against a guest project without being told.
 */
export const HOOKDECK_CLI_VERSION = '2.5.0';
const REGISTRY_RETRY_DELAYS_MS = [5_000, 30_000, 60_000];

/**
 * Run a failure-prone step to completion, retrying failed attempts on the
 * schedule in {@link REGISTRY_RETRY_DELAYS_MS}. Registry pulls and image
 * builds are the transient-failure cases this exists for.
 */
async function withTransientRetries<R extends { ok: boolean }>(
  label: string,
  run: () => Promise<R>,
  options: {
    buildError: (result: R) => Error;
    beforeRetry?: () => Promise<void>;
    isTerminal?: (result: R) => boolean;
  }
): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    const result = await run();
    if (result.ok) return result;

    const delayMs = REGISTRY_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || options.isTerminal?.(result)) {
      throw options.buildError(result);
    }
    console.warn(
      `[sandbox] ${label} failed ` +
        `(attempt ${attempt + 1}/${REGISTRY_RETRY_DELAYS_MS.length + 1}), ` +
        `retrying in ${delayMs / 1000}s`
    );
    const readyAt = Date.now() + delayMs;
    await options.beforeRetry?.();
    const remainingMs = readyAt - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }
  }
}

/** The sandbox image definition lives in an actual Dockerfile for editability. */
export const SANDBOX_DOCKERFILE_PATH = fileURLToPath(
  new URL('../Dockerfile', import.meta.url)
);

/**
 * The tag a given Dockerfile builds to.
 *
 * The Dockerfile's own hash is part of it, not only the two pins. An image is
 * reused whenever its tag exists, so a tag made of the pins alone meant an edit
 * to the Dockerfile never reached a machine that had built the image before:
 * the PATH fix for login shells would have been silently skipped on every
 * machine with a cached image, and the toolchain check would then have refused
 * every cell there.
 */
export function sandboxImageTag(dockerfile: string): string {
  return (
    `${SANDBOX_IMAGE_REPOSITORY}:` +
    `skills-${SKILLS_CLI_VERSION}-hookdeck-${HOOKDECK_CLI_VERSION}-` +
    sandboxImageDefinition(dockerfile)
  );
}

/**
 * A short hash of the image definition: the Dockerfile's bytes.
 *
 * Exported for provenance as well as the tag. The image is part of the
 * instrument, and the case that made it so is the login-shell PATH: with the
 * same pins, prompt and skills, Codex's login shells had no `hookdeck` on PATH
 * before the Dockerfile changed, and the change is meant to give them the
 * pinned one. A row's provenance has to tell those apart, and the pins alone
 * cannot.
 */
export function sandboxImageDefinition(
  dockerfile: string = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8')
): string {
  return createHash('sha256').update(dockerfile).digest('hex').slice(0, 12);
}

/** Build (or reuse) the sandbox image and return its tag. */
export async function ensureSandboxImage(): Promise<string> {
  const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, 'utf8');
  const tag = sandboxImageTag(dockerfile);
  const existing = await dockerCli(['image', 'inspect', tag]);
  if (existing.ok) return tag;

  await withTransientRetries(
    `build ${tag}`,
    () =>
      dockerCli(
        [
          'build',
          '--build-arg',
          `SKILLS_CLI_VERSION=${SKILLS_CLI_VERSION}`,
          '--build-arg',
          `HOOKDECK_CLI_VERSION=${HOOKDECK_CLI_VERSION}`,
          '--tag',
          tag,
          '-',
        ],
        { input: dockerfile }
      ),
    {
      buildError: (build) =>
        new Error(`failed to build sandbox image ${tag}: ${build.stderr}`),
    }
  );
  return tag;
}
