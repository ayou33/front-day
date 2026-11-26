import type { IterationSnapshot, Resource } from './contracts.ts'

export const projectFields = [
  { key: 'scope', label: '项目范围', hint: '覆盖的业务、模块和明确排除的范围' },
  { key: 'conventions', label: '技术与约定', hint: '技术栈、目录入口、代码和协作约定' },
  { key: 'constraints', label: '限制与边界', hint: '兼容性、权限、数据和应保持的行为' },
  { key: 'validation', label: '验收与验证', hint: '验收标准、测试方式和参考结果' },
] as const

export const taskFields = [
  { key: 'scope', label: '这次的范围', hint: '涉及哪些页面、模块或接口' },
  { key: 'requirements', label: '本次需求', hint: '这次需要实现或核对的具体行为' },
  { key: 'constraints', label: '这次的限制', hint: '必须遵循的要求和应保留的行为' },
  { key: 'references', label: '参考资料', hint: '链接、参考项目路径或复现步骤' },
  { key: 'output', label: '预期输出', hint: '交付物、验收标准或验证方法' },
] as const

export const elementTypeGroups = [
  { label: '需求与设计', types: ['需求', '设计', '模板', '参考'] },
  { label: '开发与联调', types: ['接口', '开发约定'] },
  { label: '验证与交付', types: ['测试', '验收', '发布与交付'] },
  { label: '其他', types: ['其他'] },
]

export const elementTypeHints: Record<string, string | undefined> = {
  需求: '目标、业务规则和适用范围。', 设计: '页面设计稿、交互和适配说明。',
  模板: '可复用的页面、组件或代码骨架。', 参考: '用于对照的案例、旧实现或相关说明。',
  接口: '接口契约、调用方式和数据示例。', 开发约定: '技术约束、项目规范和兼容范围。',
  测试: '复现步骤、测试用例或测试数据。', 验收: '交付判定条件和验证结果。', 发布与交付: '发布方式、交付物及回滚说明。',
}

export function legacyIterationElements(iteration?: IterationSnapshot) {
  return [
    { name: '迭代范围', category: '需求', value: iteration?.scope },
    { name: '迭代需求', category: '需求', value: iteration?.context?.requirements },
    { name: '迭代约定与限制', category: '开发约定', value: iteration?.context?.constraints },
    { name: '迭代验收', category: '验收', value: iteration?.context?.validation },
  ].flatMap(({ name, category, value }) => value?.trim() ? [{ name, category, value }] : [])
}

export function taskElements(resources: Resource[], projectId: string, iterationId?: string) {
  return resources.filter(resource => resource.projectId === projectId && (!resource.iterationId || resource.iterationId === iterationId))
}

export const taskTypes = {
  requirements: { label: '需求整理', hint: '整理目标、范围和验收标准。', guidance: '梳理目标、范围及排除项、依赖、疑问和可验证的验收标准，输出需求整理结果。此类任务以分析为主，保持代码原样。' },
  development: { label: '功能开发', hint: '实现页面或业务功能。', guidance: '定位受影响的入口和现有约定，制定与任务规模相符的实现和验证计划，完成目标范围内的开发，汇报变更及验证结果。' },
  design: { label: '设计还原', hint: '对照设计稿实现或校正界面。', guidance: '确认设计稿的目标页面和状态，核对布局、视觉样式、交互和响应式要求。复用项目组件和资产，在目标状态下验证还原效果。' },
  integration: { label: '接口联调', hint: '接入接口并核对数据和交互状态。', guidance: '核对接口契约、调用时机与响应结构，验证正常、空数据、加载和异常状态。记录实际联调结果和待确认的接口差异。' },
  migration: { label: '移植', hint: '将参考工程的功能适配到当前项目。', guidance: '分别检查参考工程与目标工程的结构、契约和依赖，确认需迁移的行为并适配目标工程。参考工程作为只读来源，汇报适配点、验证结果和差异。' },
  bugfix: { label: 'Bug 修复', hint: '定位并修复已有问题。', guidance: '根据复现信息、日志与现有代码定位根因，选择最小修复，验证原场景和相关回归，汇报根因、变更和验证结果。' },
  refactor: { label: '重构优化', hint: '改善结构、性能或可维护性。', guidance: '先识别现有契约和可观察行为，再按目标改善结构或性能。使用相同场景验证回归，并说明改动及验证依据。' },
  verification: { label: '测试验收', hint: '按验收条件执行验证并记录结果。', guidance: '将需求和验收条件整理为可执行的验证场景，记录测试环境、结果和可复现问题，区分已验证内容和待验证内容。' },
} as const

export type TaskType = keyof typeof taskTypes

export const taskTypeGroups = [
  { label: '梳理与实现', types: ['requirements', 'development', 'design', 'integration', 'migration'] },
  { label: '维护与验证', types: ['bugfix', 'refactor', 'verification'] },
] satisfies { label: string; types: TaskType[] }[]

export function taskTypeDefinition(type?: string) {
  return type && Object.hasOwn(taskTypes, type) ? taskTypes[type as TaskType] : undefined
}

export function taskTypeLabel(type?: string) {
  return taskTypeDefinition(type)?.label ?? (type || '自动判断')
}

