/**
 * The mock IM and the shared database: every inbound message, every post an agent makes, every model call and every
 * notable event goes into one SQLite file, keyed by architecture, so the report reads one source of truth.
 */
import { DatabaseSync } from 'node:sqlite'
import type { ImMessage } from './scenario.ts'

export type Arch = 'superagent' | 'classic' | 'delegating'
export interface Post { arch: Arch; at: number; platform: string; room: string; thread: string; text: string; kind: string; id: string }
export interface Call { arch: Arch; at: number; session: string; role: string; prompt: number; purpose: string }

export class Recorder {
  readonly posts: Post[] = []
  readonly calls: Call[] = []
  readonly log: { at: number; text: string }[] = []
  readonly firstReply = new Map<string, number>()
  readonly done = new Map<string, number>()
  wasted = 0
  onPost?: (post: Post) => void
  constructor(readonly db: DatabaseSync, readonly arch: Arch) {}
  static open(file: string): DatabaseSync {
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE IF NOT EXISTS im_message (arch TEXT, at INTEGER, id TEXT, platform TEXT, room TEXT, thread TEXT, sender TEXT, bot INTEGER, mention INTEGER, text TEXT);
      CREATE TABLE IF NOT EXISTS im_post (arch TEXT, at INTEGER, id TEXT, platform TEXT, room TEXT, thread TEXT, kind TEXT, text TEXT);
      CREATE TABLE IF NOT EXISTS llm_call (arch TEXT, at INTEGER, session TEXT, role TEXT, prompt_chars INTEGER, purpose TEXT);
      CREATE TABLE IF NOT EXISTS event_log (arch TEXT, at INTEGER, text TEXT);`)
    return db
  }
  inbound(message: ImMessage): void {
    this.db.prepare('INSERT INTO im_message VALUES (?,?,?,?,?,?,?,?,?,?)').run(this.arch, message.at, message.id, message.platform, message.room, message.thread,
      message.sender, message.bot ? 1 : 0, message.mention ? 1 : 0, message.text)
  }
  post(post: Omit<Post, 'arch'>, request?: string): void {
    this.posts.push({ arch: this.arch, ...post })
    this.db.prepare('INSERT INTO im_post VALUES (?,?,?,?,?,?,?,?)').run(this.arch, post.at, post.id, post.platform, post.room, post.thread, post.kind, post.text)
    if (request && !this.firstReply.has(request)) this.firstReply.set(request, post.at)
    this.onPost?.({ arch: this.arch, ...post })
    this.note(post.at, `POST ${post.platform}/${post.room}#${post.thread} [${post.kind}] ${post.text}`)
  }
  call(call: Omit<Call, 'arch'>): void {
    this.calls.push({ arch: this.arch, ...call })
    this.db.prepare('INSERT INTO llm_call VALUES (?,?,?,?,?,?)').run(this.arch, call.at, call.session, call.role, call.prompt, call.purpose)
  }
  note(at: number, text: string): void {
    this.log.push({ at, text })
    this.db.prepare('INSERT INTO event_log VALUES (?,?,?)').run(this.arch, at, text)
  }
}

/** A discrete-event clock: callbacks run in time order, ties in scheduling order; `epoch` cancels a process's timers on restart. */
export class Clock {
  now = 0
  private seq = 0
  private queue: { at: number; seq: number; epoch: number | null; run: () => void }[] = []
  epoch = 0
  at(at: number, run: () => void, durable = false): void {
    this.queue.push({ at: Math.max(at, this.now), seq: this.seq++, epoch: durable ? null : this.epoch, run })
  }
  after(seconds: number, run: () => void, durable = false): void { this.at(this.now + seconds, run, durable) }
  /** A process restart: drops every pending non-durable callback. */
  crash(): void { this.epoch++ }
  run(until: number): void {
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = this.queue.shift()
      if (!next || next.at > until) return
      this.now = next.at
      if (next.epoch === null || next.epoch === this.epoch) next.run()
    }
  }
}
export const fmt = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
