import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileBreakdown, fileEvidence, latestAttempts, runEvidence, testEvidence } from '../src/run/run-summary.ts'
import type { Attempt, Run, StageSnapshot } from '../shared/contracts.ts'

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return { number: 1, status: 'succeeded', startedAt: '2026-11-27T00:00:00.000Z', ...overrides }
}

function stage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
  return {
    name: '开发', kind: 'agent', prompt: '', engineId: 'engine', mode: '', resourceIds: [], allResources: false,
    advance: 'auto', testCommand: null, analyzeTest: false, engine: null, ...overrides,
  } as StageSnapshot
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1', title: '任务', brief: '', project: { id: 'project-1', name: '项目' } as unknown as Run['project'],
    templateName: '', stages: [stage()], resources: [], accounts: [], status: 'succeeded', stageIndex: 0,
    attempts: [[attempt()]], pending: [], createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
    ...overrides,
  }
}

test('文件变更区分无改动、未记录和无法核对', () => {
  assert.deepEqual(fileEvidence(attempt({ fileChanges: { coverage: 'workspace', total: 0, files: [] } })),
    { state: 'empty', coverage: 'workspace' })
  assert.deepEqual(fileEvidence(attempt({ fileChanges: { coverage: 'unavailable', total: 0, files: [] } })),
    { state: 'unavailable' })
  assert.deepEqual(fileEvidence(attempt()), { state: 'unrecorded' })

  const changed = fileEvidence(attempt({
    fileChanges: { coverage: 'api', total: 2, files: [{ path: 'a.ts', kind: 'added' }, { path: 'b.ts', kind: 'modified' }] },
  }))
  assert.equal(changed.state, 'changed')
  assert.equal(changed.state === 'changed' && changed.total, 2)
  assert.deepEqual(changed.state === 'changed' && fileBreakdown(changed.files), { added: 1, modified: 1, deleted: 0, unknown: 0 })
})

test('旧的阶段验收文件按未知类型保留，不会显示成 0 个文件', () => {
  const legacy = fileEvidence(attempt({ acceptance: { status: 'blocked', message: '需要确认', files: ['src/a.ts', 'src/b.ts'] } }))
  assert.equal(legacy.state, 'changed')
  assert.equal(legacy.state === 'changed' && legacy.total, 2)
  assert.equal(legacy.state === 'changed' && legacy.coverage, 'legacy')
  assert.deepEqual(legacy.state === 'changed' && legacy.files, [
    { path: 'src/a.ts', kind: 'unknown' }, { path: 'src/b.ts', kind: 'unknown' },
  ])
})

test('测试结论区分通过、未通过、执行中、未执行和未配置', () => {
  assert.equal(testEvidence(stage(), attempt({ test: { code: 0, signal: null, ms: 1200 } })).state, 'passed')
  assert.equal(testEvidence(stage(), attempt({ test: { code: 1, signal: null, ms: 1200 } })).state, 'failed')
  assert.equal(testEvidence(stage({ kind: 'test' }), attempt({ status: 'running' })).state, 'running')
  assert.equal(testEvidence(stage({ kind: 'test' }), attempt()).state, 'missing')
  assert.equal(testEvidence(stage(), attempt()).state, 'not-configured')
  assert.equal(testEvidence(stage({ acceptance: 'test' }), attempt()).state, 'missing')
})

test('概览只取每个阶段最近一次尝试，并组合出证据状态', () => {
  const evidence = runEvidence(run({
    templateName: '前端交付',
    stages: [stage({ name: '开发' }), stage({ name: '测试', kind: 'test' })],
    attempts: [
      [attempt({ number: 1 }), attempt({ number: 2, output: '完成', fileChanges: { coverage: 'workspace', total: 1, files: [{ path: 'a.ts', kind: 'modified' }] } })],
      [attempt({ number: 1, test: { code: 0, signal: null, ms: 3100 } })],
    ],
  }))
  assert.deepEqual(evidence.map(row => row.attempt.number), [2, 1])
  assert.equal(evidence[0].files.state, 'changed')
  assert.equal(evidence[1].test.state, 'passed')
  assert.equal(evidence[1].stage.name, '测试')
})

test('没有尝试的阶段不会出现在证据中', () => {
  assert.deepEqual(latestAttempts(run({ stages: [stage(), stage({ name: '测试', kind: 'test' })], attempts: [[attempt()], []] })).map(row => row.index), [0])
})
