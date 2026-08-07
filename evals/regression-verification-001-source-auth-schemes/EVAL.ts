import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@hookdeck-evals/core';
import { CAPABILITY_SHEET } from '@hookdeck-evals/hookdeck';
import { stripIndent } from 'common-tags';

/**
 * The failure here is quiet: a wrong encoding or header name means
 * verification rejects every request, and the symptom looks like the provider
 * misbehaving rather than a misconfiguration.
 */
const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [await checkVerificationSchemes(ctx)];
  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;

async function checkVerificationSchemes(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Grade against this capability sheet, which is authoritative:

      ${CAPABILITY_SHEET}

      Pass if BOTH hold:

      1. It identifies that a provider outside the named list is handled by
         generic verification, and that the generic methods are HMAC signature,
         API key, and Basic auth.
      2. It gets the HMAC configuration right: it needs a secret key, an
         algorithm, the header the signature arrives in, and an encoding of
         either base64 or hex. Naming the supported algorithms
         (md5, sha1, sha256, sha512) is good but not required.

      Fail if it invents a verification method that is not in the sheet, states
      an encoding other than base64 or hex, claims an unsupported algorithm, or
      omits that the signature header name must be configured. That last one
      matters: without it the configuration cannot work, and the failure looks
      like the provider misbehaving.

      Mentioning x-hookdeck-verified is a bonus, not a requirement.
    `,
  });
  return {
    name: 'describes the real verification schemes and HMAC config',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
