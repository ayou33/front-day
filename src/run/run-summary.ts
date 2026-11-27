import type { Attempt, FileChange, Run, StageSnapshot, TestResult } from '../../shared/contracts.ts'

export type EvidenceFile = { path: string; kind: FileChange['kind'] | 'unknown' }

/** 单个尝试的文件变更状态。区分「没有改动」「没有记录」和「无法核对」，避免把空结果当成 0 个变更展示。 */
export type FileEvidence =
  | { state: 'changed'; total: number; files: EvidenceFile[]; coverage: 'workspace' | 'api' | 'legacy' }
  | { state: 'empty'; coverage: 'workspace' | 'api' }
  | { state: 'unavailable' }
  | { state: 'unrecorded' }

export type TestEvidence =
  | { state: 'passed' | 'failed'; result: TestResult }
  | { state: 'running' | 'missing' | 'not-configured' }

export type StageAttempt = { stage: StageSnapshot; index: number; attempt: Attempt }
export type StageEvidence = StageAttempt & { files: FileEvidence; test: TestEvidence }

export function fileEvidence(attempt: Attempt): FileEvidence {
  const changes = attempt.fileChanges
  if (changes) {
    if (changes.coverage === 'unavailable') return { state: 'unavailable' }
    if (!changes.total) return { state: 'empty', coverage: changes.coverage }
    return { state: 'changed', total: changes.total, files: changes.files, coverage: changes.coverage }
  }
  const legacy = attempt.acceptance?.files
  if (legacy?.length) {
    return { state: 'changed', total: legacy.length, files: legacy.map(path => ({ path, kind: 'unknown' })), coverage: 'legacy' }
  }
  return { state: 'unrecorded' }
}

export function testEvidence(stage: StageSnapshot, attempt: Attempt): TestEvidence {
  if (attempt.test) return { state: attempt.test.code === 0 ? 'passed' : 'failed', result: attempt.test }
  if (stage.kind !== 'test' && stage.acceptance !== 'test') return { state: 'not-configured' }
  return { state: attempt.status === 'running' ? 'running' : 'missing' }
}

export function fileBreakdown(files: EvidenceFile[]) {
  const counts = { added: 0, modified: 0, deleted: 0, unknown: 0 }
  for (const file of files) counts[file.kind] += 1
  return counts
}

/** 概览只统计每个阶段最近一次尝试，和执行结果、文件变更页签保持同一口径。 */
export function latestAttempts(run: Run): StageAttempt[] {
  return run.stages.flatMap((stage, index) => {
    const attempt = run.attempts[index]?.at(-1)
    return attempt ? [{ stage, index, attempt }] : []
  })
}

export function runEvidence(run: Run): StageEvidence[] {
  return latestAttempts(run).map(row => ({ ...row, files: fileEvidence(row.attempt), test: testEvidence(row.stage, row.attempt) }))
}
