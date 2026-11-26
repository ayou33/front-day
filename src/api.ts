import type { ConfigKind, Entity, Run } from '../shared/contracts.ts'

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`)
  return result as T
}

export function saveConfig<K extends ConfigKind>(kind: K, value: Entity<K>) {
  return request<Entity<K>>(`/config/${kind}${value.id ? `/${encodeURIComponent(value.id)}` : ''}`, value.id ? 'PUT' : 'POST', value)
}

export function runAction(id: string, action: string, body: unknown = {}) {
  return request<Run>(`/runs/${encodeURIComponent(id)}/${action}`, 'POST', body)
}
