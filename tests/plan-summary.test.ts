import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PlanItem } from '../shared/contracts.ts'
import { planBriefing } from '../src/plan-summary.ts'

const item = (id: string, status: PlanItem['status'], startDate: string, endDate: string): PlanItem =>
  ({ id, name: id, status, startDate, endDate, notes: '', order: 0 })

test('计划概览按今天、明天、本周和五个工作日统计待交付与进行中', () => {
  const briefing = planBriefing([
    item('today', 'planned', '2026-11-27', '2026-11-27'),
    item('tomorrow', 'in-progress', '2026-11-27', '2026-11-28'),
    item('week', 'planned', '2026-11-27', '2026-11-29'),
    item('workday', 'planned', '2026-11-30', '2026-12-02'),
    item('done', 'done', '2026-11-27', '2026-12-02'),
    item('later', 'planned', '2026-12-01', '2026-12-07'),
    item('overdue', 'planned', '2026-11-24', '2026-11-26'),
    item('ongoing', 'in-progress', '2026-12-01', '2026-12-10'),
  ], '2026-11-27')
  assert.deepEqual(briefing.pending, { today: 1, tomorrow: 1, week: 3, fiveWorkdays: 4 })
  assert.equal(briefing.active, 2)
})
