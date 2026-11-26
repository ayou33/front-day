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

test('统一使用项目和迭代要素，旧迭代信息迁移一次且保留原内容', async t => {
  const h = await harness()
  const database = join(h.dir, 'data', 'workbench.sqlite')
  const store = new Store(database)
  const project = store.saveConfig('projects', { name: '项目 A', directory: h.project, description: '项目通用背景', testCommand: null })
  const legacy = store.saveConfig('resources', { name: '旧项目资料', projectId: project.id, kind: 'text', value: '旧背景', category: '说明', prompt: '', fetch: false, accountId: '' })
  const previous = store.saveConfig('iterations', { name: '当前迭代', projectId: project.id, description: '迭代说明' })
  store.close()
  const legacyDb = new DatabaseSync(database)
  try {
    legacyDb.prepare('DELETE FROM settings WHERE key = ?').run('iteration-elements-v1')
    legacyDb.prepare("UPDATE configs SET json = ? WHERE kind = 'iterations' AND id = ?").run(
      JSON.stringify({ ...previous, scope: '当前迭代的范围', context: { requirements: '保留原有报名需求', validation: '校验订单号' } }), previous.id)
  } finally { legacyDb.close() }
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  await api('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const migrated = await api<Catalog>('/catalog')
  assert.ok(migrated.resources.some(resource => resource.id === legacy.id))
  assert.deepEqual(migrated.iterations.find(iteration => iteration.id === previous.id), previous)
  const converted = migrated.resources.filter(resource => resource.iterationId === previous.id)
  assert.deepEqual(converted.map(({ name, category, value }) => ({ name, category, value })), [
    { name: '迭代范围', category: '需求', value: '当前迭代的范围' },
    { name: '迭代需求', category: '需求', value: '保留原有报名需求' },
    { name: '迭代验收', category: '验收', value: '校验订单号' },
  ])
  const otherProject = await api<Project>('/config/projects', 'POST', { name: '项目 B', directory: h.project })
  const sibling = await api<Iteration>('/config/iterations', 'POST', { name: '其他迭代', projectId: project.id })
  const addResource = (name: string, iterationId?: string, projectId = project.id) => api<Resource>('/config/resources', 'POST', {
    projectId, iterationId, name, kind: 'text', value: name, category: '说明', prompt: '', fetch: false, accountId: '',
  })
  await assert.rejects(() => addResource('错误资料', previous.id, otherProject.id), /400/)
  await addResource('项目级新要素')
  await addResource('当前迭代资料', previous.id)
  await addResource('其他迭代资料', sibling.id)
  const dispatch = (projectId: string, iterationId?: string) => api<Run>('/runs', 'POST', {
    requestId: randomUUID(), projectId, iterationId, goal: '完成目标',
  })
  await assert.rejects(() => dispatch(otherProject.id, previous.id), /400/)
  const run = await dispatch(project.id, previous.id)
  const completed = await waitForRun(api, run.id, 'succeeded')
  assert.equal(completed.iteration?.description, '迭代说明')
  assert.equal(completed.project.description, '项目通用背景')
  assert.deepEqual(completed.resources.map(resource => resource.name), ['旧项目资料', '迭代范围', '迭代需求', '迭代验收', '项目级新要素', '当前迭代资料'])
  const direct = await dispatch(project.id)
  assert.deepEqual(direct.resources.map(resource => resource.name), ['旧项目资料', '项目级新要素'])
  await waitForRun(api, direct.id, 'succeeded')
  await api(`/config/iterations/${previous.id}`, 'PUT', { ...previous, description: '新版说明' })
  assert.equal((await api<Run>(`/runs/${run.id}`)).iteration?.description, '迭代说明')
  await app.stop()
  const reopened = new Store(database)
  try {
    assert.deepEqual(reopened.getConfig('resources', legacy.id), legacy)
    assert.equal(reopened.listConfig('resources').filter(resource => resource.iterationId === previous.id).length, 4)
  }
  finally { reopened.close() }
})


test('切换数据目录保护已有数据和运行中的任务，并应用任务默认值', { timeout: 30_000 }, async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  const defaults = await api<Preferences>('/preferences')
  assert.equal(defaults.recentTaskLimit, 5)
  assert.equal(defaults.followOutput, true)
  assert.equal(defaults.theme, 'auto')
  const engine = await api<Engine>('/config/engines/codex-default', 'PUT', { name: 'Codex', provider: 'codex', executable: h.wrappers.codex, model: '', mode: 'agent' })
  const prefs = { ...defaults, defaultEngineId: engine.id, defaultTaskType: 'requirements', recentTaskLimit: 8, followOutput: false, theme: 'dark' }
  await api('/preferences', 'PUT', prefs)
  const project = await api<Project>('/config/projects', 'POST', { name: '数据目录项目', directory: h.project })
  const run = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, goal: 'HOLD_FOR_CANCEL' })
  assert.equal(run.taskType, 'requirements')
  assert.equal(run.stages[0].engine?.id, engine.id)
  await waitForRun(api, run.id, 'running', current => !!current.attempts[0][0]?.sessionId)
  const target = join(h.dir, 'history')
  await mkdir(target)
  await assert.rejects(() => api('/preferences', 'PUT', { ...prefs, dataDirectory: target }), /请等任务/)
  await api(`/runs/${run.id}/stop`, 'POST', {})
  await waitForRun(api, run.id, 'stopped')
  const occupied = join(h.dir, 'occupied')
  await mkdir(occupied)
  const existing = join(occupied, 'workbench.sqlite')
  await writeFile(existing, 'existing database sentinel')
  await assert.rejects(() => api('/preferences', 'PUT', { ...prefs, dataDirectory: occupied }), /目标目录已有/)
  assert.equal(await readFile(existing, 'utf8'), 'existing database sentinel')
  const saved = await api<Preferences>('/preferences', 'PUT', { ...prefs, dataDirectory: target })
  assert.deepEqual(saved, { ...prefs, dataDirectory: target })
  assert.equal(saved.theme, 'dark')
  await assert.rejects(() => api('/preferences', 'PUT', { ...prefs, theme: 'blue' }), /400/)
  assert.equal((await api<Run>(`/runs/${run.id}`)).status, 'stopped')
  const db = new DatabaseSync(join(target, 'workbench.sqlite'), { readOnly: true })
  try { assert.ok(db.prepare('SELECT 1 FROM run_events WHERE run_id = ? LIMIT 1').get(run.id)) }
  finally { db.close() }
})

test('旧偏好文件缺少主题字段时按跟随系统处理', async t => {
  const h = await harness()
  await writeFile(join(h.dir, '.front-day.preferences.json'), JSON.stringify({
    dataDirectory: join(h.dir, 'data'), defaultEngineId: '', defaultTaskType: '', followOutput: true, recentTaskLimit: 5,
  }))
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  assert.equal((await app.api<Preferences>('/preferences')).theme, 'auto')
})

test('内置流水线模板覆盖需求、Issue 与排查场景，重启不会重复写入', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const templates = (await app.api<Catalog>('/catalog')).templates
  const names = templates.map(template => template.name)
  for (const name of ['前端交付', '需求整理', 'Issue 概览', 'Issue 修复', '问题分析', '实施计划']) assert.ok(names.includes(name), name)
  assert.equal(new Set(templates.map(template => template.id)).size, templates.length)
  const brief = templates.find(template => template.name === '需求整理')!
  assert.equal(brief.stages.length, 2)
  assert.ok(brief.stages.every(stage => stage.kind === 'agent' && stage.mode === 'ask' && stage.advance === 'auto'))
  const fix = templates.find(template => template.name === 'Issue 修复')!
  assert.deepEqual(fix.stages.map(stage => stage.name), ['定位与复现', '修复与自测'])
  assert.equal(fix.stages[1].mode, '')
  await app.stop()
  app = await serve(h.dir)
  assert.equal((await app.api<Catalog>('/catalog')).templates.length, templates.length)
})