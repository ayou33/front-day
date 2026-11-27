export const planStatuses = ['planned', 'in-progress', 'done'] as const
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
