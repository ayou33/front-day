import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Account, ApiExecutor, Catalog, Config, ConfigKind, Entity, EventKind, Executor, IterationSnapshot, Run, RunEvent, RunGroup, RunPage, RunState, RunSummary } from '../shared/contracts.ts'
import { legacyIterationElements, taskTypeLabel } from '../shared/context.ts'
import { engineGuides, engineProviders } from '../shared/engines.ts'
import { defaultPromptOptimizer, modelApiId, modelApiName, optimizerProviderOptions, promptOptimizerProviders, supportsApiPurpose } from '../shared/prompt-optimizer.ts'
import type { ModelApiConfig, ModelApiProfile, ModelApiPurpose, PromptOptimizerProvider, PromptOptimizerSelection, PromptOptimizerSettings } from '../shared/prompt-optimizer.ts'
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
const executorSettingsKey = 'executor-settings-v1'
type StoredProfiles = Partial<Record<PromptOptimizerProvider, { model: string; sealed?: string }>>
type StoredApi = ModelApiConfig & { name?: string; purpose?: ModelApiPurpose; sealed?: string }
type StoredExecutors = { optimizer: PromptOptimizerSelection; profiles: StoredProfiles; custom?: Record<string, StoredApi> }
type LegacyOptimizer = { enabled: boolean; provider: PromptOptimizerProvider } & ({ profiles: StoredProfiles } | { model: string; sealed?: string })
type HistoryFilters = { archived: boolean; limit: number; projectId?: string; iterationId?: string; status?: string; query?: string; cursor?: string }

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
      CREATE TABLE IF NOT EXISTS run_summaries (
        id TEXT PRIMARY KEY REFERENCES runs(id), root_id TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
        iteration_id TEXT NOT NULL, iteration_name TEXT NOT NULL, archived INTEGER NOT NULL, status TEXT NOT NULL,
        updated_at TEXT NOT NULL, created_at TEXT NOT NULL, search TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS summary_by_archive ON run_summaries(archived, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS summary_by_project ON run_summaries(archived, project_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS summary_by_iteration ON run_summaries(archived, project_id, iteration_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS summary_by_iteration_only ON run_summaries(archived, iteration_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS summary_scopes ON run_summaries(project_id, iteration_id, project_name, iteration_name);
      CREATE INDEX IF NOT EXISTS summary_by_root ON run_summaries(root_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS summary_by_status ON run_summaries(status);
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
    this.migrateFolderResources()
    this.migrateRunStart()
    this.migrateRunSummaries()
  }

  private migrateRunSummaries() {
    const version = 'run-summaries-v1'
    if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(version)) return
    this.transaction(() => {
      const runs = this.listRuns().reverse()
      const byId = new Map(runs.map(run => [run.id, run]))
      for (const run of runs) {
        let root = run
        const visited = new Set([run.id])
        while (root.continuation) {
          const parent = byId.get(root.continuation.parentId)
          if (!parent || visited.has(parent.id)) break
          root = parent
          visited.add(root.id)
        }
        this.saveSummary(run, root.id)
      }
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(version, 'true')
    })
  }

  private migrateRunStart() {
    const version = 'run-started-v1'
    if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(version)) return
    this.transaction(() => {
      // A stopped task may have left the queue before it recorded an attempt.
      this.db.exec(`
        UPDATE runs SET json = json_set(json, '$.started', json(CASE
          WHEN json_extract(runs.json, '$.status') NOT IN ('saved', 'stopped')
            OR EXISTS (SELECT 1 FROM json_each(runs.json, '$.attempts') WHERE json_array_length(value) > 0)
            OR EXISTS (SELECT 1 FROM run_events WHERE run_id = runs.id
              AND json_extract(run_events.json, '$.kind') = 'state'
              AND json_extract(run_events.json, '$.data.status') = 'queued')
          THEN 'true' ELSE 'false' END))
        WHERE json_type(json, '$.started') IS NULL
      `)
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(version, 'true')
    })
  }

  private migrateFolderResources() {
    const version = 'folder-resources-v1'
    if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(version)) return
    this.transaction(() => {
      for (const resource of this.listConfig('resources')) {
        if ((resource as { kind: string }).kind === 'folder') this.saveConfig('resources', { ...resource, kind: 'file' }, resource.id)
      }
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(version, 'true')
    })
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

  private storedExecutors(): StoredExecutors {
    const current = this.db.prepare('SELECT value AS json FROM settings WHERE key = ?').get(executorSettingsKey)
    if (current) return parse<StoredExecutors>(current)
    const row = this.db.prepare('SELECT value AS json FROM settings WHERE key = ?').get(optimizerKey)
    if (!row) return { optimizer: defaultPromptOptimizer, profiles: {} }
    const saved = parse<LegacyOptimizer>(row)
    const { enabled, provider } = saved
    const profiles = 'profiles' in saved ? saved.profiles : { [provider]: { model: saved.model, sealed: saved.sealed } }
    return { optimizer: { enabled, executorId: modelApiId(provider) }, profiles }
  }

  private saveExecutorSettings(settings: StoredExecutors) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(executorSettingsKey, JSON.stringify(settings))
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(optimizerKey)
  }

  private hasSecrets() {
    const settings = this.storedExecutors()
    return !!this.db.prepare('SELECT 1 FROM account_secrets LIMIT 1').get()
      || [...Object.values(settings.profiles), ...Object.values(settings.custom ?? {})].some(profile => !!profile.sealed)
  }

  private apiEntries(settings: StoredExecutors): [string, StoredApi][] {
    const defaults = promptOptimizerProviders.flatMap(provider => {
      const profile = settings.profiles[provider]
      return profile ? [[modelApiId(provider), { ...profile, provider }] as [string, StoredApi]] : []
    })
    return [...defaults, ...Object.entries(settings.custom ?? {})]
  }

  modelApis(): ModelApiProfile[] {
    return this.apiEntries(this.storedExecutors()).map(([id, { sealed, name, ...api }]) =>
      ({ ...api, id, name: name || modelApiName(api), hasApiKey: !!sealed }))
  }

  getExecutor(id: string, purpose: 'execution' | 'optimization' = 'execution'): Executor | undefined {
    if (!id.startsWith('api:')) return this.getConfig('engines', id)
    const profile = this.modelApis().find(api => api.id === id && api.hasApiKey && supportsApiPurpose(api, purpose))
    if (!profile) return undefined
    const { provider, model, name } = profile
    return { id, provider, model, name, kind: 'api', mode: 'agent' } satisfies ApiExecutor
  }

  promptOptimizer(): PromptOptimizerSettings {
    const { optimizer } = this.storedExecutors()
    const executor = this.getExecutor(optimizer.executorId, 'optimization')
    return { ...optimizer, enabled: optimizer.enabled && !!executor, executorName: executor?.name }
  }

  savePromptOptimizer(optimizer: PromptOptimizerSelection) {
    return this.transaction(() => {
      if (optimizer.enabled && !this.getExecutor(optimizer.executorId, 'optimization')) throw new HttpError(400, '请选择已配置的本地引擎或厂商 API')
      this.saveExecutorSettings({ ...this.storedExecutors(), optimizer })
      return this.promptOptimizer()
    })
  }

  saveModelApi(config: ModelApiConfig & { name?: string; purpose?: ModelApiPurpose }, apiKey: string | null | undefined, id = modelApiId(config.provider)) {
    return this.transaction(() => {
      const settings = this.storedExecutors()
      const previous = this.apiEntries(settings).find(([key]) => key === id)?.[1]
      if (previous && previous.provider !== config.provider) throw new HttpError(400, '已有配置的厂商不可更改，请新建配置')
      const { provider, ...fields } = config
      const legacy = id === modelApiId(provider)
      const sealed = apiKey === null ? undefined : apiKey === undefined ? previous?.sealed
        : this.secrets.seal(apiKey, legacy ? optimizerBinding(provider) : id, !this.hasSecrets())
      const stored = { ...previous, ...fields, provider, sealed }
      if (legacy) settings.profiles[provider] = stored
      else (settings.custom ??= {})[id] = stored
      if (settings.optimizer.executorId === id && (!sealed || !supportsApiPurpose(stored, 'optimization'))) settings.optimizer.enabled = false
      this.saveExecutorSettings(settings)
      return this.modelApis().find(api => api.id === id)!
    })
  }

  deleteModelApi(id: string) {
    this.transaction(() => {
      const settings = this.storedExecutors()
      const entry = this.apiEntries(settings).find(([key]) => key === id)
      if (!entry) throw new HttpError(404, '找不到厂商配置')
      const [, profile] = entry
      if (id === modelApiId(profile.provider)) delete settings.profiles[profile.provider]
      else if (settings.custom) delete settings.custom[id]
      if (settings.optimizer.executorId === id) settings.optimizer = { ...defaultPromptOptimizer }
      this.saveExecutorSettings(settings)
    })
    return { ok: true }
  }

  modelApiKey(profileId: string) {
    const id = profileId.startsWith('api:') ? profileId : modelApiId(profileId as PromptOptimizerProvider)
    const profile = this.apiEntries(this.storedExecutors()).find(([key]) => id === key)?.[1]
    const sealed = profile?.sealed
    const label = profile ? optimizerProviderOptions[profile.provider].label : '所选厂商'
    if (!sealed) throw new HttpError(400, `请先保存 ${label} API Key`)
    const binding = id === modelApiId(profile!.provider) ? optimizerBinding(profile!.provider) : id
    try { return this.secrets.open(sealed, binding) }
    catch { throw new HttpError(409, `无法读取保存的 ${label} API Key，请在「引擎与 API」中重新保存`) }
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
      } else if (kind === 'engines') {
        const settings = this.storedExecutors()
        if (settings.optimizer.executorId === id) this.saveExecutorSettings({ ...settings, optimizer: defaultPromptOptimizer })
      }
      this.db.prepare('DELETE FROM configs WHERE kind = ? AND id = ?').run(kind, id)
    })
  }

  catalog(): Catalog {
    return {
      projects: this.listConfig('projects'), iterations: this.listConfig('iterations'),
      resources: this.listConfig('resources'), templates: this.listConfig('templates'),
      engines: this.listConfig('engines'), accounts: this.listConfig('accounts'), modelApis: this.modelApis(),
    }
  }

  listRuns(): Run[] {
    return this.db.prepare('SELECT json FROM runs ORDER BY created_at DESC, rowid DESC').all().map(parse<Run>)
  }

  summaries(): RunSummary[] {
    return this.db.prepare('SELECT json FROM run_summaries ORDER BY created_at DESC, rowid DESC').all().map(parse<RunSummary>)
  }

  private saveSummary({ id, title, taskType, status, stageIndex, started, createdAt, updatedAt, durationMs, archivedAt,
    project, iteration, templateName, stages, continuation, attempts }: Run, rootId?: string) {
    const root = rootId ?? (continuation && this.db.prepare('SELECT root_id FROM run_summaries WHERE id = ?').get(continuation.parentId)?.root_id) ?? id
    const summary: RunSummary = {
      id, title, taskType, status, stageIndex, started, createdAt, updatedAt, durationMs, archivedAt, projectId: project.id, projectName: project.name, templateName,
      iterationId: iteration?.id, iterationName: iteration?.name,
      stageName: stages[stageIndex]?.name ?? '', stageCount: stages.length,
      continuation, contextMode: continuation && attempts.flat().findLast(attempt => attempt.contextMode)?.contextMode,
    }
    const search = [title, project.name, iteration?.name, taskTypeLabel(taskType)].filter(Boolean).join(' ').toLowerCase()
    this.db.prepare(`INSERT INTO run_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, project_name = excluded.project_name,
      iteration_id = excluded.iteration_id, iteration_name = excluded.iteration_name, archived = excluded.archived,
      status = excluded.status, updated_at = excluded.updated_at, search = excluded.search, json = excluded.json`)
      .run(id, String(root), project.id, project.name, iteration?.id ?? '', iteration?.name ?? '', Number(!!archivedAt), status, updatedAt, createdAt, search, JSON.stringify(summary))
  }

  hasActiveRuns() {
    return !!this.db.prepare("SELECT 1 FROM run_summaries WHERE status IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_stage', 'stopping') LIMIT 1").get()
  }

  recentRuns(project: string, iteration: string | undefined, limit: number) {
    const where = iteration ? ' AND iteration_id = ?' : ''
    return this.db.prepare(`SELECT json FROM run_summaries WHERE archived = 0 AND project_id = ?${where}
      ORDER BY CASE WHEN status = 'saved' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT ?`)
      .all(project, ...(iteration ? [iteration] : []), limit).map(parse<RunSummary>)
  }

  relatedRuns(id: string): RunGroup | undefined {
    const root = this.db.prepare('SELECT root_id FROM run_summaries WHERE id = ?').get(id)?.root_id
    if (typeof root !== 'string') return undefined
    const rows = this.db.prepare('SELECT json FROM run_summaries WHERE root_id = ? ORDER BY created_at DESC, id DESC').all(root).map(parse<RunSummary>)
    const source = rows.find(run => run.id === root) ?? rows.at(-1)
    return source && { source, runs: rows }
  }

  runPage(filters: HistoryFilters): RunPage {
    const where = ['archived = ?']
    const params: (string | number)[] = [Number(filters.archived)]
    for (const [key, value] of [['project_id', filters.projectId], ['iteration_id', filters.iterationId === 'unassigned' ? '' : filters.iterationId], ['status', filters.status]]) {
      if (value !== undefined) { where.push(`${key} = ?`); params.push(value) }
    }
    if (filters.query) {
      where.push(`(instr(search, ?) > 0 OR EXISTS (SELECT 1 FROM configs WHERE
        ((kind = 'projects' AND id = project_id) OR (kind = 'iterations' AND id = iteration_id))
        AND instr(lower(json_extract(configs.json, '$.name')), ?) > 0))`)
      params.push(filters.query.toLowerCase(), filters.query.toLowerCase())
    }
    const filtered = where.join(' AND ')
    const [priority, updated, rootId] = filters.cursor?.split('|', 3) ?? []
    const roots = this.db.prepare(`SELECT root_id, MAX(updated_at) AS latest,
        MAX(CASE WHEN status = 'saved' THEN 1 ELSE 0 END) AS priority
      FROM run_summaries WHERE ${filtered} GROUP BY root_id
      ${updated && rootId ? 'HAVING (priority, latest, root_id) < (?, ?, ?)' : ''}
      ORDER BY priority DESC, latest DESC, root_id DESC LIMIT ?`)
      .all(...params, ...(updated && rootId ? [Number(priority ?? 0), updated, rootId] : []), filters.limit + 1)
    const page = roots.slice(0, filters.limit)
    const records = page.flatMap(({ root_id }) => {
      const runs = this.db.prepare(`SELECT json FROM run_summaries WHERE root_id = ? AND ${filtered} ORDER BY updated_at DESC, id DESC`)
        .all(String(root_id), ...params).map(parse<RunSummary>)
      const row = this.db.prepare('SELECT json FROM run_summaries WHERE id = ?').get(String(root_id))
      const source = row ? parse<RunSummary>(row) : runs[0]
      const forks = this.db.prepare(`SELECT COUNT(*) AS count FROM run_summaries WHERE root_id = ?
        AND json_extract(json, '$.contextMode') = 'fork'`).get(String(root_id))
      return source && runs.length ? [{ source, runs, forkCount: Number(forks?.count ?? 0) }] : []
    })
    const projects = this.db.prepare('SELECT project_id AS id, MAX(project_name) AS name FROM run_summaries GROUP BY project_id').all()
      .map(row => ({ id: String(row.id), name: String(row.name) }))
    const iterations = this.db.prepare("SELECT iteration_id AS id, MAX(iteration_name) AS name, project_id FROM run_summaries WHERE iteration_id <> '' GROUP BY project_id, iteration_id").all()
      .map(row => ({ id: String(row.id), name: String(row.name), projectId: String(row.project_id) }))
    const last = page.at(-1)
    const scopeHasRuns = !!this.db.prepare('SELECT 1 FROM run_summaries WHERE archived = ? LIMIT 1').get(Number(filters.archived))
    return { records, projects, iterations, scopeHasRuns, next: last && roots.length > filters.limit ? `${last.priority}|${last.latest}|${last.root_id}` : undefined }
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT json FROM runs WHERE id = ?').get(id)
    return row && parse<Run>(row)
  }

  saveRun(run: Run, contextChanged = false, taskChanged = false) {
    run.updatedAt = new Date().toISOString()
    run.revision = (run.revision ?? 0) + 1
    const { status, stageIndex, attempts, pending, started, updatedAt, archivedAt, error, approvalMode, revision, durationMs } = run
    const state: RunState = { status, stageIndex, attempts, pending, started, updatedAt, archivedAt: archivedAt ?? null, error: error ?? null, approvalMode, revision, durationMs }
    if (contextChanged) {
      const { project, iteration, resources, stages, accounts, savedContext } = run
      state.context = { project, iteration, resources, stages, accounts, savedContext }
    }
    if (taskChanged) {
      const { title, goal, brief, details, taskType, apiFiles, apiExcluded } = run
      state.task = { title, goal, brief, details, taskType, apiFiles, apiExcluded }
    }
    const event = this.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
        .run(run.id, run.createdAt, JSON.stringify(run))
      this.saveSummary(run)
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
    return event
  }

  history(runId: string, after: number, limit = 500): RunEvent[] {
    return this.db.prepare('SELECT seq, json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, after, limit).map(row => ({ ...parse<RunEvent>(row), seq: Number(row.seq) }))
  }

  conversationEvents(runId: string): RunEvent[] {
    return this.db.prepare(`SELECT seq, json FROM run_events WHERE run_id = ?
      AND (json_extract(json, '$.kind') = 'turn'
      OR (json_extract(json, '$.kind') = 'native' AND json_extract(json, '$.name') = 'turn/completed'))
      ORDER BY seq`).all(runId).map(row => ({ ...parse<RunEvent>(row), seq: Number(row.seq) }))
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
