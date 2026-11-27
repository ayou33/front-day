import type { z } from 'zod'
import type { configSchemas, dispatchSchema } from './schemas.ts'
import type { ApprovalMode } from './engines.ts'
import type { ContextStamp, Handoff } from './continuations.ts'
import type { ModelApiProfile, PromptOptimizerSettings } from './prompt-optimizer.ts'

export type ConfigKind = keyof typeof configSchemas
export type Config<K extends ConfigKind> = z.infer<(typeof configSchemas)[K]>
export type Entity<K extends ConfigKind> = Config<K> & { id: string }
export type Catalog = { [K in Exclude<ConfigKind, 'plan-items' | 'plan-day-marks'>]: Entity<K>[] } & {
  engineAvailability?: EngineAvailability[]; modelApis?: ModelApiProfile[]; promptOptimizer?: PromptOptimizerSettings
}
export type Project = Entity<'projects'>
export type PlanItem = Entity<'plan-items'>
export type PlanDayMarks = Entity<'plan-day-marks'>
export type PlanDayMark = PlanDayMarks['marks'][number]
export type Iteration = Entity<'iterations'>
export type IterationSnapshot = Iteration & {
  scope?: string
  context?: Partial<Record<'requirements' | 'constraints' | 'validation', string>>
}
export type Resource = Entity<'resources'>
export type Account = Entity<'accounts'>
export type Engine = Entity<'engines'>
export type ApiExecutor = Omit<ModelApiProfile, 'hasApiKey'> & { kind: 'api'; mode: Engine['mode']; approvalMode?: ApprovalMode }
export type Executor = Engine | ApiExecutor
export function isApiExecutor(executor: Executor): executor is ApiExecutor {
  return 'kind' in executor && executor.kind === 'api'
}
export type Template = Entity<'templates'>
export type Stage = Template['stages'][number]
export type TestCommand = NonNullable<Project['testCommand']>
export type Provider = Engine['provider']

export type DirectoryEntry = { name: string; path: string; kind: 'directory' | 'file' }
export type DirectoryBrowser = { kind: 'locations'; entries: DirectoryEntry[] }
  | { kind: 'directory'; path: string; parent: string | null; entries: DirectoryEntry[]; selectedFile?: string }

export type Dispatch = z.infer<typeof dispatchSchema>

export type RunStatus = 'saved' | 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'waiting_stage'
  | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'interrupted'
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted'
export type Acceptance = { status: 'passed' | 'failed' | 'blocked' | 'unchecked'; message: string; files?: string[] }
export type FileChange = { path: string; kind: 'added' | 'modified' | 'deleted' }
export type AttemptFileChanges = { files: FileChange[]; total: number; coverage: 'workspace' | 'api' | 'unavailable' }
export type ApiMetrics = { rounds: number; elapsedMs: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; measuredRounds: number }
export type TestResult = { code: number | null; signal: string | null; ms: number; error?: string }
export type Attempt = {
  number: number; status: AttemptStatus; startedAt: string; endedAt?: string; output?: string
  sessionId?: string; error?: string; test?: TestResult; analysisError?: string
  handoff?: Handoff; contextStamps?: ContextStamp[]; historyChars?: number; contextMode?: 'resume' | 'handoff'
  acceptance?: Acceptance; apiMetrics?: ApiMetrics; fileChanges?: AttemptFileChanges
}
export type Interaction = {
  id: string; type: 'approval' | 'question' | 'form'; title: string; detail: string
  fields?: { label: string; value: string; code?: boolean }[]; raw?: string
  choices?: { id: string; label: string; reason?: string }[]
  questions?: { id: string; label: string; multiple?: boolean; freeText?: boolean; secret?: boolean; choices: { id: string; label: string }[] }[]
  defaultValue?: string
  change?: { beforeBytes: number; afterBytes: number; preview: string }
}
export type StageSnapshot = Stage & { engine: Executor | null; resourceIds: string[]; promptOverride?: string; projectTest?: boolean }
export type AgentPromptPreview = { text: string; edited: boolean }
export type ContextSnapshot = Pick<Run, 'project' | 'iteration' | 'resources' | 'accounts' | 'stages'>
export type ContextDifference = {
  changes: { label: string; kind: 'added' | 'removed' | 'updated'; before?: string; after?: string }[]
  version?: string
  unavailable?: string
}
export type Run = {
  id: string; title: string; brief: string; goal?: string; taskType?: string; details?: Dispatch['details']; project: Project; templateName: string; templateId?: string
  iteration?: IterationSnapshot
  stages: StageSnapshot[]; resources: Resource[]; accounts: Account[]
  continuation?: NonNullable<Dispatch['continuation']> & { parentTitle: string }
  status: RunStatus; stageIndex: number; attempts: Attempt[][]; pending: Interaction[]
  started?: boolean
  apiFiles?: boolean; apiExcluded?: string[]; savedContext?: ContextSnapshot
  createdAt: string; updatedAt: string; archivedAt?: string; error?: string; revision?: number; approvalMode?: ApprovalMode; durationMs?: number
}
export type ArchivedRun = Pick<Run, 'id' | 'title' | 'status' | 'started' | 'updatedAt' | 'revision'> & {
  archivedAt: string
  project: Pick<Project, 'name'>
  iteration?: Pick<IterationSnapshot, 'name'>
}
export type RunRecord = Run | ArchivedRun

export function archivedRun(run: Run, archivedAt: string): ArchivedRun {
  return {
    id: run.id, title: run.title, status: run.status, started: run.started,
    updatedAt: run.updatedAt, revision: run.revision, archivedAt,
    project: { name: run.project.name },
    iteration: run.iteration && { name: run.iteration.name },
  }
}

export type RunSummary = Pick<Run, 'id' | 'title' | 'taskType' | 'status' | 'stageIndex' | 'started' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'durationMs'> & {
  projectId: string; projectName: string; iterationId?: string; iterationName?: string; templateName: string; stageName: string; stageCount: number
  continuation?: Run['continuation']; contextMode?: Attempt['contextMode']
}
export type RunGroup = { source: RunSummary; runs: RunSummary[] }
export type RunPage = { records: RunGroup[]; next?: string; scopeHasRuns: boolean;
  projects: { id: string; name: string }[]; iterations: { id: string; name: string; projectId: string }[] }

export type EventKind = 'state' | 'system' | 'input' | 'agent_text' | 'agent_item' | 'native' | 'test_output' | 'test_result'
export type RunEvent = {
  seq: number; stageIndex: number; attempt: number; at: string; kind: EventKind; name: string; data: unknown
}

export type EngineHealth = {
  provider: Provider; executable: string | null; version?: string
  installed: boolean; connected: boolean; auth: 'ready' | 'required' | 'unknown'; message?: string; authExecutable?: string; sessionReady?: boolean
  codexHome?: string
  projectId?: string; workingDirectory?: string
}
export type EngineAvailability = { id: string; executable: string | null; health?: EngineHealth; codexHome?: string }

export const terminalStatuses = new Set<RunStatus>(['succeeded', 'failed', 'stopped', 'interrupted'])
export function canArchiveTask(run: Pick<Run, 'status' | 'started'>) {
  return terminalStatuses.has(run.status) && (run.status !== 'stopped' || run.started === true)
}
export function canEditTask(run: Pick<Run, 'status' | 'archivedAt' | 'started'>) {
  return !run.archivedAt && run.status === 'saved' && run.started !== true
}

export const statusLabels: Record<RunStatus, string> = {
  saved: '待开始', queued: '排队中', running: '运行中', waiting_input: '等待回复', waiting_approval: '等待审批',
  waiting_stage: '等待放行', stopping: '正在停止', succeeded: '已完成', failed: '失败',
  stopped: '已停止', interrupted: '已中断',
}

export type RunState = Pick<Run, 'status' | 'stageIndex' | 'attempts' | 'pending' | 'started' | 'updatedAt' | 'revision' | 'approvalMode' | 'durationMs'> & {
  error?: string | null; archivedAt?: string | null; context?: ContextSnapshot & Pick<Run, 'savedContext'>
  task?: Pick<Run, 'title' | 'goal' | 'brief' | 'details' | 'taskType' | 'apiFiles' | 'apiExcluded'>
}
