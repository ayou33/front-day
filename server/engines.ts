import type { Engine, EventKind, Interaction } from '../shared/contracts.ts'
import { engineGuides } from '../shared/engines.ts'
import type { ApprovalMode } from '../shared/engines.ts'
import { acpAuthRequired, codexAuth, connectEngine, engineLaunch, initializeEngine } from './engine-connections.ts'
import { openAcpSession, openCodexThread } from './engine-session-setup.ts'
import { HttpError } from './errors.ts'
import { array, object, string } from './rpc.ts'
import type { EngineRpc, JsonObject, RpcId } from './rpc.ts'

const codexDecisions: Record<string, string> = { accept: '本次允许', acceptForSession: '本会话允许', decline: '拒绝', cancel: '取消' }
const acpDecisions: Record<string, string> = { allow_once: '本次允许', allow_always: '始终允许', reject_once: '本次拒绝', reject_always: '始终拒绝' }

export type EngineHooks = {
  emit: (kind: EventKind, name: string, data: unknown) => void
  request: (interaction: Interaction) => void
  resolved: (id: string) => void
}
type Pending = { wireId: RpcId; interaction: Interaction; answer: (data: JsonObject) => JsonObject; cancel: JsonObject;
  auto?: { approve?: string; deny?: string } }
type ActiveTurn = {
  key: string; id: string; output: string; partial: string; final: boolean
  started?: Promise<JsonObject>
  done: ReturnType<typeof Promise.withResolvers<string>>
}

function interactionId(id: RpcId) { return `${typeof id}:${id}` }

function selected(data: JsonObject, choices: { id: string }[]) {
  const option = string(data.choice)
  if (!choices.some(choice => choice.id === option)) throw new HttpError(400, '请选择有效选项')
  return option
}

function queryAnswers(interaction: Interaction, data: JsonObject) {
  const answers = object(data.answers)
  return (interaction.questions ?? []).map(question => {
    const values = array(answers[question.id]).map(string).filter(Boolean)
    if (!values.length || (!question.multiple && values.length > 1) || values.some(value =>
      !question.freeText && !question.choices.some(choice => choice.id === value))) throw new HttpError(400, '请完成所有问题')
    return [question.id, values] as const
  })
}

function approvalFields(...entries: [label: string, value: unknown, code?: boolean][]): NonNullable<Interaction['fields']> {
  return entries.flatMap(([label, value, code]) => typeof value === 'string' && value.trim() ? [{ label, value, code }] : [])
}

export class EngineSession {
  private rpc: EngineRpc
  private acp: boolean
  private waiting = new Map<string, Pending>()
  private active?: ActiveTurn
  private model = ''
  private turnNumber = 0
  private loadingHistory = false
  private closed = false
  private config: Engine
  private cwd: string
  private hooks: EngineHooks
  private approvalMode: ApprovalMode
  sessionId = ''
  lastNativeTurnId?: string

  constructor(config: Engine, executable: string, cwd: string, excludeEnv: string[], hooks: EngineHooks) {
    this.config = config
    this.cwd = cwd
    this.hooks = hooks
    this.approvalMode = config.approvalMode ?? 'manual'
    this.acp = config.provider !== 'codex'
    this.rpc = connectEngine(config.provider, engineLaunch(config.provider, executable, cwd, excludeEnv),
      (method, params, id) => this.receive(method, params, id), text => hooks.emit('native', 'stderr', { text }),
      id => this.resolveRequest(interactionId(id)))
    void this.rpc.done.then(result => {
      this.closed = true
      this.clearRequests()
      this.active?.done.reject(new Error(result.error ?? `Agent 连接已结束（${result.code ?? result.signal ?? '未知状态'}）`))
    })
  }

  async start(signal: AbortSignal, resumeId?: string, forkTurnId?: string) {
    const abort = () => { void this.close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const init = await initializeEngine(this.rpc, this.config.provider)
      if (this.acp) {
        if (forkTurnId) throw new Error('当前引擎尚未接入指定轮次的分支')
        this.loadingHistory = !!resumeId
        this.sessionId = await openAcpSession(this.rpc, this.config, this.cwd, init, resumeId)
        this.loadingHistory = false
      } else {
        const account = await this.rpc.call('account/read', { refreshToken: false })
        if (codexAuth(account) === 'required') throw new Error('当前 Codex CLI 会话尚未登录。请在「引擎」核对路径和登录方式。')
        const session = await openCodexThread(this.rpc, this.config, this.cwd, resumeId, false, forkTurnId)
        this.sessionId = session.id
        this.model = session.model
      }
      signal.throwIfAborted()
    } catch (error) {
      if (this.acp && acpAuthRequired(error)) throw this.authenticationError()
      throw error
    } finally { this.loadingHistory = false; signal.removeEventListener('abort', abort) }
  }

  private authenticationError() {
    return new Error(`${this.config.name} 需要认证。请在「引擎」查看登录指引，完成后重试。`)
  }

  async prompt(text: string) {
    if (this.closed || this.active) throw new Error('Agent 会话当前无法启动对话')
    const turn: ActiveTurn = { key: `turn-${++this.turnNumber}`, id: '', output: '', partial: '', final: false, done: Promise.withResolvers<string>() }
    this.active = turn
    this.lastNativeTurnId = undefined
    void turn.done.promise.catch(() => {})
    const input = [{ type: 'text', text }]
    try {
      if (this.acp) {
        const result = await this.rpc.call('session/prompt', { sessionId: this.sessionId, prompt: input }, 0)
        this.hooks.emit('native', 'session/prompt:result', result)
        if (result.stopReason !== 'end_turn') throw new Error(`${this.config.name} 停止 · ${string(result.stopReason) || '未知原因'}`)
        return (turn.partial || turn.output).trim()
      }
      turn.started = this.rpc.call('turn/start', {
        threadId: this.sessionId, input,
        ...(this.config.mode === 'plan' && this.model ? { collaborationMode: { mode: 'plan', settings: {
          model: this.model, reasoning_effort: null, developer_instructions: null,
        } } } : {}),
      })
      const result = await turn.started
      turn.id ||= string(object(result.turn).id)
      return await turn.done.promise
    } catch (error) {
      if (this.acp && acpAuthRequired(error)) throw this.authenticationError()
      throw error
    } finally {
      if (!this.acp) this.lastNativeTurnId = turn.id || undefined
      this.active = undefined
      this.clearRequests()
    }
  }

  get canSteer() { return !this.acp && !!this.active?.id }
  async steer(text: string) {
    if (!this.canSteer) return false
    const turn = this.active!
    try {
      await this.rpc.call('turn/steer', { threadId: this.sessionId, expectedTurnId: turn.id, input: [{ type: 'text', text }] })
      return true
    } catch (error) {
      if (this.active !== turn) return false
      throw error
    }
  }

  async interrupt() {
    if (this.closed) return
    for (const request of this.waiting.values()) this.rpc.reply(request.wireId, request.cancel)
    this.clearRequests()
    if (this.acp) {
      await this.rpc.notify('session/cancel', { sessionId: this.sessionId })
      return
    }
    const turn = this.active
    if (!turn) return
    const turnId = turn.id || string(object((await turn.started)?.turn).id)
    if (this.active === turn && turnId) await this.rpc.call('turn/interrupt', { threadId: this.sessionId, turnId }, 2000)
  }

  close() { return this.rpc.close() }

  answer(id: string, data: JsonObject) {
    const request = this.waiting.get(id)
    if (!request) throw new HttpError(409, '这个请求已处理或已过期')
    const answer = request.answer(data)
    this.rpc.reply(request.wireId, answer)
    this.resolveRequest(id)
  }

  setApprovalMode(mode: ApprovalMode) {
    this.approvalMode = mode
    if (this.closed) return
    for (const request of this.waiting.values()) this.autoRespond(request)
  }

  private autoRespond(request: Pending) {
    if (!request.auto || this.approvalMode === 'manual') return false
    const allow = this.approvalMode === 'auto-approve'
    const choice = allow ? request.auto.approve : request.auto.deny
    if (allow && !choice) return false
    const reply = choice ? request.answer({ choice }) : request.cancel
    this.rpc.reply(request.wireId, reply)
    this.hooks.emit('system', allow ? '自动允许授权' : '自动拒绝授权', { text: request.interaction.title })
    this.resolveRequest(request.interaction.id)
    return true
  }

  private clearRequests() {
    for (const id of this.waiting.keys()) this.resolveRequest(id)
  }

  private resolveRequest(id: string) {
    if (this.waiting.delete(id)) this.hooks.resolved(id)
  }

  private receive(method: string, params: JsonObject, wireId?: RpcId) {
    if (this.loadingHistory && wireId === undefined) return
    this.hooks.emit('native', method, params)
    if (wireId !== undefined) {
      const id = interactionId(wireId)
      const request = this.toInteraction(method, params, id)
      if (!request) { this.rpc.unsupported(wireId); return }
      const pending = { ...request, wireId }
      this.waiting.set(id, pending)
      if (!this.autoRespond(pending)) this.hooks.request(request.interaction)
      return
    }
    if (method === 'serverRequest/resolved' && (typeof params.requestId === 'number' || typeof params.requestId === 'string')) {
      this.resolveRequest(interactionId(params.requestId))
    }
    if (this.acp) this.receiveAcp(method, params)
    else this.receiveCodex(method, params)
  }

  private receiveAcp(method: string, params: JsonObject) {
    const turn = this.active
    if (method === 'session/update') {
      const update = object(params.update)
      const type = string(update.sessionUpdate)
      if (type === 'agent_message_chunk' && turn) {
        const text = string(object(update.content).text)
        turn.partial += text
        if (text) this.hooks.emit('agent_text', type, { id: turn.key, text })
      } else {
        if (type === 'tool_call' && turn?.partial.trim()) { turn.output = turn.partial; turn.partial = '' }
        this.hooks.emit('agent_item', type || method, update)
      }
    } else if (['cursor/update_todos', 'cursor/task', 'cursor/generate_image'].includes(method)) {
      this.hooks.emit('agent_item', method, params)
    }
  }

  private receiveCodex(method: string, params: JsonObject) {
    const turn = this.active
    if (params.threadId && params.threadId !== this.sessionId) return
    if (turn && (method === 'turn/started' || method === 'turn/completed')) {
      const data = object(params.turn)
      const id = string(data.id)
      if (turn.id && id !== turn.id) return
      turn.id ||= id
      if (method === 'turn/completed') {
        if (data.status === 'completed') turn.done.resolve((turn.output || turn.partial).trim())
        else turn.done.reject(new Error(string(object(data.error).message) || `Codex 停止 · ${string(data.status)}`))
      }
    }
    if (method === 'item/agentMessage/delta' && turn) {
      const text = string(params.delta)
      turn.partial += text
      this.hooks.emit('agent_text', method, { id: params.itemId ?? turn.key, text })
    }
    if (method === 'item/completed' || method === 'item/started') {
      const item = object(params.item)
      if (item.type === 'agentMessage' && method === 'item/completed') {
        if (turn && (!turn.final || item.phase === 'final_answer')) {
          turn.output = string(item.text)
          turn.final = item.phase === 'final_answer'
        }
        this.hooks.emit('agent_text', method, { id: item.id, text: item.text, replace: true })
      } else if (item.type !== 'agentMessage' && item.type !== 'userMessage') {
        this.hooks.emit('agent_item', method, item)
      }
    }
    if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'turn/diff/updated', 'turn/plan/updated', 'error'].includes(method)) {
      this.hooks.emit('agent_item', method, params)
    }
  }

  private toInteraction(method: string, p: JsonObject, id: string): Omit<Pending, 'wireId'> | null {
    const approval = (title: string, detail: string, choices: NonNullable<Interaction['choices']>,
      response: (choice: string) => JsonObject, cancel: JsonObject, presentation?: Pick<Interaction, 'fields' | 'raw'>, auto?: Pending['auto']) => ({
      interaction: { id, type: 'approval' as const, title, detail, choices, ...presentation },
      answer: (data: JsonObject) => response(selected(data, choices)), cancel, auto,
    })
    if (method === 'session/request_permission') {
      const options = array(p.options).map(object)
      const choices = options.map(option => ({
        id: string(option.optionId), label: acpDecisions[string(option.kind)] || string(option.name) || string(option.optionId),
      })).filter(option => option.id)
      const tool = object(p.toolCall)
      const input = object(tool.rawInput)
      const paths = array(tool.locations).map(location => string(object(location).path)).filter(Boolean).join('\n')
      return approval(`${engineGuides[this.config.provider].name} 权限请求`, string(tool.title) || 'Agent 请求执行工具操作', choices,
        optionId => ({ outcome: { outcome: 'selected', optionId } }), { outcome: { outcome: 'cancelled' } }, {
          fields: approvalFields(['命令', string(input.command ?? input.cmd), true], ['涉及路径', paths || string(input.path ?? input.filePath), true], ['访问地址', input.url, true]),
          raw: JSON.stringify(tool, null, 2),
        }, { approve: string(options.find(option => option.kind === 'allow_once')?.optionId), deny: string(options.find(option => option.kind === 'reject_once')?.optionId) })
    }
    if (method === 'cursor/create_plan') {
      return approval(string(p.name) || 'Cursor 计划审批', string(p.plan), [{ id: 'accepted', label: '批准' }, { id: 'rejected', label: '拒绝' }],
        outcome => ({ outcome: { outcome } }), { outcome: { outcome: 'cancelled' } })
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const available = array(p.availableDecisions)
      const names = available.length ? available.map(string).filter(value => value in codexDecisions) : Object.keys(codexDecisions)
      if (!names.includes('cancel')) names.push('cancel')
      const choices = names.map(value => ({ id: value, label: codexDecisions[value] }))
      const network = object(p.networkApprovalContext)
      const title = network.host ? 'Codex 网络访问审批' : p.command ? 'Codex 命令审批' : method.includes('fileChange') ? 'Codex 文件变更审批' : 'Codex 执行审批'
      return approval(title, string(p.reason), choices, decision => ({ decision }), { decision: 'cancel' }, {
        fields: approvalFields(['命令', p.command, true], ['工作目录', p.cwd, true], ['文件范围', p.grantRoot, true], ['网络主机', network.host, true]),
        raw: JSON.stringify(p, null, 2),
      }, { approve: names.includes('accept') ? 'accept' : undefined, deny: names.includes('decline') ? 'decline' : 'cancel' })
    }
    if (method === 'item/permissions/requestApproval') {
      const permissions = object(p.permissions)
      return approval('Codex 权限请求', string(p.reason),
        [{ id: 'allow', label: '本轮允许' }, { id: 'decline', label: '拒绝' }], choice => ({ permissions: choice === 'allow' ? p.permissions : {}, scope: 'turn' }),
        { permissions: {}, scope: 'turn' }, { fields: approvalFields(['请求范围', Object.keys(permissions).join('、')]), raw: JSON.stringify(permissions, null, 2) },
        { deny: 'decline' })
    }
    if (method === 'cursor/ask_question' || method === 'item/tool/requestUserInput') {
      const cursor = method === 'cursor/ask_question'
      const interaction: Interaction = { id, type: 'question', title: string(p.title) || 'Agent 需要回复', detail: '',
        questions: array(p.questions).map(object).map(question => ({ id: string(question.id), label: string(question.prompt ?? question.question),
          multiple: question.allowMultiple === true, freeText: question.isOther === true || !array(question.options).length, secret: question.isSecret === true,
          choices: array(question.options).map(object).map(option => ({ id: string(option.id ?? option.label), label: string(option.label) })),
        })) }
      return { interaction, answer: data => {
        const answers = queryAnswers(interaction, data)
        return cursor ? { outcome: { outcome: 'answered', answers: answers.map(([questionId, selectedOptionIds]) => ({ questionId, selectedOptionIds })) } }
          : { answers: Object.fromEntries(answers.map(([key, values]) => [key, { answers: values }])) }
      }, cancel: cursor ? { outcome: { outcome: 'cancelled' } } : { answers: {} } }
    }
    if (method === 'mcpServer/elicitation/request') {
      const form = p.mode !== 'url'
      const interaction: Interaction = { id, type: form ? 'form' : 'approval', title: `MCP · ${string(p.serverName)}`,
        detail: [string(p.message), string(p.url), form ? JSON.stringify(p.requestedSchema, null, 2) : ''].filter(Boolean).join('\n'),
        choices: [{ id: 'accept', label: '提交' }, { id: 'decline', label: '拒绝' }], defaultValue: '{}' }
      return { interaction, answer: data => {
        const action = selected(data, interaction.choices!)
        let content = null
        if (form && action === 'accept') {
          try { content = JSON.parse(string(data.value)) } catch { throw new HttpError(400, '请输入有效的 JSON') }
        }
        return { action, content, _meta: null }
      }, cancel: { action: 'cancel', content: null, _meta: null } }
    }
    return null
  }
}
