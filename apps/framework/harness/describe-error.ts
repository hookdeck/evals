import { inspect } from 'node:util';

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
 * Two shapes need more than the message:
 *
 * - **An `AggregateError` with an empty message.** Every provider host this
 *   harness calls resolves to several addresses, and when all of them refuse,
 *   Node's connect throws an `AggregateError` whose message is `""` and whose
 *   addresses are only in `.errors` (checked on Node 22.17). Each sub-error is
 *   listed, or the line says `ECONNREFUSED` and nothing about where.
 * - **A `code` the message leaves out**, such as `UND_ERR_CONNECT_TIMEOUT`.
 *
 * The chain is bounded, and a cycle stops it. When it is longer than
 * `maxDepth`, the middle is elided rather than the end, because the root cause
 * is last and is the part worth reading.
 *
 * Never throws: it runs inside the per-cell error handler, and an exception
 * here would escape it before the cell's evidence is written.
 */
export function describeError(error: unknown, maxDepth = 6): string {
  try {
    const chain: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;

    while (current !== undefined && current !== null && chain.length < 50) {
      if (seen.has(current)) break;
      seen.add(current);
      if (!(current instanceof Error)) {
        chain.push(describeValue(current));
        break;
      }
      chain.push(describeOne(current, true));
      current = current.cause;
    }

    const kept =
      chain.length > maxDepth
        ? [...chain.slice(0, maxDepth - 1), '…', chain[chain.length - 1]]
        : chain;
    return kept.filter(Boolean).join(' ← ');
  } catch {
    return '(error could not be described)';
  }
}

/** One error: its message, a code the message omits, and any sub-errors. */
function describeOne(e: Error, withSubErrors: boolean): string {
  const code = (e as Error & { code?: unknown }).code;
  let text = e.message;
  if (typeof code === 'string' && !text.includes(code)) {
    text = text ? `${text} (${code})` : code;
  }
  const subs = (e as Error & { errors?: unknown }).errors;
  if (withSubErrors && Array.isArray(subs) && subs.length > 0) {
    const listed = subs.map((s) =>
      s instanceof Error ? describeOne(s, false) : describeValue(s)
    );
    text = `${text} [${listed.join('; ')}]`;
  }
  return text;
}

/** A thrown value that is not an Error, including null-prototype objects. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return inspect(value, { depth: 2, breakLength: Number.POSITIVE_INFINITY });
  } catch {
    return Object.prototype.toString.call(value);
  }
}
