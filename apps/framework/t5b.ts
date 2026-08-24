import {
  discoverEvals,
  loadExperiments,
  readSessionSeedArgs,
} from './lib/discovery.js';
const ev = discoverEvals().find(
  (e) => e.id === 'benchmark-outpost-005-topic-scoping'
)!;
const runtime = ((await loadExperiments())[0].config as any).runtime;
const un = (r: any) => (Array.isArray(r) ? r : (r?.models ?? []));
const scorer = (await import(ev.scorerPath ?? `${ev.dir}/EVAL.ts`)).default;
for (const mode of ['delete', 'correct'] as const) {
  const s = await runtime.startSession(readSessionSeedArgs(ev));
  const ctx = s.scoringContext;
  try {
    for (const d of un(
      await ctx.outpost('GET', '/tenants/acme/destinations')
    )) {
      if (mode === 'delete')
        await ctx.outpost('DELETE', `/tenants/acme/destinations/${d.id}`);
      else
        await ctx.outpost('PATCH', `/tenants/acme/destinations/${d.id}`, {
          topics: ['order.created', 'order.shipped'],
        });
    }
    const r = await scorer(ctx);
    console.log(
      `${mode}: passed=${r.passed} (${r.checks.filter((c: any) => c.passed).length}/${r.checks.length})`
    );
    for (const c of r.checks) if (!c.passed) console.log('    FAIL', c.name);
  } catch (e: any) {
    console.log(`${mode}: THREW -> ${String(e.message).slice(0, 80)}`);
  } finally {
    await s.close();
  }
}
