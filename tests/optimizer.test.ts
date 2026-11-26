import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { Account, Catalog, Engine, EngineHealth, Iteration, Project, Resource, Run, RunSummary, Template } from '../shared/contracts.ts'
import type { Preferences } from '../shared/preferences.ts'
import { engineGuides, engineProviders } from '../shared/engines.ts'
import { Store } from '../server/storage.ts'
import { AccountSecrets } from '../server/secrets.ts'
import { optimizePrompt } from '../server/prompt-optimizer.ts'
import { defaultPromptOptimizer, optimizerProviderOptions, promptOptimizerProviders } from '../shared/prompt-optimizer.ts'
import { harness, serve, stage, waitForRun } from './support.ts'

test('提示词优化兼容已有 DeepSeek 配置，切换厂商时各自保留模型和加密凭据', async t => {
  const h = await harness()
  let app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const config = { enabled: true, provider: 'deepseek', model: 'deepseek-v4-pro' } as const
  const key = 'fixture-deepseek-key'
  assert.deepEqual(await app.api('/prompt-optimizer'), defaultPromptOptimizer)
  await assert.rejects(() => app.api('/prompt-optimizer', 'PUT', config), /需保存 DeepSeek API Key/)
  await app.stop()
  const database = join(h.dir, 'data', 'workbench.sqlite')
  const legacy = new DatabaseSync(database)
  try {
    const sealed = new AccountSecrets(`${database}.key`).seal(key, 'prompt-optimizer', true)
    legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('prompt-optimizer', JSON.stringify({ ...config, sealed }))
  } finally { legacy.close() }

  app = await serve(h.dir)
  const deepseek = { model: config.model, hasApiKey: true }
  const options = { ...config, hasApiKey: true, profiles: { deepseek } }
  assert.deepEqual(await app.api('/prompt-optimizer'), options)
  const openai = { enabled: true, provider: 'openai', model: 'gpt-5.4-nano' } as const
  await assert.rejects(() => app.api('/prompt-optimizer', 'PUT', openai), /需保存 OpenAI API Key/)
  const openAIKey = 'fixture-openai-key'
  const profiles = { deepseek, openai: { model: openai.model, hasApiKey: true } }
  assert.deepEqual(await app.api('/prompt-optimizer', 'PUT', { ...openai, apiKey: openAIKey }), { ...openai, hasApiKey: true, profiles })
  await assert.rejects(() => app.api('/prompt-optimizer', 'POST', { goal: '优化原始输入', provider: 'deepseek' }), /厂商已变更/)
  await app.stop()
  const store = new Store(database)
  try {
    assert.equal(store.promptOptimizerKey('openai'), openAIKey)
    assert.equal(store.promptOptimizerKey('deepseek'), key)
  } finally { store.close() }

  app = await serve(h.dir)
  assert.deepEqual(await app.api('/prompt-optimizer', 'PUT', config), { ...options, profiles })
  assert.deepEqual(await app.api('/prompt-optimizer', 'PUT', { ...config, enabled: false, apiKey: null }),
    { ...config, enabled: false, hasApiKey: false, profiles: { ...profiles, deepseek: { ...deepseek, hasApiKey: false } } })
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
    const result = await optimizePrompt(config, key, { goal: '检查表单输入校验', taskType: 'verification' }, async (url, init) => {
      assert.equal(String(url), urls[provider])
      assert.equal(init?.redirect, 'error')
      const headers = new Headers(init?.headers)
      const authHeader = provider === 'anthropic' ? 'x-api-key' : provider === 'gemini' ? 'x-goog-api-key' : 'Authorization'
      assert.equal(headers.get(authHeader), authHeader === 'Authorization' ? `Bearer ${key}` : key)
      const body = JSON.parse(String(init?.body))
      if (provider !== 'gemini') assert.equal(body.model, config.model)
      if (provider === 'openai' || provider === 'xai') assert.equal(body.store, false)
      if (provider === 'anthropic') assert.ok(headers.has('anthropic-version'))
      const input = Array.isArray(body.input) ? body.input.at(-1).content : body.input
      assert.deepEqual(JSON.parse(input ?? body.contents?.[0].parts[0].text ?? body.messages.at(-1).content),
        { goal: '检查表单输入校验', taskType: '测试验收' })
      assert.equal(String(init?.body).includes(key), false)
      const result = provider === 'openai' || provider === 'xai' || provider === 'anthropic' || provider === 'gemini' || provider === 'mistral'
        ? payloads[provider] : { choices: [{ finish_reason: 'stop', message: { content } }] }
      return Response.json(result)
    })
    assert.equal(result.goal, content)
  })
})
