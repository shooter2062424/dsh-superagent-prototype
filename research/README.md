# Research: DeepSeek super-agent vs. a classic agent loop

- `sim/` drives this repository's real `src/core` Engine, `settingsPolicy` and Feishu/GitHub SourceKinds on a mock IM backed by `node:sqlite`, next to two baselines (a synchronous single loop and a single session that delegates to subagents). Model judgements come from a shared scripted oracle, so only the architecture differs.
- `diagrams/` holds the Archify candidates (with source evidence at commit 6337fc8) and their rendered diagrams.
- `report/` builds the published report page from `template.html` and `sim/out/results.json`.

```sh
pnpm install
npx tsx research/sim/run.ts      # writes research/sim/out/results.json and sim.sqlite
node research/report/build.mjs   # writes research/report/out/index.html
```
