import { createHash } from 'node:crypto'
import { isApiExecutor } from '../shared/contracts.ts'
import type { Attempt, Run, StageSnapshot } from '../shared/contracts.ts'
import type { ContextStamp, Handoff } from '../shared/continuations.ts'
import { legacyIterationElements, projectFields } from '../shared/context.ts'

export const resumeHistoryLimit = 24_000
export const resumeDeltaLimit = 6_000

export const handoffInstruction = `交付结论后，可另起一行给出供后续任务复用的简短交接信息。只记录实际完成与验证的事实；未验证要注明。每项保持简短。格式如下：
<front-day-handoff>{"changes":"已完成的改动","constraints":"仍需遵守的约束和关键决定","files":"相关文件路径","verification":"验证命令和结果"}</front-day-handoff>`

export function excerpt(value: string | undefined, limit: number) {
  const text = value?.trim() ?? ''
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

export function saveHandoff(attempt: Attempt, text: string) {
  const match = /\s*<front-day-handoff>\s*([\s\S]*?)\s*<\/front-day-handoff>\s*$/.exec(text)
  if (!match) return text
  try {
    const { changes, constraints, files, verification } = JSON.parse(match[1])
    if ([changes, constraints, files, verification].every(item => typeof item === 'string')) {
      attempt.handoff = { changes: excerpt(changes, 650), constraints: excerpt(constraints, 420), files: excerpt(files, 380), verification: excerpt(verification, 380) }
      return text.slice(0, match.index).trimEnd() || attempt.handoff.changes
    }
  } catch { /* retain plain output when it does not contain a structured handoff */ }
  return text
}

export function sessionFrom(run: Run) {
  for (let index = run.stages.length - 1; index >= 0; index--) {
    const stage = run.stages[index]
    const attempt = run.attempts[index]?.findLast(item => item.status === 'succeeded' && item.sessionId)
    if (stage.kind === 'agent' && stage.engine && attempt) return { index, stage, engine: stage.engine, attempt }
  }
}

export function compatibleSession(parent: Run, directory: string, stage?: StageSnapshot) {
  const source = sessionFrom(parent)
  const engine = stage?.engine
  if (parent.project.directory !== directory || !source || !engine || stage.kind !== 'agent') return undefined
  const previous = source.engine
  if (isApiExecutor(engine) || isApiExecutor(previous) || engine.id !== previous.id || engine.provider !== previous.provider || engine.executable !== previous.executable
    || engine.model !== previous.model || engine.mode !== previous.mode) return undefined
  return source
}

export function handoffText(parent: Run) {
  const previous = sessionFrom(parent)?.attempt ?? parent.attempts.flat().findLast(item => item.status === 'succeeded' && item.output)
  const summary: Handoff = previous?.handoff ?? {
    changes: excerpt(previous?.output, 650) || excerpt(parent.goal ?? parent.title, 250),
    constraints: excerpt(parent.project.context?.constraints, 420),
    files: excerpt(previous?.output?.match(/`[^`\n]*[\/\\][^`\n]*`/g)?.slice(0, 6).join('、'), 380),
    verification: '',
  }
  const tests = parent.stages.flatMap((stage, index) => {
    const attempt = parent.attempts[index]?.findLast(item => item.status === 'succeeded' && item.test)
    return attempt?.test ? [`${stage.name} · 退出码 ${attempt.test.code ?? '未知'}`] : []
  }).join('；')
  return [
    `原任务：${excerpt(parent.title, 150)}`,
    `已完成：${summary.changes || '详见工作区现有改动'}`,
    `关键约束：${summary.constraints || '查阅当前任务的约束'}`,
    `相关文件：${summary.files || '根据本次目标定位'}`,
    `验证结果：${[summary.verification, excerpt(tests, 300)].filter(Boolean).join('；') || '原任务未记录验证结论，执行时请核实'}`,
  ].join('\n')
}

export type ContextEntry = { id: string; label: string; value: string; version?: string }

export function projectEntries(run: Run): ContextEntry[] {
  return [
    { id: 'project:name', label: '项目名称', value: run.project.name },
    { id: 'project:description', label: '项目说明', value: run.project.description },
    ...projectFields.map(({ key, label }) => ({ id: `project:${key}`, label, value: run.project.context?.[key] ?? '' })),
    { id: 'project:test', label: '项目测试命令', value: run.project.testCommand ? JSON.stringify(run.project.testCommand) : '' },
    { id: 'iteration:name', label: '迭代名称', value: run.iteration?.name ?? '' },
    { id: 'iteration:description', label: '迭代说明', value: run.iteration?.description ?? '' },
    ...legacyIterationElements(run.iteration).map(({ name, value }) => ({ id: `iteration:${name}`, label: name, value })),
  ].filter(entry => entry.value.trim())
}

export function stamp(entry: ContextEntry): ContextStamp {
  return { id: entry.id, label: entry.label, digest: createHash('sha256').update(JSON.stringify([entry.label, entry.value, entry.version])).digest('hex') }
}

export function contextChanges(current: ContextEntry[], previous: ContextStamp[]) {
  const before = new Map(previous.map(item => [item.id, item]))
  const changed = current.filter(entry => before.get(entry.id)?.digest !== stamp(entry).digest)
  const currentIds = new Set(current.map(item => item.id))
  const removed = previous.filter(item => !currentIds.has(item.id))
  return { changed, removed }
}
