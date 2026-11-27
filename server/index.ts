import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { archivedRun, isApiExecutor, statusLabels } from '../shared/contracts.ts'
import type { Config, ConfigKind, Run, RunState } from '../shared/contracts.ts'
import type { Preferences } from '../shared/preferences.ts'
import { accountWriteSchema, agentPromptWriteSchema, configSchemas, dispatchSchema, planDatePatchSchema, planDateSchema, planDatesSchema } from '../shared/schemas.ts'
import { localPlanDate, pastPlanDateError } from '../shared/plans.ts'
import { approvalModes } from '../shared/engines.ts'
import { modelApiId } from '../shared/prompt-optimizer.ts'
import { browseDirectories } from './directories.ts'
import { inspectEngine, localEngines } from './engine-connections.ts'
import { HttpError, errorMessage } from './errors.ts'
import { generateLocalText } from './local-optimizer.ts'
import { loadPreferences, preferencesSchema, savePreferences } from './preferences.ts'
import { agentPromptOptimizerSchema, generateModelText, inspectModelApi, modelApiProviderSchema, modelApiSettingsSchema, optimizeAgentPrompt, optimizePrompt, optimizerInputSchema, optimizerSettingsSchema } from './prompt-optimizer.ts'
import type { TextGenerator } from './prompt-optimizer.ts'
import { accountOrigin, localPath, projectDirectory, webUrl, withinDirectory } from './resources.ts'
import { object } from './rpc.ts'
import { Store } from './storage.ts'
import { Workflow } from './workflow.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'dist')
const dev = process.argv.includes('--dev')
const server = createServer()
const vite = dev ? await (await import('vite')).createServer({ root, server: {
  middlewareMode: true, hmr: { server }, watch: { ignored: ['**/.front-day/**', '**/workbench.sqlite*'] },
  fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.front-day/**', '**/workbench.sqlite*', '**/.front-day.preferences.json*'] },
}, appType: 'spa' }) : null

const defaultDataDirectory = resolve(process.env.FRONT_DAY_DATA_DIR || resolve(root, '.front-day'))
const preferencesFile = resolve(process.env.FRONT_DAY_PREFERENCES_FILE || resolve(root, '.front-day.preferences.json'))
let preferences = loadPreferences(preferencesFile, defaultDataDirectory)
let store = new Store(resolve(preferences.dataDirectory, 'workbench.sqlite'))
let workflow = new Workflow(store, () => preferences, workbenchOrigin)
let switchingDirectory = false
let pendingWrites = 0
let closing = false
const eventStreams = new Set<ServerResponse>()
const port = Number(process.env.FRONT_DAY_PORT ?? '4317')

function workbenchOrigin() {
  const address = server.address()
  return `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : port}`
}
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

async function json(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求')
  const parts: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 2_000_000) throw new HttpError(413, '请求超过 2 MB')
    parts.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) }
  catch { throw new HttpError(400, '请求 JSON 格式有误') }
}

function send(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function publicRun(run: Run) {
  return run.archivedAt ? archivedRun(run, run.archivedAt) : run
}

function events(req: IncomingMessage, res: ServerResponse, id: string, url: URL) {
  workflow.requireUnarchivedRun(id)
  let last = Math.max(0, Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0)
  if (!Number.isSafeInteger(last)) last = 0
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
  res.flushHeaders()
  const write = (event: ReturnType<Store['history']>[number]) => {
    if (res.writableEnded) return
    if (res.writableLength > 4 * 1024 * 1024) { res.end(); return }
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    last = event.seq
  }
  const unsubscribe = store.subscribe(id, event => {
    write(event)
    if (event.kind === 'state' && (event.data as RunState).archivedAt) res.end()
  })
  const timer = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n') }, 15_000)
  eventStreams.add(res)
  res.once('close', () => { unsubscribe(); clearInterval(timer); eventStreams.delete(res) })
  while (!res.writableEnded) {
    const batch = store.history(id, last)
    for (const event of batch) write(event)
    if (batch.length < 500) break
  }
}

async function updatePreferences(next: Preferences) {
  if (closing || switchingDirectory) throw new HttpError(409, '服务正在切换数据目录或退出')
  if (next.defaultEngineId && !store.getExecutor(next.defaultEngineId)) throw new HttpError(400, '请选择可用的执行器')
  if (!relative(preferences.dataDirectory, next.dataDirectory)) {
    const updated = { ...next, dataDirectory: preferences.dataDirectory }
    savePreferences(preferencesFile, updated)
    return preferences = updated
  }

  if (pendingWrites || workflow.hasWork()) throw new HttpError(409, '请等任务和正在保存的操作结束后再切换数据目录')
  switchingDirectory = true
  try {
    const directory = await projectDirectory(next.dataDirectory)
    await workflow.waitForCleanup()
    if (closing) throw new HttpError(409, '服务正在退出')
    if (withinDirectory(dist, directory)) throw new HttpError(400, '请选择构建输出目录之外的位置')
    const updated = { ...next, dataDirectory: directory }
    if (!relative(preferences.dataDirectory, directory)) {
      savePreferences(preferencesFile, updated)
      return preferences = updated
    }
    const previous = store
    const target = store.copyTo(resolve(directory, 'workbench.sqlite'), () => savePreferences(preferencesFile, updated))
    preferences = updated
    store = target
    workflow = new Workflow(store, () => preferences, workbenchOrigin)
    for (const stream of eventStreams) stream.end()
    previous.close()
    return preferences
  } finally { switchingDirectory = false }
}

function configuredOptimizer(expectedExecutorId?: string): TextGenerator {
  const config = store.promptOptimizer()
  const executor = config.enabled ? store.getExecutor(config.executorId, 'optimization') : undefined
  if (!executor) throw new HttpError(409, '请先在配置中启用提示词优化')
  if (expectedExecutorId && expectedExecutorId !== executor.id) throw new HttpError(409, '提示词优化执行器已变更，请刷新页面后重试')
  if (isApiExecutor(executor)) {
    const key = store.modelApiKey(executor.id)
    return (input, instructions) => generateModelText(executor, key, input, instructions)
  }
  const excludedEnv = store.listConfig('accounts').map(account => account.secretEnv)
  return (input, instructions) => generateLocalText(executor, excludedEnv, input, instructions)
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) {
  const [, section, id, action, requestId] = parts
  if (req.method === 'GET' && section === 'ping' && parts.length === 2) return send(res, { ready: true })
  if (req.method === 'GET' && section === 'catalog' && parts.length === 2) {
    const catalog = store.catalog()
    const promptOptimizer = store.promptOptimizer()
    return send(res, { ...catalog, promptOptimizer, engineAvailability: await localEngines(catalog.engines, catalog.accounts.map(account => account.secretEnv)) })
  }
  if (section === 'model-apis') {
    if (req.method === 'GET' && parts.length === 2) return send(res, store.modelApis())
    if (req.method === 'POST' && parts.length === 2) {
      const { apiKey, ...config } = modelApiSettingsSchema.extend({ provider: modelApiProviderSchema }).parse(await json(req))
      const initial = modelApiId(config.provider)
      const exists = store.modelApis().some(profile => profile.id === initial)
      return send(res, store.saveModelApi(config, apiKey, exists ? `api:${randomUUID()}` : initial), 201)
    }
    const profile = id && store.modelApis().find(item => item.id === id)
    if (req.method === 'POST' && action === 'health' && parts.length === 4) {
      if (!profile) throw new HttpError(404, '找不到厂商配置')
      if (!profile.hasApiKey) return send(res, { status: 'key', message: '请先保存 API Key', elapsedMs: 0 })
      let key: string
      try { key = store.modelApiKey(profile.id) }
      catch { return send(res, { status: 'key', message: '无法读取保存的密钥，请重新保存', elapsedMs: 0 }) }
      return send(res, await inspectModelApi(profile, key))
    }
    if (req.method === 'PUT' && id && parts.length === 3) {
      if (id.startsWith('api:') && !profile) throw new HttpError(404, '找不到厂商配置')
      const provider = profile ? profile.provider : modelApiProviderSchema.parse(id)
      const { apiKey, ...config } = modelApiSettingsSchema.parse(await json(req))
      return send(res, store.saveModelApi({ provider, ...config }, apiKey, profile ? profile.id : undefined))
    }
    if (req.method === 'DELETE' && id && parts.length === 3) {
      if (id.startsWith('api:') && !profile) throw new HttpError(404, '找不到厂商配置')
      return send(res, store.deleteModelApi(id))
    }
  }
  if (section === 'prompt-optimizer' && parts.length === 2) {
    if (req.method === 'GET') return send(res, store.promptOptimizer())
    if (req.method === 'PUT') {
      return send(res, store.savePromptOptimizer(optimizerSettingsSchema.parse(await json(req))))
    }
    if (req.method === 'POST') {
      const input = optimizerInputSchema.parse(await json(req))
      return send(res, await optimizePrompt(configuredOptimizer(input.executorId), input))
    }
  }
  if (req.method === 'GET' && section === 'directories' && parts.length === 2) {
    return send(res, await browseDirectories(root, url.searchParams.get('path'), url.searchParams.get('files') === '1'))
  }
  if (section === 'config' && id === 'plan-day-marks' && parts.length <= 4) {
    if (req.method === 'GET' && !action) return send(res, store.listConfig(id))
    if (req.method === 'PUT' && action) {
      const date = planDateSchema.parse(action)
      const config = configSchemas[id].parse(await json(req))
      if (config.marks.length) return send(res, store.saveConfig(id, config, date))
      store.deleteConfig(id, date)
      return send(res, { id: date, marks: [] })
    }
    throw new HttpError(404, '找不到请求的接口')
  }
  if (section === 'config' && id && Object.hasOwn(configSchemas, id) && parts.length <= 4) {
    const kind = id as ConfigKind
    if (kind === 'plan-items' && req.method === 'GET' && !action) return send(res, store.listConfig(kind))
    if (kind === 'plan-items' && req.method === 'PATCH' && action) {
      const body = object(await json(req))
      const item = store.getConfig(kind, action)
      if (!item) throw new HttpError(404, '计划项已删除')
      if (body.order !== undefined) {
        return send(res, store.saveConfig(kind, { ...item, order: z.number().int().nonnegative().parse(body.order) }, action))
      }
      const patch = planDatePatchSchema.parse(body)
      const dates = planDatesSchema.parse({ ...item, ...patch })
      const error = pastPlanDateError(dates, localPlanDate(), item)
      if (error) throw new HttpError(400, error)
      return send(res, store.saveConfig(kind, { ...item, ...dates }, action))
    }
    if (req.method === 'DELETE' && action) {
      store.deleteConfig(kind, action)
      return send(res, { ok: true })
    }
    if ((req.method === 'POST' && !action) || (req.method === 'PUT' && action)) {
      const body = await json(req)
      if (action && !store.getConfig(kind, action)) throw new HttpError(404, '配置已删除')
      if (kind === 'accounts') {
        const { password, ...account } = accountWriteSchema.parse(body)
        account.origin = accountOrigin(account)
        if (account.credentialSource === 'saved') {
          if (account.type !== 'basic') throw new HttpError(400, '保存密码适用于账号密码认证')
          account.secretEnv = ''
        } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(account.secretEnv)) throw new HttpError(400, '请输入有效的环境变量名称')
        return send(res, store.saveAccount(account, password, action), action ? 200 : 201)
      }
      const config = configSchemas[kind].parse(body)
      if (kind === 'plan-items') {
        const previous = action ? store.getConfig(kind, action) : undefined
        const error = pastPlanDateError(config as Config<'plan-items'>, localPlanDate(), previous)
        if (error) throw new HttpError(400, error)
      }
      if (kind === 'projects') {
        const project = config as Config<'projects'>
        const existing = action && store.getConfig('projects', action)
        if (!existing || existing.directory !== project.directory) await projectDirectory(project.directory)
      }
      if (kind === 'iterations') {
        const iteration = config as Config<'iterations'>
        const existing = action && store.getConfig('iterations', action)
        if (!store.getConfig('projects', iteration.projectId)) throw new HttpError(400, '请选择迭代所属的项目')
        if (existing && existing.projectId !== iteration.projectId) throw new HttpError(409, '迭代所属项目已锁定')
      }
      if (kind === 'resources') {
        const resource = config as Config<'resources'>
        const project = store.getConfig('projects', resource.projectId)
        if (!project) throw new HttpError(400, '请选择项目')
        if (resource.iterationId && store.getConfig('iterations', resource.iterationId)?.projectId !== resource.projectId) {
          throw new HttpError(400, '请选择当前项目中的迭代')
        }
        if (resource.kind === 'url') {
          const url = webUrl(resource.value)
          if (resource.fetch && resource.accountId) {
            const account = store.getConfig('accounts', resource.accountId)
            if (!account || account.origin !== url.origin) throw new HttpError(400, '资源 URL 与所选账户来源不匹配')
          }
        }
        if (resource.kind === 'file' && isAbsolute(resource.value)) {
          const current = action && store.getConfig('resources', action)
          if (!current || current.value !== resource.value || current.projectId !== resource.projectId) {
            resource.value = (await localPath(resource.value, await projectDirectory(project.directory))).path
            if (store.getConfig('projects', project.id)?.directory !== project.directory
              || (resource.iterationId && store.getConfig('iterations', resource.iterationId)?.projectId !== project.id)) {
              throw new HttpError(409, '项目目录或迭代已变更，请重新选择文件')
            }
          }
        }
      }
      return send(res, store.saveConfig(kind, config, action), action ? 200 : 201)
    }
  }
  if (section === 'engines' && id && action === 'health' && req.method === 'GET') {
    const engine = store.getConfig('engines', id)
    if (!engine) throw new HttpError(404, '找不到这个引擎配置')
    const projectId = url.searchParams.get('projectId')
    const project = projectId ? store.getConfig('projects', projectId) : undefined
    if (projectId && !project) throw new HttpError(404, '找不到所选项目')
    const cwd = project ? await projectDirectory(project.directory) : root
    return send(res, await inspectEngine(engine, cwd, store.listConfig('accounts').map(account => account.secretEnv), project?.id))
  }
  if (section === 'runs') {
    if (req.method === 'GET' && !action) {
      const params = url.searchParams
      if (id === 'activity') return send(res, { active: store.hasActiveRuns() })
      if (id === 'recent') {
        const query = z.object({ project: z.string().min(1).max(100), iteration: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(30).default(5) }).parse(Object.fromEntries(params))
        return send(res, store.recentRuns(query.project, query.iteration, query.limit))
      }
      if (id === 'page') {
        const query = z.object({ archived: z.enum(['0', '1']).default('0'), limit: z.coerce.number().int().min(1).max(50).default(20),
          projectId: z.string().min(1).max(100).optional(), iterationId: z.string().min(1).max(100).optional(),
          status: z.enum(Object.keys(statusLabels)).optional(), query: z.string().trim().max(200).optional(),
          cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[a-z0-9-]{1,100}$/i).optional(),
        }).parse(Object.fromEntries(params))
        return send(res, store.runPage({ ...query, archived: query.archived === '1' }))
      }
    }
    if (req.method === 'GET' && !id) return send(res, workflow.store.summaries())
    if (req.method === 'POST' && !id) return send(res, publicRun(await workflow.dispatch(dispatchSchema.parse(await json(req)))), 201)
    if (id && req.method === 'GET' && action === 'events') return events(req, res, id, url)
    if (id && req.method === 'GET' && action === 'related') {
      return send(res, store.relatedRuns(id))
    }
    if (id && req.method === 'GET' && action === 'context-difference') return send(res, workflow.contextDifference(id))
    if (id && req.method === 'PUT' && !action) return send(res, await workflow.update(id, dispatchSchema.parse(await json(req))))
    if (id && !requestId && (action === 'prompt' || action === 'optimize-prompt')) {
      const stage = z.coerce.number().int().min(0).parse(url.searchParams.get('stage') ?? 0)
      if (req.method === 'GET' && action === 'prompt') return send(res, await workflow.previewPrompt(id, stage))
      if (req.method === 'PUT' && action === 'prompt') {
        const { text, revision } = agentPromptWriteSchema.parse(await json(req))
        return send(res, workflow.updatePrompt(id, stage, text, revision))
      }
      if (req.method === 'POST' && action === 'optimize-prompt') {
        const input = agentPromptOptimizerSchema.parse(await json(req))
        const { run } = workflow.requirePromptStage(id, stage)
        const result = await optimizeAgentPrompt(configuredOptimizer(input.executorId), input.text)
        if (workflow.requirePromptStage(id, stage).run.revision !== run.revision) throw new HttpError(409, '任务已变更，请重新查看提示词')
        return send(res, result)
      }
    }
    if (id && req.method === 'GET' && action === 'context') {
      const stage = z.coerce.number().int().min(0).parse(url.searchParams.get('stage') ?? 0)
      return send(res, await workflow.readContext(id, stage, requestId))
    }
    if (id && req.method === 'GET' && !action) return send(res, publicRun(workflow.requireRun(id)))
    if (id && req.method === 'POST' && action) {
      const body = object(await json(req))
      if (action !== 'unarchive') workflow.requireUnarchivedRun(id)
      if (action === 'advance') workflow.advance(id)
      else if (action === 'start') await workflow.start(id, z.number().int().nonnegative().optional().parse(body.revision))
      else if (action === 'stop') workflow.stop(id)
      else if (action === 'retry') await workflow.retry(id, body.refreshResources !== false)
      else if (action === 'archive' || action === 'unarchive') workflow.setArchived(id, action === 'archive')
      else if (action === 'approval') workflow.updateApproval(id, z.enum(approvalModes).optional().parse(body.mode))
      else if (action === 'followup') workflow.followup(id, z.string().trim().min(1).max(100_000).parse(body.text))
      else if (action === 'interactions' && requestId) workflow.answer(id, requestId, body)
      else throw new HttpError(404, '找不到操作')
      return send(res, publicRun(workflow.requireRun(id)))
    }
  }
  throw new HttpError(404, '找不到请求的接口')
}

async function staticPage(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法')
  const requested = resolve(dist, `.${decodeURIComponent(url.pathname)}`)
  if (!withinDirectory(dist, requested)) throw new HttpError(403, '无法访问此路径')
  const file = relative(dist, requested) && (await stat(requested).catch(() => null))?.isFile()
    ? requested : resolve(dist, 'index.html')
  const data = await readFile(file).catch(() => { throw new HttpError(503, '请先运行 pnpm build，或使用 pnpm dev') })
  res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' })
  res.end(req.method === 'HEAD' ? undefined : data)
}

server.on('request', (req, res) => {
  void (async () => {
    const address = server.address()
    const currentPort = address && typeof address !== 'string' ? address.port : port
    const host = req.headers.host?.toLowerCase()
    const allowedHosts = [`127.0.0.1:${currentPort}`, `localhost:${currentPort}`]
    const fetchSite = req.headers['sec-fetch-site']
    if (!host || !allowedHosts.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)
      || (fetchSite && fetchSite !== 'none' && fetchSite !== 'same-origin')) {
      throw new HttpError(403, '请从本机工作台地址访问')
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, '请求路径无效')
    const url = new URL(req.url, `http://${host}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (!dev) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] === 'api') {
      if (parts.length === 2 && parts[1] === 'preferences') {
        if (req.method === 'GET') return send(res, preferences)
        if (req.method === 'PUT') return send(res, await updatePreferences(preferencesSchema.parse(await json(req))))
      }
      if (req.method === 'GET' || req.method === 'HEAD') return api(req, res, url, parts)
      if (switchingDirectory || closing) throw new HttpError(409, '服务正在切换数据目录或退出')
      pendingWrites++
      try { return await api(req, res, url, parts) }
      finally { pendingWrites-- }
    }
    if (vite) return vite.middlewares(req, res, () => { if (!res.writableEnded) send(res, { error: '页面不存在' }, 404) })
    return staticPage(req, res, url)
  })().catch(error => {
    if (res.headersSent) { res.destroy(); return }
    if (error instanceof HttpError) send(res, { error: error.message }, error.status)
    else if (error instanceof z.ZodError) send(res, { error: error.issues.map(issue => issue.message).join(' · ') }, 400)
    else {
      console.error(errorMessage(error))
      send(res, { error: '服务处理请求时出错，请查看终端日志' }, 500)
    }
  })
})

server.once('error', error => { console.error(`启动失败 · ${errorMessage(error)}`); process.exitCode = 1; void vite?.close(); store.close() })
server.listen(port, '127.0.0.1', () => {
  workflow.recover()
  const address = server.address()
  if (address && typeof address !== 'string') console.log(`Front Day · http://127.0.0.1:${address.port}`)
})

async function shutdown() {
  if (closing) return
  closing = true
  server.close()
  await workflow.close()
  server.closeAllConnections()
  await vite?.close()
  store.close()
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
