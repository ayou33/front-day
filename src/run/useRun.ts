import { useEffect, useState } from 'react'
import type { Run, RunEvent, RunState } from '../../shared/contracts.ts'
import { request } from '../api.ts'
import { message } from '../ui.tsx'

function isCurrent(next: Pick<Run, 'revision' | 'updatedAt'>, current: Run) {
  if (next.revision !== undefined || current.revision !== undefined) return (next.revision ?? 0) >= (current.revision ?? 0)
  return next.updatedAt >= current.updatedAt
}

export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    let disposed = false
    let es: EventSource | undefined
    let last = 0
    let frame = 0
    let batch: RunEvent[] = []
    function flush() {
      frame = 0
      const next = batch
      batch = []
      const states = next.filter(event => event.kind === 'state').map(event => event.data as RunState)
      if (states.length) setRun(current => current && states.reduce((latest, state) => {
        if (!isCurrent(state, latest)) return latest
        const { context, error, archivedAt, ...status } = state
        return { ...latest, ...context, ...status, error: error ?? undefined, approvalMode: state.approvalMode, archivedAt: archivedAt ?? undefined }
      }, current))
      setEvents(current => [...current, ...next])
    }
    void request<Run>(`/runs/${id}`).then(result => {
      if (disposed) return
      setRun(result)
      es = new EventSource(`/api/runs/${id}/events`)
      es.onopen = () => setConnected(true)
      es.onerror = () => setConnected(false)
      es.onmessage = message => {
        const event = JSON.parse(message.data) as RunEvent
        if (event.seq <= last) return
        last = event.seq
        batch.push(event)
        if (!frame) frame = window.requestAnimationFrame(flush)
      }
    }).catch(error => { if (!disposed) setError(message(error)) })
    return () => { disposed = true; es?.close(); if (frame) window.cancelAnimationFrame(frame) }
  }, [id])
  return { run, events, connected, error, accept: (next: Run) => setRun(current => !current || isCurrent(next, current) ? next : current) }
}
