export const continuationModes = ['auto', 'resume', 'handoff'] as const
export type ContinuationMode = typeof continuationModes[number]
export const continuationLabels: Record<ContinuationMode, string> = {
  auto: '自动选择', resume: '续接原会话', handoff: '用交接摘要开启新会话',
}

export type Handoff = { changes: string; constraints: string; files: string; verification: string }
export type ContextStamp = { id: string; label: string; digest: string }
