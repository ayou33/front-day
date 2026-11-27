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

test('Cursor 和 Codex 的原生审批、提问、补充轮次与中断', async t => {
  const h = await harness()
  const app = await serve(h.dir, { FRONT_DAY_FIXTURE_CURSOR_AUTH: 'mixed' })
  t.after(async () => { await app.stop(); await h.cleanup() })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '本地项目', directory: h.project, description: '', testCommand: null })
  for (const provider of ['cursor', 'codex'] as const) {
    await t.test(provider, async () => {
      const engine = await app.api<Engine>('/config/engines', 'POST', { name: provider, provider, executable: h.wrappers[provider], model: provider === 'cursor' ? 'Auto' : 'fixture-model', mode: 'agent' })
      const health = await app.api<EngineHealth>(`/engines/${engine.id}/health`)
      assert.equal(health.connected, true, health.message)
      assert.equal(health.auth, 'ready')
      const template = await app.api<Template>('/config/templates', 'POST', { name: '交互测试', description: '', stages: [stage('审批和问题', { prompt: 'REQUEST_INPUT', advance: 'manual' }), stage('停住', { prompt: 'HOLD_FOR_CANCEL' })] })
      const payload = { requestId: randomUUID(), title: '交互任务', brief: '', templateId: template.id, projectId: project.id, engineId: engine.id }
      const run = await app.api<Run>('/runs', 'POST', payload)
      assert.equal((await app.api<Run>('/runs', 'POST', payload)).id, run.id)
      const approval = await waitForRun(app.api, run.id, 'waiting_approval')
      const request = approval.pending[0]
      assert.ok(request.choices?.length)
      await app.api(`/runs/${run.id}/followup`, 'POST', { text: '补充指令（当前执行中）' })
      await app.api(`/runs/${run.id}/interactions/${encodeURIComponent(request.id)}`, 'POST', { choice: request.choices[0].id })
      const question = (await waitForRun(app.api, run.id, 'waiting_input')).pending[0]
      const option = question.questions![0].choices[0].id
      await app.api(`/runs/${run.id}/interactions/${encodeURIComponent(question.id)}`, 'POST', { answers: { scope: [option] } })
      const gate = await waitForRun(app.api, run.id, 'waiting_stage')
      assert.match(gate.attempts[0][0].output ?? '', /已补充/)
      if (provider === 'cursor') assert.match(gate.attempts[0][0].output ?? '', /· Auto/)
      await app.api(`/runs/${run.id}/followup`, 'POST', { text: '补充指令' })
      const renewed = await waitForRun(app.api, run.id, 'waiting_stage', run => !!run.attempts[0][0].output?.includes('已补充'))
      assert.match(renewed.attempts[0][0].output ?? '', /已补充/)
      await app.api(`/runs/${run.id}/advance`, 'POST', {})
      await waitForRun(app.api, run.id, 'running', run => run.stageIndex === 1 && !!run.attempts[1][0].sessionId)
      await app.api(`/runs/${run.id}/stop`, 'POST', {})
      const stopped = await waitForRun(app.api, run.id, 'stopped')
      assert.equal(stopped.attempts[1][0].status, 'stopped')
      const response = await fetch(`${app.baseUrl}/api/runs/${run.id}/events?after=0`, { signal: AbortSignal.timeout(15_000) })
      const reader = response.body!.getReader()
      let events = ''
      const decoder = new TextDecoder()
      const expectedStop = provider === 'cursor' ? '"stopReason":"cancelled"' : '"status":"interrupted"'
      try {
        while (!events.includes('"status":"stopped"') || !events.includes(expectedStop)) {
          const next = await reader.read()
          if (next.done) break
          events += decoder.decode(next.value, { stream: true })
        }
      } catch (error) {
        if ((error as Error).name !== 'TimeoutError') throw error
      }
      await reader.cancel().catch(() => {})
      assert.match(events, /id: \d+/)
      assert.match(events, provider === 'cursor' ? /session\/update/ : /item\/commandExecution\/outputDelta/)
      assert.match(events, provider === 'cursor' ? /"stopReason":"cancelled"/ : /"status":"interrupted"/)
    })
  }
})

test('发现本机 CLI，区分认证状态并优先派发到已就绪的引擎', async t => {
  const h = await harness()
  const app = await serve(h.dir, { FRONT_DAY_FIXTURE_CURSOR_AUTH: 'signed-out', FRONT_DAY_FIXTURE_CODEX_AUTH: 'unknown', CURSOR_API_KEY: '', CURSOR_AUTH_TOKEN: '' })
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  assert.deepEqual((await api<Catalog>('/catalog')).engines.map(engine => engine.provider), [...engineProviders])
  for (const provider of engineProviders) {
    await api(`/config/engines/${provider}-default`, 'PUT', { name: engineGuides[provider].name, provider, executable: h.wrappers[provider], model: '', mode: 'agent' })
  }
  const discovered = await api<Catalog>('/catalog')
  assert.equal(discovered.engineAvailability?.length, engineProviders.length)
  assert.ok(discovered.engineAvailability.every(entry => entry.executable && !entry.health))
  const cursor = await api<EngineHealth>('/engines/cursor-default/health')
  assert.equal(cursor.auth, 'required')
  const codex = await api<EngineHealth>('/engines/codex-default/health')
  assert.equal(codex.auth, 'unknown')
  const copilot = await api<EngineHealth>('/engines/copilot-default/health')
  assert.equal(copilot.auth, 'unknown')
  assert.equal(copilot.sessionReady, true)
  assert.equal((await api<Catalog>('/catalog')).engineAvailability?.find(entry => entry.id === 'cursor-default')?.health?.auth, 'required')
  const project = await api<Project>('/config/projects', 'POST', { name: '引擎接入项目', directory: h.project })
  const automatic = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, goal: '验证自动派发' })
  assert.equal(automatic.stages[0].engine?.provider, 'opencode')
  await waitForRun(api, automatic.id, 'succeeded')
  for (const provider of ['claude', 'copilot', 'opencode'] as const) {
    const run = await api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, goal: '梳理任务范围', taskType: 'requirements', engineId: `${provider}-default` })
    const done = await waitForRun(api, run.id, 'succeeded')
    assert.equal(done.attempts[0][0].sessionId, `${provider}-session`)
    assert.equal(done.attempts[0][0].output, `${engineGuides[provider].name} 结果 · 已处理 · plan`)
  }
})

test('引擎默认授权可由任务覆盖，执行中切换只处理权限请求', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const { api } = app
  const engine = await api<Engine>('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent', approvalMode: 'auto-deny' })
  const project = await api<Project>('/config/projects', 'POST', { name: '授权设置项目', directory: h.project })
  const payload = { projectId: project.id, engineId: engine.id, goal: 'REQUEST_INPUT' }
  const denied = await api<Run>('/runs', 'POST', { ...payload, requestId: randomUUID() })
  assert.match((await waitForRun(api, denied.id, 'failed')).error ?? '', /cancelled/)
  const allowed = await api<Run>('/runs', 'POST', { ...payload, requestId: randomUUID(), approvalMode: 'manual' })
  await waitForRun(api, allowed.id, 'waiting_approval')
  const updated = await api<Run>(`/runs/${allowed.id}/approval`, 'POST', { mode: 'auto-approve' })
  assert.equal(updated.approvalMode, 'auto-approve')
  const question = (await waitForRun(api, allowed.id, 'waiting_input')).pending[0]
  assert.equal(question.type, 'question')
  await api(`/runs/${allowed.id}/interactions/${encodeURIComponent(question.id)}`, 'POST', { answers: { scope: ['full'] } })
  await waitForRun(api, allowed.id, 'succeeded')
})


test('工作台重启后，Codex 检查和项目任务沿用同一个本机配置目录', async t => {
  const h = await harness()
  const profile = join(h.dir, '.codex')
  await mkdir(profile)
  const env = { FRONT_DAY_FIXTURE_CODEX_PROFILE: profile,
    ...(process.platform === 'win32' ? { USERPROFILE: h.dir, CODEX_HOME: '' } : { CODEX_HOME: profile }) }
  let app = await serve(h.dir, env)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const engine = await app.api<Engine>('/config/engines/codex-default', 'PUT', { name: 'Codex', provider: 'codex', executable: h.wrappers.codex, model: '', mode: 'agent' })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '配置目录验证', directory: h.project })
  assert.equal((await app.api<EngineHealth>(`/engines/${engine.id}/health`)).auth, 'ready')
  await app.stop()
  app = await serve(h.dir, env)
  const local = (await app.api<Catalog>('/catalog')).engineAvailability?.find(entry => entry.id === engine.id)
  assert.equal(local?.codexHome, profile)
  assert.equal(local?.health, undefined)
  assert.equal((await app.api<EngineHealth>(`/engines/${engine.id}/health`)).auth, 'ready')
  const run = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, goal: '验证项目任务沿用配置', engineId: engine.id })
  const done = await waitForRun(app.api, run.id, 'succeeded')
  assert.equal(done.attempts[0][0].sessionId, 'codex-session')
})

test('项目连接检查使用项目目录和引擎公布的配置，Codex 项目探测使用临时线程', async t => {
  const h = await harness()
  const app = await serve(h.dir, { FRONT_DAY_FIXTURE_PROJECT_CWD: h.project, FRONT_DAY_FIXTURE_MODE: 'readonly-custom',
    FRONT_DAY_FIXTURE_PROBE_ONLY: '1', CODEX_HOME: h.dir })
  t.after(async () => { await app.stop(); await h.cleanup() })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '引擎检查项目', directory: h.project })
  const engine = { name: 'Claude 测试', provider: 'claude', executable: h.wrappers.claude, model: 'fixture-model', mode: 'ask' }
  await app.api('/config/engines/claude-default', 'PUT', engine)
  const path = `/engines/claude-default/health?projectId=${project.id}`
  const health = await app.api<EngineHealth>(path)
  assert.equal(health.projectId, project.id)
  assert.equal(health.workingDirectory, h.project)
  assert.equal(health.sessionReady, true, health.message)
  assert.equal((await app.api<Catalog>('/catalog')).engineAvailability?.find(item => item.id === 'claude-default')?.health, undefined)
  const run = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: 'claude-default', goal: '核对项目能力' })
  assert.match((await waitForRun(app.api, run.id, 'succeeded')).attempts[0][0].output ?? '', /readonly-custom/)

  await app.api('/config/engines/claude-default', 'PUT', { ...engine, model: 'unsupported-fixture-model' })
  const failed = await app.api<EngineHealth>(path)
  assert.equal(failed.connected, true)
  assert.equal(failed.sessionReady, false)
  assert.match(failed.message ?? '', /无法设置模型/)
  await assert.rejects(() => app.api('/engines/claude-default/health?projectId=missing'), /找不到所选项目/)
  await app.api('/config/engines/codex-default', 'PUT', { ...engine, provider: 'codex', executable: h.wrappers.codex })
  const codex = await app.api<EngineHealth>(`/engines/codex-default/health?projectId=${project.id}`)
  assert.equal(codex.auth, 'ready')
  assert.equal(codex.sessionReady, true, codex.message)
})

test('ACP 引擎撤回授权后，工作台清理待处理请求', async t => {
  const h = await harness()
  const app = await serve(h.dir)
  t.after(async () => { await app.stop(); await h.cleanup() })
  const project = await app.api<Project>('/config/projects', 'POST', { name: '授权撤回', directory: h.project })
  await app.api('/config/engines/cursor-default', 'PUT', { name: 'Cursor', provider: 'cursor', executable: h.wrappers.cursor, model: '', mode: 'agent' })
  const run = await app.api<Run>('/runs', 'POST', { requestId: randomUUID(), projectId: project.id, engineId: 'cursor-default', goal: 'CANCEL_APPROVAL' })
  const waiting = await waitForRun(app.api, run.id, 'waiting_approval')
  const stopped = await waitForRun(app.api, run.id, 'failed')
  assert.match(stopped.error ?? '', /cancelled/)
  assert.deepEqual(stopped.pending, [])
  await assert.rejects(() => app.api(`/runs/${run.id}/interactions/${encodeURIComponent(waiting.pending[0].id)}`, 'POST', { choice: 'allow-once' }), /过期/)
})
