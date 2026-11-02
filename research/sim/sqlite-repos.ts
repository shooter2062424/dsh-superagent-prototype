/**
 * A durable implementation of the core's `Repositories` port on node:sqlite, so a simulated host restart builds a new
 * Engine over the same file. Rows are JSON documents; ordering matches MemoryRepositories (tickets newest first).
 */
import { DatabaseSync } from 'node:sqlite'
import { latestAssignment, type Decision, type Repositories, type Thread, type Ticket, type Trigger, type TriggerDisposition } from '../../src/core/index.ts'

const TABLES = ['trigger', 'disposition', 'thread', 'ticket', 'decision'] as const
type Table = typeof TABLES[number]

export class SqliteRepositories implements Repositories {
  private depth = 0
  constructor(readonly db: DatabaseSync) {
    for (const table of TABLES) db.exec(`CREATE TABLE IF NOT EXISTS sa_${table} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, json TEXT NOT NULL)`)
  }
  private get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT json FROM sa_${table} WHERE id = ?`).get(id) as { json: string } | undefined
    return row ? JSON.parse(row.json) as T : undefined
  }
  private put(table: Table, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO sa_${table} (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(id, JSON.stringify(value))
  }
  private all<T>(table: Table, order: 'ASC' | 'DESC' = 'ASC'): T[] {
    return (this.db.prepare(`SELECT json FROM sa_${table} ORDER BY seq ${order}`).all() as { json: string }[]).map(row => JSON.parse(row.json) as T)
  }
  atomic<T>(work: () => T): T {
    const name = `sp${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try { const result = work(); this.db.exec(`RELEASE ${name}`); return result }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
  }
  readonly triggers = {
    get: (id: string) => this.get<Trigger>('trigger', id),
    save: (trigger: Trigger) => this.put('trigger', trigger.id, trigger),
    disposition: (id: string) => this.get<TriggerDisposition>('disposition', id),
    saveDisposition: (id: string, value: TriggerDisposition) => this.put('disposition', id, value),
  }
  readonly threads = {
    get: (key: string) => this.get<Thread>('thread', key),
    save: (thread: Thread) => this.put('thread', thread.key, thread),
    list: () => this.all<Thread>('thread'),
    active: () => this.all<Thread>('thread').filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => this.get<Ticket>('ticket', id),
    save: (ticket: Ticket) => this.put('ticket', ticket.id, ticket),
    list: () => this.all<Ticket>('ticket', 'DESC'),
    open: () => this.all<Ticket>('ticket', 'DESC').filter(ticket => !ticket.ended),
    active: () => this.all<Ticket>('ticket', 'DESC').filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => this.get<Decision>('decision', id),
    save: (decision: Decision) => this.put('decision', decision.id, decision),
    byThread: (key: string) => this.all<Decision>('decision').filter(decision => decision.threadKey === key),
  }
}
