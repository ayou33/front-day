import { array, object, string } from './rpc.ts'
import type { PromptOptimizerProvider } from '../shared/prompt-optimizer.ts'

export type ModelUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export type ModelTelemetry = ModelUsage & { elapsedMs: number }

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function modelUsage(provider: PromptOptimizerProvider, payload: unknown): ModelUsage {
  const data = object(payload)
  const usage = object(provider === 'gemini' ? data.usageMetadata : data.usage)
  const input = count(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount)
  const inputTokens = provider === 'anthropic' && input !== undefined
    ? input + (count(usage.cache_creation_input_tokens) ?? 0) + (count(usage.cache_read_input_tokens) ?? 0) : input
  const outputTokens = count(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount)
  const totalTokens = count(usage.total_tokens ?? usage.totalTokenCount)
  return { ...(inputTokens !== undefined && { inputTokens }), ...(outputTokens !== undefined && { outputTokens }),
    ...(totalTokens !== undefined && { totalTokens }) }
}

const streamEventLimit = 1_000_000

async function* serverEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let separator: RegExpMatchArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const at = separator.index!
        if (at > streamEventLimit) throw new Error('API 流式响应事件过大')
        const event = buffer.slice(0, at)
        buffer = buffer.slice(at + separator[0].length)
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (data === '[DONE]') return
        if (data) yield object(JSON.parse(data))
      }
      if (buffer.length > streamEventLimit) throw new Error('API 流式响应事件过大')
      if (done) return
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function readModelStream(provider: PromptOptimizerProvider, body: ReadableStream<Uint8Array>, onText?: (delta: string) => void) {
  let text = ''
  let completed = false
  let normalEnd = false
  let usage: ModelUsage = {}
  const append = (delta: string) => {
    if (!delta) return
    text += delta
    if (text.length > streamEventLimit) throw new Error('模型输出过大')
    onText?.(delta)
  }
  for await (const event of serverEvents(body)) {
    if (event.error || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('模型中止输出')
    usage = { ...usage, ...modelUsage(provider, event) }
    if (provider === 'openai' || provider === 'xai') {
      if (event.type === 'response.output_text.delta') append(string(event.delta))
      if (event.type === 'response.completed') { completed = true; usage = modelUsage(provider, event.response); break }
    } else if (provider === 'anthropic') {
      if (event.type === 'message_start') usage = modelUsage(provider, event.message)
      const delta = object(event.delta)
      const block = object(event.content_block)
      if (event.type === 'content_block_start' && block.type === 'text') append(string(block.text))
      if (event.type === 'content_block_delta' && delta.type === 'text_delta') append(string(delta.text))
      if (event.type === 'message_delta' && delta.stop_reason) normalEnd = delta.stop_reason === 'end_turn' || delta.stop_reason === 'stop_sequence'
      if (event.type === 'message_stop') { completed = normalEnd; break }
    } else if (provider === 'gemini') {
      const candidate = object(array(event.candidates)[0])
      for (const part of array(object(candidate.content).parts).map(object)) if (part.thought !== true) append(string(part.text))
      if (candidate.finishReason) completed = candidate.finishReason === 'STOP'
    } else {
      const choice = object(array(event.choices)[0])
      append(string(object(choice.delta).content))
      if (choice.finish_reason) completed = choice.finish_reason === 'stop'
    }
  }
  if (!completed || !text.trim()) throw new Error('模型未返回完整内容')
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined && provider === 'anthropic') {
    usage.totalTokens = usage.inputTokens + usage.outputTokens
  }
  return { text, usage }
}
