import type { Run } from './contracts.ts'

export const continuationModes = ['auto', 'resume', 'handoff', 'fork'] as const
export type ContinuationMode = typeof continuationModes[number]
export const continuationLabels: Record<ContinuationMode, string> = {
  auto: '自动选择', resume: '继续当前会话', handoff: '用交接摘要开启新会话', fork: '从此轮创建分支',
}

export function sessionFrom(run: Run) {
  for (let index = run.stages.length - 1; index >= 0; index--) {
    const stage = run.stages[index]
    const attempt = run.attempts[index]?.findLast(item => item.status === 'succeeded' && item.sessionId)
    if (stage.kind === 'agent' && stage.engine && attempt) return { index, stage, engine: stage.engine, attempt }
  }
}

export type Handoff = { changes: string; constraints: string; files: string; verification: string }
export type ContextStamp = { id: string; label: string; digest: string }

export function splitHandoff(text: string): { text: string; handoff?: Handoff } {
  let handoff: Handoff | undefined
  const body = text.replace(/<front-day-handoff>\s*([\s\S]*?)\s*<\/front-day-handoff>/gi, (block, json: string) => {
    try {
      const payload = json.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i, '$1')
      const { changes, constraints, files, verification } = JSON.parse(payload) as Record<keyof Handoff, unknown>
      if (typeof changes !== 'string' || typeof constraints !== 'string' || typeof files !== 'string' || typeof verification !== 'string') return block
      handoff = { changes, constraints, files, verification }
      return '\n\n'
    } catch { return block }
  })
  return handoff ? { text: body.trim(), handoff } : { text }
}
