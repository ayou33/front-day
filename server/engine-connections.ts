import { access, stat } from 'node:fs/promises'
import { constants, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Engine, EngineAvailability, EngineHealth, Provider } from '../shared/contracts.ts'
import { engineGuides } from '../shared/engines.ts'
import { errorMessage } from './errors.ts'
import { capture } from './processes.ts'
import type { Launch } from './processes.ts'
import { RpcError, StdioRpc, object, string } from './rpc.ts'
import type { JsonObject } from './rpc.ts'

const clientInfo = { name: 'front-day', title: 'Front Day', version: '0.1.0' }
const probeTimeout = 8_000

async function locateExecutable(names: string[], extraDirectories: string[] = []) {
  const windows = process.platform === 'win32'
  const dirs = [...new Set([...(process.env.PATH ?? '').split(delimiter), ...extraDirectories]
    .map(dir => dir.replace(/^"|"$/g, '')).filter(isAbsolute))]
  for (const name of names) {
    if (!isAbsolute(name) && /[\\/]/.test(name)) continue
    const suffixes = !windows || extname(name) ? [''] : ['.exe', '.cmd', '.bat', '']
    const candidates = isAbsolute(name) ? [name] : dirs.flatMap(dir => suffixes.map(suffix => join(dir, name + suffix)))
    for (const candidate of candidates) {
      try {
        if (!(await stat(candidate)).isFile()) continue
        await access(candidate, constants.X_OK)
        return candidate
      } catch { /* try the next location */ }
    }
  }
  return null
}

export function findExecutable(engine: Engine) {
  const home = homedir()
  const dirs = [join(home, '.local', 'bin'), join(home, '.opencode', 'bin')]
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'))
    if (engine.provider === 'cursor') dirs.push(join(process.env.LOCALAPPDATA, 'cursor-agent'))
  }
  return locateExecutable(engine.executable ? [engine.executable] : engineGuides[engine.provider].commands, dirs)
}

function codexProfile(excludeEnv: string[]) {
  if (excludeEnv.some(key => key.toUpperCase() === 'CODEX_HOME')) return
  const configured = process.env.CODEX_HOME
  if (configured?.trim()) return resolve(configured)
  if (process.platform === 'win32') {
    const profile = join(homedir(), '.codex')
    try {
      // On Windows, Codex can resolve an empty/default profile differently from the user who started the workbench.
      if (statSync(profile, { throwIfNoEntry: false })?.isDirectory()) return profile
    } catch { /* allow Codex to resolve its own profile when this directory is inaccessible */ }
  }
}

export function engineLaunch(provider: Provider, program: string, cwd: string, excludeEnv: string[]): Omit<Launch, 'args'> {
  const profile = provider === 'codex' ? codexProfile(excludeEnv) : undefined
  return { program, cwd, excludeEnv, env: profile ? { CODEX_HOME: profile } : undefined }
}

export async function initializeEngine(rpc: StdioRpc, provider: Provider) {
  if (provider !== 'codex') {
    const result = await rpc.call('initialize', { protocolVersion: 1, clientInfo, clientCapabilities: {} }, probeTimeout)
    if (result.protocolVersion !== 1) throw new Error(`${engineGuides[provider].name} 未协商 ACP v1，请检查 CLI 版本`)
    return result
  }
  const result = await rpc.call('initialize', { clientInfo, capabilities: { experimentalApi: true } }, probeTimeout)
  rpc.notify('initialized')
  return result
}

export function codexAuth(account: JsonObject): EngineHealth['auth'] {
  if (string(object(account.account).type) || account.requiresOpenaiAuth === false) return 'ready'
  return account.account === null && account.requiresOpenaiAuth === true ? 'required' : 'unknown'
}

export function acpAuthRequired(error: unknown) {
  return error instanceof RpcError && error.code === -32000
}

function localCredential(excludeEnv: string[], names: string[]) {
  const excluded = new Set(excludeEnv.map(name => name.toUpperCase()))
  return names.some(name => !excluded.has(name) && !!process.env[name]?.trim())
}

async function terminalAuth(provider: Provider, launch: Omit<Launch, 'args'>): Promise<Pick<EngineHealth, 'auth' | 'authExecutable'>> {
  if (provider === 'cursor') {
    const status = await capture({ ...launch, args: ['status'] }, probeTimeout)
    const lines = `${status.stdout}\n${status.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
      .map(line => line.trim().replace(/^[✓✔✗✖✅❌●]\s*/u, ''))
    const ready = status.code === 0 && lines.some(line => /^(?:(?:you are(?: currently)? )?(?:logged in|authenticated)\b|login successful\b|(?:status|authentication):\s*(?:authenticated|logged in)\b)/i.test(line))
    const signedOut = lines.some(line => /^(?:(?:you are(?: currently)? )?not (?:logged in|authenticated)\b|(?:status:\s*)?unauthenticated\b|(?:log ?in|authentication) required\b)/i.test(line))
    const supplied = localCredential(launch.excludeEnv ?? [], ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'])
    return { auth: ready ? 'ready' : signedOut && !supplied ? 'required' : 'unknown' }
  }
  if (provider === 'claude') {
    const bundled = join(dirname(launch.program), process.platform === 'win32' ? 'claude.exe' : 'claude')
    const explicit = process.env.CLAUDE_CODE_EXECUTABLE
    const program = await locateExecutable(explicit ? [explicit] : [bundled, 'claude'], [join(homedir(), '.local', 'bin')])
    if (!program) return { auth: 'unknown' }
    const status = await capture({ ...launch, program, args: ['auth', 'status'] }, probeTimeout)
    try {
      const { loggedIn } = object(JSON.parse(status.stdout))
      if (loggedIn === true && status.code === 0) return { auth: 'ready', authExecutable: program }
      if (loggedIn === false && status.code === 1) return { auth: 'required', authExecutable: program }
    } catch { /* this release did not return JSON */ }
    return { auth: 'unknown', authExecutable: program }
  }
  if (provider === 'opencode') {
    const status = await capture({ ...launch, args: ['auth', 'list'] }, probeTimeout)
    const log = status.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    if (status.code === 0 && /\b[1-9]\d*\s+credentials?\b/i.test(log)) return { auth: 'ready' }
  }
  return { auth: 'unknown' }
}

function loginNote(provider: Provider) {
  return `当前 CLI 会话需要认证。请在启动工作台的同一系统账户下执行 ${engineGuides[provider].login}，完成后重新检查。`
}

export async function checkEngine(engine: Engine, cwd: string, excludeEnv: string[] = [], includeVersion = true): Promise<EngineHealth> {
  const { provider } = engine
  const executable = await findExecutable(engine)
  const result: EngineHealth = { provider, executable, installed: !!executable, connected: false, auth: 'unknown' }
  if (!executable) return { ...result, message: `未找到 ${engineGuides[provider].commands.join(' / ')}，请安装 CLI 或指定可执行文件路径。` }
  const launch = engineLaunch(provider, executable, cwd, excludeEnv)
  result.codexHome = launch.env?.CODEX_HOME
  const version = includeVersion ? capture({ ...launch, args: ['--version'] }, probeTimeout).then(value =>
    value.code === 0 ? value.stdout.trim().split(/\r?\n/)[0].slice(0, 200) : undefined) : undefined
  const rpc = new StdioRpc({ ...launch, args: engineGuides[provider].args }, provider !== 'codex',
    (_method, _params, id) => { if (id !== undefined) rpc.unsupported(id) }, () => {})
  try {
    await initializeEngine(rpc, provider)
    result.connected = true
    if (provider === 'codex') {
      result.auth = codexAuth(await rpc.call('account/read', { refreshToken: false }, probeTimeout))
    } else {
      Object.assign(result, await terminalAuth(provider, launch))
      if (result.auth === 'unknown' || provider === 'claude' || provider === 'opencode') {
        try {
          const session = await rpc.call('session/new', { cwd, mcpServers: [] }, probeTimeout)
          result.sessionReady = !!string(session.sessionId)
          // Claude's adapter may use its own bundled CLI. A different CLI's signed-out status is inconclusive.
          if (provider === 'claude' && result.auth === 'required') result.auth = 'unknown'
        } catch (error) {
          if (acpAuthRequired(error)) result.auth = 'required'
          else throw error
        }
      }
    }
    if (result.auth === 'required') result.message = loginNote(provider)
    if (result.auth === 'unknown') result.message = result.sessionReady
      ? '已建立会话。引擎未报告可确认的认证状态，实际可用性由所选模型决定。'
      : '协议已连接，暂时无法确认此 CLI 的认证状态。'
  } catch (error) {
    if (provider !== 'codex' && acpAuthRequired(error)) {
      result.auth = 'required'
      result.message = loginNote(provider)
    } else {
      result.auth = 'unknown'
      result.message = result.connected ? `认证或会话检查未完成 · ${errorMessage(error)}` : `协议启动失败 · ${errorMessage(error)}`
    }
  } finally { await rpc.close() }
  result.version = await version
  return result
}

const recent = new Map<string, { health: EngineHealth; checkedAt: number }>()
const checkKey = (engine: Engine) => JSON.stringify([engine.id, engine.provider, engine.executable, engine.model, engine.mode])

export async function inspectEngine(engine: Engine, cwd: string, excludeEnv: string[]) {
  const health = await checkEngine(engine, cwd, excludeEnv)
  recent.set(checkKey(engine), { health, checkedAt: Date.now() })
  return health
}

export async function localEngines(engines: Engine[], excludeEnv: string[]): Promise<EngineAvailability[]> {
  const keys = new Set(engines.map(checkKey))
  for (const key of recent.keys()) if (!keys.has(key)) recent.delete(key)
  return Promise.all(engines.map(async engine => {
    const executable = await findExecutable(engine)
    const codexHome = executable && engine.provider === 'codex' ? codexProfile(excludeEnv) : undefined
    const check = recent.get(checkKey(engine))
    const health = check && Date.now() - check.checkedAt < 5 * 60_000 && check.health.executable === executable && check.health.codexHome === codexHome
      ? check.health : undefined
    return { id: engine.id, executable, health, codexHome }
  }))
}
