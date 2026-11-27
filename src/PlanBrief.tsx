import { Activity, CalendarClock } from 'lucide-react'
import type { PlanBriefing } from './plan-summary.ts'

const buckets = [
  { key: 'today', label: '今天', hint: '今天' },
  { key: 'tomorrow', label: '明天', hint: '明天' },
  { key: 'week', label: '本周', hint: '本周' },
  { key: 'fiveWorkdays', label: '一周内', hint: '一周内（5 个工作日）' },
] as const

export function PlanBrief({ briefing }: { briefing: PlanBriefing }) {
  return <div className="plan-brief" aria-label="计划概览">
    <div className="plan-brief-group">
      <span className="plan-brief-label"><CalendarClock size={14} aria-hidden="true" />待交付</span>
      {buckets.map(({ key, label, hint }) => {
        const count = briefing.pending[key]
        return <a key={key} href="#/plans" className={`plan-brief-item${count ? ' has-items' : ''}`}
          title={`${hint}待交付 ${count} 项`}><span>{label}</span><b>{count}</b></a>
      })}
    </div>
    <span className="plan-brief-sep" aria-hidden="true" />
    <a href="#/plans" className={`plan-brief-item plan-brief-active${briefing.active ? ' has-items' : ''}`} title={`进行中 ${briefing.active} 项`}>
      <span className="plan-brief-label"><Activity size={14} aria-hidden="true" />进行中</span><b>{briefing.active}</b>
    </a>
  </div>
}
