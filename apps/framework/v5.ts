import { discoverEvals, loadExperiments, readSessionSeedArgs } from './lib/discovery.js';
import { pathToFileURL } from 'node:url';
const ev = discoverEvals().find((e) => e.id === 'benchmark-outpost-005-topic-scoping')!;
const runtime = (((await loadExperiments())[0]).config as any).runtime;
const un = (r: any) => Array.isArray(r) ? r : (r?.models ?? []);
const scorer = (await import(ev.scorerPath ?? `${ev.dir}/EVAL.ts`)).default;
for (const [label, topics] of [['naive (only the named keeper)', ['order.created']], ['correct', ['order.created','order.shipped']]] as const) {
  const s = await runtime.startSession(readSessionSeedArgs(ev));
  const ctx = s.scoringContext;
  try {
    for (const d of un(await ctx.outpost('GET', '/tenants/acme/destinations'))) {
      await ctx.outpost('PATCH', `/tenants/acme/destinations/${d.id}`, { topics });
    }
    const r = await scorer(ctx);
    console.log(`${label}: passed=${r.passed} (${r.checks.filter((c:any)=>c.passed).length}/${r.checks.length})`);
    for (const c of r.checks) if (!c.passed) console.log('     FAIL', c.name);
  } finally { await s.close(); }
}
