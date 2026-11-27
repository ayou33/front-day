import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, Provider, Run, RunStatus } from '../shared/contracts.ts'
import { engineGuides, engineProviders } from '../shared/engines.ts'

export const root = fileURLToPath(new URL('../', import.meta.url))

export async function harness() {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'front day test-'))
  const project = join(dir, 'test project')
  await mkdir(project)
  const fixture = fileURLToPath(new URL('./fixtures/agent.ts', import.meta.url))
  const wrappers = {} as Record<Provider, string>
  for (const provider of engineProviders) {
    const windows = process.platform === 'win32'
    const command = engineGuides[provider].commands[0]
    const file = join(dir, windows ? `${command}.cmd` : command)
    const script = windows ? `@echo off\r\n"${process.execPath}" "${fixture}" ${provider} %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${fixture}' ${provider} "$@"\n`
    await writeFile(file, script, { mode: 0o755 })
    wrappers[provider] = file
  }
  return { dir, project, wrappers, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) }
}

export async function serve(dir: string, env: NodeJS.ProcessEnv = {}, preload?: URL) {
  const args = [...preload ? ['--import', preload.href] : [], 'server/index.ts']
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    CLAUDE_CODE_EXECUTABLE: join(dir, 'missing-claude-cli'), ...env, FRONT_DAY_PORT: '0', FRONT_DAY_DATA_DIR: join(dir, 'data'),
    FRONT_DAY_PREFERENCES_FILE: join(dir, '.front-day.preferences.json') }, stdio: 'pipe', windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`服务启动超时\n${stderr}`)) }, 15_000)
    child.stdout.setEncoding('utf8').on('data', text => {
      stdout += text
      const address = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (address) { clearTimeout(timeout); resolve(address[0]) }
    })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`服务退出 ${code}\n${stderr}`)) })
  })
  async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api${path}`, { method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    const value = await response.json()
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(value)}\n${stderr}`)
    return value as T
  }
  return { baseUrl, api, async stop() { if (child.exitCode !== null || child.signalCode) return; const exited = once(child, 'exit'); child.kill(); await exited } }
}

export function stage(name: string, overrides: Partial<Config<'templates'>['stages'][number]> = {}): Config<'templates'>['stages'][number] {
  return { name, kind: 'agent', prompt: '', engineId: '', mode: '', resourceIds: [], allResources: true, advance: 'auto', testCommand: null, analyzeTest: false, ...overrides }
}

export async function waitForRun(api: Awaited<ReturnType<typeof serve>>['api'], runId: string, status: RunStatus, predicate: (run: Run) => boolean = () => true) {
  let value: Run | undefined
  for (let i = 0; i < 150; i++) {
    value = await api<Run>(`/runs/${runId}`)
    if (value.status === status && predicate(value)) return value
    if (value.status !== status && ['failed', 'succeeded', 'stopped'].includes(value.status)) break
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`期望 ${status}，实际 ${value?.status} · ${value?.error ?? ''}`)
}
