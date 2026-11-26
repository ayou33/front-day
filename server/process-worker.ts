import { spawn as spawnProcess } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import spawn from 'cross-spawn'
import type { Launch } from './processes.ts'
import { errorMessage } from './errors.ts'

let child: ChildProcess | undefined
let stopping = false
let finished = false

function finish(result: { code: number | null; signal: string | null; error?: string }) {
  if (finished) return
  finished = true
  if (process.connected && process.send) {
    process.send({ type: 'exit', ...result }, () => { if (process.connected) process.disconnect() })
  }
}

function stop() {
  if (stopping || !child?.pid || child.exitCode !== null || child.signalCode !== null) return
  stopping = true
  if (process.platform === 'win32') {
    const tree = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    tree.once('error', () => child?.kill())
    tree.once('exit', code => { if (code !== 0) child?.kill() })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

process.on('disconnect', stop)
process.on('message', (message: { type: 'launch'; launch: Launch } | { type: 'stop' } | { type: 'stdin'; text: string }) => {
  if (message.type === 'stop') return stop()
  if (message.type === 'stdin') { child?.stdin?.write(message.text); return }
  if (child) return
  const { program, args, cwd, excludeEnv = [], env: overrides } = message.launch
  const env = { ...process.env, ...overrides }
  const excluded = new Set(excludeEnv.map(key => key.toUpperCase()))
  for (const key of Object.keys(env)) if (excluded.has(key.toUpperCase())) delete env[key]
  try {
    const launched = spawn(program, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true })
    child = launched
    launched.stdin?.on('error', () => {})
    for (const stream of ['stdout', 'stderr'] as const) {
      launched[stream]?.setEncoding('utf8').on('data', (text: string) => {
        if (process.connected) process.send?.({ type: 'output', stream, text }, () => {})
      })
    }
    launched.once('error', error => finish({ code: null, signal: null, error: errorMessage(error) }))
    launched.once('close', (code, signal) => finish({ code, signal }))
  } catch (error) {
    finish({ code: null, signal: null, error: errorMessage(error) })
  }
})
