import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { Catalog, Project, Run, Template } from '../shared/contracts.ts'
import type { Preferences } from '../shared/preferences.ts'
import { Store } from '../server/storage.ts'
import { AccountSecrets } from '../server/secrets.ts'
import { generateModelText, optimizeAgentPrompt, optimizePrompt } from '../server/prompt-optimizer.ts'
import { defaultPromptOptimizer, modelApiId, modelApiName, optimizerProviderOptions, promptOptimizerProviders } from '../shared/prompt-optimizer.ts'
import type { ModelApiProfile } from '../shared/prompt-optimizer.ts'
import { harness, serve, stage, waitForRun } from './support.ts'

test('旧提示词优化配置迁移到厂商 API，密钥和优化选择独立保存', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const config = { provider: 'deepseek', model: 'deepseek-v4-pro' } as const
  const openai = { provider: 'openai', model: 'gpt-5.4-nano' } as const
  const select = { enabled: true, executorId: modelApiId(config.provider) }
  const selectOpenAI = { enabled: true, executorId: modelApiId(openai.provider) }
  const key = 'fixture-deepseek-key'
  assert.deepEqual(await app.api('/prompt-optimizer'), defaultPromptOptimizer)
  await assert.rejects(() => app.api('/prompt-optimizer', 'PUT', select), /请选择已配置/)
  await app.stop()
  const database = join(h.dir, 'data', 'workbench.sqlite')
  const legacy = new DatabaseSync(database)
  try {
    const sealed = new AccountSecrets(`${database}.key`).seal(key, 'prompt-optimizer', true)
    legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('prompt-optimizer', JSON.stringify({ ...config, enabled: true, sealed }))
  } finally { legacy.close() }

  app = await serve(h.dir)
  const deepseek = { ...config, id: select.executorId, name: modelApiName(config), hasApiKey: true }
  const options = { ...select, executorName: deepseek.name }
  assert.deepEqual(await app.api('/prompt-optimizer'), options)
  assert.deepEqual(await app.api('/model-apis'), [deepseek])
  await assert.rejects(() => app.api('/prompt-optimizer', 'PUT', selectOpenAI), /请选择已配置/)
  const openAIKey = 'fixture-openai-key'
  const openAIProfile = { ...openai, id: selectOpenAI.executorId, name: modelApiName(openai), hasApiKey: true }
  assert.deepEqual(await app.api('/model-apis/openai', 'PUT', { model: openai.model, apiKey: openAIKey }), openAIProfile)
  assert.deepEqual(await app.api('/prompt-optimizer'), options)
  assert.deepEqual(await app.api('/prompt-optimizer', 'PUT', selectOpenAI), { ...selectOpenAI, executorName: openAIProfile.name })
  await assert.rejects(() => app.api('/prompt-optimizer', 'POST', { goal: '优化原始输入', executorId: select.executorId }), /执行器已变更/)
  await app.stop()
  const store = new Store(database)
  try {
    assert.equal(store.modelApiKey('openai'), openAIKey)
    assert.equal(store.modelApiKey('deepseek'), key)
  } finally { store.close() }

  app = await serve(h.dir)
  assert.deepEqual(await app.api('/model-apis'), [deepseek, openAIProfile])
  assert.deepEqual(await app.api('/prompt-optimizer', 'PUT', select), options)
  assert.deepEqual(await app.api('/model-apis/deepseek', 'PUT', { model: config.model, apiKey: null }), { ...deepseek, hasApiKey: false })
  assert.deepEqual(await app.api('/prompt-optimizer'), { ...select, enabled: false })
})

test('各厂商适配使用对应 API、模型和密钥，优化只发送目标和类型', async t => {
  const urls = {
    deepseek: 'https://api.deepseek.com/chat/completions',
    openai: 'https://api.openai.com/v1/responses',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    xai: 'https://api.x.ai/v1/responses',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    kimi: 'https://api.moonshot.cn/v1/chat/completions',
    glm: 'https://api.z.ai/api/paas/v4/chat/completions',
    minimax: 'https://api.minimax.cn/v1/chat/completions',
  }
  const content = '核对输入和异常状态并记录结果'
  const responsesResult = { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: content }] }] }
  const payloads = {
    openai: responsesResult,
    xai: responsesResult,
    anthropic: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '推理过程' }, { type: 'text', text: content }] },
    gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '推理过程' }, { text: content }] } }] },
    mistral: { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: content }] } }] },
  }
  for (const provider of promptOptimizerProviders) await t.test(provider, async () => {
    const key = `fixture-${provider}-key`
    const config = { provider, model: optimizerProviderOptions[provider].models[0], enabled: true }
    const result = await optimizePrompt((input, instructions) => generateModelText(config, key, input, instructions, { send: async (url, init) => {
      assert.equal(String(url), urls[provider])
      assert.equal(init?.redirect, 'error')
      const headers = new Headers(init?.headers)
      const authHeader = provider === 'anthropic' ? 'x-api-key' : provider === 'gemini' ? 'x-goog-api-key' : 'Authorization'
      assert.equal(headers.get(authHeader), authHeader === 'Authorization' ? `Bearer ${key}` : key)
      const body = JSON.parse(String(init?.body))
      if (provider !== 'gemini') assert.equal(body.model, config.model)
      if (provider === 'openai' || provider === 'xai') assert.equal(body.store, false)
      if (provider === 'anthropic') assert.ok(headers.has('anthropic-version'))
      const goal = Array.isArray(body.input) ? body.input.at(-1).content : body.input
      assert.deepEqual(JSON.parse(goal ?? body.contents?.[0].parts[0].text ?? body.messages.at(-1).content),
        { goal: '检查表单输入校验', taskType: '测试验收' })
      assert.equal(String(init?.body).includes(key), false)
      const result = provider === 'openai' || provider === 'xai' || provider === 'anthropic' || provider === 'gemini' || provider === 'mistral'
        ? payloads[provider] : { choices: [{ finish_reason: 'stop', message: { content } }] }
      return Response.json(result)
    } }), { goal: '检查表单输入校验', taskType: 'verification' })
    assert.equal(result.goal, content)
  })
})

test('优化 Agent 提示词只提交当前正文，并返回建议正文', async () => {
  const text = '核对报名表单。保持接口不变。'
  const suggestion = '逐项验证报名表单，保留现有接口。'
  const config = { provider: 'deepseek', model: 'deepseek-flash' } as const
  const result = await optimizeAgentPrompt((input, instructions) => generateModelText(config, 'fixture-deepseek-key', input, instructions, { send: async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(JSON.parse(body.messages.at(-1).content), { text })
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: suggestion } }] })
  } }), text)
  assert.deepEqual(result, { text: suggestion })
})

test('本地引擎与 API 都能优化，API 可执行任务、审批写入、续改和解读测试', { timeout: 35_000 }, async t => {
  const h = await harness()
  const app = await serve(h.dir, { CODEX_HOME: h.dir }, new URL('./fixtures/model-fetch.ts', import.meta.url))
  t.after(async () => { await app.stop(); await h.cleanup() })
  const config = { model: 'deepseek-flash', apiKey: 'fixture-deepseek-key' }
  const api = await app.api<ModelApiProfile>('/model-apis/deepseek', 'PUT', config)
  const cursor = await app.api('/config/engines/cursor-default', 'PUT',
    { provider: 'cursor', name: '测试 Cursor', executable: h.wrappers.cursor, mode: 'agent', model: '' })
  assert.ok(cursor)
  const select = (executorId: string, enabled = true) => app.api('/prompt-optimizer', 'PUT', { executorId, enabled })
  const optimize = (executorId: string) => app.api('/prompt-optimizer', 'POST', { goal: '整理验收条件', executorId })
  await select('cursor-default')
  assert.deepEqual(await optimize('cursor-default'), { goal: 'Cursor 结果 · 已处理' })
  await select(api.id)
  assert.deepEqual(await optimize(api.id), { goal: 'API 优化建议' })
  await select(api.id, false)
  await assert.rejects(() => optimize(api.id), /启用提示词优化/)
  await select(api.id)

  const directory = join(h.dir, 'migrated')
  await mkdir(directory)
  const prefs = await app.api<Preferences>('/preferences')
  await app.api('/preferences', 'PUT', { ...prefs, dataDirectory: directory, defaultEngineId: api.id })
  assert.deepEqual(await optimize(api.id), { goal: 'API 优化建议' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: 'API 示例', directory: h.project })
  const file = join(h.project, 'app.js')
  await writeFile(file, 'export const base = 1\n')
  const dispatch = (goal: string, options: Record<string, unknown> = {}) =>
    app.api<Run>('/runs', 'POST', { requestId: randomUUID(), title: goal, goal, projectId: project.id, ...options })
  const reference = join(h.dir, 'reference')
  await mkdir(reference)
  await writeFile(join(reference, 'reference.md'), 'API 已读取已关联的外部参考')
  await app.api('/config/resources', 'POST', { projectId: project.id, name: '外部参考', kind: 'file', category: '参考', value: reference,
    prompt: '', fetch: false, accountId: '' })
  const linked = await dispatch('FIXTURE_LINKED_RESOURCE', { engineId: api.id })
  assert.equal((await waitForRun(app.api, linked.id, 'succeeded')).attempts[0][0].output, 'API 已读取已关联的外部参考')
  const saved = await dispatch('FIXTURE_WRITE_API', { engineId: '', start: false })
  assert.equal(saved.status, 'saved')
  assert.equal(saved.stages[0].engine?.id, api.id)
  assert.deepEqual(await app.api(`/runs/${saved.id}/optimize-prompt`, 'POST', { text: '核对项目文件', executorId: api.id }), { text: 'API 优化建议' })
  await app.api(`/runs/${saved.id}/start`, 'POST', {})
  const pending = await waitForRun(app.api, saved.id, 'waiting_approval')
  assert.equal(await readFile(file, 'utf8'), 'export const base = 1\n')
  assert.equal(pending.pending[0].fields?.[0].value, 'app.js')
  await app.api(`/runs/${saved.id}/interactions/${pending.pending[0].id}`, 'POST', { choice: 'allow' })
  const completed = await waitForRun(app.api, saved.id, 'succeeded')
  assert.equal(await readFile(file, 'utf8'), 'export const base = 2\n')
  assert.equal(completed.attempts[0][0].output, 'API 文件已更新')
  assert.ok(!JSON.stringify(completed).includes(config.apiKey))
  assert.ok(!JSON.stringify(await app.api<Catalog>('/catalog')).includes(config.apiKey))

  const parentId = saved.id
  await assert.rejects(() => dispatch('继续整理', { continuation: { parentId, mode: 'resume' } }), /交接摘要/)
  const next = await dispatch('继续整理', { continuation: { parentId, mode: 'auto' } })
  assert.equal((await waitForRun(app.api, next.id, 'succeeded')).attempts[0][0].contextMode, 'handoff')
  const template = await app.api<Template>('/config/templates', 'POST', { name: 'API 检查', description: '', stages: [
    stage('测试并解读', { kind: 'test', analyzeTest: true, engineId: api.id, testCommand: { program: process.execPath, args: ['--version'] } }),
  ] })
  const diagnostics = await dispatch('输出测试结论', { templateId: template.id })
  const tested = (await waitForRun(app.api, diagnostics.id, 'succeeded')).attempts[0][0]
  assert.equal(tested.test?.code, 0)
  assert.equal(tested.output, 'API 任务已处理')

  await writeFile(file, 'export const base = 1\n')
  const denied = await dispatch('FIXTURE_WRITE_API', { approvalMode: 'auto-deny' })
  assert.equal((await waitForRun(app.api, denied.id, 'succeeded')).attempts[0][0].output, '本次写入未获授权')
  const readonly = await dispatch('FIXTURE_WRITE_API', { taskType: 'requirements', approvalMode: 'auto-approve' })
  assert.equal((await waitForRun(app.api, readonly.id, 'succeeded')).attempts[0][0].output, '当前任务为只读运行模式')
  assert.equal(await readFile(file, 'utf8'), 'export const base = 1\n')
  const stopped = await dispatch('FIXTURE_WAIT_API')
  await waitForRun(app.api, stopped.id, 'running')
  await app.api(`/runs/${stopped.id}/stop`, 'POST', {})
  await waitForRun(app.api, stopped.id, 'stopped')
  const failed = await dispatch('FIXTURE_AUTH_ERROR')
  assert.match((await waitForRun(app.api, failed.id, 'failed')).error ?? '', /认证失败/)
})
