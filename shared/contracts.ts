import type { z } from 'zod'
import type { configSchemas, dispatchSchema } from './schemas.ts'
import type { ApprovalMode } from './engines.ts'
import type { ContextStamp, Handoff } from './continuations.ts'
import type { PromptOptimizerSettings } from './prompt-optimizer.ts'

export type ConfigKind = keyof typeof configSchemas
export type Config<K extends ConfigKind> = z.infer<(typeof configSchemas)[K]>
export type Entity<K extends ConfigKind> = Config<K> & { id: string }
export type Catalog = { [K in ConfigKind]: Entity<K>[] } & { engineAvailability?: EngineAvailability[]; promptOptimizer?: PromptOptimizerSettings }
export type Project = Entity<'projects'>
export type Iteration = Entity<'iterations'>
export type IterationSnapshot = Iteration & {
  scope?: string
  context?: Partial<Record<'requirements' | 'constraints' | 'validation', string>>
}
export type Resource = Entity<'resources'>
export type Account = Entity<'accounts'>
export type Engine = Entity<'engines'>
export type Template = Entity<'templates'>
export type Stage = Template['stages'][number]
export type TestCommand = NonNullable<Project['testCommand']>
export type Provider = Engine['provider']

export type DirectoryEntry = { name: string; path: string; kind: 'directory' | 'file' }
export type DirectoryBrowser = { kind: 'locations'; entries: DirectoryEntry[] }
  | { kind: 'directory'; path: string; parent: string | null; entries: DirectoryEntry[]; selectedFile?: string }

export type Dispatch = z.infer<typeof dispatchSchema>

export type RunStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'waiting_stage'
  | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'interrupted'
export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted'
export type TestResult = { code: number | null; signal: string | null; ms: number; error?: string }
export type Attempt = {
  number: number; status: AttemptStatus; startedAt: string; endedAt?: string; output?: string
  sessionId?: string; error?: string; test?: TestResult; analysisError?: string
  handoff?: Handoff; contextStamps?: ContextStamp[]; historyChars?: number; contextMode?: 'resume' | 'handoff'
}
export type Interaction = {
  id: string; type: 'approval' | 'question' | 'form'; title: string; detail: string
  fields?: { label: string; value: string; code?: boolean }[]; raw?: string
  choices?: { id: string; label: string; reason?: string }[]
  questions?: { id: string; label: string; multiple?: boolean; freeText?: boolean; secret?: boolean; choices: { id: string; label: string }[] }[]
  defaultValue?: string
}
export type StageSnapshot = Stage & { engine: Engine | null; resourceIds: string[] }
export type Run = {
  id: string; title: string; brief: string; goal?: string; taskType?: string; details?: Dispatch['details']; project: Project; templateName: string
  iteration?: IterationSnapshot
  stages: StageSnapshot[]; resources: Resource[]; accounts: Account[]
  continuation?: NonNullable<Dispatch['continuation']> & { parentTitle: string }
  status: RunStatus; stageIndex: number; attempts: Attempt[][]; pending: Interaction[]
  createdAt: string; updatedAt: string; archivedAt?: string; error?: string; revision?: number; approvalMode?: ApprovalMode
}
export type RunSummary = Pick<Run, 'id' | 'title' | 'taskType' | 'status' | 'stageIndex' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
  projectId: string; projectName: string; iterationId?: string; iterationName?: string; templateName: string; stageName: string; stageCount: number
}

export type EventKind = 'state' | 'system' | 'input' | 'agent_text' | 'agent_item' | 'native' | 'test_output' | 'test_result'
export type RunEvent = {
  seq: number; stageIndex: number; attempt: number; at: string; kind: EventKind; name: string; data: unknown
}

export type EngineHealth = {
  provider: Provider; executable: string | null; version?: string
  installed: boolean; connected: boolean; auth: 'ready' | 'required' | 'unknown'; message?: string; authExecutable?: string; sessionReady?: boolean
  codexHome?: string
}
export type EngineAvailability = { id: string; executable: string | null; health?: EngineHealth; codexHome?: string }

export const terminalStatuses = new Set<RunStatus>(['succeeded', 'failed', 'stopped', 'interrupted'])

export const statusLabels: Record<RunStatus, string> = {
  queued: '排队中', running: '运行中', waiting_input: '等待回复', waiting_approval: '等待审批',
  waiting_stage: '等待放行', stopping: '正在停止', succeeded: '已完成', failed: '失败',
  stopped: '已停止', interrupted: '已中断',
}

export type RunState = Pick<Run, 'status' | 'stageIndex' | 'attempts' | 'pending' | 'updatedAt' | 'revision' | 'approvalMode'> & {
  error?: string | null; archivedAt?: string | null; context?: Pick<Run, 'project' | 'iteration' | 'resources' | 'stages' | 'accounts'>
}
