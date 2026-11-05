/**
 * One line describing an error and every cause beneath it.
 *
 * Node's `fetch` fails with `TypeError: fetch failed` and keeps the reason —
 * the refused connection, the DNS miss, the reset socket, and the host it was
 * talking to — on `cause`. The harness printed `e.message` alone, so an errored
 * cell said "fetch failed" and nothing else: on 26 October
 * `regression-verification-001-generic-hmac` errored three seconds into a
 * scheduled run, and the log could not say which of Hookdeck, Anthropic,
 * OpenAI or the sandbox it had failed to reach. The `AggregateError` thrown at
 * the end does not help either, because Node prints nested causes as
 * `[cause]: [TypeError]` past a depth of two.
 *
 * Errors carry a `code` (`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`) more often
 * than a useful message, so it is included when present. Bounded, because a
 * cause chain can be cyclic.
 */
export function describeError(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && parts.length < maxDepth) {
    if (seen.has(current)) break;
    seen.add(current);

    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      parts.push(
        typeof code === 'string' && !current.message.includes(code)
          ? `${current.message} (${code})`
          : current.message
      );
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.filter(Boolean).join(' ← ');
}
