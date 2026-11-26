import type { TestResult } from '../shared/contracts.ts'
import { CommandProcess } from './processes.ts'
import type { Launch } from './processes.ts'

export type JsonObject = Record<string, unknown>
export type RpcId = string | number
export function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
export function string(value: unknown): string { return typeof value === 'string' ? value : '' }

type Receiver = (method: string, params: JsonObject, id?: RpcId) => void

export class RpcError extends Error {
  readonly code: unknown
  constructor(message: string, code: unknown) {
    super(message)
    this.code = code
  }
}

export class StdioRpc {
  private child: CommandProcess
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (result: JsonObject) => void; reject: (error: Error) => void }>()
  private stopped = false
  private versioned: boolean
  private receive: Receiver
  readonly done: Promise<TestResult>

  constructor(launch: Launch, versioned: boolean, receive: Receiver, log: (text: string) => void) {
    this.versioned = versioned
    this.receive = receive
    this.child = new CommandProcess(launch, (stream, text) => {
      if (stream === 'stderr') log(text)
      else this.ingest(text, log)
    })
    this.done = this.child.done
    this.child.onExit(result => {
      this.stopped = true
      const error = new Error(result.error || `Agent 进程已退出（${result.code ?? result.signal ?? '未知状态'}）`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    })
  }

  private ingest(text: string, log: (text: string) => void) {
    this.buffer += text
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      this.ingestLine(line, log)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > 16_000_000) {
      log('Agent 的单条协议消息超过 16 MB，终止连接。')
      this.close()
    }
  }

  private ingestLine(line: string, log: (text: string) => void) {
    if (!line) return
    let message: JsonObject
    try { message = object(JSON.parse(line)) }
    catch { log(line); return }
    if (typeof message.method === 'string') {
      const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined
      this.receive(message.method, object(message.params), id)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.error) {
      const error = object(message.error)
      pending.reject(new RpcError(string(error.message) || 'Agent 协议请求失败', error.code))
    } else pending.resolve(object(message.result))
  }

  private send(message: JsonObject) {
    if (this.stopped) throw new Error('Agent 连接已经关闭')
    const envelope = this.versioned ? { jsonrpc: '2.0', ...message } : message
    this.child.write(`${JSON.stringify(envelope)}\n`)
  }

  async call(method: string, params: JsonObject = {}, deadline = 15_000): Promise<JsonObject> {
    const id = this.nextId++
    let timer: NodeJS.Timeout | undefined
    try {
      return await new Promise<JsonObject>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        if (deadline) timer = setTimeout(() => reject(new Error(`Agent 请求超时 · ${method}`)), deadline)
        this.send({ id, method, params })
      })
    } finally {
      if (timer) clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  notify(method: string, params: JsonObject = {}) { this.send({ method, params }) }
  reply(id: RpcId, result: JsonObject) { this.send({ id, result }) }
  unsupported(id: RpcId) { this.send({ id, error: { code: -32601, message: 'Client does not implement this request' } }) }
  close() { this.child.stop(); return this.done }
}
