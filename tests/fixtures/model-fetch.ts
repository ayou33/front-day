import assert from 'node:assert/strict'

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.deepseek.com/chat/completions') return realFetch(url, init)
  const key = new Headers(init?.headers).get('Authorization')
  init?.signal?.throwIfAborted()
  const body = JSON.parse(String(init?.body))
  const input = body.messages.at(-1).content as string
  const system = body.messages[0].content as string
  const respond = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
  if (input === 'Ping') {
    if (key === 'Bearer fixture-quota') return new Response(null, { status: 429 })
    if (key === 'Bearer fixture-permission') return Response.json({ error: { code: 'model_not_found' } }, { status: 400 })
    if (key === 'Bearer fixture-network') throw new Error('fixture network error')
    if (key !== 'Bearer fixture-deepseek-key' && key !== 'Bearer fixture-custom-key') return new Response(null, { status: 401 })
    return respond('OK')
  }
  assert.equal(key, body.model === 'fixture-custom-model' ? 'Bearer fixture-custom-key' : 'Bearer fixture-deepseek-key')
  if (system.includes('润色')) return respond('API 优化建议')
  if (input.includes('FIXTURE_WAIT_API')) {
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  }
  if (input.includes('FIXTURE_AUTH_ERROR')) return new Response(null, { status: 401 })
  if (input.includes('继续整理')) return respond('API 续改已处理')
  if (input.includes('FIXTURE_SCOPE')) {
    assert.ok(!input.includes('FOREIGN_PRIVATE_TEXT'))
    assert.ok(!input.includes('ON_DEMAND_TEXT'))
    if (!input.startsWith('{"history":')) return respond('{"tool":"read_file","path":"private.md"}')
    const last = JSON.parse(input).history.at(-1)
    if (last.tool === 'read_file private.md') {
      assert.equal(last.result.error, '路径不可访问')
      return respond('{"tool":"list_context"}')
    }
    assert.ok(!last.result.some((entry: { label: string }) => entry.label === '敏感文件'))
    return respond('资料范围正确')
  }
  if (input.includes('FIXTURE_PATCH_API')) {
    assert.equal(body.stream, true)
    const streamed = (chunks: string[]) => new Response(chunks.map(text =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\r\n\r\n`).join('')
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\r\n\r\ndata: [DONE]\r\n\r\n',
    { headers: { 'Content-Type': 'text/event-stream' } })
    if (!input.startsWith('{"history":')) return streamed(['{"tool":"read_file",', '"path":"large.txt"}'])
    const history = JSON.parse(input).history
    const last = history.at(-1)
    const read = '{"tool":"read_file","path":"large.txt","offset":0,"limit":256}'
    if (last.result?.error) return streamed([read])
    if (last.tool === 'read_file large.txt' && last.result.bytes > 16000) {
      assert.ok(last.result.nextOffset <= 16000)
      const replacement = last.result.content.startsWith('并行') ? '更新后的第一行' : '补丁第一行'
      return streamed([JSON.stringify({ tool: 'patch_file', path: 'large.txt', startLine: 1, deleteCount: 1,
        content: replacement, expectedHash: last.result.hash })])
    }
    assert.equal(last.result.written, true)
    return streamed(['API ', '补丁完成'])
  }
  if (input.includes('FIXTURE_LINKED_RESOURCE')) {
    if (!input.startsWith('{"history":')) return respond('{"tool":"list_context"}')
    const last = JSON.parse(input).history.at(-1)
    if (last.tool === 'list_context') {
      const entry = last.result.find((item: { label: string }) => item.label === '外部参考')
      return respond(JSON.stringify({ tool: 'read_context', id: entry.id, path: 'reference.md' }))
    }
    return respond(last.result.local.content)
  }
  if (!input.includes('FIXTURE_WRITE_API')) return respond('API 任务已处理')
  if (!input.startsWith('{"history":')) return respond('{"tool":"read_file","path":"app.js"}')
  const { history } = JSON.parse(input)
  const last = history.at(-1)
  if (last.tool === 'read_file app.js') {
    assert.equal(last.result.content, 'export const base = 1\n')
    return respond(JSON.stringify({ tool: 'write_file', path: 'app.js', expectedHash: last.result.hash, content: 'export const base = 2\n' }))
  }
  return respond(last.result.written ? 'API 文件已更新' : last.result.error)
}
