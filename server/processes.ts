import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { TestResult } from '../shared/contracts.ts'
import { errorMessage } from './errors.ts'

export type Output = (stream: 'stdout' | 'stderr', text: string) => void
export type Launch = { program: string; args: string[]; cwd: string; excludeEnv?: string[]; env?: Record<string, string> }
type WorkerMessage = { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'exit'; code: number | null; signal: string | null; error?: string }

export class CommandProcess {
  readonly done: Promise<TestResult>
  private child
  private events = new EventEmitter()

  constructor(launch: Launch, onOutput: Output) {
    const started = performance.now()
    this.child = fork(fileURLToPath(new URL('./process-worker.ts', import.meta.url)), [], {
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.done = new Promise(resolve => {
      let result: Omit<TestResult, 'ms'> | undefined
      this.child.on('message', (message: WorkerMessage) => {
        if (message.type === 'output') onOutput(message.stream, message.text)
        if (message.type === 'exit') result = { code: message.code, signal: message.signal, error: message.error }
      })
      this.child.once('error', error => {
        resolve({ code: null, signal: null, error: errorMessage(error), ms: Math.round(performance.now() - started) })
      })
      this.child.once('close', (code, signal) => {
        resolve({ ...(result ?? { code, signal, error: '进程管理器意外退出' }), ms: Math.round(performance.now() - started) })
      })
    })
    void this.done.then(result => this.events.emit('exit', result))
    this.send({ type: 'launch', launch })
  }

  private send(message: object) {
    if (this.child.connected) this.child.send(message, () => {})
  }

  write(text: string) { this.send({ type: 'stdin', text }) }
  stop() { this.send({ type: 'stop' }) }
  onExit(listener: (result: TestResult) => void) { this.events.once('exit', listener) }
}

export async function capture(launch: Launch, timeout = 10_000) {
  let stdout = ''
  let stderr = ''
  const child = new CommandProcess(launch, (stream, text) => {
    if (stream === 'stdout') stdout = (stdout + text).slice(-16_000)
    else stderr = (stderr + text).slice(-16_000)
  })
  const timer = setTimeout(() => child.stop(), timeout)
  try { return { ...await child.done, stdout, stderr } }
  finally { clearTimeout(timer) }
}
