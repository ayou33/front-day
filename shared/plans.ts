export const planStatuses = ['planned', 'in-progress', 'done'] as const
export type PlanStatus = (typeof planStatuses)[number]
export const planStatusLabels = { planned: '未开始', 'in-progress': '进行中', done: '已完成' }
export const planMarkStyles = ['border', 'fill'] as const
export const planMarkLabelMax = 24

export type PlanDates = { startDate: string; endDate: string }

export function localPlanDate(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function pastPlanDateError(dates: PlanDates, today: string, previous?: PlanDates) {
  if (dates.startDate < today && dates.startDate !== previous?.startDate) return '开始日期不能早于今天'
  if (dates.endDate < today && dates.endDate !== previous?.endDate) return '结束日期不能早于今天'
  return ''
}

/** 只有进行中的计划在结束日期过去后才算逾期；未开始计划不进入逾期状态。 */
export function isPlanOverdue(item: { status: PlanStatus; endDate: string }, today: string) {
  return item.status === 'in-progress' && item.endDate < today
}

/** 开始按钮的互斥规则：已开始或已完成不能再开始。 */
export function planStartBlockedReason(item: { status: PlanStatus }) {
  if (item.status === 'done') return '计划已完成'
  if (item.status === 'in-progress') return '计划已开始'
  return ''
}

export function planCompleteBlockedReason(item: { status: PlanStatus }) {
  if (item.status === 'done') return '计划已完成'
  if (item.status === 'planned') return '计划未开始'
  return ''
}