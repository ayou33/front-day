import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentPromptPreview, ContextDifference, Iteration, Project, Resource, Run, RunGroup, RunPage } from '../shared/contracts.ts'
import type { ModelApiHealth, ModelApiProfile } from '../shared/prompt-optimizer.ts'
import { readModelStream } from '../server/model-stream.ts'
import { harness, serve, stage, waitForRun } from './support.ts'

const mock = new URL('./fixtures/model-fetch.ts', import.meta.url)
const apiId = 'api:deepseek'
const profile = { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture-deepseek-key' }
const context = { kind: 'text', category: '需求', prompt: '', fetch: false, accountId: '' }

test('多种流式协议保留正文增量，并只汇总厂商上报的用量', async () => {
  const cases = {
    openai: [{ type: 'response.output_text.delta', delta: '答' }, { type: 'response.output_text.delta', delta: '复' },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }],
    anthropic: [{ type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '不展示的推理' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '答' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '复' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }],
    gemini: [{ candidates: [{ content: { parts: [{ text: '答' }] } }] },
      { candidates: [{ content: { parts: [{ text: '复' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }],
  } as const
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    const data = new TextEncoder().encode(cases[provider].map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join(''))
    const chunks: string[] = []
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < data.length; index += 7) controller.enqueue(data.subarray(index, index + 7))
      controller.close()
    } })
    assert.deepEqual(await readModelStream(provider, body, text => chunks.push(text)),
      { text: '答复', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } })
    assert.deepEqual(chunks, ['答', '复'])
  }
})

test('同厂商独立保存 Key 和用途，手动检查区分认证、模型、配额与网络', async t => {
  const h = await harness()
  const app = await serve(h.dir, {}, mock)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const create = (options: object) => app.api<ModelApiProfile>('/model-apis', 'POST', { ...profile, ...options })
  const main = await create({ name: '开发专用', purpose: 'execution' })
  const alternate = await create({ name: '文案专用', purpose: 'optimization', model: 'fixture-custom-model', apiKey: 'fixture-custom-key' })
  assert.equal(main.id, apiId)
  assert.notEqual(main.id, alternate.id)
  assert.deepEqual((await app.api<ModelApiProfile[]>('/model-apis')).map(item => item.name), ['开发专用', '文案专用'])
  const check = (id: string) => app.api<ModelApiHealth>(`/model-apis/${encodeURIComponent(id)}/health`, 'POST', {})
  assert.equal((await check(main.id)).status, 'ready')
  assert.equal((await check(alternate.id)).status, 'ready')
  for (const [key, result] of [['fixture-quota', 'quota'], ['fixture-permission', 'model'], ['fixture-network', 'network'], ['invalid', 'key']]) {
    const invalid = await create({ name: key, apiKey: key })
    assert.equal((await check(invalid.id)).status, result)
  }
  await assert.rejects(() => app.api('/prompt-optimizer', 'PUT', { enabled: true, executorId: main.id }), /请选择已配置/)
  await app.api('/prompt-optimizer', 'PUT', { enabled: true, executorId: alternate.id })
  await app.api(`/model-apis/${encodeURIComponent(alternate.id)}`, 'PUT', { name: '调整用途后仍保留密钥', model: alternate.model })
  assert.deepEqual(await app.api('/prompt-optimizer', 'POST', { goal: '优化文本' }), { goal: 'API 优化建议' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '项目', directory: h.project })
  const dispatch = () => app.api('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, goal: '仅执行', engineId: alternate.id })
  await assert.rejects(dispatch, /需要选择 Agent 配置/)
  assert.equal((await app.api<{ enabled: boolean }>('/prompt-optimizer')).enabled, true)
  await app.api(`/model-apis/${encodeURIComponent(alternate.id)}`, 'DELETE')
  const afterDelete = await app.api<{ enabled: boolean; executorId: string }>('/prompt-optimizer')
  assert.equal(afterDelete.enabled, false)
  assert.equal(afterDelete.executorId, '')
  assert.equal((await app.api<ModelApiProfile[]>('/model-apis')).some(item => item.id === alternate.id), false)
  await assert.rejects(app.api(`/model-apis/${encodeURIComponent(alternate.id)}`, 'DELETE'), /404/)
})

test('待开始任务预览和启动自动采用当前资料，API 执行遵守发送范围', async t => {
  const h = await harness()
  const app = await serve(h.dir, {}, mock)
  t.after(async () => { await app.stop(); await h.cleanup() })
  await app.api('/model-apis', 'POST', profile)
  const project = await app.api<Project>('/config/projects', 'POST', { name: '资料范围', directory: h.project, description: '初始描述' })
  const resource = { ...context, projectId: project.id }
  await writeFile(join(h.project, 'private.md'), 'FOREIGN_PRIVATE_TEXT')
  const sensitive = await app.api<Resource>('/config/resources', 'POST', { ...resource, kind: 'file', name: '敏感文件', value: 'private.md' })
  const optional = await app.api<Resource>('/config/resources', 'POST', { ...resource, name: '按需要素', value: 'ON_DEMAND_TEXT', apiShare: 'on-demand' })
  const saved = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), goal: 'FIXTURE_SCOPE',
    engineId: apiId, projectId: project.id, start: false })
  await app.api(`/config/resources/${sensitive.id}`, 'PUT', { ...sensitive, apiShare: 'excluded' })
  await app.api(`/config/projects/${project.id}`, 'PUT', { ...project, description: '当前描述' })
  await app.api('/config/resources', 'POST', { ...resource, name: '新要素', value: '项目验收清单' })
  const diff = await app.api<ContextDifference>(`/runs/${saved.id}/context-difference`)
  assert.deepEqual(diff.changes.map(change => change.kind).sort(), ['added', 'updated', 'updated'])
  const preview = await app.api<AgentPromptPreview>(`/runs/${saved.id}/prompt`)
  assert.ok(!preview.text.includes('敏感文件') && !preview.text.includes(optional.value))
  assert.match(preview.text, /按需要素/)
  assert.match(preview.text, /当前描述/)
  assert.match(preview.text, /项目验收清单/)
  const desktop = await app.api<{ text: string }>(`/runs/${saved.id}/desktop-prompt`)
  assert.match(desktop.text, /FIXTURE_SCOPE/)
  assert.match(desktop.text, /当前描述/)
  assert.match(desktop.text, /项目验收清单/)
  assert.ok(desktop.text.includes(`/context/${encodeURIComponent(`resource:${optional.id}`)}?stage=0`))
  assert.doesNotMatch(desktop.text, /敏感文件|private\.md|ON_DEMAND_TEXT|调用 list_context/)
  await assert.rejects(() => app.api(`/runs/${saved.id}/context/${encodeURIComponent(`resource:${sensitive.id}`)}`), /找不到关联/)
  assert.match(JSON.stringify(await app.api(`/runs/${saved.id}/context/${encodeURIComponent(`resource:${optional.id}`)}`)), /ON_DEMAND_TEXT/)
  await assert.rejects(() => app.api(`/runs/${saved.id}/start`, 'POST', { revision: saved.revision! + 1 }), /任务已变更/)
  await app.api(`/runs/${saved.id}/start`, 'POST', {})
  const result = await waitForRun(app.api, saved.id, 'succeeded')
  assert.equal(result.attempts[0][0].output, '资料范围正确')
  assert.equal(result.project.description, '当前描述')
  assert.equal(result.savedContext?.project.description, '初始描述')
  assert.equal(result.savedContext?.resources.length, 2)
  assert.equal(result.resources.length, 3)
})

test('API 使用流式输出、分段读取和补丁，文件变动后重新审批并验收', async t => {
  const h = await harness()
  const app = await serve(h.dir, {}, mock)
  t.after(async () => { await app.stop(); await h.cleanup() })
  await app.api('/model-apis', 'POST', profile)
  const project = await app.api<Project>('/config/projects', 'POST', { name: '验收项目', directory: h.project,
    testCommand: { program: process.execPath, args: ['--version'] } })
  const file = join(h.project, 'large.txt')
  const longLine = '项目内容'.repeat(3000) + '\n'
  await writeFile(file, '修改前\n' + longLine)
  const dispatch = (goal: string, extras: object) => app.api<Run>('/runs', 'POST', {
    requestId: randomUUID(), goal, engineId: apiId, projectId: project.id, ...extras,
  })
  const run = await dispatch('FIXTURE_PATCH_API', { acceptance: 'changes' })
  const initial = (await waitForRun(app.api, run.id, 'waiting_approval')).pending[0]
  assert.match(initial.change?.preview ?? '', /− 修改前\n\+ 补丁第一行/)
  await writeFile(file, '并行编辑\n' + longLine)
  await app.api(`/runs/${run.id}/interactions/${initial.id}`, 'POST', { choice: 'allow' })
  const second = (await waitForRun(app.api, run.id, 'waiting_approval', value => value.pending[0].id !== initial.id)).pending[0]
  assert.match(second.change?.preview ?? '', /− 并行编辑\n\+ 更新后的第一行/)
  assert.ok((second.change?.afterBytes ?? 0) > 16_000)
  await app.api(`/runs/${run.id}/interactions/${second.id}`, 'POST', { choice: 'allow' })
  const attempt = (await waitForRun(app.api, run.id, 'succeeded')).attempts[0][0]
  assert.equal(attempt.output, 'API 补丁完成')
  assert.equal(attempt.acceptance?.status, 'passed')
  assert.deepEqual(attempt.acceptance?.files, ['large.txt'])
  assert.deepEqual(attempt.fileChanges, { coverage: 'api', total: 1, files: [{ path: 'large.txt', kind: 'modified' }] })
  assert.equal(attempt.apiMetrics?.totalTokens, 16 * attempt.apiMetrics!.rounds)
  assert.equal(await readFile(file, 'utf-8'), '更新后的第一行\n' + longLine)

  await writeFile(join(h.project, 'app.js'), 'export const base = 1\n')
  const blocked = await dispatch('FIXTURE_WRITE_API', { acceptance: 'changes', approvalMode: 'auto-deny' })
  assert.equal((await waitForRun(app.api, blocked.id, 'succeeded')).attempts[0][0].acceptance?.status, 'blocked')
  const verified = await dispatch('执行项目验收', { acceptance: 'test' })
  const verifiedAttempt = (await waitForRun(app.api, verified.id, 'succeeded')).attempts[0][0]
  assert.equal(verifiedAttempt.test?.code, 0)
  assert.equal(verifiedAttempt.acceptance?.status, 'passed')
  await app.api(`/config/projects/${project.id}`, 'PUT', { ...project,
    testCommand: { program: process.execPath, args: ['-e', 'process.exit(7)'] } })
  const rejected = await dispatch('验收未通过的执行结果', { acceptance: 'test' })
  const rejectedAttempt = (await waitForRun(app.api, rejected.id, 'succeeded')).attempts[0][0]
  assert.equal(rejectedAttempt.test?.code, 7)
  assert.equal(rejectedAttempt.acceptance?.status, 'failed')
})

test('按尝试记录普通 CLI 阶段与失败测试的文件变更，忽略已有改动', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  await writeFile(join(h.project, 'modified.ts'), 'export const value = 1\n')
  await writeFile(join(h.project, 'removed.ts'), '旧文件')
  await writeFile(join(h.project, 'existing.ts'), '阶段开始前已有内容')
  await app.api('/config/engines/cursor-default', 'PUT', { provider: 'cursor', name: '测试 Cursor', executable: h.wrappers.cursor,
    model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '文件记录', directory: h.project })
  const task = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: 'cursor-default',
    goal: 'FIXTURE_FILE_CHANGES' })
  const completed = await waitForRun(app.api, task.id, 'succeeded')
  assert.equal(completed.attempts[0][0].acceptance?.status, 'unchecked')
  assert.deepEqual(completed.attempts[0][0].fileChanges, { coverage: 'workspace', total: 3, files: [
    { path: 'added.ts', kind: 'added' }, { path: 'modified.ts', kind: 'modified' }, { path: 'removed.ts', kind: 'deleted' },
  ] })
  const template = await app.api<{ id: string }>('/config/templates', 'POST', { name: '测试文件记录', description: '',
    stages: [stage('失败测试', { kind: 'test', testCommand: {
      program: process.execPath, args: ['-e', "require('node:fs').writeFileSync('test-output.txt', 'report'); process.exit(7)"],
    } })] })
  const tested = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, templateId: template.id,
    goal: '核对测试文件' })
  const failed = await waitForRun(app.api, tested.id, 'failed')
  assert.deepEqual(failed.attempts[0][0].fileChanges, { coverage: 'workspace', total: 1, files: [{ path: 'test-output.txt', kind: 'added' }] })
  await app.api(`/runs/${tested.id}/retry`, 'POST', {})
  const retried = await waitForRun(app.api, tested.id, 'failed', run => run.attempts[0].length === 2)
  assert.equal(retried.attempts[0][0].fileChanges?.total, 1)
  assert.deepEqual(retried.attempts[0][1].fileChanges, { coverage: 'workspace', total: 0, files: [] })
})

test('历史按续改链和游标分页，归档、项目、迭代和搜索过滤保留来源', async t => {
  const h = await harness()
  let app = await serve(h.dir, {}, mock)
  t.after(async () => { await app.stop(); await h.cleanup() })
  await app.api('/model-apis', 'POST', profile)
  const project = await app.api<Project>('/config/projects', 'POST', { name: '分页主项目', directory: h.project })
  const iteration = await app.api<Iteration>('/config/iterations', 'POST', { name: '当期迭代', projectId: project.id })
  const dispatch = (title: string, options: object = {}) => app.api<Run>('/runs', 'POST',
    { requestId: randomUUID(), title, projectId: project.id, engineId: apiId, ...options })
  const source = await dispatch('源任务', { iterationId: iteration.id })
  await waitForRun(app.api, source.id, 'succeeded')
  const child = await dispatch('续改甲', { iterationId: iteration.id, continuation: { parentId: source.id, mode: 'handoff' } })
  await waitForRun(app.api, child.id, 'succeeded')
  const other = await dispatch('独立任务', { start: false })
  const base = `/runs/page?projectId=${project.id}&limit=1`
  const first = await app.api<RunPage>(base)
  assert.equal(first.records.length, 1)
  assert.equal(first.records[0].source.id, other.id)
  assert.ok(first.next)
  const second = await app.api<RunPage>(`${base}&cursor=${encodeURIComponent(first.next!)}`)
  assert.equal(second.records.length, 1)
  assert.deepEqual(new Set([first.records[0].source.id, second.records[0].source.id]), new Set([source.id, other.id]))
  assert.equal(second.next, undefined)
  await app.api(`/runs/${source.id}/archive`, 'POST', {})
  const filtered = await app.api<RunPage>(`${base}&iterationId=${iteration.id}&query=${encodeURIComponent('续改甲')}`)
  assert.equal(filtered.records.length, 0)
  const archivedGroup = (await app.api<RunPage>(`${base}&archived=1`)).records.find(record => record.source.id === source.id)
  assert.ok(archivedGroup)
  assert.deepEqual(new Set(archivedGroup.runs.map(run => run.id)), new Set([source.id, child.id]))
  await app.stop()
  app = await serve(h.dir, {}, mock)
  assert.equal((await app.api<RunGroup>(`/runs/${child.id}/related`)).runs.length, 2)
  assert.equal((await app.api<RunPage>(`${base}&iterationId=unassigned`)).records[0].source.id, other.id)
})
