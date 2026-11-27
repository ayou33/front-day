import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from '../shared/contracts.ts'
import { findExecutable } from './engine-connections.ts'
import { EngineSession } from './engines.ts'
import { HttpError } from './errors.ts'

export async function generateLocalText(engine: Engine, excludedEnv: string[], input: string, instructions: string) {
  const executable = await findExecutable(engine)
  if (!executable) throw new HttpError(409, `未找到 ${engine.name} 的 CLI，请检查引擎与 API 配置`)
  const directory = await mkdtemp(join(tmpdir(), 'front-day-optimize-'))
  const timeout = AbortSignal.timeout(60_000)
  let session: EngineSession | undefined
  const close = () => { if (session) void session.close() }
  timeout.addEventListener('abort', close, { once: true })
  try {
    session = new EngineSession({ ...engine, mode: 'ask', approvalMode: 'auto-deny' }, executable, directory, excludedEnv, {
      emit: () => {},
      request: close,
      resolved: () => {},
    })
    await session.start(timeout)
    return await session.prompt(`${instructions}\n\n待处理的 JSON 输入：\n${input}`)
  } catch (error) {
    if (timeout.aborted) throw new HttpError(502, '本地引擎优化超时，请稍后重试')
    throw error
  } finally {
    timeout.removeEventListener('abort', close)
    try { await session?.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}
