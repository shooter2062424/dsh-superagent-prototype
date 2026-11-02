/**
 * dsh-superagent on the mock IM: the repository's real Engine, real Policy (`settingsPolicy`) and real Feishu and
 * GitHub SourceKinds decide intake, gate, batching, fan-out, Mandates, idempotent replies and restart recovery. Only the
 * model is scripted: the main Session and the workers read each message's ground-truth intent through the same oracle
 * the baselines use, and every model call is recorded with the size of the context it would send.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { Engine, followupOwners, runningAssignment, type Assignment, type Candidate, type Executor, type OutboundMessage, type Ticket, type Trigger }
  from '../../src/core/index.ts'
import { SettingsSchema, assessmentOutcome, settingsPolicy, type Assessment } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { SqliteRepositories } from './sqlite-repos.ts'
import { Clock, Recorder, fmt } from './im.ts'
import { MODEL_OUTPUT, MODEL_SECONDS, REACTIONS, SCENARIO, reactionTo, type ScenarioEvent, SUPPORT, TEAM, WORK, type ImMessage, type Step, type TaskId } from './scenario.ts'

const prompt = (...files: string[]) => files.map(file => readFileSync(new URL(`../../prompts/${file}`, import.meta.url), 'utf8')).join('\n').length
/** System prompt sizes from the repository's real prompt files; workers also read the harness coding prompt (~6k) and AGENTS.md (~2k). */
export const MAIN_SYSTEM = prompt('shared.md', 'orchestrator.md', 'subscriptions.md', 'replies.md', 'dispatch.md', 'admission.md', 'handoff-orchestrator.md', 'team/communication.md', 'team/scope.md', 'team/delivery.md')
export const WORKER_SYSTEM = prompt('shared.md', 'worker.md', 'subscriptions.md', 'replies.md', 'work.md', 'handoff-worker.md', 'team/communication.md', 'team/scope.md', 'team/delivery.md') + 8000
/** Characters of a candidate card or relay: bounded by the host (Trigger text ≤4000, report ≤600, thread window of short messages). */
const CARD = 900

export const settings = SettingsSchema.parse({
  policy: {
    rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation.' }],
    sources: {
      feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], admission: { [SUPPORT]: { unlistedUnaddressed: 'inferred' } } },
      github: { allowed: [{ id: 'alice-gh' }] },
    },
  },
  eval: { mode: 'observe' },
  sources: {
    feishu: { enabled: true, config: { chats: [{ chatId: TEAM, listen: 'mentions' }, { chatId: SUPPORT, listen: 'all' }], directMessages: true } },
    github: { enabled: true, config: {} },
  },
})

export function toTrigger(message: ImMessage): Trigger {
  const at = new Date(Date.UTC(2026, 10, 2, 9, 0, message.at)).toISOString()
  if (message.platform === 'feishu') return {
    id: `feishu:${message.id}`, source: 'feishu', threads: [{ source: 'feishu', id: message.thread }], actor: { source: 'feishu', id: message.sender },
    human: !message.bot, ...message.mention ? { addressed: 'mention' as const } : {}, at, text: message.text,
    channel: { source: 'feishu', thread: message.thread, address: { message: message.id, chatId: message.room } },
    meta: { chatId: message.room, direct: false, mentioned: message.mention },
  }
  const ci = message.intent.kind === 'ci-failed'
  return {
    id: `github:${message.id}`, source: 'github', threads: [{ source: 'github', id: message.thread }], actor: { source: 'github', id: ci ? '' : message.sender },
    human: !message.bot, ...message.mention ? { addressed: 'mention' as const } : {}, at, text: message.text,
    ...ci ? {} : { channel: { source: 'github', thread: message.thread, address: { number: message.thread } } },
    meta: ci ? { ci: true, branch: 'agent/fix-submit-typo', number: Number(message.thread), isPr: true } : { kind: 'conversation', number: Number(message.thread), isPr: message.thread === '50' },
  }
}

interface Worker { ticketId: string; task: TaskId; steps: Step[]; busy: boolean; context: number; inbox: string[]; recovering: boolean; started?: number }

export function runSuperagent(db: DatabaseSync, until: number) {
  const rec = new Recorder(db, 'superagent')
  const clock = new Clock()
  const sources = new SourceRegistry(() => settings)
  sources.register(feishuKind); sources.register(githubKind)
  if (!sources.instance('feishu')?.enabled || !sources.instance('github')?.enabled) throw new Error('mock Source configuration was rejected')
  const policy = settingsPolicy(settings, sources)
  const messages = new Map([...SCENARIO, ...REACTIONS.map(reaction => reaction.event)].flatMap(event => event.type === 'message' ? [[toTrigger(event.message).id, event.message] as const] : []))
  const intentOf = (triggerId: string) => messages.get(triggerId)!.intent
  const iso = () => new Date(Date.UTC(2026, 10, 2, 9, 0, clock.now)).toISOString()

  const repo = new SqliteRepositories(db)
  db.exec('CREATE TABLE IF NOT EXISTS sa_outbox (id TEXT PRIMARY KEY, json TEXT, status TEXT); CREATE TABLE IF NOT EXISTS sa_worktree (ticket TEXT PRIMARY KEY, task TEXT, done INTEGER, phase TEXT)')
  const ticketTask = new Map<string, TaskId>()
  let engine!: Engine
  let workers = new Map<string, Worker>()
  let mainContext = MAIN_SYSTEM
  const loggedDecisions = new Set<string>()
  let stopArrived: number | undefined
  const requestOf = (ticketId: string) => `task:${ticketTask.get(ticketId)}`

  const outbox = {
    send(message: OutboundMessage) {
      if (db.prepare('SELECT 1 FROM sa_outbox WHERE id = ?').get(message.id)) return
      db.prepare('INSERT INTO sa_outbox VALUES (?,?,?)').run(message.id, JSON.stringify(message), 'pending')
      clock.after(1, () => {
        const row = db.prepare('SELECT status FROM sa_outbox WHERE id = ?').get(message.id) as { status: string }
        if (row.status !== 'pending') return
        db.prepare("UPDATE sa_outbox SET status = 'sent' WHERE id = ?").run(message.id)
        rec.post({ at: clock.now, id: message.id, platform: message.channel.source, room: message.channel.address.chatId ?? 'repo', thread: message.channel.thread,
          text: message.text, kind: message.kind }, message.ticketId ? requestOf(message.ticketId) : undefined)
      }, true)
    },
    status: (id: string) => (db.prepare('SELECT status FROM sa_outbox WHERE id = ?').get(id) as { status: 'pending' | 'sent' | 'dropped' } | undefined)?.status,
    withdraw: (id: string) => { db.prepare("UPDATE sa_outbox SET status = 'dropped' WHERE id = ? AND status = 'pending'").run(id) },
  }

  /** The main Session: one model call per candidate batch or relay; its context grows only by bounded cards. */
  function mainCall(purpose: string, act: () => void) {
    rec.call({ at: clock.now, session: 'main', role: 'router', prompt: mainContext + CARD, purpose })
    mainContext += CARD + MODEL_OUTPUT
    clock.after(MODEL_SECONDS, act, true)
  }
  const assessor = {
    request(candidate: Candidate) {
      engine.candidateDelivered(candidate.evalId)
      const ids = candidate.triggers.map(trigger => trigger.id)
      rec.note(clock.now, `EVAL batch [${ids.join(', ')}] strength=${candidate.strength}`)
      mainCall(`eval ${ids.join('+')}`, () => decideCandidate(candidate))
    },
  }
  function decideCandidate(candidate: Candidate) {
    const first = candidate.triggers[0]!
    const intent = intentOf(first.id)
    const handed = intent.kind === 'scope-creep'
    const decide = (outcome: Parameters<Engine['decide']>[1]) => {
      const decision = engine.decide(first.id, { ...outcome, evalId: candidate.evalId })
      loggedDecisions.add(decision.id)
      rec.note(clock.now, `DECISION ${decision.kind}${decision.audit?.would_accept ? ' (would accept, observe mode)' : ''} on ${first.id}`)
      if (decision.ticketId) ticketTask.set(decision.ticketId, handed ? intent.becomes : (intent as { task: TaskId }).task)
    }
    if (intent.kind === 'request' || handed) {
      const title = intent.title
      return decide({ kind: 'accept', title, scope: 'small local change', reason: 'explicit request from an allowed sender', name: title.toLowerCase().split(' ').slice(0, 4).join('-'),
        acknowledgement: handed ? '收到，另開一張單處理按鈕顏色。' : intent.task === 'A' ? '收到，修正登入頁（含手機版）的 Submit 拼字，完成後回報 PR。' : '收到，修 docs/theme.md 的失效連結並檢查全文連結，完成後回 PR。' })
    }
    if (intent.kind === 'answer') return decide({ kind: 'ignore', reason: 'already answered inside the colour ticket' })
    if (intent.kind === 'chatter') return decide({ kind: 'ignore', reason: 'ignoredFromCard: plain chat, touches no enabled rule' })
    const assessment: Assessment = intent.kind === 'typo-proposal'
      ? { decision: 'accept', title: 'Fix "Pasword" in settings title', scope: 'copy fix', reason: 'concrete typo with the replacement given', intent_evidence: '"改成 Password 就好"',
          rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'a typo with a specified replacement' }],
          direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'replacement given' } }
      : { decision: 'ignore', title: '-', scope: '-', reason: 'a preference about another product, not a settled request',
          rule_assessments: [{ rule_id: 'copy', matched: false, reason: 'not a copy fix' }],
          direction: { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: true, evidence: '"要是…就好了"' } }
    decide(assessmentOutcome(assessment, settings, candidate.strength))
  }

  const executor: Executor = {
    start(ticket: Ticket, assignment: Assignment) {
      clock.after(2, () => {
        engine.assignmentStarted(ticket.id, assignment.id)
        const task = ticketTask.get(ticket.id) ?? (db.prepare('SELECT task FROM sa_worktree WHERE ticket = ?').get(ticket.id) as { task: TaskId }).task
        ticketTask.set(ticket.id, task)
        const saved = db.prepare('SELECT done, phase FROM sa_worktree WHERE ticket = ?').get(ticket.id) as { done: number; phase: string } | undefined
        const phase = (saved?.phase ?? 'first') as keyof typeof WORK[TaskId]
        const steps = (WORK[task][phase] ?? []).slice(saved?.done ?? 0)
        if (!saved) db.prepare("INSERT INTO sa_worktree VALUES (?,?,0,'first')").run(ticket.id, task)
        const old = workers.get(ticket.id)
        const worker: Worker = { ticketId: ticket.id, task, steps, busy: false, context: old?.context ?? WORKER_SYSTEM + 1500, inbox: [], recovering: !!saved }
        if (worker.recovering) worker.steps.unshift({ label: 'recovery note: inspect worktree, git log and GitHub before repeating anything', seconds: 60, output: 1500 })
        workers.set(ticket.id, worker)
        rec.note(clock.now, `WORKER ${ticket.id} (${task}) starts${worker.recovering ? ' after restart' : ''}`)
        next(worker)
      })
    },
    deliver(ticket: Ticket) {
      clock.after(1, () => {
        const fresh = repo.tickets.get(ticket.id)!
        const assignment = runningAssignment(fresh)
        const worker = workers.get(ticket.id)
        if (!assignment || !worker || fresh.ended) return
        const ids = [...fresh.undelivered]
        if (!ids.length) return
        engine.inputsDelivered(ticket.id, assignment.id, ids)
        worker.inbox.push(...ids)
        if (!worker.busy) next(worker)
      })
    },
    stop(ticket: Ticket) {
      const worker = workers.get(ticket.id)
      if (worker && stopArrived !== undefined && ticket.ended?.by === 'human') rec.wasted += clock.now - Math.max(stopArrived, worker.started ?? 0)
      if (worker) { worker.steps = []; worker.busy = true; rec.note(clock.now, `WORKER ${ticket.id} stopped`) }
    },
  }

  /** One worker step: a model call over its own context, then the tool time; Inputs that arrived meanwhile are read at the boundary. */
  function next(worker: Worker) {
    const ticket = repo.tickets.get(worker.ticketId)
    if (!ticket || ticket.ended) return
    if (worker.inbox.length) return readInputs(worker)
    const step = worker.steps.shift()
    if (!step) { worker.busy = false; return }
    worker.busy = true
    worker.started = clock.now
    rec.call({ at: clock.now, session: `worker-${worker.task}`, role: 'worker', prompt: worker.context, purpose: step.label })
    worker.context += MODEL_OUTPUT + step.output
    clock.after(MODEL_SECONDS + step.seconds, () => finish(worker, step))
  }
  function readInputs(worker: Worker) {
    const ids = worker.inbox.splice(0)
    worker.busy = true
    rec.call({ at: clock.now, session: `worker-${worker.task}`, role: 'worker', prompt: worker.context + CARD, purpose: 'read new inputs' })
    worker.context += CARD
    clock.after(MODEL_SECONDS, () => {
      const ticket = repo.tickets.get(worker.ticketId)!
      if (ticket.ended) return
      const inputs = ticket.inputs.filter(input => ids.includes(input.id))
      engine.inputsRead(ticket.id, ids)
      for (const input of inputs) {
        const triggerId = input.kind === 'trigger' ? input.triggerId : undefined
        const intent = triggerId && messages.has(triggerId) ? intentOf(triggerId) : undefined
        if (!intent) continue
        if (intent.kind === 'ci-failed') { worker.steps.push(...WORK[worker.task].afterCi ?? []); setPhase(worker, 'afterCi') }
        if (intent.kind === 'answer') { worker.steps.push(...WORK[worker.task].afterAnswer ?? []); setPhase(worker, 'afterAnswer'); engine.report(ticket.id, { state: 'progress', summary: 'answer received', question: null }) }
        if (intent.kind === 'scope-creep') {
          const queued = engine.handback(ticket.id, triggerId!, 'a colour change is a separate design request, beyond this typo ticket')
          rec.note(clock.now, `HANDBACK ${triggerId} from ${ticket.id} (queued for Eval: ${queued})`)
        }
      }
      next(worker)
    })
  }
  function setPhase(worker: Worker, phase: string) { db.prepare('UPDATE sa_worktree SET phase = ?, done = 0 WHERE ticket = ?').run(phase, worker.ticketId) }
  function finish(worker: Worker, step: Step) {
    const ticket = repo.tickets.get(worker.ticketId)
    if (!ticket || ticket.ended) { rec.wasted += 0; return }
    if (!step.label.startsWith('recovery')) db.prepare('UPDATE sa_worktree SET done = done + 1 WHERE ticket = ?').run(worker.ticketId)
    rec.note(clock.now, `WORKER ${worker.task} done: ${step.label}`)
    if (step.pr) { engine.bindThread(ticket.id, { source: 'github', id: step.pr }, true); engine.report(ticket.id, { state: 'progress', summary: `PR #${step.pr} opened` }) }
    if (step.ask) {
      engine.report(ticket.id, { state: 'waiting', summary: 'needs a colour decision', question: step.ask })
      mainCall('relay worker_attention', () => engine.reply({ purpose: 'attention', ticketId: ticket.id, question: step.ask, text: step.ask! }))
    }
    if (step.ready) {
      engine.report(ticket.id, { state: 'ready', summary: `${ticket.title}: done` })
      rec.done.set(`task:${worker.task}`, clock.now)
      const after = repo.tickets.get(ticket.id)!
      if (worker.task !== 'A' || !after.ended) mainCall('relay worker_report ready', () => {
        try { engine.reply({ purpose: 'result', ticketId: ticket.id, text: worker.task === 'A' ? 'PR #50 已就緒：Submit 拼字與 e2e 都修好了，請 review。' : `${ticket.title} 的 PR 已就緒，請 review。` }) }
        catch (error) { rec.note(clock.now, `reply refused: ${(error as Error).message}`) }
      })
    }
    if (!worker.steps.length && !worker.inbox.length && !step.ask && !step.ready) engine.report(ticket.id, { state: 'waiting', summary: 'waiting for CI' })
    next(worker)
  }

  function build() {
    engine = new Engine({ repo, scope: sources, policy: () => policy, assessor, executor, outbox, now: iso,
      emit: event => {
        if (event.type === 'ticket.ended' && event.data.outcome === 'merged') {
          const ticket = repo.tickets.get(event.data.ticketId)!
          const chat = ticket.channels.find(channel => channel.source === 'feishu')
          if (chat) outbox.send({ id: `pull-end:${ticket.id}`, channel: chat, text: 'PR #50 已合併。', kind: 'notice', ticketId: ticket.id })
        }
        if (event.type === 'decision.recorded' && !loggedDecisions.has(event.data.decisionId)) {
          const decision = repo.decisions.get(event.data.decisionId)
          if (decision && decision.reason.some(reason => !('code' in reason) || reason.code !== 'said')) rec.note(clock.now, `GATE/ENGINE decision ${decision.kind} on ${decision.triggerIds.join(',')}: ${decision.reason.map(reason => reason.code).join(',')}`)
        }
        if (event.type === 'ticket.ended') rec.note(clock.now, `TICKET ${event.data.ticketId} ended: ${event.data.outcome} by ${event.data.by}`)
      } })
  }
  build()
  const pass = () => { engine.evaluateDue() }
  for (let t = 0; t <= until; t += 2) clock.at(t, pass, true)

  function schedule(event: ScenarioEvent) {
    if (event.type === 'restart') clock.at(event.at, () => {
      rec.note(clock.now, 'HOST RESTART: process memory lost; SQLite state and worktrees survive')
      clock.crash()
      for (const worker of workers.values()) if (worker.busy && worker.started !== undefined && !repo.tickets.get(worker.ticketId)?.ended) {
        rec.wasted += clock.now - worker.started
        rec.note(clock.now, `lost in-flight step of worker ${worker.task}`)
      }
      workers = new Map([...workers].map(([id, worker]) => [id, { ...worker, steps: [], inbox: [], busy: false }]))
      build()
      for (const ticket of repo.tickets.open()) {
        const assignment = runningAssignment(ticket)
        if (assignment) engine.assignmentInterrupted(ticket.id, assignment.id)
      }
    }, true)
    if (event.type === 'merge') clock.at(event.at, () => { rec.note(clock.now, `PR #${event.pr} merged by a person`); engine.threadClosed({ source: 'github', id: event.pr }, 'merged', iso()) }, true)
    if (event.type === 'message') clock.at(event.message.at, () => {
      const message = event.message
      if (message.intent.kind === 'stop') stopArrived = clock.now
      rec.inbound(message)
      const trigger = toTrigger(message)
      const result = engine.receive(trigger)
      const owners = followupOwners(repo.triggers.get(trigger.id) ?? trigger, repo)
      const disposition = repo.triggers.disposition(trigger.id)
      rec.note(clock.now, `IN ${message.platform}/${message.room} ${message.name}: ${message.text}  -> ${result}${disposition?.filtered ? ` (${disposition.filtered.code})` : ''}${owners.length ? ` fan-out to ${owners.join(',')}` : ''}`)
      if (result === 'stored' && trigger.human && owners.length) mainCall(`relay follow_up ${trigger.id}`, () => {
        if (message.intent.kind !== 'stop') return
        const decision = engine.decide(trigger.id, { kind: 'stop', ticketId: owners[0]!, reason: 'the requester asked to stop' })
        rec.note(clock.now, `DECISION ${decision.kind} ${owners[0]}`)
      })
    }, true)
  }
  SCENARIO.forEach(schedule)
  rec.onPost = post => {
    const key = reactionTo(post.text)
    const reaction = REACTIONS.find(item => item.on === key)
    if (!reaction) return
    const at = clock.now + reaction.delay
    schedule(reaction.event.type === 'message' ? { type: 'message', message: { ...reaction.event.message, at } } : { ...reaction.event, at } as ScenarioEvent)
  }
  clock.run(until)
  const decisions = repo.tickets.list().length
  return { rec, tickets: repo.tickets.list(), decisionCount: (db.prepare('SELECT COUNT(*) AS n FROM sa_decision').get() as { n: number }).n, decisions, mainContext, workers, at: fmt(clock.now) }
}
