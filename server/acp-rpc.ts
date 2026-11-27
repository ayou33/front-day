import { client, ndJsonStream, RequestError } from '@agentclientprotocol/sdk'
import type { ClientConnection, ClientRequestContext } from '@agentclientprotocol/sdk'
import type { TestResult } from '../shared/contracts.ts'
import { CommandProcess } from './processes.ts'
import type { Launch } from './processes.ts'
import { object, RpcError } from './rpc.ts'
import type { EngineRpc, JsonObject, Receiver, RpcId } from './rpc.ts'

type InboundRequest = ReturnType<typeof Promise.withResolvers<JsonObject>> & { method: string }
const maxMessageBytes = 16_000_000

export class AcpRpc implements EngineRpc {
  private child: CommandProcess
  private connection: ClientConnection
  private pending = new Map<RpcId, InboundRequest>()
  readonly done: Promise<TestResult>

  constructor(launch: Launch, receive: Receiver, log: (text: string) => void, cancelled: (id: RpcId) => void) {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const input = new ReadableStream<Uint8Array>({
      start: value => { controller = value },
      cancel: () => { controller = undefined },
    })
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    this.child = new CommandProcess(launch, (stream, text) => {
      if (stream === 'stderr') log(text)
      else controller?.enqueue(encoder.encode(text))
    })
    const output = new WritableStream<Uint8Array>({
      write: bytes => this.child.write(decoder.decode(bytes)),
    })
    this.connection = client({ name: 'front-day' })
      .onRequest('*', ctx => this.request(ctx, receive, cancelled))
      .onNotification('*', ({ method, params }) => { receive(method, object(params)) })
      .connect(ndJsonStream(output, input, { maxMessageBytes }))
    this.done = this.child.done.then(async result => {
      controller?.close()
      controller = undefined
      await this.connection.closed
      return result
    })
    void this.connection.closed.then(() => this.child.stop())
  }

  private async request({ method, requestId, params, signal }: ClientRequestContext<unknown>, receive: Receiver, cancelled: (id: RpcId) => void) {
    if (requestId === null) throw RequestError.invalidRequest()
    const pending = { ...Promise.withResolvers<JsonObject>(), method }
    const abort = () => {
      if (method === 'session/request_permission') pending.resolve({ outcome: { outcome: 'cancelled' } })
      else pending.reject(RequestError.requestCancelled())
      cancelled(requestId)
    }
    signal.addEventListener('abort', abort, { once: true })
    this.pending.set(requestId, pending)
    try {
      signal.throwIfAborted()
      try { receive(method, object(params), requestId) } catch (error) { pending.reject(error) }
      return await pending.promise
    } finally {
      signal.removeEventListener('abort', abort)
      this.pending.delete(requestId)
    }
  }

  async call(method: string, params: JsonObject = {}, deadline = 15_000) {
    const signal = deadline ? AbortSignal.timeout(deadline) : undefined
    try { return object(await this.connection.agent.request(method, params, { cancellationSignal: signal, stopWaitingOnCancel: true })) }
    catch (error) {
      if (signal?.aborted) throw new Error(`Agent 请求超时 · ${method}`)
      if (error instanceof RequestError) throw new RpcError(error.message, error.code)
      throw error
    }
  }

  notify(method: string, params: JsonObject = {}) { return this.connection.agent.notify(method, params) }
  reply(id: RpcId, result: JsonObject) { this.pending.get(id)?.resolve(result) }
  unsupported(id: RpcId) {
    const request = this.pending.get(id)
    if (request) request.reject(RequestError.methodNotFound(request.method))
  }

  close() {
    this.connection.close()
    this.child.stop()
    return this.done
  }
}
