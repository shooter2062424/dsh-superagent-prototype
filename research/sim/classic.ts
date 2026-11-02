/**
 * The baselines on the same mock IM: one long-lived agent loop in one context (`classic`), and the same loop that
 * delegates each request to a subagent (`delegating`, like a Claude Code session using the Task tool). Both read the same
 * oracle as dsh-superagent and follow the same communication rules (acknowledge once, speak on a result or a question),
 * so what differs is only the shape: who holds which context, what blocks what, and what survives a restart.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Clock, Recorder, type Arch } from './im.ts'
import { MODEL_OUTPUT, MODEL_SECONDS, REACTIONS, SCENARIO, reactionTo, type ScenarioEvent, WORK, type ImMessage, type Step, type TaskId } from './scenario.ts'
import { MAIN_SYSTEM, WORKER_SYSTEM } from './superagent.ts'

interface Job { label: string; seconds: number; output: number; extra?: number; done: () => void; task?: TaskId }
interface Runner { name: string; queue: Job[]; busy: boolean; context: number; current?: { job: Job; started: number } }
interface Task { phase: 'first' | 'afterCi' | 'afterAnswer'; done: number; running: boolean; stopped: boolean; subagent?: Runner }

export function runBaseline(db: DatabaseSync, arch: Exclude<Arch, 'superagent'>, until: number) {
  const rec = new Recorder(db, arch)
  const clock = new Clock()
  const delegate = arch === 'delegating'
  /** One agent holds the routing rules and the coding prompt in the same context. */
  const SYSTEM = WORKER_SYSTEM + MAIN_SYSTEM / 2
  const main: Runner = { name: 'main', queue: [], busy: false, context: SYSTEM, }
  const tasks = new Map<TaskId, Task>()
  let pendingContext = false
  const stopArrived = new Map<TaskId, number>()

  function run(runner: Runner) {
    if (runner.busy) return
    const job = runner.queue.shift()
    if (!job) return
    runner.busy = true
    runner.current = { job, started: clock.now }
    rec.call({ at: clock.now, session: runner.name, role: runner === main ? 'agent' : 'subagent', prompt: runner.context + (job.extra ?? 0), purpose: job.label })
    runner.context += (job.extra ?? 0) + MODEL_OUTPUT + job.output
    const started = clock.now
    clock.after(MODEL_SECONDS + job.seconds, () => {
      runner.busy = false
      runner.current = undefined
      // Work on a task after its requester asked to stop, while the stop still waits in the queue, is wasted.
      const stop = job.task ? stopArrived.get(job.task) : undefined
      if (stop !== undefined && clock.now > stop && !tasks.get(job.task!)!.stopped) rec.wasted += clock.now - Math.max(stop, started)
      job.done()
      run(runner)
    })
  }
  const post = (message: ImMessage | { platform: string; room: string; thread: string }, text: string, kind: string, request?: string) =>
    rec.post({ at: clock.now, id: `${arch}-${rec.posts.length}`, platform: message.platform, room: message.room, thread: message.thread, text, kind }, request)

  function steps(task: TaskId): Step[] {
    const state = tasks.get(task)!
    return (WORK[task][state.phase] ?? []).slice(state.done)
  }
  /** Queue a task's remaining steps: inline at the front of the one loop, or on the task's own subagent. */
  function work(task: TaskId, origin: ImMessage, prefix: Step[] = []) {
    const state = tasks.get(task)!
    if (state.stopped) return
    state.running = true
    const jobs: Job[] = [...prefix, ...steps(task)].map(step => ({ label: `${task}: ${step.label}`, seconds: step.seconds, output: step.output, task, done: () => {
      if (state.stopped) return
      if (!prefix.includes(step)) state.done++
      rec.note(clock.now, `${task} done: ${step.label}`)
      if (step.ask) { finished(); returnToMain(`${task} needs a decision`, () => post(origin, step.ask!, 'question', `task:${task}`)) }
      else if (step.ready) { rec.done.set(`task:${task}`, clock.now); finished(); returnToMain(`${task} ready`, () => post(origin, readyText(task), 'result', `task:${task}`)) }
      else if (state.done === (WORK[task][state.phase] ?? []).length) { finished(); if (delegate) returnToMain(`${task} waiting for CI`, () => {}) }
    } }))
    const finished = () => { state.running = false }
    if (!delegate) { main.queue.unshift(...jobs); return run(main) }
    const sub: Runner = { name: `subagent-${task}-${clock.now}`, queue: [{ label: `${task}: read the brief`, seconds: 30, output: 2000, done: () => {} }, ...jobs], busy: false, context: WORKER_SYSTEM + 1500 }
    state.subagent = sub
    run(sub)
  }
  /** A subagent's result re-enters the main context as a summary; inline work is already in the one context. */
  function returnToMain(label: string, act: () => void) {
    if (!delegate) return act()
    main.queue.push({ label: `subagent result: ${label}`, seconds: 0, output: 600, done: act })
    run(main)
  }
  const readyText = (task: TaskId) => task === 'A' ? 'PR #50 已就緒：Submit 拼字與 e2e 都修好了，請 review。' : task === 'B' ? 'docs 連結修好了，PR 已開，請 review。' : '按鈕顏色 PR #51 已就緒，請 review。'

  function handle(message: ImMessage) {
    const intent = message.intent
    switch (intent.kind) {
      case 'request':
        if (message.redelivery) return rec.note(clock.now, `noticed duplicate ${message.id} in context`)
        tasks.set(intent.task, { phase: 'first', done: 0, running: false, stopped: false })
        post(message, intent.task === 'A' ? '收到，修正登入頁的 Submit 拼字，完成後回報 PR。' : '收到，修 docs/theme.md 的失效連結並檢查全文連結，完成後回 PR。', 'acknowledgement', `task:${intent.task}`)
        return work(intent.task, message)
      case 'context': {
        const state = tasks.get(intent.task)!
        if (state.done > 0 || state.running) {
          rec.note(clock.now, 'context arrived after the work started: rework for the mobile layout')
          rec.wasted += 120
          const amend: Step = { label: 'rework: also fix the mobile layout', seconds: 120, output: 1500 }
          if (!delegate) { main.queue.unshift({ label: `A: ${amend.label}`, seconds: amend.seconds, output: amend.output, done: () => {} }); return }
          pendingContext = true
        }
        return
      }
      case 'injection': return post(message, '抱歉，我不能分享任何憑證。', 'reply')
      case 'chatter': case 'preference': case 'typo-proposal': return
      case 'ci-failed': {
        const state = tasks.get(intent.task)!
        state.phase = 'afterCi'; state.done = 0
        const origin = SCENARIO.find(event => event.type === 'message' && event.message.id === 'om_1')!
        const prefix: Step[] = pendingContext ? [{ label: 'rework: also fix the mobile layout', seconds: 120, output: 1500 }] : []
        pendingContext = false
        return work(intent.task, (origin as { message: ImMessage }).message, prefix)
      }
      case 'scope-creep':
        tasks.set(intent.becomes, { phase: 'first', done: 0, running: false, stopped: false })
        return work(intent.becomes, message)
      case 'answer': {
        const state = tasks.get(intent.task)!
        state.phase = 'afterAnswer'; state.done = 0
        return work(intent.task, message)
      }
      case 'stop': {
        const state = tasks.get(intent.task)!
        state.stopped = true
        if (state.subagent) state.subagent.queue = []
        main.queue = main.queue.filter(job => job.task !== intent.task)
        return rec.note(clock.now, `stopped ${intent.task}`)
      }
    }
  }

  function schedule(event: ScenarioEvent) {
    if (event.type === 'message') clock.at(event.message.at, () => {
      rec.inbound(event.message)
      if (event.message.intent.kind === 'stop') stopArrived.set(event.message.intent.task, clock.now)
      rec.note(clock.now, `IN ${event.message.platform}/${event.message.room} ${event.message.name}: ${event.message.text}`)
      main.queue.push({ label: `handle ${event.message.id}`, seconds: 0, output: 0, extra: event.message.text.length + 200, done: () => handle(event.message) })
      run(main)
    }, true)
    if (event.type === 'merge') clock.at(event.at, () => {
      main.queue.push({ label: 'handle PR merged webhook', seconds: 0, output: 0, extra: 300, done: () => post({ platform: 'feishu', room: 'oc_team', thread: 'om_1' }, 'PR #50 已合併。', 'notice') })
      run(main)
    }, true)
    if (event.type === 'restart') clock.at(event.at, () => {
      rec.note(clock.now, 'HOST RESTART: in-memory queue and running tool calls lost; the transcript is resumed from disk')
      for (const runner of [main, ...[...tasks.values()].flatMap(task => task.subagent ? [task.subagent] : [])]) {
        if (runner.current) { rec.wasted += clock.now - runner.current.started; rec.note(clock.now, `lost in-flight: ${runner.current.job.label}`) }
        runner.busy = false; runner.current = undefined
      }
      const lostJobs = main.queue.filter(job => job.label.startsWith('handle'))
      const lost = lostJobs.length
      main.queue = []
      clock.crash()
      rec.note(clock.now, `${lost} received messages were only in memory; catch up from chat history`)
      main.queue.push({ label: 'catch up: re-read chat and GitHub history since the last handled message', seconds: 30, output: 4000, done: () => {
        for (const [id, task] of tasks) {
          const origin = (SCENARIO.find(event => event.type === 'message' && event.message.intent.kind === 'request' && event.message.intent.task === id) as { message: ImMessage } | undefined)?.message
            ?? (SCENARIO.find(event => event.type === 'message' && event.message.intent.kind === 'scope-creep') as { message: ImMessage }).message
          if (!task.stopped && task.running) work(id, origin, [{ label: 'recover: inspect worktree and git log', seconds: 60, output: 1500 }])
        }
        main.queue.push(...lostJobs)
      } })
      run(main)
    }, true)
  }
  SCENARIO.forEach(schedule)
  rec.onPost = post => {
    const reaction = REACTIONS.find(item => item.on === reactionTo(post.text))
    if (!reaction) return
    const at = clock.now + reaction.delay
    schedule(reaction.event.type === 'message' ? { type: 'message', message: { ...reaction.event.message, at } } : { ...reaction.event, at } as ScenarioEvent)
  }
  clock.run(until)
  return { rec, mainContext: main.context }
}
