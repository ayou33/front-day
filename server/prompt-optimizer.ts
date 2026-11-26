import { z } from 'zod'
import { taskTypeLabel } from '../shared/context.ts'
import { maxOptimizationInput, optimizerProviderOptions, promptOptimizerProviders } from '../shared/prompt-optimizer.ts'
import type { PromptOptimizerConfig, PromptOptimizerProvider } from '../shared/prompt-optimizer.ts'
import { HttpError } from './errors.ts'

export const optimizerSettingsSchema = z.object({
  enabled: z.boolean(), provider: z.enum(promptOptimizerProviders), model: z.string().trim().min(1, '请输入模型').max(150),
  apiKey: z.string().trim().min(1).max(1024).regex(/^[\x21-\x7e]+$/, 'API Key 格式无效').nullable().optional(),
})

export const optimizerInputSchema = z.object({
  goal: z.string().trim().min(1, '请先填写任务目标').max(maxOptimizationInput, '优化支持最多 12000 字符'),
  taskType: z.string().trim().max(100).optional(),
  provider: z.enum(promptOptimizerProviders).optional(),
})

const instruction = '你负责润色前端工程任务提示词。将给出的目标整理为清晰、可执行的任务描述，保留原始目标、限制、文件名和验收要求。只使用输入中提供的事实，不新增需求、不执行任务。缺少的信息可表述为待核对事项。用输入的语言输出优化后的提示词正文。'
const maxOutputTokens = 6000
const noThinking = { type: 'disabled' }

const chatProviders = {
  deepseek: { url: 'https://api.deepseek.com/chat/completions', options: { max_tokens: 3000, thinking: noThinking } },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', options: { max_tokens: maxOutputTokens, reasoning_effort: 'none' } },
  qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', options: { max_tokens: 3000, enable_thinking: false } },
  doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', options: { max_tokens: 3000, thinking: noThinking } },
  kimi: { url: 'https://api.moonshot.cn/v1/chat/completions', options: { max_completion_tokens: maxOutputTokens } },
  glm: { url: 'https://api.z.ai/api/paas/v4/chat/completions', options: { max_tokens: maxOutputTokens } },
  minimax: { url: 'https://api.minimax.cn/v1/chat/completions', options: { max_completion_tokens: maxOutputTokens, reasoning_split: true } },
}

function providerRequest({ provider, model }: PromptOptimizerConfig, apiKey: string, goal: string): {
  url: string; headers: Record<string, string>; body: object
} {
  const userMessage = { role: 'user', content: goal }
  const bearer = { Authorization: `Bearer ${apiKey}` }
  switch (provider) {
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/responses', headers: bearer,
        body: { model, instructions: instruction, input: goal, store: false, max_output_tokens: maxOutputTokens },
      }
    case 'xai':
      return {
        url: 'https://api.x.ai/v1/responses', headers: bearer,
        body: { model, input: [{ role: 'system', content: instruction }, userMessage], store: false, max_output_tokens: maxOutputTokens },
      }
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' },
        body: { model, system: instruction, messages: [userMessage], max_tokens: maxOutputTokens },
      }
    case 'gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`,
        headers: { 'x-goog-api-key': apiKey },
        body: { systemInstruction: { parts: [{ text: instruction }] }, contents: [{ role: 'user', parts: [{ text: goal }] }],
          generationConfig: { maxOutputTokens } },
      }
    default: {
      const { url, options } = chatProviders[provider]
      const modelOptions = chatModelOptions[provider]?.[model]
      return { url, headers: bearer, body: { model, stream: false, ...options, ...modelOptions,
        messages: [{ role: 'system', content: instruction }, userMessage] } }
    }
  }
}

const chatModelOptions: Partial<Record<PromptOptimizerProvider, Record<string, object>>> = {
  kimi: { 'kimi-k2.6': { thinking: noThinking } },
  glm: { 'glm-5.2': { thinking: noThinking }, 'glm-5.1': { thinking: noThinking }, 'glm-5.3': { reasoning_effort: 'low' } },
  minimax: { 'MiniMax-M3.1-Flash': { reasoning_effort: 'low' } },
}

const textBlock = z.object({ type: z.string(), text: z.string().optional() })
const chatResponse = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.union([z.string(), z.array(textBlock)]) }), finish_reason: z.literal('stop'),
})).min(1) })
const responsesResult = z.object({ status: z.literal('completed'), output: z.array(z.object({
  type: z.string(), content: z.array(textBlock).optional(),
})) })
const anthropicResponse = z.object({ stop_reason: z.literal('end_turn'), content: z.array(textBlock) })
const geminiResponse = z.object({ candidates: z.array(z.object({
  finishReason: z.literal('STOP'), content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }),
})).min(1) })

function providerText(provider: PromptOptimizerProvider, payload: unknown) {
  switch (provider) {
    case 'openai':
    case 'xai': {
      const { data } = responsesResult.safeParse(payload)
      return data?.output.filter(item => item.type === 'message').flatMap(item =>
        item.content?.filter(part => part.type === 'output_text').map(part => part.text) ?? []).join('\n')
    }
    case 'anthropic': {
      const { data } = anthropicResponse.safeParse(payload)
      return data?.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    }
    case 'gemini': {
      const { data } = geminiResponse.safeParse(payload)
      return data?.candidates[0].content.parts.filter(part => !part.thought).map(part => part.text).join('\n')
    }
    default: {
      const text = chatResponse.safeParse(payload).data?.choices[0].message.content
      return typeof text === 'string' ? text : text?.filter(part => part.type === 'text').map(part => part.text).join('\n')
    }
  }
}

const optimizedGoal = z.string().trim().min(1).max(maxOptimizationInput)

export async function optimizePrompt(config: PromptOptimizerConfig, apiKey: string, input: z.infer<typeof optimizerInputSchema>, send = fetch) {
  const label = optimizerProviderOptions[config.provider].label
  const goal = JSON.stringify({ goal: input.goal, ...(input.taskType && { taskType: taskTypeLabel(input.taskType) }) })
  const { url, headers, body } = providerRequest(config, apiKey, goal)
  let response: Response
  try {
    response = await send(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
  } catch (error) {
    throw new HttpError(502, error instanceof Error && error.name === 'TimeoutError' ? `${label} 请求超时，请稍后重试` : `无法连接 ${label}，请检查网络`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const message = response.status === 401 || response.status === 403 ? `${label} 认证失败，请检查 API Key 和权限`
      : response.status === 402 ? `${label} 账户余额不足` : response.status === 429 ? `${label} 超出配额或调用频率，请稍后重试`
        : `${label} 请求失败（${response.status}），请检查模型配置或稍后重试`
    throw new HttpError(502, message)
  }
  const result = optimizedGoal.safeParse(providerText(config.provider, await response.json().catch(() => null)))
  if (!result.success) throw new HttpError(502, `${label} 未返回完整的优化结果，请稍后重试`)
  return { goal: result.data }
}
