import type { PlanItem } from '../shared/contracts.ts'
import type { PlanDates } from '../shared/plans.ts'

export const earliestDate = '0001-01-01'
export const latestDate = '9999-12-31'
export const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
export const planLaneHeight = 26
export const byPlanOrder = (a: PlanItem, b: PlanItem) => (a.order ?? 0) - (b.order ?? 0)
  || b.endDate.localeCompare(a.endDate) || a.name.localeCompare(b.name)

const dayMs = 86_400_000
const utcDate = (date: string) => new Date(`${date}T00:00:00Z`)
const isoDay = (date: Date) => date.toISOString().split('T')[0]
const validDate = (date: string) => date.length === 10 && date >= earliestDate && date <= latestDate

export function nextPlanDate(date: string) {
  return validDate(date) && date < latestDate ? isoDay(new Date(utcDate(date).getTime() + dayMs)) : date
}

export function moveMonth(month: string, offset: number) {
  const date = utcDate(`${month}-01`)
  date.setUTCMonth(date.getUTCMonth() + offset)
  return isoDay(date).slice(0, 7)
}

export function calendarWeeks(month: string) {
  const first = utcDate(`${month}-01`)
  const leadingDays = (first.getUTCDay() + 6) % 7
  const last = new Date(first)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  const weekCount = Math.ceil((leadingDays + last.getUTCDate()) / 7)
  return Array.from({ length: weekCount }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const date = isoDay(new Date(first.getTime() + (week * 7 + day - leadingDays) * dayMs))
    return validDate(date) ? date : null
  }))
}

export function layoutWeek(days: (string | null)[], sortedItems: PlanItem[]) {
  const first = days.find(date => date !== null)!
  const last = days.findLast(date => date !== null)!
  const laneEnds: number[] = []
  const segments = sortedItems.filter(item => item.startDate <= last && item.endDate >= first).map(item => {
    const startsBefore = item.startDate < first
    const endsAfter = item.endDate > last
    const start = days.indexOf(startsBefore ? first : item.startDate)
    const end = days.indexOf(endsAfter ? last : item.endDate)
    const freeLane = laneEnds.findIndex(previousEnd => previousEnd < start)
    const lane = freeLane === -1 ? laneEnds.length : freeLane
    laneEnds[lane] = end
    return { item, start, end, lane, startsBefore, endsAfter }
  })
  return { segments, lanes: laneEnds.length }
}

export function shiftPlan(item: PlanDates, from: string, to: string): PlanDates | null {
  if (from === to) return null
  const offset = utcDate(to).getTime() - utcDate(from).getTime()
  const startDate = isoDay(new Date(utcDate(item.startDate).getTime() + offset))
  const endDate = isoDay(new Date(utcDate(item.endDate).getTime() + offset))
  return validDate(startDate) && validDate(endDate) ? { startDate, endDate } : null
}
