import type { RunEvent } from '../../shared/contracts.ts'

export type RecordData = Record<string, unknown>
export const details = (value: unknown): RecordData => value && typeof value === 'object' ? value as RecordData : {}
export const textOf = (value: unknown) => typeof value === 'string' ? value : ''
export const readable = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')

export type Frame = { id: number; kind: RunEvent['kind']; title: string; data: RecordData; text?: string }

export function timeline(events: RunEvent[]) {
  const frames: Frame[] = []
  const messages = new Map<unknown, Frame>()
  const tools = new Map<unknown, Frame>()
  const output = new Map<unknown, Frame>()
  for (const event of events) {
    const data = details(event.data)
    const last = frames.at(-1)
    if (event.kind === 'agent_text') {
      const previous = data.replace ? messages.get(data.id) : last?.kind === 'agent_text' && last.data.id === data.id ? last : undefined
      if (previous) previous.text = data.replace ? textOf(data.text) : (previous.text ?? '') + textOf(data.text)
      else {
        const frame = { id: event.seq, kind: event.kind, title: 'Agent', data, text: textOf(data.text) }
        messages.set(data.id, frame)
        frames.push(frame)
      }
    } else if (event.kind === 'agent_item') {
      const toolId = data.id ?? data.toolCallId
      if (['item/started', 'item/completed', 'tool_call', 'tool_call_update'].includes(event.name) && toolId != null) {
        const previous = tools.get(toolId)
        if (previous) previous.data = { ...previous.data, ...data }
        else {
          const frame = { id: event.seq, kind: event.kind, title: event.name, data }
          tools.set(toolId, frame)
          frames.push(frame)
        }
      } else if (event.name.includes('/outputDelta') && data.itemId != null) {
        const previous = output.get(data.itemId)
        if (previous) previous.text = (previous.text ?? '') + textOf(data.delta)
        else {
          const frame = { id: event.seq, kind: event.kind, title: '实时输出', data, text: textOf(data.delta) }
          output.set(data.itemId, frame)
          frames.push(frame)
        }
      } else frames.push({ id: event.seq, kind: event.kind, title: event.name, data })
    } else if (event.kind === 'test_output' && last?.kind === 'test_output' && last.title === event.name) {
      last.text = (last.text ?? '') + textOf(data.text)
    } else if (!['native', 'state'].includes(event.kind)) {
      frames.push({ id: event.seq, kind: event.kind, title: event.name, data, text: textOf(data.text) })
    }
  }
  return frames
}
