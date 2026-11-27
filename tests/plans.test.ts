import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../server/storage.ts'
import type { PlanItem, Project } from '../shared/contracts.ts'
import { localPlanDate } from '../shared/plans.ts'
import { harness, serve } from './support.ts'

test('计划项独立保存，验证日期并在服务重启后保留', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })

  const path = '/config/plan-items'
  const year = new Date().getFullYear() + 1
  const draft = { name: '跨月排期', startDate: `${year}-02-28`, endDate: `${year}-03-02`, status: 'planned', notes: '手动维护' }
  assert.deepEqual(await app.api(path), [])
  for (const dates of [{ startDate: `${year}-02-30` }, { endDate: `${year}-02-27` }]) {
    await assert.rejects(app.api(path, 'POST', { ...draft, ...dates }), /POST .* -> 400/)
  }
  assert.deepEqual(await app.api(path), [])

  const project = await app.api<Project>('/config/projects', 'POST', { name: '本地项目', directory: h.project })
  const plan = await app.api<PlanItem>(path, 'POST', { ...draft, projectId: project.id, runId: 'unrelated-task' })
  assert.deepEqual(plan, { ...draft, id: plan.id })
  assert.equal(Object.hasOwn(await app.api<object>('/catalog'), 'plan-items'), false)
  await app.api(`/config/projects/${project.id}`, 'DELETE')

  const updated = await app.api<PlanItem>(`${path}/${plan.id}`, 'PUT', { ...plan, status: 'done', endDate: plan.startDate })
  assert.equal(updated.status, 'done')
  assert.equal(updated.endDate, updated.startDate)
  await app.stop()
  app = await serve(h.dir)
  assert.deepEqual(await app.api(path), [updated])

  const dates = { startDate: `${year}-03-03`, endDate: `${year}-03-03` }
  const moved = await app.api<PlanItem>(`${path}/${plan.id}`, 'PATCH', { ...dates, status: 'planned', notes: '旧备注' })
  assert.deepEqual(moved, { ...updated, ...dates })
  await assert.rejects(app.api(`${path}/${plan.id}`, 'PATCH', { ...dates, endDate: plan.startDate }), /PATCH .* -> 400/)
  assert.deepEqual(await app.api(path), [moved])

  await app.api(`${path}/${plan.id}`, 'DELETE')
  await assert.rejects(app.api(`${path}/${plan.id}`, 'PUT', plan), /PUT .* -> 404/)
  await assert.rejects(app.api(`${path}/${plan.id}`, 'PATCH', dates), /PATCH .* -> 404/)
  assert.deepEqual(await app.api(path), [])
})

test('新日期必须从今天起，历史计划可保留原日期并单独调整结束日期', async t => {  const h = await harness()
  let app: Awaited<ReturnType<typeof serve>> | undefined
  t.after(async () => { await app?.stop(); await h.cleanup() })
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const past = localPlanDate(yesterday)
  const future = `${new Date().getFullYear() + 1}-04-03`
  const db = new Store(join(h.dir, 'data', 'workbench.sqlite'))
  const historical = db.saveConfig('plan-items', { name: '历史计划', startDate: past, endDate: past, status: 'done', notes: '' })
  db.close()
  app = await serve(h.dir)
  const path = '/config/plan-items'
  const entry = `${path}/${historical.id}`

  await assert.rejects(app.api(path, 'POST', historical), /POST .* -> 400 .*开始日期不能早于今天/)
  const renamed = await app.api<PlanItem>(entry, 'PUT', { ...historical, name: '已改名的历史计划' })
  const resized = await app.api<PlanItem>(entry, 'PATCH', { endDate: future })
  assert.deepEqual(resized, { ...renamed, endDate: future })
  await assert.rejects(app.api(entry, 'PATCH', { endDate: past }), /PATCH .* -> 400 .*结束日期不能早于今天/)
  await assert.rejects(app.api(entry, 'PUT', { ...resized, endDate: past }), /PUT .* -> 400 .*结束日期不能早于今天/)
  await assert.rejects(app.api(entry, 'PATCH', { startDate: `${future.slice(0, 8)}04` }), /PATCH .* -> 400 .*结束日期不能早于开始日期/)
  assert.deepEqual(await app.api(path), [resized])
})

test('标记按日期独立保存顺序和样式，清空后移除该日期记录', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const path = '/config/plan-day-marks'
  const date = '2024-02-29'
  const marks = [{ label: '休', style: 'border', color: '#27966b' }, { label: '假', style: 'fill', color: '#f5c66c', notes: '上午休息\n下午返程' }]

  assert.deepEqual(await app.api(path), [])
  await assert.rejects(app.api(`${path}/2023-02-29`, 'PUT', { marks }), /PUT .* -> 400/)
  await assert.rejects(app.api(`${path}/${date}`, 'PUT', { marks: [{ ...marks[0], color: 'red' }] }), /PUT .* -> 400/)
  assert.deepEqual(await app.api(`${path}/${date}`, 'PUT', { marks }), { id: date, marks })
  assert.deepEqual(await app.api('/config/plan-items'), [])
  await app.stop()
  app = await serve(h.dir)
  assert.deepEqual(await app.api(path), [{ id: date, marks }])

  const remaining = { marks: [marks[1]] }
  assert.deepEqual(await app.api(`${path}/${date}`, 'PUT', remaining), { id: date, ...remaining })
  assert.deepEqual(await app.api(path), [{ id: date, ...remaining }])
  await app.api(`${path}/${date}`, 'PUT', { marks: [] })
  assert.deepEqual(await app.api(path), [])
})

test('同日计划项可调整顺序并在重启后保留', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const path = '/config/plan-items'
  const startDate = `${new Date().getFullYear() + 1}-03-01`
  const base = { startDate, endDate: startDate, status: 'planned', notes: '' }
  const first = await app.api<PlanItem>(path, 'POST', { ...base, name: '第一项', order: 0 })
  const second = await app.api<PlanItem>(path, 'POST', { ...base, name: '第二项', order: 1 })
  const moved = await app.api<PlanItem>(`${path}/${second.id}`, 'PATCH', { order: 0 })
  assert.equal(moved.order, 0)
  assert.equal((await app.api<PlanItem>(`${path}/${first.id}`, 'PATCH', { order: 1 })).order, 1)
  await app.stop()
  app = await serve(h.dir)
  assert.deepEqual((await app.api<PlanItem[]>(path)).map(item => [item.name, item.order]).sort(), [['第一项', 1], ['第二项', 0]])
})
