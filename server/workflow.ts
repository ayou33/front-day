import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canArchiveTask, canEditTask, isApiExecutor, terminalStatuses } from '../shared/contracts.ts'
import type { Attempt, AttemptFileChanges, ContextDifference, ContextSnapshot, Dispatch, Engine, Executor, Project, Run, RunStatus, Stage, StageSnapshot, Template } from '../shared/contracts.ts'
import { taskElements, taskTypeLabel } from '../shared/context.ts'
import { sessionFrom } from '../shared/continuations.ts'
import { applyApiRestrictions, sharing, usesProjectFiles } from '../shared/task-context.ts'
import { approvalLabels } from '../shared/engines.ts'
import type { ApprovalMode } from '../shared/engines.ts'
import type { Preferences } from '../shared/preferences.ts'
import { checkEngine, findExecutable } from './engine-connections.ts'
import { compatibleSession, projectEntries, resumeHistoryLimit, saveHandoff, stamp } from './continuations.ts'
import { buildPrompts, originalContext } from './run-prompt.ts'
import type { ContextSource } from './run-prompt.ts'
import type { ContextEntry } from './continuations.ts'
import { forkSource } from './conversations.ts'
import { EngineSession } from './engines.ts'
import type { EngineHooks } from './engines.ts'
import { HttpError, errorMessage } from './errors.ts'
import { changedWorkspaceFiles, workspaceContents } from './file-acceptance.ts'
import { ModelApiSession } from './model-api-session.ts'
import type { ReadLocalContext } from './model-api-session.ts'
import { CommandProcess } from './processes.ts'
import { projectDirectory, resolveResource, withinDirectory } from './resources.ts'
import type { JsonObject } from './rpc.ts'
import { Store } from './storage.ts'

type Followup = { text: string; seq: number; delivered: Promise<boolean> }
type Control = {
  run: Run; abort: AbortController; followups: Followup[]; agent?: EngineSession | ModelApiSession; command?: CommandProcess
  gate?: ReturnType<typeof Promise.withResolvers<'next' | 'followup'>>; done?: Promise<void>; stopTimer?: NodeJS.Timeout; turn?: number
}

const runningStatuses = new Set<RunStatus>(['running', 'waiting_input', 'waiting_approval', 'waiting_stage'])
const time = () => new Date().toISOString()
const maxRecordedFiles = 200
const taskTitle = (input: Pick<Dispatch, 'title' | 'goal'>) => input.title ?? input.goal!.split(/\r?\n/, 1)[0].trim().slice(0, 150)

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

  requireUnarchivedRun(id: string) {
    const run = this.requireRun(id)
    if (run.archivedAt) throw new HttpError(409, '请先恢复归档任务')
    return run
  }

  private requireEditableRun(id: string) {
    const run = this.requireUnarchivedRun(id)
    if (!canEditTask(run)) throw new HttpError(409, '只有已保存且未开始的任务可以编辑')
    return run
  }

  recover() {
    for (const run of this.store.listRuns()) {
      if (terminalStatuses.has(run.status) || run.status === 'saved') continue
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
    const parent = input.continuation && this.requireUnarchivedRun(input.continuation.parentId)
    if (parent && (!['succeeded', 'interrupted'].includes(parent.status) || parent.project.id !== project.id || parent.iteration?.id !== iteration?.id)) {
      throw new HttpError(400, '请选择同项目和迭代中已完成或已中断的来源任务')
    }
    const catalog = this.store.catalog()
    project.directory = await projectDirectory(project.directory)
    const { resources, taskType, stages } = await this.plan(input, project, template, parent)
    if (parent && input.continuation?.mode === 'resume' && (template || !compatibleSession(parent, project.directory, stages[0]))) {
      throw new HttpError(400, '续接原会话需要沿用工作目录、引擎、模型和运行模式，并直接执行。也可选择用交接摘要开启新会话。')
    }
    if (parent && input.continuation?.mode === 'fork' && (template || !forkSource(this.store, parent, project.directory, stages[0], input.continuation.turn))) {
      throw new HttpError(409, '无法从所选轮次创建分支，请核对项目目录和 Codex 引擎配置')
    }
    const duplicate = this.store.getRun(input.requestId)
    if (duplicate) return duplicate
    if (this.closing) throw new HttpError(503, '服务正在退出')
    if (parent) this.requireUnarchivedRun(parent.id)
    const run: Run = {
      id: input.requestId, title: taskTitle(input), brief: input.brief,
      goal: input.goal, taskType, details: input.details, approvalMode: input.approvalMode, project, iteration, templateName: template?.name ?? '', templateId: template?.id, stages, resources,
      apiFiles: input.apiFiles ?? parent?.apiFiles, apiExcluded: input.apiExcluded ?? parent?.apiExcluded,
      continuation: parent && input.continuation ? { ...input.continuation, parentTitle: parent.title } : undefined,
      accounts: catalog.accounts.filter(account => resources.some(resource => resource.accountId === account.id)),
      started: input.start !== false,
      status: input.start === false ? 'saved' : 'queued', stageIndex: 0, attempts: stages.map(() => []), pending: [], createdAt: time(), updatedAt: time(),
    }
    this.store.saveRun(run)
    if (input.start === false) {
      this.store.append(run, 'system', '任务已保存', { text: '尚未开始执行，可在任务页开始' })
      return this.requireRun(run.id)
    }
    this.pump()
    return this.requireRun(run.id)
  }

  private async plan(input: Dispatch, project: Project, template: Template | undefined, parent?: Run) {
    const catalog = this.store.catalog()
    const preferences = this.preferences()
    const resources = taskElements(catalog.resources, project.id, input.iterationId)
    const taskType = input.taskType ?? preferences.defaultTaskType
    const previousExecutor = parent && (sessionFrom(parent)?.engine ?? parent.stages[parent.stageIndex]?.engine)
    const reuseMode = input.continuation?.mode === 'resume' || input.continuation?.mode === 'fork'
    const configured = this.store.getExecutor(input.engineId || previousExecutor?.id || preferences.defaultEngineId)
    const directStage: Stage = {
      name: taskType ? taskTypeLabel(taskType) : '任务执行', kind: 'agent', prompt: '', engineId: '',
      mode: reuseMode && previousExecutor ? previousExecutor.mode : taskType === 'requirements' ? 'ask' : '',
      resourceIds: [], allResources: true,
      advance: 'auto', testCommand: null, analyzeTest: false, acceptance: input.acceptance,
    }
    const planned = template?.stages ?? [directStage]
    const needsPrimary = planned.some(stage => (stage.kind === 'agent' || stage.analyzeTest) && !stage.engineId)
    const primary = configured ?? (input.engineId || !needsPrimary ? undefined : await this.defaultEngine(catalog.engines, project.directory, catalog.accounts.map(account => account.secretEnv)))
    const stages: StageSnapshot[] = planned.map(stage => {
      const usesEngine = stage.kind === 'agent' || stage.analyzeTest
      const engine = usesEngine ? (stage.engineId ? this.store.getExecutor(stage.engineId) : primary) : null
      const testCommand = stage.kind === 'test' || stage.acceptance === 'test' ? stage.testCommand ?? project.testCommand : null
      if (usesEngine && !engine) throw new HttpError(400, `阶段「${stage.name}」需要选择 Agent 配置`)
      if ((stage.kind === 'test' || stage.acceptance === 'test') && !testCommand) throw new HttpError(400, `请配置阶段「${stage.name}」或项目的测试命令`)
      const resourceIds = stage.allResources ? resources.map(resource => resource.id)
        : stage.resourceIds.filter(resourceId => resources.some(resource => resource.id === resourceId))
      return { ...stage, engine: engine ? { ...engine, mode: stage.mode || engine.mode } : null, resourceIds, testCommand,
        projectTest: testCommand && !stage.testCommand ? true : undefined }
    })
    return { catalog, resources, taskType, stages }
  }

  async update(id: string, input: Dispatch) {
    if (this.closing) throw new HttpError(503, '服务正在退出')
    const run = this.requireEditableRun(id)
    const project = this.store.getConfig('projects', input.projectId)
    if (!project) throw new HttpError(404, '所选项目已删除')
    const template = input.templateId ? this.store.getConfig('templates', input.templateId) : undefined
    if (input.templateId && !template) throw new HttpError(404, '所选流水线模板已删除')
    const iteration = input.iterationId ? this.store.getConfig('iterations', input.iterationId) : undefined
    if (input.iterationId && iteration?.projectId !== project.id) throw new HttpError(400, '请选择当前项目中的迭代')
    if (run.continuation && (input.projectId !== run.project.id || input.iterationId !== run.iteration?.id)) {
      throw new HttpError(400, '续改任务不能更换项目或迭代')
    }
    project.directory = await projectDirectory(project.directory)
    const { catalog, resources, taskType, stages } = await this.plan(input, project, template)
    if (this.requireEditableRun(id).revision !== run.revision) throw new HttpError(409, '任务状态已变更')
    const sameTemplate = run.templateId ? run.templateId === template?.id : run.templateName === (template?.name ?? '')
    if (sameTemplate) for (const [index, stage] of stages.entries()) {
      const prior = run.stages[index]
      if (stage.engine && prior?.kind === stage.kind && (!template || prior.name === stage.name)) stage.promptOverride = prior.promptOverride
    }
    const updated: Run = {
      ...run, title: taskTitle(input), brief: input.brief, goal: input.goal, taskType, details: input.details, approvalMode: input.approvalMode,
      apiFiles: input.apiFiles, apiExcluded: input.apiExcluded, savedContext: run.savedContext ?? this.contextSnapshot(run),
      project, iteration, templateName: template?.name ?? '', templateId: template?.id,
      stages, resources, pending: [], error: undefined,
      accounts: catalog.accounts.filter(account => resources.some(resource => resource.accountId === account.id)),
    }
    this.store.saveRun(updated, true, true)
    this.store.append(updated, 'system', '任务已更新', { text: '任务配置已更新，尚未开始执行' })
    return this.requireRun(updated.id)
  }

  requirePromptStage(id: string, stageIndex: number) {
    const run = this.requireEditableRun(id)
    const stage = run.stages[stageIndex]
    if (!stage) throw new HttpError(404, '找不到任务阶段')
    if (!stage.engine) throw new HttpError(409, '当前阶段没有 Agent 提示词')
    return { run, stage }
  }

  async previewPrompt(id: string, stageIndex: number) {
    const { run, stage } = this.requirePromptStage(id, stageIndex)
    if (stage.promptOverride) return { text: stage.promptOverride, edited: true }
    const latest = this.latestContext(run)
    const { freshPrompt, resumePrompt, useResume, parent, shareHandoff } = await this.preparePrompts(
      { ...run, ...latest, stageIndex }, latest.stages[stageIndex], AbortSignal.timeout(15_000), undefined, true,
    )
    if (this.requireEditableRun(id).revision !== run.revision) throw new HttpError(409, '任务已变更，请重新查看提示词')
    return { text: (useResume && resumePrompt) || freshPrompt(parent, shareHandoff), edited: false }
  }

  async desktopPrompt(id: string, stageIndex: number) {
    const run = this.requireUnarchivedRun(id)
    const snapshot = canEditTask(run) ? { ...run, ...this.latestContext(run), stageIndex } : { ...run, stageIndex }
    const stage = snapshot.stages[stageIndex]
    if (!stage) throw new HttpError(404, '找不到任务阶段')
    const { freshPrompt, parent, shareHandoff } = await this.preparePrompts(
      snapshot, stage, AbortSignal.timeout(15_000), undefined, true, true,
    )
    if (this.requireUnarchivedRun(id).revision !== run.revision && canEditTask(run)) {
      throw new HttpError(409, '任务已更新，请重新复制')
    }
    return { text: freshPrompt(parent, shareHandoff) }
  }

  updatePrompt(id: string, stageIndex: number, text: string | null, revision?: number) {
    const { run, stage } = this.requirePromptStage(id, stageIndex)
    if (revision !== undefined && revision !== (run.revision ?? 0)) throw new HttpError(409, '任务已变更，请重新打开编辑器')
    stage.promptOverride = text ?? undefined
    this.store.saveRun(run, true)
    return run
  }

  private contextSnapshot({ project, iteration, resources, accounts, stages }: Run): ContextSnapshot {
    return { project, iteration, resources, accounts, stages }
  }

  private latestContext(run: Run): ContextSnapshot {
    const catalog = this.store.catalog()
    const project = catalog.projects.find(item => item.id === run.project.id)
    if (!project) throw new HttpError(409, '所属项目已删除，无法读取最新资料')
    const iteration = catalog.iterations.find(item => item.id === run.iteration?.id && item.projectId === project.id)
    if (run.iteration && !iteration) throw new HttpError(409, '所属迭代已删除，无法读取最新资料')
    const resources = taskElements(catalog.resources, project.id, iteration?.id)
    const ids = resources.map(resource => resource.id)
    const stages = run.stages.map((stage, index) => index < run.stageIndex ? stage : {
      ...stage, resourceIds: stage.allResources ? ids : stage.resourceIds.filter(id => ids.includes(id)),
      testCommand: stage.projectTest ? project.testCommand : stage.testCommand,
    })
    const accounts = catalog.accounts.filter(account => resources.some(resource => resource.accountId === account.id))
    return { project, iteration, resources, accounts, stages }
  }

  contextDifference(id: string): ContextDifference {
    const run = this.requireEditableRun(id)
    try {
      const latest = this.latestContext(run)
      const entries = (snapshot: ContextSnapshot) => new Map<string, { label: string; value: unknown }>([
        ['project', { label: '项目背景与配置', value: snapshot.project }],
        ['iteration', { label: '迭代说明', value: snapshot.iteration }],
        ...snapshot.resources.map(resource => [`resource:${resource.id}`,
          { label: `${resource.iterationId ? '迭代' : '项目'}要素 · ${resource.name}`, value: resource }] as const),
        ...snapshot.accounts.map(account => [`account:${account.id}`, { label: `资料账户 · ${account.name}`, value: account }] as const),
      ] as const)
      const before = entries(run)
      const after = entries(latest)
      const changes: ContextDifference['changes'] = []
      const display = (value: unknown) => {
        const text = JSON.stringify(value, null, 2)
        return text && (text.length > 2400 ? text.slice(0, 2400) + '\n… 已截取' : text)
      }
      for (const [id, item] of after) {
        const prior = before.get(id)
        if (!prior) changes.push({ label: item.label, kind: 'added', after: display(item.value) })
        else if (JSON.stringify(prior.value) !== JSON.stringify(item.value)) {
          changes.push({ label: item.label, kind: 'updated', before: display(prior.value), after: display(item.value) })
        }
      }
      for (const [id, item] of before) if (!after.has(id)) changes.push({ label: item.label, kind: 'removed', before: display(item.value) })
      return { changes, version: createHash('sha256').update(JSON.stringify(latest)).digest('hex') }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      return { changes: [], unavailable: error.message }
    }
  }

  async start(id: string, expectedRevision?: number) {
    const control = this.active.get(id)
    if (control) throw new HttpError(409, '任务已经在执行')
    const run = this.requireRun(id)
    if (run.status !== 'saved') throw new HttpError(409, '当前任务无法开始')
    if (expectedRevision !== undefined && expectedRevision !== run.revision) throw new HttpError(409, '任务已变更，请重新核对上下文')
    const latest = this.latestContext(run)
    const directory = await projectDirectory(latest.project.directory)
    if (latest.stages.some(stage => (stage.acceptance === 'test' || stage.kind === 'test') && !stage.testCommand)) {
      throw new HttpError(409, '最新项目配置缺少测试命令，请补充后重试')
    }
    if (this.requireEditableRun(id).revision !== run.revision || JSON.stringify(latest) !== JSON.stringify(this.latestContext(run))) {
      throw new HttpError(409, '任务或项目资料已变更，请重新核对上下文')
    }
    if (this.closing) throw new HttpError(503, '服务正在退出')
    run.savedContext ??= this.contextSnapshot(run)
    Object.assign(run, latest, { project: { ...latest.project, directory } })
    run.started = true
    run.status = 'queued'
    this.store.saveRun(run, true)
    this.store.append(run, 'system', '任务已加入队列', { text: '等待可用工作目录后开始' })
    this.pump()
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
      if (run.status !== 'queued' || run.archivedAt) continue
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

  private runDuration(run: Run) {
    const attempts = run.attempts.flat()
    if (!attempts.length) return undefined
    return attempts.reduce((total, attempt) => {
      const end = attempt.endedAt ?? run.updatedAt
      return total + Math.max(0, Date.parse(end) - Date.parse(attempt.startedAt))
    }, 0)
  }

  private endRun(run: Run, status: 'failed' | 'stopped' | 'interrupted', error?: string) {
    run.durationMs = this.runDuration(run)
    run.error = error
    run.pending = []
    const attempt = run.attempts[run.stageIndex]?.at(-1)
    if (attempt?.status === 'running') Object.assign(attempt, { status, endedAt: time(), error })
    this.save(run, status)
    if (error) this.store.append(run, 'system', '执行说明', { text: error })
  }

  private async execute(control: Control) {
    const { run, abort } = control
    run.durationMs = undefined
    try {
      while (run.stageIndex < run.stages.length) {
        abort.signal.throwIfAborted()
        const stage = run.stages[run.stageIndex]
        const attempts = run.attempts[run.stageIndex]
        const attempt: Attempt = { number: attempts.length + 1, status: 'running', startedAt: time() }
        attempts.push(attempt)
        this.save(run, 'running')
        this.store.append(run, 'system', '阶段开始', { text: `${stage.name} · 第 ${attempt.number} 次尝试` })
        const compareWorkspace = stage.kind === 'test' || stage.acceptance === 'test' || !stage.engine || !isApiExecutor(stage.engine)
        const before = compareWorkspace ? await workspaceContents(run.project.directory, abort.signal) : undefined
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
          } else {
            attempt.output = await this.runAgent(control, stage, attempt)
            if (stage.acceptance === 'test') await this.runTest(control, stage, attempt)
          }
          abort.signal.throwIfAborted()
          attempt.fileChanges = await this.collectFileChanges(run.project.directory, before, control.agent, abort.signal)
          this.assessAttempt(stage, attempt)
          const hasNext = run.stageIndex + 1 < run.stages.length
          const needsReview = attempt.acceptance?.status === 'blocked' || attempt.acceptance?.status === 'failed'
            || (!!stage.acceptance && attempt.acceptance?.status === 'unchecked')
          if (hasNext && (stage.advance === 'manual' || needsReview)) {
            const followedUp = await this.waitForGate(control, attempt)
            if (followedUp && stage.acceptance === 'test') await this.runTest(control, stage, attempt)
            if (followedUp || before) {
              attempt.fileChanges = await this.collectFileChanges(run.project.directory, before, control.agent, abort.signal)
              this.assessAttempt(stage, attempt)
            }
          }
          abort.signal.throwIfAborted()
          Object.assign(attempt, { status: 'succeeded', endedAt: time() })
          if (!hasNext) {
            run.durationMs = this.runDuration(run)
            this.save(run, 'succeeded')
            return
          }
          this.save(run, 'running')
        } finally {
          const agent = control.agent
          control.agent = undefined
          try { await agent?.close() }
          finally {
            if (attempt.status === 'running' && (!attempt.fileChanges || abort.signal.aborted)) {
              const signal = AbortSignal.timeout(5000)
              attempt.fileChanges = await this.collectFileChanges(run.project.directory, before, agent, signal).catch(() => undefined) ?? attempt.fileChanges
            }
            control.followups = []
          }
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

  private async collectFileChanges(directory: string, before: Map<string, string> | undefined, agent: Control['agent'], signal: AbortSignal): Promise<AttemptFileChanges> {
    const after = before ? await workspaceContents(directory, signal) : undefined
    if (before && after) {
      const files = changedWorkspaceFiles(before, after)
      return { coverage: 'workspace', files: files.slice(0, maxRecordedFiles), total: files.length }
    }
    if (agent instanceof ModelApiSession) {
      const files = await agent.verifiedChanges(signal)
      return { coverage: 'api', files: files.slice(0, maxRecordedFiles), total: files.length }
    }
    return { coverage: 'unavailable', files: [], total: 0 }
  }

  private assessAttempt(stage: StageSnapshot, attempt: Attempt) {
    const changes = attempt.fileChanges
    const files = changes && changes.coverage !== 'unavailable' ? changes : undefined
    const listed = files?.files.slice(0, 100).map(file => file.path)
    if (attempt.acceptance?.status === 'blocked') attempt.acceptance.files = listed
    else if (stage.kind === 'test' || stage.acceptance === 'test') {
      attempt.acceptance = attempt.test?.code === 0 ? { status: 'passed', message: '配置的测试命令成功退出', files: listed }
        : { status: 'failed', message: attempt.test?.error ?? `测试命令退出码 ${attempt.test?.code ?? attempt.test?.signal ?? '未知'}`, files: listed }
    } else if (stage.acceptance === 'changes') {
      attempt.acceptance = !files ? { status: 'unchecked', message: '工作目录超出可核对范围或文件无法读取' }
        : files.total ? { status: 'passed', message: `已验证 ${files.total} 个文件发生变化`, files: listed }
          : { status: 'failed', message: '未发现符合验收要求的项目文件改动' }
    } else {
      attempt.acceptance = { status: 'unchecked', message: '此阶段未配置自动验收', files: listed }
    }
    if (stage.kind === 'test' && attempt.test?.code !== 0) {
      throw new Error(attempt.test?.error ?? `测试命令退出码 ${attempt.test?.code ?? attempt.test?.signal ?? '未知'}`)
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

  async readContext(id: string, stageIndex: number, entryId?: string, signal = AbortSignal.timeout(15_000), readLocal?: ReadLocalContext) {
    const saved = this.requireUnarchivedRun(id)
    const snapshot = canEditTask(saved) ? { ...saved, ...this.latestContext(saved) } : saved
    const stage = snapshot.stages[stageIndex]
    if (!stage) throw new HttpError(404, '找不到任务阶段')
    const run = stage.engine && isApiExecutor(stage.engine) ? this.effectiveApiRun(snapshot) : snapshot
    const background = projectEntries(run)
    const resources = run.resources.filter(resource => stage.resourceIds.includes(resource.id)
      && (!stage.engine || !isApiExecutor(stage.engine) || sharing(resource, run, stage) !== 'excluded'))
    if (!entryId) return [...background.map(({ id, label }) => ({ id, label })), ...resources.map(resource => ({ id: `resource:${resource.id}`, label: resource.name }))]
    const entry = background.find(item => item.id === entryId)
    if (entry) return entry
    const resource = resources.find(item => `resource:${item.id}` === entryId)
    if (!resource) throw new HttpError(404, '找不到关联的上下文条目')
    try {
      const resolved = await resolveResource(resource, run.accounts, run.project.directory, signal, account => this.store.readAccountPassword(account))
      return resource.kind === 'file' && readLocal ? { ...resolved, local: await readLocal(resolved.content) } : resolved
    }
    catch (error) { throw new HttpError(502, errorMessage(error)) }
  }

  private effectiveApiRun(run: Run): Run {
    return applyApiRestrictions(run, this.store.getConfig('projects', run.project.id), this.store.listConfig('resources'))
  }

  private sessionHasNewerTurns(run: Run, parent: Run, provider: Executor['provider'], source: Attempt) {
    return this.store.listRuns().some(item => item.id !== parent.id && item.project.directory === run.project.directory
      && item.stages.some((stage, index) => stage.engine?.provider === provider && item.attempts[index]?.some(attempt =>
        attempt.contextMode === 'resume' && attempt.sessionId === source.sessionId && attempt.startedAt >= source.startedAt)))
  }

  private async preparePrompts(run: Run, stage: StageSnapshot, signal: AbortSignal, testLogs?: string, preview = false, desktop = false) {
    const origin = this.origin()
    const parent = run.continuation && this.requireRun(run.continuation.parentId)
    const fork = parent && run.continuation?.mode === 'fork'
      ? forkSource(this.store, parent, run.project.directory, stage, run.continuation.turn) : undefined
    const source = parent && run.stageIndex === 0 && !run.templateName && run.continuation?.mode !== 'handoff'
      ? run.continuation?.mode === 'fork' ? fork : compatibleSession(parent, run.project.directory, stage) : undefined
    const history = parent && source ? source.attempt.historyChars ?? this.store.attemptHistorySize(parent.id, source.index, source.attempt.number) : 0
    const canResume = parent && source && (fork || !this.sessionHasNewerTurns(run, parent, stage.engine!.provider, source.attempt))
    const scopeChanged = parent && !!run.details?.scope && run.details.scope !== parent.details?.scope
    const compareContext = !!canResume && (run.continuation?.mode === 'resume' || !!fork ||
      (history <= resumeHistoryLimit && !scopeChanged && run.taskType !== 'migration'))
    const sources: ContextSource[] = []
    const entries = projectEntries(run)
    const missing: string[] = []
    const apiExecutor = !!stage.engine && isApiExecutor(stage.engine)
    if (apiExecutor) run = this.effectiveApiRun(run)
    const restricted = apiExecutor && run.resources.some(resource => sharing(resource, run) === 'excluded')
    for (const id of stage.resourceIds) {
      const resource = run.resources.find(candidate => id === candidate.id)
      try {
        if (!resource) throw new Error(`资源「${id}」已删除`)
        const level = resource.iterationId ? '迭代要素' : '项目要素'
        const entryId = `resource:${resource.id}`
        const detailUrl = `${origin}/api/runs/${encodeURIComponent(run.id)}/context/${encodeURIComponent(entryId)}?stage=${run.stageIndex}`
        if (apiExecutor) {
          const mode = sharing(resource, run, stage)
          if (mode === 'excluded') continue
          if (mode === 'on-demand') {
            const source = { id: entryId, level, reference: true, name: resource.name, category: resource.category,
              source: desktop ? '通过任务资料索引按需读取' : '通过资料工具按需读取', content: desktop ? detailUrl : '', prompt: '' } satisfies ContextSource
            sources.push(source)
            entries.push({ id: entryId, label: resource.name, value: '' })
            continue
          }
        }
        const deferred = resource.kind === 'url' && resource.fetch && (preview || !!stage.promptOverride || (!!parent && !compareContext))
        const resolved = preview && deferred
          ? { name: resource.name, category: resource.category, prompt: resource.prompt, source: '通过任务资料索引读取在线资料',
              content: apiExecutor && !desktop ? entryId : detailUrl }
          : await resolveResource(deferred ? { ...resource, fetch: false } : resource, run.accounts,
              run.project.directory, signal, account => this.store.readAccountPassword(account))
        const reference = resource.kind === 'file' || (resource.kind === 'url' && (!resource.fetch || deferred))
        const file = resource.kind === 'file' ? await stat(resolve(run.project.directory, resolved.content)) : undefined
        sources.push({ id: entryId, level, reference, ...resolved })
        entries.push({ id: entryId, label: resource.name, value: JSON.stringify({ level, ...resolved }),
          version: file ? `${file.size}:${file.mtimeMs}:${file.ctimeMs}` : undefined })
      } catch (error) {
        signal.throwIfAborted()
        if (!preview && !run.goal && !stage.promptOverride) throw error
        const note = errorMessage(error)
        missing.push(note)
        if (!preview) this.store.append(run, 'system', '资料暂不可用', { text: note })
      }
    }
    signal.throwIfAborted()
    const previous = restricted ? undefined : run.attempts[run.stageIndex - 1]?.at(-1)
    const outgoingLogs = restricted && testLogs ? JSON.stringify({ code: run.attempts[run.stageIndex]?.at(-1)?.test?.code }) : testLogs
    const prompts = buildPrompts({
      run, stage, parent, source, previous, sources, entries, missing,
      testLogs: outgoingLogs,
      origin, compareContext, preview, desktop,
      original: source?.attempt.contextStamps ?? (parent && source ? originalContext(parent, source.stage) : []),
    })
    return { ...prompts, parent, source, fork, history, entries, shareHandoff: !restricted }
  }

  private async runAgent(control: Control, stage: StageSnapshot, attempt: Attempt, testLogs?: string) {
    const { run, abort } = control
    const engine = { ...stage.engine!, mode: testLogs === undefined ? stage.engine!.mode : 'ask' as const,
      approvalMode: run.approvalMode ?? stage.engine!.approvalMode }
    if (isApiExecutor(engine) && !this.store.getExecutor(engine.id)) {
      throw new HttpError(409, `厂商配置「${engine.name}」缺少密钥或当前用途不允许执行任务`)
    }
    const executable = isApiExecutor(engine) ? undefined : await findExecutable(engine)
    if (!isApiExecutor(engine) && !executable) throw new Error(`未找到 ${engine.name} 的本地 CLI，请检查引擎设置`)
    const { freshPrompt, resumePrompt, useResume, parent, source, fork, history, entries, shareHandoff } = await this.preparePrompts(run, stage, abort.signal, testLogs)
    this.store.append(run, 'system', isApiExecutor(engine) ? '连接 API' : '连接 Agent', { text: engine.name })
    const hooks: EngineHooks = {
      emit: (kind, name, data) => {
        if (kind === 'agent_text' || kind === 'agent_item') attempt.historyChars = (attempt.historyChars ?? 0) + (JSON.stringify(data)?.length ?? 0)
        if (name === '写入授权已拒绝' || name === '自动拒绝授权') {
          attempt.acceptance = { status: 'blocked', message: '执行中有授权请求被拒绝，请核对目标完成情况' }
        }
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
    }
    const apiRun = isApiExecutor(engine) ? this.effectiveApiRun(run) : run
    const excludedPaths = isApiExecutor(engine) ? await Promise.all(apiRun.resources
      .filter(resource => resource.kind === 'file' && sharing(resource, apiRun, stage) === 'excluded')
      .map(async resource => {
        const path = resolve(run.project.directory, resource.value)
        return { path, actual: await realpath(path).catch(() => path) }
      })) : []
    const connect = () => isApiExecutor(engine)
      ? new ModelApiSession(engine, this.store.modelApiKey(engine.id), run.project.directory, hooks,
          (signal, id, readLocal) => this.readContext(run.id, run.stageIndex, id, signal, readLocal),
          { files: usesProjectFiles(apiRun.project, apiRun), excluded: excludedPaths.flatMap(({ path, actual }) => [path, actual]) })
      : new EngineSession(engine, executable!, run.project.directory, this.excludeEnv(run), hooks)
    let agent = connect()
    control.agent = agent
    let resumed = Boolean(useResume && source?.attempt.sessionId)
    try {
      if (fork && agent instanceof EngineSession) await agent.start(abort.signal, fork.attempt.sessionId, fork.nativeId)
      else await agent.start(abort.signal, resumed ? source?.attempt.sessionId : undefined)
    }
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
    if (agent instanceof ModelApiSession) attempt.apiMetrics = agent.metrics
    attempt.contextStamps = stage.promptOverride ? [] : entries.map(stamp)
    attempt.contextMode = parent ? resumed ? fork ? 'fork' : 'resume' : 'handoff' : undefined
    const prompt = (!stage.promptOverride && resumed && resumePrompt) || freshPrompt(parent, shareHandoff)
    attempt.historyChars = (attempt.historyChars ?? 0) + prompt.length + (resumed ? history : 0)
    this.save(run)
    this.store.append(run, 'input', run.goal ? '发送给 Agent 的任务上下文' : '阶段输入', { text: prompt })
    const output = await this.promptTurn(control, attempt, prompt, run.goal || run.title)
    abort.signal.throwIfAborted()
    return this.drainFollowups(control, output)
  }

  private async promptTurn(control: Control, attempt: Attempt, prompt: string, text: string, followup?: number) {
    const { run, agent, abort } = control
    const turn = this.store.append(run, 'turn', 'started', { text, followup }).seq
    control.turn = turn
    try {
      const output = saveHandoff(attempt, await agent!.prompt(prompt))
      this.store.append(run, 'turn', 'finished', { turn, text: output, status: 'succeeded',
        nativeId: agent instanceof EngineSession ? agent.lastNativeTurnId : undefined })
      return output
    } catch (error) {
      this.store.append(run, 'turn', 'finished', { turn, status: abort.signal.aborted ? 'stopped' : 'failed' })
      throw error
    } finally {
      control.turn = undefined
    }
  }

  private async drainFollowups(control: Control, output: string) {
    while (control.followups.length) {
      control.abort.signal.throwIfAborted()
      const followup = control.followups.shift()!
      if (await followup.delivered) continue
      control.abort.signal.throwIfAborted()
      this.store.append(control.run, 'system', '已发送补充消息', { text: '同一会话的新轮次' })
      const attempt = control.run.attempts[control.run.stageIndex].at(-1)!
      const result = await this.promptTurn(control, attempt, followup.text, followup.text, followup.seq)
      if (result) output = result
    }
    return output
  }

  private syncWaiting(run: Run) {
    if (!runningStatuses.has(run.status) || run.status === 'waiting_stage') return this.save(run)
    this.save(run, run.pending.some(request => request.type === 'approval') ? 'waiting_approval' : run.pending.length ? 'waiting_input' : 'running')
  }

  private async waitForGate(control: Control, attempt: Attempt) {
    let followedUp = false
    for (;;) {
      control.abort.signal.throwIfAborted()
      const gate = Promise.withResolvers<'next' | 'followup'>()
      control.gate = gate
      this.save(control.run, 'waiting_stage')
      if (await gate.promise === 'next') return followedUp
      this.save(control.run, 'running')
      attempt.output = await this.drainFollowups(control, attempt.output ?? '')
      followedUp = true
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
    const seq = this.store.append(control.run, 'input', '补充消息', { text }).seq
    const turn = control.turn
    const delivered = agent.canSteer ? agent.steer(text).then(sent => {
      if (sent) {
        this.store.append(control.run, 'system', '已发送补充消息', { text: '追加到当前轮次' })
        this.store.append(control.run, 'turn', 'supplement', { turn, followup: seq, text })
      }
      return sent
    }).catch(() => false) : Promise.resolve(false)
    control.followups.push({ text, seq, delivered })
    if (control.gate) this.releaseGate(control, 'followup')
  }

  answer(id: string, requestId: string, response: JsonObject) {
    const control = this.active.get(id)
    if (!control?.agent || !runningStatuses.has(control.run.status)) throw new HttpError(409, 'Agent 已停止或请求已过期')
    const interaction = control.run.pending.find(item => item.id === requestId && item.type === 'approval')
    const denied = interaction?.choices?.find(choice => choice.id === response.choice)?.label.includes('拒绝')
    control.agent.answer(requestId, response)
    if (denied) {
      const attempt = control.run.attempts[control.run.stageIndex].at(-1)
      if (attempt) {
        attempt.acceptance = { status: 'blocked', message: '执行中有授权请求被拒绝，请核对目标完成情况' }
        this.save(control.run)
      }
    }
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
    if (control.abort.signal.aborted || terminalStatuses.has(control.run.status)) return
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
    const acceptance = run.attempts[run.stageIndex]?.at(-1)?.acceptance
    const verificationFailed = run.status === 'succeeded' && (acceptance?.status === 'failed' || acceptance?.status === 'blocked')
    if (this.closing || (!verificationFailed && !['failed', 'stopped', 'interrupted'].includes(run.status))) {
      throw new HttpError(409, '当前运行无法重试')
    }
    // A terminal status can arrive while the previous Agent subprocess is still closing.
    await this.active.get(id)?.done
    if (refreshContext) {
      const latest = this.latestContext(run)
      const directory = await projectDirectory(latest.project.directory)
      if (JSON.stringify(latest) !== JSON.stringify(this.latestContext(run))) throw new HttpError(409, '项目资料已变更，请重试')
      if (latest.stages.slice(run.stageIndex).some(stage => (stage.acceptance === 'test' || stage.kind === 'test') && !stage.testCommand)) {
        throw new HttpError(409, '最新项目配置缺少测试命令，请补充后重试')
      }
      Object.assign(run, latest, { project: { ...latest.project, directory } })
    }
    if (this.closing || this.active.has(id) || this.requireRun(id).revision !== run.revision) throw new HttpError(409, '任务状态已变更')
    run.error = undefined
    run.pending = []
    run.started = true
    run.status = 'queued'
    run.durationMs = undefined
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
    const run = this.requireRun(id)
    if (run.continuation) throw new HttpError(409, '请在任务记录中归档或恢复整个会话')
    const runs = this.store.listRuns()
    const ids = new Set([id])
    for (let added = true; added;) {
      added = false
      for (const candidate of runs) {
        if (candidate.continuation && ids.has(candidate.continuation.parentId) && !ids.has(candidate.id)) {
          ids.add(candidate.id)
          added = true
        }
      }
    }
    const targets = runs.filter(candidate => ids.has(candidate.id))
    if (archived) {
      const blocked = targets.find(candidate => !canArchiveTask(candidate))
      if (blocked) throw new HttpError(409, blocked.id === id ? '任务开始且进入非活动状态后方可归档' : '关联的续改任务尚未结束，暂不能归档')
    }
    for (const target of targets) {
      if (archived === !!target.archivedAt) continue
      target.archivedAt = archived ? time() : undefined
      this.save(target)
    }
  }

  async close() {
    this.closing = true
    const controls = [...this.active.values()]
    for (const control of controls) this.stopControl(control)
    await Promise.allSettled(controls.map(control => control.done))
  }
}
