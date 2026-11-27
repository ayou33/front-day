import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Account, Resource } from '../shared/contracts.ts'
import { HttpError, errorMessage } from './errors.ts'

const maxBytes = 96_000
const allowedHeader = /^(authorization|cookie|api-key|x-[a-z0-9-]+)$/i

export async function projectDirectory(path: string) {
  if (!isAbsolute(path)) throw new HttpError(400, '项目目录须使用绝对路径')
  const directory = await realpath(path).catch(() => undefined)
  if (!directory || !(await stat(directory).catch(() => undefined))?.isDirectory()) throw new HttpError(400, `无法访问项目目录 · ${path}`)
  return directory
}

export function webUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) }
  catch { throw new HttpError(400, '请输入完整的 HTTP 或 HTTPS 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, '资源地址须使用 HTTP 或 HTTPS，认证请通过账户配置')
  }
  return url
}

export function accountOrigin(account: Omit<Account, 'id'>) {
  const url = webUrl(account.origin)
  if (url.pathname !== '/' || url.search || url.hash) throw new HttpError(400, '账户来源只填写协议、域名和端口')
  if (account.type === 'header' && !allowedHeader.test(account.header)) throw new HttpError(400, '请填写 Authorization、Cookie、API-Key 或 X- 开头的请求头')
  if (account.type === 'basic' && (!account.username.trim() || account.username.includes(':'))) throw new HttpError(400, 'Basic 认证需要有效用户名')
  return url.origin
}

type ReadPassword = (account: Account) => string

function authHeaders(url: URL, account: Account | undefined, readPassword: ReadPassword): { headers: Record<string, string>; redact: string[] } {
  if (!account) return { headers: {}, redact: [] }
  if (url.origin !== account.origin) throw new Error(`URL 来源与账户「${account.name}」不匹配`)
  const secret = account.credentialSource === 'saved' ? readPassword(account) : process.env[account.secretEnv]
  if (!secret) throw new Error(`缺少账户「${account.name}」的环境变量 ${account.secretEnv}`)
  if (account.type === 'basic') {
    const encoded = Buffer.from(`${account.username}:${secret}`).toString('base64')
    return { headers: { Authorization: `Basic ${encoded}` }, redact: [secret, JSON.stringify(secret).slice(1, -1), encoded] }
  }
  if (account.type === 'header') return { headers: { [account.header]: secret }, redact: [secret] }
  return { headers: { Authorization: `Bearer ${secret}` }, redact: [secret] }
}

async function fetchText(url: URL, account: Account | undefined, signal: AbortSignal, readPassword: ReadPassword) {
  const { headers, redact } = authHeaders(url, account, readPassword)
  const response = await fetch(url, {
    headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  const type = response.headers.get('Content-Type')?.split(';')[0].toLowerCase() ?? ''
  if (!(type.startsWith('text/') || type === 'application/json' || type.endsWith('+json'))) {
    await response.body?.cancel()
    throw new Error(`当前响应格式无法作为文本读取${type ? `（${type}）` : ''}`)
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  let text = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error(`响应超过 ${maxBytes / 1000} KB`)
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally { await reader.cancel().catch(() => {}) }
  for (const secret of [...new Set(redact)].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]')
  return text
}

export function withinDirectory(root: string, file: string) {
  const rel = relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function localPath(value: string, directory: string) {
  const absolute = isAbsolute(value)
  const target = await realpath(absolute ? value : resolve(directory, value)).catch(() => undefined)
  const stats = target ? await stat(target).catch(() => undefined) : undefined
  if (!target || (!absolute && !withinDirectory(directory, target)) || !(stats?.isFile() || stats?.isDirectory())) {
    throw new HttpError(400, '无法读取所选本地文件或文件夹')
  }
  return { path: withinDirectory(directory, target) ? relative(directory, target) : target, folder: !!stats?.isDirectory() }
}

export async function resolveResource(resource: Resource, accounts: Account[], directory: string, signal: AbortSignal, readPassword: ReadPassword) {
  try {
    signal.throwIfAborted()
    let content = resource.value
    let source = '文本'
    let accountUsage = ''
    if (resource.kind === 'file') {
      const local = await localPath(resource.value, directory)
      content = local.path
      source = local.folder
        ? (isAbsolute(content) ? '本机文件夹绝对路径，请读取该目录中的文件作为参考' : '项目文件夹相对路径，请读取该目录中的文件')
        : (isAbsolute(content) ? '本机文件绝对路径，请读取此文件作为参考' : '项目文件相对路径，请读取该文件')
    }
    if (resource.kind === 'url') {
      const url = webUrl(resource.value)
      source = 'URL 引用'
      if (resource.fetch) {
        const account = accounts.find(candidate => candidate.id === resource.accountId)
        if (resource.accountId && !account) throw new Error('所选 HTTP 账户已删除')
        content = await fetchText(url, account, signal, readPassword)
        accountUsage = account?.usage?.trim() ?? ''
        source = `从 ${url.origin}${url.pathname} 读取的原始资料`
      }
    }
    return { name: resource.name, category: resource.category, source, content, prompt: resource.prompt,
      ...(accountUsage ? { accountUsage } : {}) }
  } catch (error) {
    throw new Error(`资源「${resource.name}」读取失败 · ${errorMessage(error)}`)
  }
}
