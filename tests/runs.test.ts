import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { canArchiveTask } from '../shared/contracts.ts'
import type { Account, AgentPromptPreview, ArchivedRun, Catalog, Conversation, Engine, EngineHealth, Iteration, Project, Resource, Run, RunSummary, Template } from '../shared/contracts.ts'
import type { Preferences } from '../shared/preferences.ts'
import { engineGuides, engineProviders } from '../shared/engines.ts'
import { Store } from '../server/storage.ts'
import { AccountSecrets } from '../server/secrets.ts'
import { optimizePrompt } from '../server/prompt-optimizer.ts'
import { defaultPromptOptimizer, optimizerProviderOptions, promptOptimizerProviders } from '../shared/prompt-optimizer.ts'
import { harness, serve, stage, waitForRun } from './support.ts'

test('资源凭据按来源使用，阶段按目录排队，重启后可从失败阶段重试', async t => {
  const h = await harness()
  const secret = 'fixture-resource-key'
  const source = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== `Bearer ${secret}` || req.url !== '/spec') { res.writeHead(404); res.end('{}'); return }
    res.end(JSON.stringify({ summary: '接口示例', reflected: secret }))
  })
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  t.after(() => source.close())
  const address = source.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const env = { FRONT_DAY_TEST_TOKEN: secret }
  let app = await serve(h.dir, env)
  t.after(async () => { await app.stop(); await h.cleanup() })
  await assert.rejects(() => serve(h.dir, env), /已有 Front Day 服务使用此数据目录/)
  const { api } = app
  const engine = await api<Engine>('/config/engines', 'POST', { name: 'fixture', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await api<Project>('/config/projects', 'POST', { name: '本地项目', directory: h.project, description: '', testCommand: {
    program: process.execPath, args: ['-e', "if (process.env.FRONT_DAY_TEST_TOKEN) process.exit(9); console.log('真实日志'); process.exit(require('fs').existsSync('passed.flag') ? 0 : 7)"],
  } })
  const iteration = await api<Iteration>('/config/iterations', 'POST', { name: '接口迭代', projectId: project.id, description: '接口更新' })
  const account = await api<Account>('/config/accounts', 'POST', { name: '接口账户', origin, type: 'bearer', secretEnv: 'FRONT_DAY_TEST_TOKEN', username: '', header: '', usage: '读取内部接口文档时使用' })
  const form = { name: '接口说明', projectId: project.id, iterationId: iteration.id, category: '接口', kind: 'url', value: `${origin}/missing`, fetch: true, accountId: account.id, prompt: '提取接口字段' }
  const resource = await api<Resource>('/config/resources', 'POST', form)
  const template = await api<Template>('/config/templates', 'POST', { name: '阶段测试', description: '', stages: [stage('资料分析', { advance: 'manual' }), stage('真实测试', { kind: 'test' })] })
  const dispatch = () => api<Run>('/runs', 'POST', { requestId: randomUUID(), title: '资源测试', brief: '', templateId: template.id, projectId: project.id, iterationId: iteration.id, engineId: engine.id })
  const first = await dispatch()
  assert.match((await waitForRun(api, first.id, 'failed')).error!, /接口说明.*404/)
  await api(`/config/resources/${resource.id}`, 'PUT', { ...form, value: `${origin}/spec` })
  await api(`/config/projects/${project.id}`, 'PUT', { ...project, description: '已更新的项目背景' })
  await api(`/config/iterations/${iteration.id}`, 'PUT', { ...iteration, description: '已更新的迭代背景' })
  await api(`/runs/${first.id}/retry`, 'POST', {})
  const retried = await waitForRun(api, first.id, 'waiting_stage')
  assert.equal(retried.error, undefined)
  assert.match(retried.attempts[0][0].error ?? '', /404/)
  assert.equal(retried.resources[0].value, `${origin}/spec`)
  const events = await fetch(`${app.baseUrl}/api/runs/${first.id}/events`)
  const reader = events.body!.getReader()
  let payload = ''
  const decoder = new TextDecoder()
  while (!payload.includes('接口示例')) {
    const next = await reader.read()
    if (next.done) break
    payload += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel()
  assert.match(payload, /提取接口字段/)
  assert.match(payload, /读取内部接口文档时使用/)
  assert.match(payload, /已更新的项目背景/)
  assert.match(payload, /已更新的迭代背景/)
  assert.doesNotMatch(payload, new RegExp(secret))
  const second = await dispatch()
  assert.equal(second.status, 'queued')
  await api(`/runs/${first.id}/advance`, 'POST', {})
  const failed = await waitForRun(api, first.id, 'failed')
  assert.equal(failed.attempts[1][0].test?.code, 7)
  await waitForRun(api, second.id, 'waiting_stage')
  await app.stop()
  app = await serve(h.dir, env)
  assert.equal((await app.api<Run>(`/runs/${second.id}`)).status, 'interrupted')
  await writeFile(join(h.project, 'passed.flag'), '')
  await app.api(`/runs/${first.id}/retry`, 'POST', {})
  const passed = await waitForRun(app.api, first.id, 'succeeded')
  assert.equal(passed.attempts[1][1].test?.code, 0)
  assert.equal(passed.attempts[0].length, 2)
})

test('旧版记录缺少开始标记时仍可按已完成、失败或中断状态归档', () => {
  for (const status of ['succeeded', 'failed', 'interrupted'] as const) assert.equal(canArchiveTask({ status }), true)
  for (const status of ['saved', 'queued', 'running', 'waiting_input', 'waiting_approval', 'waiting_stage', 'stopping'] as const) {
    assert.equal(canArchiveTask({ status, started: true }), false)
  }
  assert.equal(canArchiveTask({ status: 'stopped' }), false)
  assert.equal(canArchiveTask({ status: 'stopped', started: false }), false)
  assert.equal(canArchiveTask({ status: 'stopped', started: true }), true)
})

test('发起过且已不活动的任务可归档，归档后需恢复才能操作', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const engine = await app.api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '归档项目', directory: h.project })
  const iteration = await app.api<Iteration>('/config/iterations', 'POST', { name: '归档迭代', projectId: project.id })
  const defaults = { projectId: project.id, iterationId: iteration.id, engineId: engine.id }
  const saved = await app.api<Run>('/runs', 'POST', { ...defaults, requestId: randomUUID(), goal: '待开始任务', start: false })
  await assert.rejects(() => app.api(`/runs/${saved.id}/archive`, 'POST', {}), /非活动状态后方可归档/)
  const neverStarted = await app.api<Run>('/runs', 'POST', { ...defaults, requestId: randomUUID(), goal: '从未开始的任务', start: false })
  await app.api(`/runs/${neverStarted.id}/stop`, 'POST', {})
  await assert.rejects(() => app.api(`/runs/${neverStarted.id}/archive`, 'POST', {}), /非活动状态后方可归档/)
  const active = await app.api<Run>('/runs', 'POST', { ...defaults, requestId: randomUUID(), goal: 'HOLD_FOR_CANCEL' })
  await waitForRun(app.api, active.id, 'running', current => !!current.attempts[0]?.[0]?.sessionId)
  await assert.rejects(() => app.api(`/runs/${active.id}/archive`, 'POST', {}), /非活动状态后方可归档/)
  await assert.rejects(() => app.api(`/runs/${active.id}`, 'PUT', { ...defaults, requestId: active.id, goal: '执行中编辑' }), /已保存且未开始/)
  await app.api(`/runs/${saved.id}/start`, 'POST', {})
  await waitForRun(app.api, saved.id, 'queued')
  await assert.rejects(() => app.api(`/runs/${saved.id}/prompt`, 'PUT', { text: '排队时编辑' }), /已保存且未开始/)
  await assert.rejects(() => app.api(`/runs/${saved.id}/archive`, 'POST', {}), /非活动状态后方可归档/)
  await app.api(`/runs/${saved.id}/stop`, 'POST', {})
  const stoppedWhileQueued = await waitForRun(app.api, saved.id, 'stopped')
  assert.equal(stoppedWhileQueued.started, true)
  assert.equal(stoppedWhileQueued.attempts.flat().length, 0)
  assert.ok((await app.api<Run>(`/runs/${saved.id}/archive`, 'POST', {})).archivedAt)
  await app.api(`/runs/${active.id}/stop`, 'POST', {})
  await waitForRun(app.api, active.id, 'stopped')
  assert.ok((await app.api<Run>(`/runs/${active.id}/archive`, 'POST', {})).archivedAt)

  const run = await app.api<Run>('/runs', 'POST', { ...defaults, requestId: randomUUID(), goal: '完成后归档' })
  const done = await waitForRun(app.api, run.id, 'succeeded')
  const archived = await app.api<ArchivedRun>(`/runs/${run.id}/archive`, 'POST', {})
  assert.ok(archived.archivedAt)
  assert.equal(archived.status, 'succeeded')
  const locked = await app.api<ArchivedRun>(`/runs/${run.id}`)
  assert.deepEqual(locked, archived)
  assert.deepEqual(locked.project, { name: project.name })
  assert.deepEqual(locked.iteration, { name: iteration.name })
  for (const key of ['goal', 'details', 'attempts', 'stages', 'resources', 'accounts', 'pending']) {
    assert.equal(Object.hasOwn(locked, key), false, key)
  }
  assert.deepEqual(await app.api('/runs', 'POST', { ...defaults, requestId: run.id, goal: '重复提交' }), locked)
  for (const action of ['archive', 'start', 'retry', 'stop', 'followup', 'approval', 'advance', 'interactions/fixture']) {
    await assert.rejects(() => app.api(`/runs/${run.id}/${action}`, 'POST', {}), /请先恢复归档任务/)
  }
  await assert.rejects(() => app.api(`/runs/${run.id}/context`), /请先恢复归档任务/)
  await assert.rejects(() => app.api(`/runs/${run.id}/events`), /请先恢复归档任务/)
  await assert.rejects(() => app.api(`/runs/${run.id}/prompt`, 'PUT', { text: '尝试编辑归档提示词' }), /请先恢复归档任务/)
  await assert.rejects(() => app.api(`/runs/${run.id}/optimize-prompt`, 'POST', { text: '尝试优化归档提示词' }), /请先恢复归档任务/)
  await assert.rejects(() => app.api(`/runs/${run.id}`, 'PUT', { ...defaults, requestId: run.id, goal: '尝试编辑归档任务' }), /请先恢复归档任务/)
  await assert.rejects(() => app.api('/runs', 'POST', {
    ...defaults, requestId: randomUUID(), goal: '尝试继续归档任务', continuation: { parentId: run.id },
  }), /请先恢复归档任务/)
  await app.stop()
  const database = new DatabaseSync(join(h.dir, 'data', 'workbench.sqlite'))
  try {
    database.exec("DELETE FROM settings WHERE key = 'run-started-v1'")
    database.prepare("UPDATE runs SET json = json_remove(json, '$.started') WHERE id IN (?, ?)").run(saved.id, neverStarted.id)
  } finally { database.close() }
  app = await serve(h.dir)
  const summary = (await app.api<RunSummary[]>('/runs')).find(item => item.id === run.id)
  assert.equal(summary?.archivedAt, archived.archivedAt)
  assert.equal(summary?.projectId, project.id)
  assert.equal(summary?.iterationId, iteration.id)
  assert.equal((await app.api<ArchivedRun>(`/runs/${saved.id}`)).started, true)
  assert.equal((await app.api<Run>(`/runs/${neverStarted.id}`)).started, false)
  const restored = await app.api<Run>(`/runs/${run.id}/unarchive`, 'POST', {})
  assert.equal(restored.archivedAt, undefined)
  assert.equal(restored.status, 'succeeded')
  assert.deepEqual(restored.attempts, done.attempts)
  await assert.rejects(() => app.api(`/runs/${run.id}/prompt`, 'PUT', { revision: restored.revision, text: '恢复后编辑' }), /已保存且未开始/)
})

test('继续修改可复用原生会话和资料差异，也可用交接摘要开启新会话', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  const project = await api<Project>('/config/projects', 'POST', { name: '续改项目', directory: h.project, description: '原项目长背景保持不变' })
  const resource = { projectId: project.id, category: '需求', kind: 'text', prompt: '', fetch: false, accountId: '' }
  const stable = await api<Resource>('/config/resources', 'POST', { ...resource, name: '通用约定', value: '沿用的内容'.repeat(300) })
  const change = await api<Resource>('/config/resources', 'POST', { ...resource, name: '接口结果', value: '旧接口字段' })
  const removed = await api<Resource>('/config/resources', 'POST', { ...resource, name: '待移除材料', value: '旧材料全文' })

  async function trace(run: Run) {
    const response = await fetch(`${app.baseUrl}/api/runs/${run.id}/events`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let contents = ''
    try {
      while (!contents.includes('"status":"succeeded"')) {
        const entry = await reader.read()
        if (entry.done) break
        contents += decoder.decode(entry.value, { stream: true })
      }
    } finally { await reader.cancel() }
    const events = contents.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    return { events, prompt: String(events.find(event => event.kind === 'input')?.data.text ?? '') }
  }

  for (const provider of ['cursor', 'codex'] as const) {
    const engine = await api<Engine>(`/config/engines/${provider}-default`, 'PUT', { name: provider, provider, executable: h.wrappers[provider], model: '', mode: 'agent' })
    const start = (goal: string, continuation?: { parentId: string; mode: string }) => api<Run>('/runs', 'POST', {
      requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal, continuation,
      details: continuation && { output: '检查键盘焦点' },
    })
    const parent = await waitForRun(api, (await start('完成表单 CONTINUATION_SUMMARY')).id, 'succeeded')
    const firstAttempt = parent.attempts[0][0]
    assert.equal(firstAttempt.handoff?.files, 'src/form.ts')
    assert.match(firstAttempt.output ?? '', /本地预览服务已结束。/)
    assert.doesNotMatch(firstAttempt.output ?? '', /front-day-handoff|"changes":/)
    await api(`/config/resources/${change.id}`, 'PUT', { ...change, value: `当前接口字段 ${provider}`, prompt: '提取当前接口必填字段' })
    if (provider === 'cursor') await api(`/config/resources/${removed.id}`, 'DELETE')
    const child = await waitForRun(api, (await start('新增提交后聚焦', { parentId: parent.id, mode: 'auto' })).id, 'succeeded')
    assert.equal(child.continuation?.parentId, parent.id)
    assert.equal(child.attempts[0][0].contextMode, 'resume')
    assert.equal(child.attempts[0][0].sessionId, firstAttempt.sessionId)
    const resume = await trace(child)
    assert.match(resume.prompt, /^## 任务目标\n新增提交后聚焦/)
    assert.match(resume.prompt, new RegExp(`当前接口字段 ${provider}`))
    assert.match(resume.prompt, /解析要求 · 提取当前接口必填字段/)
    assert.match(resume.prompt, /## 本次执行与验收[\s\S]*检查键盘焦点/)
    assert.doesNotMatch(resume.prompt, /原项目长背景|沿用的内容|旧接口字段|旧材料全文/)
    const desktop = await api<{ text: string }>(`/runs/${child.id}/desktop-prompt`)
    assert.match(desktop.text, /## 任务目标\n新增提交后聚焦/)
    assert.match(desktop.text, /原项目长背景/)
    assert.match(desktop.text, /沿用的内容/)
    assert.match(desktop.text, /## 原任务交接摘要/)
    if (provider === 'cursor') assert.match(resume.prompt, /已移除或当前不可用的旧上下文\n待移除材料/)
    assert.equal(resume.events.some(event => JSON.stringify(event.data).includes('旧会话回放标记')), false)

    const sibling = await waitForRun(api, (await start('新分支的表单校验', { parentId: parent.id, mode: 'auto' })).id, 'succeeded')
    assert.equal(sibling.attempts[0][0].contextMode, 'handoff')
    const handoff = (await trace(sibling)).prompt
    for (const marker of ['表单保存完成', '沿用旧接口', 'src/form.ts', '表单用例通过', '资料索引']) assert.ok(handoff.includes(marker), marker)
    assert.match(handoff, /## 任务目标\n新分支的表单校验[\s\S]*## 项目背景[\s\S]*## 原任务交接摘要[\s\S]*## 本次执行与验收/)
    assert.ok(handoff.length < 5000)
    assert.equal((await api<{ content: string }>(`/runs/${sibling.id}/context/${encodeURIComponent(`resource:${stable.id}`)}`)).content, stable.value)
  }

  const codex = 'codex-default'
  const long = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: codex, goal: '较长任务', brief: 'A'.repeat(25_000) })
  await waitForRun(api, long.id, 'succeeded')
  const condensed = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: codex, goal: '调整表单标签',
    continuation: { parentId: long.id, mode: 'auto' } })
  assert.equal((await waitForRun(api, condensed.id, 'succeeded')).attempts[0][0].contextMode, 'handoff')
})

test('自动续改在原会话不存在时回退到交接摘要', async t => {
  const h = await harness()
  const app = await serve(h.dir, { FRONT_DAY_FIXTURE_RESTORE_FAIL: '1' })
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  const engine = await api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await api<Project>('/config/projects', 'POST', { name: '恢复回退项目', directory: h.project })
  const start = (goal: string, parentId?: string) => api<Run>('/runs', 'POST', {
    requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal, continuation: parentId && { parentId, mode: 'auto' },
  })
  const parent = await start('原任务 CONTINUATION_SUMMARY')
  await waitForRun(api, parent.id, 'succeeded')
  const child = await start('继续修改表单文案', parent.id)
  const completed = await waitForRun(api, child.id, 'succeeded')
  assert.equal(completed.attempts[0][0].contextMode, 'handoff')
  assert.match(completed.attempts[0][0].output ?? '', /已处理/)
  const conversation = await api<Conversation>(`/runs/${child.id}/conversation`)
  const root = conversation.branches.find(branch => branch.id === parent.id)!
  const next = conversation.branches.find(branch => branch.id === child.id)!
  assert.deepEqual(next.source, { branchId: root.id, turnId: root.turns.at(-1)?.id, kind: 'handoff' })

  const strict = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id,
    goal: '仅续接原会话', continuation: { parentId: parent.id, mode: 'resume' } })
  const failed = await waitForRun(api, strict.id, 'failed')
  assert.match(failed.error ?? '', /Session not found/)
  assert.equal(failed.attempts[0][0].sessionId, undefined)
})

test('项目是必选项，直接任务可补充类型和细节并自行探索缺失资料', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  const engine = await api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await api<Project>('/config/projects', 'POST', { name: '空背景项目', directory: h.project })
  const simple = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, goal: '了解页面入口' })
  assert.equal(simple.resources.length, 0)
  await waitForRun(api, simple.id, 'succeeded')
  const projectDescription = `全局报名规则${'a'.repeat(1501)}只在项目说明全文末尾`
  await api(`/config/projects/${project.id}`, 'PUT', { ...project, description: projectDescription })
  const iteration = await api<Iteration>('/config/iterations', 'POST', { name: '活动页迭代', projectId: project.id, description: '本轮仅覆盖报名结果页' })
  await api('/config/resources', 'POST', { projectId: project.id, iterationId: iteration.id, name: '旧设计', category: '设计', kind: 'file', value: 'missing.md', prompt: '', fetch: false, accountId: '' })
  const resource = { projectId: project.id, category: '需求', kind: 'text', prompt: '', fetch: false, accountId: '' }
  await api('/config/resources', 'POST', { ...resource, iterationId: iteration.id, name: '迭代报名规则', value: '本轮覆盖重复提交' })
  const longText = `全局接口说明${'b'.repeat(2100)}只在项目要素全文末尾`
  const longResource = await api<Resource>('/config/resources', 'POST', { ...resource, name: '项目接口要素', category: '接口', value: longText })
  const payload = { requestId: randomUUID(), goal: '梳理活动页需求\n输出可验收的清单', taskType: 'requirements',
    details: { references: '对照错误码和提示文案', constraints: '保持现有接口契约', output: '列出异常状态' } }
  await assert.rejects(() => api('/runs', 'POST', payload), /400/)
  const run = await api<Run>('/runs', 'POST', { ...payload, projectId: project.id, iterationId: iteration.id, engineId: engine.id })
  assert.equal(run.title, '梳理活动页需求')
  assert.equal(run.templateName, '')
  assert.equal(run.stages[0].engine?.id, engine.id)
  assert.equal(run.stages[0].engine?.mode, 'ask')
  await waitForRun(api, run.id, 'succeeded')
  const stream = await fetch(`${app.baseUrl}/api/runs/${run.id}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let events = ''
  while (!events.includes('发送给 Agent 的任务上下文') || !events.includes('"status":"succeeded"')) {
    const next = await reader.read()
    if (next.done) break
    events += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel()
  assert.match(events, /旧设计.*读取失败/)
  const prompt = events.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    .find(event => event.kind === 'input')?.data.text as string
  assert.match(prompt, /从工作目录的说明、配置、实现和测试中补齐/)
  assert.match(prompt, /保持代码原样/)
  assert.ok(prompt.startsWith('## 任务目标\n梳理活动页需求\n\n'))
  let previousIndex = -1
  for (const marker of ['## 项目背景', '全局报名规则', '### 项目要素', '项目接口要素',
    '## 迭代背景', '本轮仅覆盖报名结果页', '### 迭代要素', '迭代报名规则',
    '## 本次任务资料', '对照错误码和提示文案', '## 本次执行与验收', payload.goal, '保持现有接口契约', '列出异常状态']) {
    const index = prompt.indexOf(marker)
    assert.ok(index > previousIndex, marker)
    previousIndex = index
  }
  assert.doesNotMatch(prompt, /只在项目(?:说明|要素)全文末尾/)
  const longResourceUrl = `/runs/${run.id}/context/${encodeURIComponent(`resource:${longResource.id}`)}?stage=0`
  const projectDescriptionUrl = `/runs/${run.id}/context/${encodeURIComponent('project:description')}?stage=0`
  assert.ok(prompt.includes(longResourceUrl))
  assert.ok(prompt.includes(projectDescriptionUrl))
  assert.equal((await api<{ content: string }>(longResourceUrl)).content, longText)
  assert.equal((await api<{ value: string }>(projectDescriptionUrl)).value, projectDescription)
})


test('绑定资料按需读取本机保存的账号密码，并在重启后继续使用', { timeout: 30_000 }, async t => {
  const h = await harness()
  const username = '迭代账户'
  const password = '本机保存密码"\\-sample'
  const basic = Buffer.from(`${username}:${password}`).toString('base64')
  let reads = 0
  const source = createServer((req, res) => {
    reads++
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== `Basic ${basic}`) { res.writeHead(401); res.end('{}'); return }
    res.end(JSON.stringify({ summary: '认证后的迭代资料', reflected: password, encoded: basic }))
  })
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  const address = source.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); source.close(); await h.cleanup() })
  await app.api('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '项目', directory: h.project })
  const iteration = await app.api<Iteration>('/config/iterations', 'POST', { name: '迭代', projectId: project.id, description: '读取接口说明' })
  const meta = { name: '接口账户', origin, type: 'basic', credentialSource: 'saved', username, header: '' }
  await assert.rejects(() => app.api('/config/accounts', 'POST', meta), /请输入要保存的密码/)
  const account = await app.api<Account>('/config/accounts', 'POST', { ...meta, password })
  assert.equal(Object.hasOwn(account, 'password'), false)
  assert.equal(Object.hasOwn((await app.api<Catalog>('/catalog')).accounts[0], 'password'), false)
  await app.api(`/config/accounts/${account.id}`, 'PUT', { ...meta, name: '更新资料账户名称' })
  await assert.rejects(() => app.api(`/config/accounts/${account.id}`, 'PUT', { ...meta, username: '改了账号' }), /请输入要保存的密码/)
  const resourceForm = { projectId: project.id, iterationId: iteration.id, kind: 'url', name: '账号保护的说明', category: '接口',
    value: `${origin}/spec`, prompt: '', fetch: false, accountId: account.id }
  const resource = await app.api<Resource>('/config/resources', 'POST', resourceForm)
  const dispatch = (start = true) => app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, iterationId: iteration.id, goal: '读取接口说明', start })
  const reference = await dispatch()
  await waitForRun(app.api, reference.id, 'succeeded')
  assert.equal(reads, 0)
  const target = join(h.dir, 'moved data')
  await mkdir(target)
  const current = await app.api<Preferences>('/preferences')
  const updated = await app.api<Preferences>('/preferences', 'PUT', { ...current, dataDirectory: target })
  assert.equal(updated.dataDirectory, target)
  assert.equal((await app.api<Run>(`/runs/${reference.id}`)).status, 'succeeded')
  await app.stop()
  const db = new DatabaseSync(join(h.dir, 'data', 'workbench.sqlite'), { readOnly: true })
  try {
    const sealed = db.prepare('SELECT sealed FROM account_secrets WHERE account_id = ?').get(account.id)?.sealed
    assert.equal(typeof sealed, 'string')
    assert.equal(Buffer.from(String(sealed), 'base64').includes(Buffer.from(password)), false)
  } finally { db.close() }
  app = await serve(h.dir)
  assert.equal((await app.api<Preferences>('/preferences')).dataDirectory, target)
  await app.api(`/config/resources/${resource.id}`, 'PUT', { ...resourceForm, fetch: true })
  const fetched = await dispatch(false)
  const preview = await app.api<AgentPromptPreview>(`/runs/${fetched.id}/prompt`)
  assert.ok(preview.text.includes(`/context/${encodeURIComponent(`resource:${resource.id}`)}?stage=0`))
  assert.doesNotMatch(preview.text, /认证后的迭代资料/)
  assert.equal(reads, 0)
  await app.api(`/runs/${fetched.id}/start`, 'POST', {})
  await waitForRun(app.api, fetched.id, 'succeeded')
  assert.equal(reads, 1)
  const stream = await fetch(`${app.baseUrl}/api/runs/${fetched.id}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let payload = ''
  while (!payload.includes('"status":"succeeded"')) {
    const next = await reader.read()
    if (next.done) break
    payload += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel()
  const input = payload.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    .find(event => event.kind === 'input')?.data.text as string
  assert.match(input, /认证后的迭代资料/)
  assert.match(input, /\[REDACTED\]/)
  assert.equal(input.includes(password) || input.includes(JSON.stringify(password).slice(1, -1)) || input.includes(basic), false)
  assert.equal(Object.hasOwn(fetched.accounts[0], 'password'), false)
})

test('本地文件夹要素按项目相对路径交给 Agent', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  const engine = await api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await api<Project>('/config/projects', 'POST', { name: '文件夹项目', directory: h.project })
  await mkdir(join(h.project, '素材'))
  await writeFile(join(h.project, '素材', '按钮规范.md'), '按钮规范')
  const resource = await api<Resource>('/config/resources', 'POST', { projectId: project.id, name: '素材目录', category: '设计', kind: 'file',
    value: join(h.project, '素材'), prompt: '参考素材目录', fetch: false, accountId: '' })
  assert.equal(resource.value, '素材')
  const run = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: '读取素材目录' })
  await waitForRun(api, run.id, 'succeeded')
  const stream = await fetch(`${app.baseUrl}/api/runs/${run.id}/events`)
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let payload = ''
  while (!payload.includes('"status":"succeeded"')) {
    const next = await reader.read()
    if (next.done) break
    payload += decoder.decode(next.value, { stream: true })
  }
  await reader.cancel()
  const input = payload.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    .find(event => event.kind === 'input')?.data.text as string
  assert.match(input, /项目文件夹相对路径，请读取该目录中的文件/)
  assert.match(input, /素材/)
})

test('任务可以只保存不执行，并可在重启后开始', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const engine = await app.api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '保存任务项目', directory: h.project })
  const run = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: '保存后稍后执行', start: false })
  assert.equal(run.status, 'saved')
  assert.equal(run.attempts.flat().length, 0)
  assert.equal((await app.api<RunSummary[]>('/runs')).find(item => item.id === run.id)?.status, 'saved')
  const form = { requestId: run.id, projectId: project.id, engineId: engine.id, goal: '保存后修改的目标', start: false, details: { output: '校验空数据' } }
  const edited = await app.api<Run>(`/runs/${run.id}`, 'PUT', form)
  assert.equal(edited.goal, '保存后修改的目标')
  assert.equal(edited.title, '保存后修改的目标')
  assert.equal(edited.status, 'saved')
  assert.equal(edited.details?.output, '校验空数据')
  assert.deepEqual(edited.attempts, run.attempts)
  await assert.rejects(() => app.api(`/runs/${run.id}/context`, 'PUT', { goal: '这份修改不应保存' }), /-> 404/)
  await assert.rejects(() => app.api(`/runs/${run.id}/optimize-context`, 'POST', { goal: '上下文优化入口已移除' }), /-> 404/)
  const path = `/runs/${run.id}/prompt`
  const automatic = await app.api<AgentPromptPreview>(path)
  assert.equal(automatic.edited, false)
  assert.match(automatic.text, /校验空数据/)
  const text = '自定义 Agent 提示词\n逐条校验空数据返回'
  const customized = await app.api<Run>(path, 'PUT', { text, revision: edited.revision })
  await assert.rejects(() => app.api(path, 'PUT', { text: '过期的编辑', revision: edited.revision }), /任务已变更/)
  assert.deepEqual(await app.api<AgentPromptPreview>(path), { text, edited: true })
  assert.equal((await app.api<Run>(path, 'PUT', { text: null, revision: customized.revision })).stages[0].promptOverride, undefined)
  assert.deepEqual(await app.api<AgentPromptPreview>(path), automatic)
  await app.api(path, 'PUT', { text })
  await app.stop()
  app = await serve(h.dir)
  assert.equal((await app.api<Run>(`/runs/${run.id}`)).goal, '保存后修改的目标')
  assert.deepEqual(await app.api<AgentPromptPreview>(path), { text, edited: true })
  await app.api(`/runs/${run.id}/start`, 'POST', {})
  const done = await waitForRun(app.api, run.id, 'succeeded')
  assert.match(done.goal ?? '', /保存后修改的目标/)
  assert.equal(done.details?.output, '校验空数据')
  assert.equal(typeof done.durationMs, 'number')
  assert.ok((done.durationMs ?? 0) >= 0)
  assert.equal(typeof (await app.api<RunSummary[]>('/runs')).find(item => item.id === run.id)?.durationMs, 'number')
  await assert.rejects(() => app.api(`/runs/${run.id}`, 'PUT', { ...form, goal: '完成后修改的记录' }), /已保存且未开始/)
  await assert.rejects(() => app.api(path, 'PUT', { text: '完成后修改提示词' }), /已保存且未开始/)
  await assert.rejects(() => app.api(`/runs/${run.id}/optimize-prompt`, 'POST', { text }), /已保存且未开始/)
  const stream = await fetch(`${app.baseUrl}/api/runs/${run.id}/events`, { signal: AbortSignal.timeout(5000) })
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  try {
    while (!received.includes('"status":"succeeded"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += decoder.decode(chunk.value, { stream: true })
    }
  } finally { await reader.cancel() }
  const input = received.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.kind === 'input')
  assert.equal(input?.data.text, text)
})

test('中断的任务可以继续修改', async t => {  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const engine = await app.api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '中断继续项目', directory: h.project })
  const run = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: 'HOLD_FOR_CANCEL' })
  await waitForRun(app.api, run.id, 'running')
  await app.stop()
  app = await serve(h.dir)
  assert.equal((await app.api<Run>(`/runs/${run.id}`)).status, 'interrupted')
  const next = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: '继续完成中断前的改动',
    continuation: { parentId: run.id, mode: 'handoff' } })
  assert.equal(next.continuation?.parentId, run.id)
  await waitForRun(app.api, next.id, 'running')
  await app.api(`/runs/${next.id}/stop`, 'POST', {})
  await waitForRun(app.api, next.id, 'stopped')
})

test('归档主任务时连同续改任务一起归档，恢复同样联动', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const engine = await app.api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '归档联动项目', directory: h.project })
  const first = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: '第一段工作' })
  await waitForRun(app.api, first.id, 'succeeded')
  const second = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: '第二段工作',
    continuation: { parentId: first.id, mode: 'handoff' } })
  await waitForRun(app.api, second.id, 'succeeded')
  const third = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: engine.id, goal: '第三段工作',
    continuation: { parentId: second.id, mode: 'handoff' } })
  await waitForRun(app.api, third.id, 'succeeded')

  await assert.rejects(app.api(`/runs/${second.id}/archive`, 'POST', {}), /整个会话/)
  await app.api(`/runs/${first.id}/archive`, 'POST', {})
  for (const id of [first.id, second.id, third.id]) assert.ok((await app.api<Run>(`/runs/${id}`)).archivedAt, id)
  await app.api(`/runs/${first.id}/unarchive`, 'POST', {})
  for (const id of [first.id, second.id, third.id]) assert.equal((await app.api<Run>(`/runs/${id}`)).archivedAt, undefined, id)
})
