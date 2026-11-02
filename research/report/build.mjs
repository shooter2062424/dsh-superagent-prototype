// Builds research/report/out/index.html from template.html with the simulation results inlined, and copies the diagrams beside it.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const here = new URL('./', import.meta.url)
const out = new URL('out/', here), diagrams = new URL('diagrams/', out)
mkdirSync(diagrams, { recursive: true })
const r = JSON.parse(readFileSync(new URL('../sim/out/results.json', here)))
const data = { superagent: r.superagent, classic: r.classic, delegating: r.delegating, timelines: r.timelines, posts: r.posts }
for (const a of ['superagent', 'classic', 'delegating']) delete data[a].tickets
writeFileSync(new URL('index.html', out), readFileSync(new URL('template.html', here), 'utf8').replace('/*__DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c')))
for (const f of ['arch-light.png', 'arch-dark.png', 'seq-light.png', 'seq-dark.png', 'superagent-architecture.html', 'superagent-sequence.html']) copyFileSync(new URL(f, new URL('../diagrams/', here)), new URL(f, diagrams))
console.log('built', new URL('index.html', out).pathname)
