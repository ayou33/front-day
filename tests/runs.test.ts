import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { Account, Catalog, Engine, EngineHealth, Iteration, Project, Resource, Run, RunSummary, Template } from '../shared/contracts.ts'
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

test('任务可以归档和恢复，服务重启后保留执行记录与所属迭代', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const engine = await app.api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '归档项目', directory: h.project })
  const iteration = await app.api<Iteration>('/config/iterations', 'POST', { name: '归档迭代', projectId: project.id })
  const run = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, iterationId: iteration.id, engineId: engine.id, goal: 'HOLD_FOR_CANCEL' })
  await waitForRun(app.api, run.id, 'running', current => !!current.attempts[0]?.[0]?.sessionId)
  const archived = await app.api<Run>(`/runs/${run.id}/archive`, 'POST', {})
  assert.ok(archived.archivedAt)
  assert.equal(archived.status, 'running')
  assert.equal((await app.api<Run>(`/runs/${run.id}/archive`, 'POST', {})).archivedAt, archived.archivedAt)
  await app.api(`/runs/${run.id}/stop`, 'POST', {})
  const stopped = await waitForRun(app.api, run.id, 'stopped')
  assert.equal(stopped.archivedAt, archived.archivedAt)
  await app.stop()
  app = await serve(h.dir)
  const summary = (await app.api<RunSummary[]>('/runs')).find(item => item.id === run.id)
  assert.equal(summary?.archivedAt, archived.archivedAt)
  assert.equal(summary?.projectId, project.id)
  assert.equal(summary?.iterationId, iteration.id)
  const restored = await app.api<Run>(`/runs/${run.id}/unarchive`, 'POST', {})
  assert.equal(restored.archivedAt, undefined)
  assert.equal(restored.status, 'stopped')
  assert.deepEqual(restored.attempts, stopped.attempts)
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
    assert.doesNotMatch(firstAttempt.output ?? '', /front-day-handoff/)
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
  const run = await api<Run>('/runs', 'POST', { ...payload, projectId: project.id, iterationId: iteration.id })
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
  const dispatch = () => app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, iterationId: iteration.id, goal: '读取接口说明' })
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
  const fetched = await dispatch()
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
