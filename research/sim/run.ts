/**
 * Runs the shared scenario on dsh-superagent and on both baselines over one SQLite database, prints a summary and
 * writes research/sim/out/results.json for the report.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Recorder, fmt } from './im.ts'
import { runSuperagent } from './superagent.ts'
import { runBaseline } from './classic.ts'

const out = new URL('./out/', import.meta.url)
mkdirSync(out, { recursive: true })
const file = new URL('sim.sqlite', out).pathname
rmSync(file, { force: true })
const db = Recorder.open(file)
const UNTIL = 80 * 60

const sa = runSuperagent(db, UNTIL)
const classic = runBaseline(db, 'classic', UNTIL)
const delegating = runBaseline(db, 'delegating', UNTIL)

function summary(rec: Recorder) {
  const prompts = rec.calls.map(call => call.prompt)
  const bySession = new Map<string, number>()
  for (const call of rec.calls) bySession.set(call.session, Math.max(bySession.get(call.session) ?? 0, call.prompt))
  return {
    posts: rec.posts.length,
    postsByKind: Object.fromEntries([...new Set(rec.posts.map(post => post.kind))].map(kind => [kind, rec.posts.filter(post => post.kind === kind).length])),
    calls: rec.calls.length,
    promptTotal: prompts.reduce((a, b) => a + b, 0),
    promptMax: Math.max(...prompts),
    promptMean: Math.round(prompts.reduce((a, b) => a + b, 0) / prompts.length),
    maxContextBySession: Object.fromEntries(bySession),
    firstReply: Object.fromEntries(rec.firstReply),
    done: Object.fromEntries(rec.done),
    wastedSeconds: rec.wasted,
  }
}
const results = {
  generatedAt: new Date().toISOString(),
  superagent: { ...summary(sa.rec), decisions: sa.decisionCount, tickets: sa.tickets.map(t => ({ id: t.id, title: t.title, mandate: t.mandate, ended: t.ended, assignments: t.assignments.length, inputs: t.inputs.length })) },
  classic: summary(classic.rec),
  delegating: summary(delegating.rec),
  timelines: Object.fromEntries([['superagent', sa.rec], ['classic', classic.rec], ['delegating', delegating.rec]].map(([name, rec]) =>
    [name as string, (rec as Recorder).log.map(entry => ({ at: entry.at, t: fmt(entry.at), text: entry.text }))])),
  calls: Object.fromEntries([['superagent', sa.rec], ['classic', classic.rec], ['delegating', delegating.rec]].map(([name, rec]) => [name as string, (rec as Recorder).calls])),
  posts: [...sa.rec.posts, ...classic.rec.posts, ...delegating.rec.posts],
}
writeFileSync(new URL('results.json', out), JSON.stringify(results, null, 2))
for (const name of ['superagent', 'classic', 'delegating'] as const) {
  console.log(`\n=== ${name}`)
  console.log(JSON.stringify({ ...results[name], tickets: undefined }, null, 1))
}
console.log('\n--- superagent timeline'); for (const e of results.timelines.superagent) console.log(e.t, e.text)
