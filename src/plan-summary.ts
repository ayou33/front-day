import type { PlanItem } from '../shared/contracts.ts'

export type PlanBriefing = {
  pending: { today: number; tomorrow: number; week: number; fiveWorkdays: number }
  active: number
}

const dayMs = 86_400_000
const utcDate = (date: string) => new Date(`${date}T00:00:00Z`)
const isoDay = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (date: string, days: number) => isoDay(new Date(utcDate(date).getTime() + days * dayMs))

function fifthWorkday(today: string) {
  let date = today
  let count = 0
  while (count < 5) {
    const weekday = utcDate(date).getUTCDay()
    if (weekday !== 0 && weekday !== 6) count++
    if (count < 5) date = addDays(date, 1)
  }
  return date
}

export function planBriefing(items: PlanItem[], today: string): PlanBriefing {
  const tomorrow = addDays(today, 1)
  const monday = addDays(today, -((utcDate(today).getUTCDay() + 6) % 7))
  const sunday = addDays(monday, 6)
  const workdayEnd = fifthWorkday(today)
  const pending = items.filter(item => item.status !== 'done' && item.endDate >= today)
  const due = (limit: string) => pending.filter(item => item.endDate <= limit).length
  return {
    pending: {
      today: pending.filter(item => item.endDate === today).length,
      tomorrow: pending.filter(item => item.endDate === tomorrow).length,
      week: due(sunday),
      fiveWorkdays: due(workdayEnd),
    },
    active: items.filter(item => item.status === 'in-progress').length,
  }
}
