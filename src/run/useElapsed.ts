import { useEffect, useState } from 'react'
import { terminalStatuses } from '../../shared/contracts.ts'
import type { Run } from '../../shared/contracts.ts'

/** Live execution time: completed attempt spans plus the current attempt, excluding queues and idle gaps. */
export function useElapsed(run: Run | null) {
  const active = !!run && !terminalStatuses.has(run.status) && run.status !== 'saved' && run.status !== 'queued'
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  if (!run) return undefined
  const attempts = run.attempts.flat()
  const completed = attempts.filter(attempt => attempt.endedAt)
    .reduce((total, attempt) => total + Math.max(0, Date.parse(attempt.endedAt!) - Date.parse(attempt.startedAt)), 0)
  const running = attempts.findLast(attempt => !attempt.endedAt)
  return completed + (running ? Math.max(0, Date.now() - Date.parse(running.startedAt)) : 0)
}
