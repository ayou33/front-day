import { createInterface } from 'node:readline'
import { unlinkSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { engineGuides } from '../../shared/engines.ts'
import type { Provider } from '../../shared/engines.ts'

const [provider, command, ...args] = process.argv.slice(2) as [Provider, string | undefined, ...string[]]
function terminalCommand() {
  if (command === '--version') { console.log(`fixture-${provider} 1.0`); return true }
  if (command === 'status') {
    const value = process.env.FRONT_DAY_FIXTURE_CURSOR_AUTH
    if (value === 'mixed') console.error('For more help, see authentication required when there is no saved session')
    console.log(value === 'signed-out' ? 'Not logged in' : 'Logged in')
    return true
  }
  if (provider === 'opencode' && command === 'auth' && args[0] === 'list') {
    console.log('1 credential')
    return true
  }
  if (JSON.stringify([command, ...args].filter(Boolean)) === JSON.stringify(engineGuides[provider].args)) return false
  process.exitCode = 2
  return true
}
const acp = provider !== 'codex'
const cursor = provider === 'cursor'
let sessionId = !acp && process.env.FRONT_DAY_FIXTURE_UNIQUE_CODEX_SESSIONS ? `codex-session-${process.pid}` : `${provider}-session`
let turn = 0
let mode = ''
let model = 'fixture-model'
let current: { request: number; prompt: string; id: string; cancelled?: boolean } | undefined
const send = (message: object) => process.stdout.write(`${JSON.stringify(acp ? { jsonrpc: '2.0', ...message } : message)}\n`)
const result = (id: number, data: object) => send({ id, result: data })
const update = (data: object) => send({ method: 'session/update', params: { sessionId, update: data } })

function complete() {
  if (!current) return
  const { request, prompt, id, cancelled } = current
  current = undefined
  if (!cancelled && prompt.includes('FIXTURE_FILE_CHANGES')) {
    writeFileSync('added.ts', 'export const added = true\n')
    writeFileSync('modified.ts', 'export const value = 2\n')
    unlinkSync('removed.ts')
  }
  const longOutput = prompt.includes('LONG_OUTPUT')
  const handoff = longOutput || prompt.includes('CONTINUATION_SUMMARY')
    ? '\n<front-day-handoff>{"changes":"表单保存完成","constraints":"沿用旧接口","files":"src/form.ts","verification":"表单用例通过"}</front-day-handoff>本地预览服务已结束。'
    : ''
  if (acp) {
    if (!cancelled) {
      update({ sessionUpdate: 'tool_call_update', toolCallId: `tool-${turn}`, status: 'completed' })
      const activeModel = cursor && model === 'default[]' ? ' · Auto' : ''
      const text = `${engineGuides[provider].name} 结果 · ${prompt.includes('补充指令') ? '已补充' : '已处理'}${!cursor && mode ? ` · ${mode}` : ''}${activeModel}`
      const paragraphs = Array.from({ length: 55 }, (_, i) => `第 ${i + 1} 段执行说明。`)
      const output = longOutput ? [text, '| 检查项 | 结果 |\n| --- | --- |\n| 表单校验 | 通过 |', '- [x] 已检查表单校验', ...paragraphs, '阅读结束标记'].join('\n\n') : text
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output + handoff } })
    }
    result(request, { stopReason: cancelled ? 'cancelled' : 'end_turn' })
  } else {
    const text = `Codex 结果 · ${prompt.includes('补充指令') ? '已补充' : '已处理'}${handoff}`
    if (!cancelled) {
      send({ method: 'item/commandExecution/outputDelta', params: { threadId: sessionId, turnId: id, itemId: `tool-${turn}`, delta: '命令输出\n' } })
      send({ method: 'item/agentMessage/delta', params: { threadId: sessionId, turnId: id, itemId: `message-${turn}`, delta: text } })
      send({ method: 'item/completed', params: { threadId: sessionId, turnId: id, item: { type: 'agentMessage', id: `message-${turn}`, phase: 'final_answer', text } } })
    }
    send({ method: 'turn/completed', params: { threadId: sessionId, turn: { id, status: cancelled ? 'interrupted' : 'completed' } } })
  }
}

if (!terminalCommand()) createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const { method, id, params } = message
  if (!method && current) {
    if (id === 'approval') {
      const allowed = cursor ? message.result?.outcome?.optionId === 'allow-once' : message.result?.decision === 'accept'
      if (!allowed) { current.cancelled = true; complete(); return }
      send(cursor ? { id: 'question', method: 'cursor/ask_question', params: { questions: [{ id: 'scope', prompt: '确认资源范围', options: [{ id: 'full', label: '全部资源' }] }] } }
        : { id: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'scope', question: '确认资源范围', options: [{ label: '全部资源' }] }] } })
    } else if (id === 'question') {
      const answered = cursor ? message.result?.outcome?.answers?.[0]?.selectedOptionIds?.includes('full') : message.result?.answers?.scope?.answers?.includes('全部资源')
      if (!answered) current.cancelled = true
      complete()
    }
    return
  }
  if (method === 'initialize') result(id, acp ? { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } } : { userAgent: 'fixture' })
  if (method === 'account/read') {
    const profile = process.env.FRONT_DAY_FIXTURE_CODEX_PROFILE
    const account = profile && profile !== process.env.CODEX_HOME ? null : { type: 'chatgpt' }
    result(id, process.env.FRONT_DAY_FIXTURE_CODEX_AUTH === 'unknown' ? { account: null } : { requiresOpenaiAuth: true, account })
  }
  if (method === 'session/new' || method === 'session/load') {
    const projectMarker = process.env.FRONT_DAY_FIXTURE_PROJECT_CWD
    if (projectMarker && (relative(projectMarker, process.cwd()) || relative(projectMarker, params.cwd))) {
      send({ id, error: { code: -32602, message: 'Unexpected project workspace' } })
      return
    }
    if (provider === 'copilot' && process.env.FRONT_DAY_FIXTURE_COPILOT_AUTH === 'signed-out') {
      send({ id, error: { code: -32000, message: 'Authentication required' } })
    } else {
      if (method === 'session/load') {
        if (process.env.FRONT_DAY_FIXTURE_RESTORE_FAIL) { send({ id, error: { code: -32002, message: 'Session not found' } }); return }
        sessionId = params.sessionId
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '旧会话回放标记' } })
      }
      const supportedMode = process.env.FRONT_DAY_FIXTURE_MODE
      result(id, { ...(method === 'session/new' && { sessionId }), configOptions: [{ id: 'mode', category: 'mode',
        ...(supportedMode && { currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: supportedMode, name: 'Read Only' }] }) }, {
        id: 'model', category: 'model', currentValue: 'fixture-model',
        options: [{ group: 'routing', name: '路由', options: [{ value: 'default[]', name: 'Auto' }] }, { value: 'fixture-model', name: 'Fixture' }],
      }] })
    }
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'mode') {
      const supportedMode = process.env.FRONT_DAY_FIXTURE_MODE
      if (supportedMode && params.value !== supportedMode) {
        send({ id, error: { code: -32602, message: 'Expected the advertised mode' } })
        return
      }
      mode = params.value
    }
    if (params.configId === 'model') {
      if (!['default[]', 'fixture-model'].includes(params.value)) {
        send({ id, error: { code: -32602, message: 'Expected the advertised model ID' } })
        return
      }
      model = params.value
    }
    result(id, {})
  }
  if (method === 'thread/start') {
    if (process.env.FRONT_DAY_FIXTURE_PROBE_ONLY && params.ephemeral !== true) {
      send({ id, error: { code: -32602, message: 'Expected an ephemeral probe' } })
      return
    }
    result(id, { thread: { id: sessionId }, model: 'fixture-model' })
  }
  if (method === 'thread/resume') {
    if (params.excludeTurns !== true) { send({ id, error: { code: -32602, message: 'Full history requested' } }); return }
    sessionId = params.threadId
    result(id, { thread: { id: sessionId }, model: 'fixture-model' })
  }
  if (method === 'thread/fork') {
    if (params.excludeTurns !== true || !params.threadId || !params.lastTurnId) {
      send({ id, error: { code: -32602, message: 'Expected a source thread and an exact fork turn' } })
      return
    }
    sessionId = `fork-${params.lastTurnId}`
    result(id, { thread: { id: sessionId, forkedFromId: params.threadId }, model: 'fixture-model' })
  }
  if (method === 'session/prompt' || method === 'turn/start') {
    const prompt = String((params.prompt ?? params.input)[0].text)
    current = { request: id, prompt, id: `turn-${process.pid}-${++turn}` }
    if (!acp && prompt.includes('HOLD_FOR_CANCEL')) {
      const turnId = current.id
      setTimeout(() => result(id, { turn: { id: turnId, status: 'inProgress' } }), 400)
      return
    }
    if (!acp) result(id, { turn: { id: current.id, status: 'inProgress' } })
    if (cursor && prompt.includes('CANCEL_APPROVAL')) {
      send({ id: 'approval', method: 'session/request_permission', params: { sessionId,
        toolCall: { title: '等待撤回的授权' }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] } })
      setTimeout(() => send({ method: '$/cancel_request', params: { requestId: 'approval' } }), 1000)
      return
    }
    if (prompt.includes('HOLD_FOR_CANCEL')) return
    if (prompt.includes('REQUEST_INPUT')) {
      if (cursor) {
        update({ sessionUpdate: 'tool_call', toolCallId: `tool-${turn}`, title: '读取项目资源', kind: 'read', status: 'pending' })
        send({ id: 'approval', method: 'session/request_permission', params: { sessionId, toolCall: { title: '读取项目资源' }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] } })
      } else {
        send({ method: 'item/started', params: { threadId: sessionId, item: { id: `tool-${turn}`, type: 'commandExecution', command: 'node --version', status: 'inProgress' } } })
        send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: sessionId, itemId: `tool-${turn}`, command: 'node --version', availableDecisions: ['accept', 'decline'] } })
      }
    } else complete()
  }
  if (method === 'turn/steer' && current) { current.prompt += params.input[0].text; result(id, { turnId: current.id }) }
  if (method === 'turn/interrupt' || method === 'session/cancel') {
    if (!acp) result(id, {})
    if (current) { current.cancelled = true; complete() }
  }
})
