import { useEffect, useState } from 'react'
import { archivedRun } from '../../shared/contracts.ts'
import type { Run, RunEvent, RunRecord, RunState } from '../../shared/contracts.ts'
import { request } from '../api.ts'
import { message } from '../ui.tsx'

function isCurrent(next: Pick<Run, 'revision' | 'updatedAt'>, current: RunRecord) {
  if (next.revision !== undefined || current.revision !== undefined) return (next.revision ?? 0) >= (current.revision ?? 0)
  return next.updatedAt >= current.updatedAt
}

export function useRun(id: string) {
  const [record, setRecord] = useState<RunRecord | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [streamVersion, setStreamVersion] = useState(0)
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
      if (states.length) setRecord(current => current && states.reduce<RunRecord>((latest, state) => {
        if (!isCurrent(state, latest) || !('attempts' in latest)) return latest
        const { context, task, error, archivedAt, ...status } = state
        if (archivedAt) return archivedRun({ ...latest, ...status }, archivedAt)
        const updatedTask = task && { title: task.title, goal: task.goal, taskType: task.taskType, brief: task.brief, details: task.details,
          apiFiles: task.apiFiles, apiExcluded: task.apiExcluded }
        return { ...latest, ...context, ...updatedTask, ...status, error: error ?? undefined, approvalMode: state.approvalMode, archivedAt: undefined }
      }, current))
      setEvents(current => [...current, ...next])
    }
    void request<RunRecord>(`/runs/${id}`).then(result => {
      if (disposed) return
      setRecord(current => !current || isCurrent(result, current) ? result : current)
      setEvents([])
      if (result.archivedAt) return
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
  }, [id, streamVersion])
  function accept(next: RunRecord) {
    if (record && !isCurrent(next, record)) return
    setRecord(current => !current || isCurrent(next, current) ? next : current)
    if (record?.archivedAt && !next.archivedAt) setStreamVersion(version => version + 1)
  }
  const run = record && 'attempts' in record && !record.archivedAt ? record : null
  const archived = record?.archivedAt ? record : null
  return { run, archived, events, connected, error, accept }
}
