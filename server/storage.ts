import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Account, Catalog, Config, ConfigKind, Entity, EventKind, IterationSnapshot, Run, RunEvent, RunState, RunSummary } from '../shared/contracts.ts'
import { legacyIterationElements } from '../shared/context.ts'
import { engineGuides, engineProviders } from '../shared/engines.ts'
import { defaultPromptOptimizer, optimizerProviderOptions, promptOptimizerProviders } from '../shared/prompt-optimizer.ts'
import type { PromptOptimizerConfig, PromptOptimizerProfile, PromptOptimizerProvider, PromptOptimizerSettings } from '../shared/prompt-optimizer.ts'
import { HttpError } from './errors.ts'
import { AccountSecrets } from './secrets.ts'
import { builtinTemplates, seedStages } from './seed.ts'

function parse<T>(row: { json?: unknown }): T {
  return JSON.parse(String(row.json)) as T
}

function accountBinding(account: Account) {
  return JSON.stringify([account.id, account.origin, account.username])
}

const optimizerKey = 'prompt-optimizer'
type StoredOptimizerProfile = { model: string; sealed?: string }
type StoredOptimizer = Pick<PromptOptimizerConfig, 'enabled' | 'provider'> & {
  profiles: Partial<Record<PromptOptimizerProvider, StoredOptimizerProfile>>
}

function optimizerBinding(provider: PromptOptimizerProvider) {
  // Keep the original binding for previously saved DeepSeek keys.
  return provider === 'deepseek' ? optimizerKey : `${optimizerKey}:${provider}`
}

function lockDatabase(file: string) {
  const lock = new DatabaseSync(`${file}.lock`)
  try { lock.exec('BEGIN EXCLUSIVE'); return lock }
  catch (error) {
    lock.close()
    if (error instanceof Error && /database is locked/i.test(error.message)) throw new HttpError(409, '已有 Front Day 服务使用此数据目录')
    throw error
  }
}

export class Store {
  private db: DatabaseSync
  private runnerLock?: DatabaseSync
  private secrets: AccountSecrets
  private filename: string
  private events = new EventEmitter().setMaxListeners(0)

  constructor(file: string, lock?: DatabaseSync) {
    this.filename = file
    this.secrets = new AccountSecrets(file === ':memory:' ? undefined : `${file}.key`)
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true })
      this.runnerLock = lock ?? lockDatabase(file)
    }
    this.db = new DatabaseSync(file, { open: false })
    try { this.db.open(); this.initialize() }
    catch (error) { this.close(); throw error }
  }

  private initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS configs (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS account_secrets (account_id TEXT PRIMARY KEY, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_events_order ON run_events(run_id, seq);
    `)
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get('seed-v1')) {
      this.transaction(() => {
        this.saveConfig('engines', { name: 'Cursor', provider: 'cursor', executable: '', model: '', mode: 'agent' }, 'cursor-default')
        this.saveConfig('engines', { name: 'Codex', provider: 'codex', executable: '', model: '', mode: 'agent' }, 'codex-default')
        this.saveConfig('templates', { name: '前端交付', description: '串联需求分析、实现和测试验证。', stages: seedStages }, 'frontend-delivery')
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('seed-v1', 'true')
      })
    }
    this.migrateIterationElements()
    const enginesVersion = 'additional-engines-v1'
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(enginesVersion)) this.transaction(() => {
      const configured = this.listConfig('engines')
      for (const provider of engineProviders.slice(2)) {
        if (!configured.some(engine => engine.provider === provider)) {
          this.saveConfig('engines', { name: engineGuides[provider].name, provider, executable: '', model: '', mode: 'agent' }, `${provider}-default`)
        }
      }
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(enginesVersion, 'true')
    })
    this.seedBuiltinTemplates()
  }

  private seedBuiltinTemplates() {
    const version = 'builtin-templates-v1'
    if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(version)) return
    this.transaction(() => {
      for (const template of builtinTemplates) {
        if (!this.getConfig('templates', template.id)) {
          this.saveConfig('templates', { name: template.name, description: template.description, stages: template.stages }, template.id)
        }
      }
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(version, 'true')
    })
  }

  private migrateIterationElements() {
    const version = 'iteration-elements-v1'
    if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(version)) return
    this.transaction(() => {
      const resources = this.listConfig('resources')
      for (const iteration of this.listConfig('iterations') as IterationSnapshot[]) {
        if (iteration.scope === undefined && iteration.context === undefined) continue
        for (const element of legacyIterationElements(iteration)) {
          const exists = resources.some(resource => resource.projectId === iteration.projectId && resource.iterationId === iteration.id && resource.kind === 'text'
            && resource.name === element.name && resource.category === element.category && resource.value === element.value)
          if (!exists) this.saveConfig('resources', { ...element, projectId: iteration.projectId, iterationId: iteration.id,
            kind: 'text', prompt: '', fetch: false, accountId: '' })
        }
        const { id, projectId, name, description } = iteration
        this.saveConfig('iterations', { projectId, name, description: description ?? '' }, id)
      }
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(version, 'true')
    })
  }

  copyTo(filename: string, commit: () => void) {
    const lock = lockDatabase(filename)
    const sidecars = ['-wal', '-shm', '-journal']
    const keyFile = `${filename}.key`
    let ownsDatabase = false
    let ownsKey = false
    let target: Store | undefined
    try {
      if (['', '.key', ...sidecars].some(suffix => lstatSync(filename + suffix, { throwIfNoEntry: false }))) {
        throw new HttpError(409, '目标目录已有 Front Day 数据，请选择其他目录')
      }
      const destination = openSync(filename, 'wx', 0o600)
      ownsDatabase = true
      closeSync(destination)
      this.db.prepare('VACUUM INTO ?').run(filename)
      const sourceKey = `${this.filename}.key`
      if (lstatSync(sourceKey, { throwIfNoEntry: false })) {
        const key = readFileSync(sourceKey)
        if (key.length !== 32) throw new HttpError(409, '当前数据目录中的账户密钥无效')
        const keyDestination = openSync(keyFile, 'wx', 0o600)
        ownsKey = true
        try { writeFileSync(keyDestination, key) } finally { closeSync(keyDestination) }
      } else if (this.hasSecrets()) {
        throw new HttpError(409, '当前数据目录缺少凭据密钥')
      }
      target = new Store(filename, lock)
      commit()
      return target
    } catch (error) {
      if (target) target.close()
      else if (lock.isOpen) lock.close()
      if (ownsDatabase) for (const suffix of ['', ...sidecars]) rmSync(filename + suffix, { force: true })
      if (ownsKey) rmSync(keyFile, { force: true })
      throw error
    }
  }

  hasQueuedRuns() {
    return !!this.db.prepare("SELECT 1 FROM runs WHERE json_extract(json, '$.status') = 'queued' LIMIT 1").get()
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listConfig<K extends ConfigKind>(kind: K): Entity<K>[] {
    return this.db.prepare('SELECT json FROM configs WHERE kind = ? ORDER BY rowid').all(kind).map(parse<Entity<K>>)
  }

  getConfig<K extends ConfigKind>(kind: K, id: string): Entity<K> | undefined {
    const row = this.db.prepare('SELECT json FROM configs WHERE kind = ? AND id = ?').get(kind, id)
    return row && parse<Entity<K>>(row)
  }

  saveConfig<K extends ConfigKind>(kind: K, config: Config<K>, id = randomUUID() as string): Entity<K> {
    const entity = { ...config, id } as Entity<K>
    this.db.prepare('INSERT INTO configs VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json').run(kind, id, JSON.stringify(entity))
    return entity
  }

  saveAccount(config: Config<'accounts'>, password?: string, id = randomUUID() as string) {
    return this.transaction(() => {
      const previous = this.getConfig('accounts', id)
      const account = this.saveConfig('accounts', config, id)
      if (account.credentialSource === 'saved') {
        if (password !== undefined) {
          const sealed = this.secrets.seal(password, accountBinding(account), !this.hasSecrets())
          this.db.prepare('INSERT INTO account_secrets VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET sealed = excluded.sealed').run(id, sealed)
        } else if (previous?.credentialSource !== 'saved' || accountBinding(previous) !== accountBinding(account) || !this.sealedPassword(id)) {
          throw new HttpError(400, '请输入要保存的密码')
        }
      } else this.db.prepare('DELETE FROM account_secrets WHERE account_id = ?').run(id)
      return account
    })
  }

  private sealedPassword(id: string) {
    return this.db.prepare('SELECT sealed FROM account_secrets WHERE account_id = ?').get(id)?.sealed
  }

  private storedOptimizer(): StoredOptimizer {
    const row = this.db.prepare('SELECT value AS json FROM settings WHERE key = ?').get(optimizerKey)
    if (!row) return { enabled: false, provider: defaultPromptOptimizer.provider, profiles: {} }
    const saved = parse<StoredOptimizer | (PromptOptimizerConfig & { sealed?: string })>(row)
    if ('profiles' in saved) return saved
    const { enabled, provider, model, sealed } = saved
    return { enabled, provider, profiles: { [provider]: { model, sealed } } }
  }

  private hasSecrets() {
    return !!this.db.prepare('SELECT 1 FROM account_secrets LIMIT 1').get()
      || Object.values(this.storedOptimizer().profiles).some(profile => !!profile.sealed)
  }

  promptOptimizer(): PromptOptimizerSettings {
    const { enabled, provider, profiles } = this.storedOptimizer()
    const publicProfiles: PromptOptimizerSettings['profiles'] = {}
    for (const id of promptOptimizerProviders) {
      const profile = profiles[id]
      if (profile) publicProfiles[id] = { model: profile.model, hasApiKey: !!profile.sealed }
    }
    const active: PromptOptimizerProfile = publicProfiles[provider] ?? { model: optimizerProviderOptions[provider].models[0], hasApiKey: false }
    return { enabled, provider, ...active, profiles: publicProfiles }
  }

  savePromptOptimizer(config: PromptOptimizerConfig, apiKey: string | null | undefined) {
    return this.transaction(() => {
      const { enabled, provider, model } = config
      const { profiles } = this.storedOptimizer()
      const sealed = apiKey === null ? undefined : apiKey === undefined ? profiles[provider]?.sealed
        : this.secrets.seal(apiKey, optimizerBinding(provider), !this.hasSecrets())
      if (enabled && !sealed) throw new HttpError(400, `启用提示词优化时需保存 ${optimizerProviderOptions[provider].label} API Key`)
      profiles[provider] = { model, sealed }
      this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(optimizerKey, JSON.stringify({ enabled, provider, profiles }))
      return this.promptOptimizer()
    })
  }

  promptOptimizerKey(provider: PromptOptimizerProvider) {
    const sealed = this.storedOptimizer().profiles[provider]?.sealed
    const label = optimizerProviderOptions[provider].label
    if (!sealed) throw new HttpError(400, `请先保存 ${label} API Key`)
    try { return this.secrets.open(sealed, optimizerBinding(provider)) }
    catch { throw new HttpError(409, `无法读取保存的 ${label} API Key，请在配置中重新保存`) }
  }

  readAccountPassword(account: Account) {
    const current = this.getConfig('accounts', account.id)
    const sealed = this.sealedPassword(account.id)
    if (current?.credentialSource !== 'saved' || accountBinding(current) !== accountBinding(account) || typeof sealed !== 'string') {
      throw new Error(`账户「${account.name}」的凭据已变更，请检查资料的账户绑定`)
    }
    try { return this.secrets.open(sealed, accountBinding(account)) }
    catch { throw new Error(`无法读取账户「${account.name}」保存的密码`) }
  }

  deleteConfig(kind: ConfigKind, id: string) {
    this.transaction(() => {
      if (kind === 'projects') {
        this.db.prepare("DELETE FROM configs WHERE kind IN ('iterations', 'resources') AND json_extract(json, '$.projectId') = ?").run(id)
      } else if (kind === 'iterations') {
        this.db.prepare("DELETE FROM configs WHERE kind = 'resources' AND json_extract(json, '$.iterationId') = ?").run(id)
      } else if (kind === 'accounts') {
        this.db.prepare('DELETE FROM account_secrets WHERE account_id = ?').run(id)
      }
      this.db.prepare('DELETE FROM configs WHERE kind = ? AND id = ?').run(kind, id)
    })
  }

  catalog(): Catalog {
    return {
      projects: this.listConfig('projects'), iterations: this.listConfig('iterations'),
      resources: this.listConfig('resources'), templates: this.listConfig('templates'),
      engines: this.listConfig('engines'), accounts: this.listConfig('accounts'),
    }
  }

  listRuns(): Run[] {
    return this.db.prepare('SELECT json FROM runs ORDER BY created_at DESC, rowid DESC').all().map(parse<Run>)
  }

  summaries(): RunSummary[] {
    return this.listRuns().map(({ id, title, taskType, status, stageIndex, createdAt, updatedAt, archivedAt, project, iteration, templateName, stages }) => ({
      id, title, taskType, status, stageIndex, createdAt, updatedAt, archivedAt, projectId: project.id, projectName: project.name, templateName,
      iterationId: iteration?.id, iterationName: iteration?.name,
      stageName: stages[stageIndex]?.name ?? '', stageCount: stages.length,
    }))
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT json FROM runs WHERE id = ?').get(id)
    return row && parse<Run>(row)
  }

  saveRun(run: Run, contextChanged = false) {
    run.updatedAt = new Date().toISOString()
    run.revision = (run.revision ?? 0) + 1
    const { status, stageIndex, attempts, pending, updatedAt, archivedAt, error, approvalMode, revision } = run
    const state: RunState = { status, stageIndex, attempts, pending, updatedAt, archivedAt: archivedAt ?? null, error: error ?? null, approvalMode, revision }
    if (contextChanged) {
      const { project, iteration, resources, stages, accounts } = run
      state.context = { project, iteration, resources, stages, accounts }
    }
    const event = this.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
        .run(run.id, run.createdAt, JSON.stringify(run))
      return this.insertEvent(run, 'state', '执行状态', state)
    })
    this.events.emit(run.id, event)
  }

  private insertEvent(run: Run, kind: EventKind, name: string, data: unknown): RunEvent {
    const event = { stageIndex: run.stageIndex, attempt: run.attempts[run.stageIndex]?.length ?? 0,
      at: new Date().toISOString(), kind, name, data }
    const result = this.db.prepare('INSERT INTO run_events (run_id, json) VALUES (?, ?)').run(run.id, JSON.stringify(event))
    return { ...event, seq: Number(result.lastInsertRowid) }
  }

  append(run: Run, kind: EventKind, name: string, data: unknown) {
    const event = this.insertEvent(run, kind, name, data)
    this.events.emit(run.id, event)
  }

  history(runId: string, after: number, limit = 500): RunEvent[] {
    return this.db.prepare('SELECT seq, json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, after, limit).map(row => ({ ...parse<RunEvent>(row), seq: Number(row.seq) }))
  }

  attemptHistorySize(runId: string, stage: number, attempt: number) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(length(json)), 0) AS size FROM run_events WHERE run_id = ?
      AND json_extract(json, '$.stageIndex') = ? AND json_extract(json, '$.attempt') = ?
      AND json_extract(json, '$.kind') IN ('input', 'agent_text', 'agent_item', 'test_output')`).get(runId, stage, attempt)
    return Number(row?.size ?? 0)
  }

  subscribe(runId: string, callback: (event: RunEvent) => void) {
    this.events.on(runId, callback)
    return () => this.events.off(runId, callback)
  }

  close() {
    if (this.db.isOpen) this.db.close()
    if (this.runnerLock?.isOpen) this.runnerLock.close()
  }
}
