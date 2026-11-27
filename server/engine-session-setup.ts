import type { Engine } from '../shared/contracts.ts'
import { array, object, RpcError, string } from './rpc.ts'
import type { EngineRpc, JsonObject } from './rpc.ts'

const sessionSetupTimeout = 20_000

function choices(options: unknown): JsonObject[] {
  return array(options).map(object).flatMap(entry => Array.isArray(entry.options) ? choices(entry.options) : [entry])
}

const normalize = (value: string) => value.trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')

async function applyOption(rpc: EngineRpc, engine: Engine, session: JsonObject, sessionId: string, category: 'mode' | 'model') {
  const legacy = object(category === 'mode' ? session.modes : session.models)
  const descriptor = array(session.configOptions).map(object).find(option => option.category === category && string(option.id))
  const advertised = [
    ...choices(descriptor?.options),
    ...array(category === 'mode' ? legacy.availableModes : legacy.availableModels).map(object),
  ].map(entry => ({ id: string(entry.value ?? entry.modeId ?? entry.modelId ?? entry.id), name: string(entry.name) })).filter(item => item.id)
  const desired = category === 'mode' ? engine.mode : engine.model
  const preferred = category === 'mode' ? (desired === 'ask' ? ['ask', 'read-only', 'plan'] : ['plan', 'read-only']) : [normalize(desired)]
  const exact = category === 'model' ? advertised.find(item => item.id === desired) : undefined
  const selected = exact ?? preferred.map(value => advertised.find(item => normalize(item.id) === value || normalize(item.name) === value)).find(Boolean)
  const target = selected?.id ?? (category === 'mode' && engine.provider !== 'cursor' ? 'plan' : desired)
  const current = descriptor?.currentValue ?? (category === 'mode' ? legacy.currentModeId : legacy.currentModelId)
  const label = category === 'mode' ? '运行模式' : '模型'
  if (category === 'mode' && advertised.length && !selected) {
    throw new Error(`${engine.name} 未提供「${desired}」所需的只读模式`)
  }
  if (target === current) return
  try {
    if (descriptor) await rpc.call('session/set_config_option', { sessionId, configId: descriptor.id, value: target })
    else if (category === 'mode') await rpc.call('session/set_mode', { sessionId, modeId: target })
    else await rpc.call('session/set_model', { sessionId, modelId: target })
  } catch (error) {
    if (error instanceof RpcError && error.code === -32000) throw error
    throw new Error(`${engine.name} 无法设置${label}「${desired}」 · ${error instanceof Error ? error.message : '请检查引擎设置'}`)
  }
}

export async function openAcpSession(rpc: EngineRpc, engine: Engine, cwd: string, init: JsonObject, resumeId?: string) {
  if (resumeId && object(init.agentCapabilities).loadSession !== true) throw new Error('此引擎未声明支持恢复 ACP 会话')
  const session = await rpc.call(resumeId ? 'session/load' : 'session/new',
    { cwd, mcpServers: [], ...(resumeId && { sessionId: resumeId }) }, sessionSetupTimeout)
  const id = resumeId ?? string(session.sessionId)
  if (!id) throw new Error(`${engine.name} 未返回会话 ID`)
  if (engine.mode !== 'agent') await applyOption(rpc, engine, session, id, 'mode')
  if (engine.model) await applyOption(rpc, engine, session, id, 'model')
  return id
}

export async function openCodexThread(rpc: EngineRpc, engine: Engine, cwd: string, resumeId?: string, probe = false, forkTurnId?: string) {
  const session = await rpc.call(forkTurnId ? 'thread/fork' : resumeId ? 'thread/resume' : 'thread/start', {
    cwd, ...(engine.model && { model: engine.model }),
    sandbox: engine.mode === 'agent' ? 'workspace-write' : 'read-only', approvalPolicy: 'on-request',
    ...(resumeId && { threadId: resumeId, excludeTurns: true }),
    ...(forkTurnId && { lastTurnId: forkTurnId }),
    ...(probe && { ephemeral: true }),
  }, sessionSetupTimeout)
  const id = string(object(session.thread).id)
  if (!id) throw new Error('Codex 未返回会话 ID')
  if (forkTurnId && id === resumeId) throw new Error('Codex 未返回新的分支 ID')
  if (resumeId && !forkTurnId && id !== resumeId) throw new Error('Codex 返回的会话 ID 与要续接的原会话不一致')
  return { id, model: string(session.model) || engine.model }
}
