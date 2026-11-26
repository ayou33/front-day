export const promptOptimizerProviders = ['deepseek', 'openai', 'anthropic', 'gemini', 'xai', 'mistral', 'qwen', 'doubao', 'kimi', 'glm', 'minimax'] as const
export type PromptOptimizerProvider = (typeof promptOptimizerProviders)[number]

export const optimizerProviderOptions: Record<PromptOptimizerProvider, { label: string; models: readonly [string, ...string[]]; detail?: string }> = {
  deepseek: { label: 'DeepSeek', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  openai: { label: 'OpenAI', models: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4'] },
  anthropic: { label: 'Anthropic Claude', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] },
  gemini: { label: 'Google Gemini', models: ['gemini-3.1-flash-lite', 'gemini-4-hydrogen', 'gemini-4-neon'] },
  xai: { label: 'xAI Grok', models: ['grok-4.7'] },
  mistral: { label: 'Mistral AI', models: ['mistral-small-latest', 'mistral-large-4-0'] },
  qwen: { label: '阿里云百炼 · 通义千问', models: ['qwen-flash', 'qwen-plus', 'qwen4-max'], detail: '使用百炼北京地域的按量 API Key。' },
  doubao: { label: '火山方舟 · 豆包', models: ['doubao-seed-2-0-lite-260428', 'doubao-seed-2-1-pro-260915'], detail: '请使用方舟按量 API Key，并开通所选模型。' },
  kimi: { label: '月之暗面 · Kimi', models: ['kimi-k2.6', 'kimi-k3', 'kimi-k3.1-pro'], detail: '使用 Kimi 中国站 API Key。' },
  glm: { label: '智谱 GLM', models: ['glm-5.2', 'glm-5.1', 'glm-5.3'], detail: '使用 Z.AI 开放平台 API Key。' },
  minimax: { label: 'MiniMax', models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'], detail: '使用 MiniMax 中国站 API Key。' },
}

export type PromptOptimizerConfig = { enabled: boolean; provider: PromptOptimizerProvider; model: string }
export type PromptOptimizerProfile = { model: string; hasApiKey: boolean }
export type PromptOptimizerSettings = PromptOptimizerConfig & PromptOptimizerProfile & {
  profiles: Partial<Record<PromptOptimizerProvider, PromptOptimizerProfile>>
}
export const defaultPromptOptimizer: PromptOptimizerSettings = {
  enabled: false, provider: 'deepseek', model: optimizerProviderOptions.deepseek.models[0], hasApiKey: false, profiles: {},
}
export const maxOptimizationInput = 12_000
