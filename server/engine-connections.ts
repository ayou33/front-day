import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { constants, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Engine, EngineAvailability, EngineHealth, Provider } from '../shared/contracts.ts'
import { engineGuides } from '../shared/engines.ts'
import { errorMessage } from './errors.ts'
import { capture } from './processes.ts'
import type { Launch } from './processes.ts'
import { openAcpSession, openCodexThread } from './engine-session-setup.ts'
import { AcpRpc } from './acp-rpc.ts'
import { RpcError, StdioRpc, object, string } from './rpc.ts'
import type { EngineRpc, JsonObject, Receiver, RpcId } from './rpc.ts'

const clientInfo = { name: 'front-day', title: 'Front Day', version: '0.1.0' }
const probeTimeout = 8_000
const runWindowsPowerShell = promisify(execFile)
let codexDesktopCache: { expiresAt: number; result: Promise<string | null> } | undefined

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

async function queryWindowsCodexDesktop() {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !isAbsolute(systemRoot)) return null
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop"
    + " | Where-Object PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0'"
    + ' | Sort-Object { [version]$_.Version } -Descending | Select-Object -ExpandProperty InstallLocation'
  try {
    const { stdout } = await runWindowsPowerShell(powershell, ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 64_000 })
    const executables = stdout.split(/\r?\n/).map(location => location.trim()).filter(isAbsolute)
      .map(location => join(location, 'app', 'resources', 'codex.exe'))
    return locateExecutable(executables)
  } catch { return null }
}

async function locateWindowsCodexDesktop() {
  const cached = codexDesktopCache
  if (cached && cached.expiresAt > Date.now()) {
    const executable = await cached.result
    if (!executable || await locateExecutable([executable])) return executable
    if (codexDesktopCache && codexDesktopCache !== cached) return codexDesktopCache.result
  }

  const result = queryWindowsCodexDesktop()
  codexDesktopCache = { result, expiresAt: Date.now() + 60_000 }
  return result
}

export async function findExecutable(engine: Engine) {
  const home = homedir()
  const dirs = [join(home, '.local', 'bin'), join(home, '.opencode', 'bin')]
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'))
    if (engine.provider === 'cursor') dirs.push(join(process.env.LOCALAPPDATA, 'cursor-agent'))
  }
  const executable = await locateExecutable(engine.executable ? [engine.executable] : engineGuides[engine.provider].commands, dirs)
  if (executable || engine.executable || engine.provider !== 'codex' || process.platform !== 'win32') return executable
  return locateWindowsCodexDesktop()
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

export function connectEngine(provider: Provider, launch: Omit<Launch, 'args'>, receive: Receiver, log: (text: string) => void, cancelled: (id: RpcId) => void = () => {}): EngineRpc {
  const command = { ...launch, args: engineGuides[provider].args }
  return provider === 'codex' ? new StdioRpc(command, receive, log) : new AcpRpc(command, receive, log, cancelled)
}

export async function initializeEngine(rpc: EngineRpc, provider: Provider) {
  if (provider !== 'codex') {
    const result = await rpc.call('initialize', { protocolVersion: PROTOCOL_VERSION, clientInfo, clientCapabilities: {} }, probeTimeout)
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${engineGuides[provider].name} 未协商 ACP v1，请检查 CLI 版本`)
    return result
  }
  const result = await rpc.call('initialize', { clientInfo, capabilities: { experimentalApi: true } }, probeTimeout)
  await rpc.notify('initialized')
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

export async function checkEngine(engine: Engine, cwd: string, excludeEnv: string[] = [], includeVersion = true, projectId?: string): Promise<EngineHealth> {
  const { provider } = engine
  const executable = await findExecutable(engine)
  const result: EngineHealth = { provider, executable, installed: !!executable, connected: false, auth: 'unknown',
    ...(projectId && { projectId, workingDirectory: cwd }) }
  if (!executable) return { ...result, message: `未找到 ${engineGuides[provider].commands.join(' / ')}，请安装 CLI 或指定可执行文件路径。` }
  const launch = engineLaunch(provider, executable, cwd, excludeEnv)
  result.codexHome = launch.env?.CODEX_HOME
  const version = includeVersion ? capture({ ...launch, args: ['--version'] }, probeTimeout).then(value =>
    value.code === 0 ? value.stdout.trim().split(/\r?\n/)[0].slice(0, 200) : undefined) : undefined
  const rpc = connectEngine(provider, launch,
    (_method, _params, id) => { if (id !== undefined) rpc.unsupported(id) }, () => {})
  try {
    const init = await initializeEngine(rpc, provider)
    result.connected = true
    if (provider === 'codex') {
      result.auth = codexAuth(await rpc.call('account/read', { refreshToken: false }, probeTimeout))
      if (projectId && result.auth !== 'required') {
        result.sessionReady = false
        await openCodexThread(rpc, engine, cwd, undefined, true)
        result.sessionReady = true
      }
    } else {
      Object.assign(result, await terminalAuth(provider, launch))
      if (projectId && (result.auth !== 'required' || provider === 'claude')) {
        result.sessionReady = false
        const sessionId = await openAcpSession(rpc, engine, cwd, init)
        result.sessionReady = true
        if (provider === 'claude' && result.auth === 'required') result.auth = 'unknown'
        if (object(object(init.agentCapabilities).sessionCapabilities).close) {
          await rpc.call('session/close', { sessionId }, 2000).catch(() => {})
        }
      } else if (!projectId && (result.auth === 'unknown' || provider === 'claude' || provider === 'opencode')) {
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
    else if (projectId && result.sessionReady) result.message = '已在所选项目建立会话并应用配置。首轮模型输出可通过任务验证。'
    if (result.auth === 'unknown') result.message = result.sessionReady
      ? result.message ?? '已建立会话。引擎未报告可确认的认证状态，实际可用性由所选模型决定。'
      : '协议已连接，暂时无法确认此 CLI 的认证状态。'
  } catch (error) {
    if (provider !== 'codex' && acpAuthRequired(error)) {
      result.auth = 'required'
      result.message = loginNote(provider)
    } else {
      if (result.sessionReady !== false) result.auth = 'unknown'
      result.message = result.sessionReady === false ? `项目会话检查失败 · ${errorMessage(error)}`
        : result.connected ? `认证或会话检查未完成 · ${errorMessage(error)}` : `协议启动失败 · ${errorMessage(error)}`
    }
  } finally { await rpc.close() }
  result.version = await version
  return result
}

const recent = new Map<string, { health: EngineHealth; checkedAt: number }>()
const checkKey = (engine: Engine) => JSON.stringify([engine.id, engine.provider, engine.executable, engine.model, engine.mode])

export async function inspectEngine(engine: Engine, cwd: string, excludeEnv: string[], projectId?: string) {
  const health = await checkEngine(engine, cwd, excludeEnv, true, projectId)
  if (!projectId) recent.set(checkKey(engine), { health, checkedAt: Date.now() })
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
