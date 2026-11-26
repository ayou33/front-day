import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { terminalStatuses } from '../shared/contracts.ts'
import type { Attempt, Dispatch, Engine, Run, RunStatus, Stage, StageSnapshot } from '../shared/contracts.ts'
import { taskElements, taskTypeLabel } from '../shared/context.ts'
import { approvalLabels } from '../shared/engines.ts'
import type { ApprovalMode } from '../shared/engines.ts'
import type { Preferences } from '../shared/preferences.ts'
import { checkEngine, findExecutable } from './engine-connections.ts'
import { compatibleSession, projectEntries, resumeHistoryLimit, saveHandoff, sessionFrom, stamp } from './continuations.ts'
import { buildPrompts, originalContext } from './run-prompt.ts'
import type { ContextSource } from './run-prompt.ts'
import type { ContextEntry } from './continuations.ts'
import { EngineSession } from './engines.ts'
import { HttpError, errorMessage } from './errors.ts'
import { CommandProcess } from './processes.ts'
import { projectDirectory, resolveResource, withinDirectory } from './resources.ts'
import type { JsonObject } from './rpc.ts'
import { Store } from './storage.ts'

type Followup = { text: string; delivered: Promise<boolean> }
type Control = {
  run: Run; abort: AbortController; followups: Followup[]; agent?: EngineSession; command?: CommandProcess
  gate?: ReturnType<typeof Promise.withResolvers<'next' | 'followup'>>; done?: Promise<void>; stopTimer?: NodeJS.Timeout
}

const runningStatuses = new Set<RunStatus>(['running', 'waiting_input', 'waiting_approval', 'waiting_stage'])
const time = () => new Date().toISOString()

export class Workflow {
  private active = new Map<string, Control>()
  private closing = false
  readonly store: Store
  private preferences: () => Preferences
  private origin: () => string

  constructor(store: Store, preferences: () => Preferences, origin: () => string) {
    this.store = store
    this.preferences = preferences
    this.origin = origin
  }

  hasWork() {
    return [...this.active.values()].some(control => !terminalStatuses.has(control.run.status)) || this.store.hasQueuedRuns()
  }

  async waitForCleanup() { await Promise.allSettled([...this.active.values()].map(control => control.done)) }

  requireRun(id: string) {
    const run = this.store.getRun(id)
    if (!run) throw new HttpError(404, '找不到这条运行记录')
    return run
  }

  recover() {
    for (const run of this.store.listRuns()) {
      if (terminalStatuses.has(run.status)) continue
      this.endRun(run, 'interrupted', '服务已重启，可手动重试当前阶段')
    }
  }

  async dispatch(input: Dispatch) {
    if (this.closing) throw new HttpError(503, '服务正在退出')
    const existing = this.store.getRun(input.requestId)
    if (existing) return existing
    const project = this.store.getConfig('projects', input.projectId)
    const template = input.templateId ? this.store.getConfig('templates', input.templateId) : undefined
    if (!project) throw new HttpError(404, '所选项目已删除')
    if (input.templateId && !template) throw new HttpError(404, '所选流水线模板已删除')
    const iteration = input.iterationId ? this.store.getConfig('iterations', input.iterationId) : undefined
    if (input.iterationId && iteration?.projectId !== project.id) throw new HttpError(400, '请选择当前项目中的迭代')
    const parent = input.continuation && this.requireRun(input.continuation.parentId)
    if (parent && (parent.status !== 'succeeded' || parent.project.id !== project.id || parent.iteration?.id !== iteration?.id)) {
      throw new HttpError(400, '请选择同项目和迭代中已完成的来源任务')
    }
    const catalog = this.store.catalog()
    project.directory = await projectDirectory(project.directory)

    const resources = taskElements(catalog.resources, project.id, iteration?.id)
    const preferences = this.preferences()
    const taskType = input.taskType ?? preferences.defaultTaskType
    const configured = catalog.engines.find(engine => engine.id === (input.engineId ?? (parent && sessionFrom(parent)?.engine.id) ?? preferences.defaultEngineId))
    const directStage: Stage = {
      name: taskType ? taskTypeLabel(taskType) : '任务执行', kind: 'agent', prompt: '', engineId: '',
      mode: taskType === 'requirements' ? 'ask' : '', resourceIds: [], allResources: true,
      advance: 'auto', testCommand: null, analyzeTest: false,
    }
    const planned = template?.stages ?? [directStage]
    const needsPrimary = planned.some(stage => (stage.kind === 'agent' || stage.analyzeTest) && !stage.engineId)
    const primary = configured ?? (input.engineId || !needsPrimary ? undefined : await this.defaultEngine(catalog.engines, project.directory, catalog.accounts.map(account => account.secretEnv)))
    const stages: StageSnapshot[] = planned.map(stage => {
      const usesEngine = stage.kind === 'agent' || stage.analyzeTest
      const engine = usesEngine ? (stage.engineId ? catalog.engines.find(candidate => candidate.id === stage.engineId) : primary) : null
      const testCommand = stage.kind === 'test' ? stage.testCommand ?? project.testCommand : null
      if (usesEngine && !engine) throw new HttpError(400, `阶段「${stage.name}」需要选择 Agent 配置`)
      if (stage.kind === 'test' && !testCommand) throw new HttpError(400, `请配置阶段「${stage.name}」或项目的测试命令`)
      const resourceIds = stage.allResources ? resources.map(resource => resource.id)
        : stage.resourceIds.filter(resourceId => resources.some(resource => resource.id === resourceId))
      return { ...stage, engine: engine ? { ...engine, mode: stage.mode || engine.mode } : null, resourceIds, testCommand }
    })
    if (parent && input.continuation?.mode === 'resume' && (template || !compatibleSession(parent, project.directory, stages[0]))) {
      throw new HttpError(400, '续接原会话需要沿用工作目录、引擎、模型和运行模式，并直接执行。也可选择用交接摘要开启新会话。')
    }
    const duplicate = this.store.getRun(input.requestId)
    if (duplicate) return duplicate
    if (this.closing) throw new HttpError(503, '服务正在退出')
    const run: Run = {
      id: input.requestId, title: input.title ?? input.goal!.split(/\r?\n/, 1)[0].trim().slice(0, 150), brief: input.brief,
      goal: input.goal, taskType, details: input.details, approvalMode: input.approvalMode, project, iteration, templateName: template?.name ?? '', stages, resources,
      continuation: parent && input.continuation ? { ...input.continuation, parentTitle: parent.title } : undefined,
      accounts: catalog.accounts.filter(account => resources.some(resource => resource.accountId === account.id)),
      status: 'queued', stageIndex: 0, attempts: stages.map(() => []), pending: [], createdAt: time(), updatedAt: time(),
    }
    this.store.saveRun(run)
    this.pump()
    return this.requireRun(run.id)
  }

  private async defaultEngine(engines: Engine[], cwd: string, excludeEnv: string[]) {
    const checks = await Promise.all(engines.map(async engine => ({ engine, health: await checkEngine(engine, cwd, excludeEnv, false) })))
    const ready = checks.find(({ health }) => health.connected && health.auth === 'ready')
    const connected = checks.find(({ health }) => health.sessionReady && health.auth === 'unknown')
    if (ready || connected) return (ready ?? connected)!.engine
    const installed = checks.filter(({ health }) => health.installed)
    const names = installed.map(({ engine, health }) => `${engine.name}（${health.auth === 'required' ? '需要认证' : health.connected ? '认证待确认' : '连接失败'}）`).join('、')
    throw new HttpError(400, installed.length ? `暂无可自动使用的引擎。${names}。请在「引擎」检查连接。` : '本机未找到 Agent CLI，请在「引擎」查看安装指引或指定路径。')
  }

  private pump() {
    if (this.closing) return
    for (const run of this.store.listRuns().reverse()) {
      if (run.status !== 'queued') continue
      const directory = run.project.directory
      if (this.active.has(run.id) || [...this.active.values()].some(({ run: active }) =>
        withinDirectory(directory, active.project.directory) || withinDirectory(active.project.directory, directory))) continue
      const control: Control = { run, abort: new AbortController(), followups: [] }
      this.active.set(run.id, control)
      control.done = this.execute(control).finally(() => {
        this.active.delete(run.id)
        this.pump()
      })
    }
  }

  private save(run: Run, status?: RunStatus) {
    if (status) run.status = status
    this.store.saveRun(run)
  }

  private endRun(run: Run, status: 'failed' | 'stopped' | 'interrupted', error?: string) {
    run.error = error
    run.pending = []
    const attempt = run.attempts[run.stageIndex]?.at(-1)
    if (attempt?.status === 'running') Object.assign(attempt, { status, endedAt: time(), error })
    this.save(run, status)
    if (error) this.store.append(run, 'system', '执行说明', { text: error })
  }

  private async execute(control: Control) {
    const { run, abort } = control
    try {
      while (run.stageIndex < run.stages.length) {
        abort.signal.throwIfAborted()
        const stage = run.stages[run.stageIndex]
        const attempts = run.attempts[run.stageIndex]
        const attempt: Attempt = { number: attempts.length + 1, status: 'running', startedAt: time() }
        attempts.push(attempt)
        this.save(run, 'running')
        this.store.append(run, 'system', '阶段开始', { text: `${stage.name} · 第 ${attempt.number} 次尝试` })
        try {
          if (stage.kind === 'test') {
            const logs = await this.runTest(control, stage, attempt)
            if (stage.engine) {
              try { attempt.output = await this.runAgent(control, stage, attempt, logs) }
              catch (error) {
                abort.signal.throwIfAborted()
                attempt.analysisError = errorMessage(error)
                this.store.append(run, 'system', '测试解读失败', { text: attempt.analysisError })
              }
            }
            if (attempt.test?.code !== 0) throw new Error(attempt.test?.error ?? `测试命令退出码 ${attempt.test?.code ?? attempt.test?.signal ?? '未知'}`)
          } else attempt.output = await this.runAgent(control, stage, attempt)
          abort.signal.throwIfAborted()
          const hasNext = run.stageIndex + 1 < run.stages.length
          if (hasNext && stage.advance === 'manual') await this.waitForGate(control, attempt)
          abort.signal.throwIfAborted()
          Object.assign(attempt, { status: 'succeeded', endedAt: time() })
          if (!hasNext) {
            this.save(run, 'succeeded')
            return
          }
          this.save(run, 'running')
        } finally {
          const agent = control.agent
          control.agent = undefined
          await agent?.close()
          control.followups = []
        }
        run.stageIndex++
      }
    } catch (error) {
      if (abort.signal.aborted) this.endRun(run, this.closing ? 'interrupted' : 'stopped')
      else this.endRun(run, 'failed', errorMessage(error))
    } finally {
      if (control.stopTimer) clearTimeout(control.stopTimer)
    }
  }

  private excludeEnv(run: Run) {
    return [...run.accounts, ...this.store.listConfig('accounts')].map(account => account.secretEnv)
  }

  private async runTest(control: Control, stage: StageSnapshot, attempt: Attempt) {
    const { run, abort } = control
    const command = stage.testCommand!
    let tail = ''
    this.store.append(run, 'system', '测试命令', { text: [command.program, ...command.args].map(arg => JSON.stringify(arg)).join(' ') })
    const child = new CommandProcess({ ...command, cwd: run.project.directory, excludeEnv: this.excludeEnv(run) }, (stream, text) => {
      tail = `${tail}[${stream}] ${text}`.slice(-18_000)
      this.store.append(run, 'test_output', stream, { text })
    })
    control.command = child
    const result = await child.done
    control.command = undefined
    attempt.test = result
    this.store.append(run, 'test_result', '测试结果', result)
    this.save(run)
    abort.signal.throwIfAborted()
    return JSON.stringify({ command, result, recentLogs: tail }, null, 2)
  }

  async readContext(id: string, stageIndex: number, entryId?: string) {
    const run = this.requireRun(id)
    const stage = run.stages[stageIndex]
    if (!stage) throw new HttpError(404, '找不到任务阶段')
    const background = projectEntries(run)
    const resources = run.resources.filter(resource => stage.resourceIds.includes(resource.id))
    if (!entryId) return [...background.map(({ id, label }) => ({ id, label })), ...resources.map(resource => ({ id: `resource:${resource.id}`, label: resource.name }))]
    const entry = background.find(item => item.id === entryId)
    if (entry) return entry
    const resource = resources.find(item => `resource:${item.id}` === entryId)
    if (!resource) throw new HttpError(404, '找不到关联的上下文条目')
    try { return await resolveResource(resource, run.accounts, run.project.directory, AbortSignal.timeout(15_000), account => this.store.readAccountPassword(account)) }
    catch (error) { throw new HttpError(502, errorMessage(error)) }
  }

  private sessionHasNewerTurns(run: Run, parent: Run, provider: Engine['provider'], source: Attempt) {
    return this.store.listRuns().some(item => item.id !== parent.id && item.project.directory === run.project.directory
      && item.stages.some((stage, index) => stage.engine?.provider === provider && item.attempts[index]?.some(attempt =>
        attempt.contextMode === 'resume' && attempt.sessionId === source.sessionId && attempt.startedAt >= source.startedAt)))
  }

  private async runAgent(control: Control, stage: StageSnapshot, attempt: Attempt, testLogs?: string) {
    const { run, abort } = control
    const engine = testLogs === undefined ? stage.engine! : { ...stage.engine!, mode: 'ask' as const }
    const executable = await findExecutable(engine)
    if (!executable) throw new Error(`未找到 ${engine.name} 的本地 CLI，请检查引擎设置`)
    const parent = run.continuation && this.requireRun(run.continuation.parentId)
    const source = parent && run.stageIndex === 0 && !run.templateName && run.continuation?.mode !== 'handoff'
      ? compatibleSession(parent, run.project.directory, stage) : undefined
    const history = parent && source ? source.attempt.historyChars ?? this.store.attemptHistorySize(parent.id, source.index, source.attempt.number) : 0
    const canResume = parent && source && !this.sessionHasNewerTurns(run, parent, engine.provider, source.attempt)
    const scopeChanged = parent && !!run.details?.scope && run.details.scope !== parent.details?.scope
    const compareContext = canResume && (run.continuation?.mode === 'resume' ||
      (history <= resumeHistoryLimit && !scopeChanged && run.taskType !== 'migration'))
    const sources: ContextSource[] = []
    const entries = projectEntries(run)
    const missing: string[] = []
    for (const id of stage.resourceIds) {
      const resource = run.resources.find(candidate => id === candidate.id)
      try {
        if (!resource) throw new Error(`资源「${id}」已删除`)
        const deferred = !!parent && !compareContext && resource.kind === 'url' && resource.fetch
        const resolved = await resolveResource(deferred ? { ...resource, fetch: false } : resource, run.accounts,
          run.project.directory, abort.signal, account => this.store.readAccountPassword(account))
        const level = resource.iterationId ? '迭代要素' : '项目要素'
        const entryId = `resource:${resource.id}`
        const reference = resource.kind === 'file' || (resource.kind === 'url' && (!resource.fetch || deferred))
        const file = resource.kind === 'file' ? await stat(resolve(run.project.directory, resolved.content)) : undefined
        sources.push({ id: entryId, level, reference, ...resolved })
        entries.push({ id: entryId, label: resource.name, value: JSON.stringify({ level, ...resolved }),
          version: file ? `${file.size}:${file.mtimeMs}:${file.ctimeMs}` : undefined })
      } catch (error) {
        abort.signal.throwIfAborted()
        if (!run.goal) throw error
        const note = errorMessage(error)
        missing.push(note)
        this.store.append(run, 'system', '资料暂不可用', { text: note })
      }
    }
    abort.signal.throwIfAborted()
    const previous = run.attempts[run.stageIndex - 1]?.at(-1)
    const { freshPrompt, resumePrompt, useResume } = buildPrompts({
      run, stage, parent, source, previous, sources, entries, missing, testLogs,
      origin: this.origin(), compareContext,
      original: source?.attempt.contextStamps ?? (parent && source ? originalContext(parent, source.stage) : []),
    })

    this.store.append(run, 'system', '连接 Agent', { text: engine.name })
    const connect = () => new EngineSession({ ...engine, approvalMode: run.approvalMode ?? engine.approvalMode }, executable, run.project.directory, this.excludeEnv(run), {
      emit: (kind, name, data) => {
        if (kind === 'agent_text' || kind === 'agent_item') attempt.historyChars = (attempt.historyChars ?? 0) + (JSON.stringify(data)?.length ?? 0)
        this.store.append(run, kind, name, data)
      },
      request: request => {
        if (abort.signal.aborted) return
        run.pending = [...run.pending.filter(item => item.id !== request.id), request]
        this.syncWaiting(run)
      },
      resolved: id => {
        if (!run.pending.some(request => request.id === id)) return
        run.pending = run.pending.filter(request => request.id !== id)
        this.syncWaiting(run)
      },
    })
    let agent = connect()
    control.agent = agent
    let resumed = Boolean(useResume && source?.attempt.sessionId)
    try { await agent.start(abort.signal, resumed ? source?.attempt.sessionId : undefined) }
    catch (error) {
      if (!resumed || run.continuation?.mode !== 'auto' || abort.signal.aborted) throw error
      await agent.close()
      abort.signal.throwIfAborted()
      this.store.append(run, 'system', '原会话无法恢复，已改用交接摘要', { text: errorMessage(error) })
      resumed = false
      agent = connect()
      control.agent = agent
      await agent.start(abort.signal)
    }
    attempt.sessionId = agent.sessionId
    attempt.contextStamps = entries.map(stamp)
    attempt.contextMode = parent ? resumed ? 'resume' : 'handoff' : undefined
    const prompt = (resumed && resumePrompt) || freshPrompt(parent)
    attempt.historyChars = (attempt.historyChars ?? 0) + prompt.length + (resumed ? history : 0)
    this.save(run)
    this.store.append(run, 'input', run.goal ? '发送给 Agent 的任务上下文' : '阶段输入', { text: prompt })
    const output = await agent.prompt(prompt)
    abort.signal.throwIfAborted()
    return this.drainFollowups(control, saveHandoff(attempt, output))
  }


  private async drainFollowups(control: Control, output: string) {
    while (control.followups.length) {
      control.abort.signal.throwIfAborted()
      const followup = control.followups.shift()!
      if (await followup.delivered) continue
      control.abort.signal.throwIfAborted()
      this.store.append(control.run, 'system', '已发送补充消息', { text: '同一会话的新轮次' })
      const result = await control.agent!.prompt(followup.text)
      const attempt = control.run.attempts[control.run.stageIndex].at(-1)!
      if (result) output = saveHandoff(attempt, result)
    }
    return output
  }

  private syncWaiting(run: Run) {
    if (!runningStatuses.has(run.status) || run.status === 'waiting_stage') return this.save(run)
    this.save(run, run.pending.some(request => request.type === 'approval') ? 'waiting_approval' : run.pending.length ? 'waiting_input' : 'running')
  }

  private async waitForGate(control: Control, attempt: Attempt) {
    for (;;) {
      control.abort.signal.throwIfAborted()
      const gate = Promise.withResolvers<'next' | 'followup'>()
      control.gate = gate
      this.save(control.run, 'waiting_stage')
      if (await gate.promise === 'next') return
      this.save(control.run, 'running')
      attempt.output = await this.drainFollowups(control, attempt.output ?? '')
    }
  }

  advance(id: string) {
    const control = this.active.get(id)
    if (!control?.gate || control.run.status !== 'waiting_stage') throw new HttpError(409, '当前阶段不在等待放行')
    this.store.append(control.run, 'system', '阶段已放行', { text: '继续执行下一阶段' })
    this.releaseGate(control, 'next')
  }

  private releaseGate(control: Control, action: 'next' | 'followup') {
    const gate = control.gate
    control.gate = undefined
    gate?.resolve(action)
  }

  followup(id: string, text: string) {
    const control = this.active.get(id)
    if (!control?.agent?.sessionId || !runningStatuses.has(control.run.status) || (control.run.status === 'waiting_stage' && !control.gate)) {
      throw new HttpError(409, '当前没有可继续的 Agent 会话')
    }
    const agent = control.agent
    const attempt = control.run.attempts[control.run.stageIndex].at(-1)!
    attempt.historyChars = (attempt.historyChars ?? 0) + text.length
    this.store.append(control.run, 'input', '补充消息', { text })
    const delivered = agent.canSteer ? agent.steer(text).then(sent => {
      if (sent) this.store.append(control.run, 'system', '已发送补充消息', { text: '追加到当前轮次' })
      return sent
    }).catch(() => false) : Promise.resolve(false)
    control.followups.push({ text, delivered })
    if (control.gate) this.releaseGate(control, 'followup')
  }

  answer(id: string, requestId: string, response: JsonObject) {
    const control = this.active.get(id)
    if (!control?.agent || !runningStatuses.has(control.run.status)) throw new HttpError(409, 'Agent 已停止或请求已过期')
    control.agent.answer(requestId, response)
    this.store.append(control.run, 'system', '已回复 Agent', { text: '回复已提交给原会话' })
  }

  stop(id: string) {
    const run = this.requireRun(id)
    const control = this.active.get(id)
    if (terminalStatuses.has(run.status) || run.status === 'stopping') return
    if (!control) return this.endRun(run, 'stopped')
    this.stopControl(control)
  }

  private stopControl(control: Control) {
    if (control.abort.signal.aborted) return
    this.save(control.run, 'stopping')
    control.abort.abort()
    control.command?.stop()
    this.releaseGate(control, 'next')
    if (control.agent) {
      void control.agent.interrupt().catch(() => {})
      control.stopTimer = setTimeout(() => { void control.agent?.close() }, 2500)
    }
  }

  async retry(id: string, refreshContext = true) {
    const run = this.requireRun(id)
    if (this.closing || !['failed', 'stopped', 'interrupted'].includes(run.status)) {
      throw new HttpError(409, '当前运行无法重试')
    }
    // A terminal status can arrive while the previous Agent subprocess is still closing.
    await this.active.get(id)?.done
    if (refreshContext) {
      const project = this.store.getConfig('projects', run.project.id)
      if (!project) throw new HttpError(409, '项目已删除。可选择沿用上次上下文重试。')
      const directory = await projectDirectory(project.directory)
      const catalog = this.store.catalog()
      const latest = catalog.projects.find(item => item.id === project.id)
      const iteration = catalog.iterations.find(item => item.id === run.iteration?.id && item.projectId === project.id)
      if (!latest || latest.directory !== project.directory) throw new HttpError(409, '项目目录已变更，请再试一次')
      if (run.iteration && !iteration) throw new HttpError(409, '迭代已删除。可选择沿用上次上下文重试。')
      run.project = { ...latest, directory }
      run.iteration = iteration
      run.resources = taskElements(catalog.resources, project.id, iteration?.id)
      run.accounts = catalog.accounts.filter(account => run.resources.some(resource => resource.accountId === account.id))
      const resourceIds = run.resources.map(resource => resource.id)
      run.stages = run.stages.map((stage, index) => index < run.stageIndex ? stage : {
        ...stage, resourceIds: stage.allResources ? resourceIds : stage.resourceIds.filter(id => resourceIds.includes(id)),
      })
    }
    if (this.closing || this.active.has(id) || this.requireRun(id).revision !== run.revision) throw new HttpError(409, '任务状态已变更')
    run.error = undefined
    run.pending = []
    run.status = 'queued'
    this.store.saveRun(run, refreshContext)
    this.pump()
  }

  updateApproval(id: string, mode: ApprovalMode | undefined) {
    const control = this.active.get(id)
    const run = control?.run ?? this.requireRun(id)
    if (this.closing || terminalStatuses.has(run.status) || run.status === 'stopping') throw new HttpError(409, '当前任务无法更新授权模式')
    run.approvalMode = mode
    const applied = mode ?? run.stages[run.stageIndex]?.engine?.approvalMode ?? 'manual'
    this.save(run)
    this.store.append(run, 'system', '授权模式已更新', { text: approvalLabels[applied] })
    control?.agent?.setApprovalMode(applied)
  }

  setArchived(id: string, archived: boolean) {
    const run = this.active.get(id)?.run ?? this.requireRun(id)
    if (archived === !!run.archivedAt) return
    run.archivedAt = archived ? time() : undefined
    this.save(run)
  }

  async close() {
    this.closing = true
    const controls = [...this.active.values()]
    for (const control of controls) this.stopControl(control)
    await Promise.allSettled(controls.map(control => control.done))
  }
}
