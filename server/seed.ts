import type { Template } from '../shared/contracts.ts'

export const seedStages: Template['stages'] = [
  { name: '需求分析', kind: 'agent', prompt: '阅读提供的需求、设计和接口资料，列出实现步骤、验收条件和待确认问题。此阶段只分析。', engineId: '', mode: 'ask', resourceIds: [], allResources: true, advance: 'manual', testCommand: null, analyzeTest: false },
  { name: '前端开发', kind: 'agent', prompt: '结合上一阶段和资源完成前端开发。遵循项目约定，输出变更摘要和验证情况。', engineId: '', mode: '', resourceIds: [], allResources: true, advance: 'auto', testCommand: null, analyzeTest: false },
  { name: '测试验证', kind: 'test', prompt: '根据真实测试日志总结通过情况和失败原因。', engineId: '', mode: '', resourceIds: [], allResources: false, advance: 'auto', testCommand: null, analyzeTest: false },
]

export const builtinTemplates: { id: string; name: string; description: string; stages: Template['stages'] }[] = [
  {
    id: 'requirements-brief', name: '需求整理', description: '把需求资料整理成可直接指导开发的 Agent 文档。',
    stages: [
      { name: '需求梳理', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '阅读提供的需求、设计和接口资料，提取背景、目标用户、核心场景、功能范围与排除项、依赖与约束。区分资料事实与推断，列出缺失信息和待确认问题。本阶段只梳理，不修改代码。' },
      { name: '开发文档', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '基于上一阶段，输出可直接指导后续开发的 Agent 文档（Markdown）：背景与目标、范围与排除项、用户流程、页面与状态、接口与数据、异常与边界、验收标准、实现步骤、风险与待确认事项。只使用已确认的信息，推断需标注。' },
    ],
  },
  {
    id: 'issue-overview', name: 'Issue 概览', description: '汇总 bug 列表，给出分类、优先级与置信度。',
    stages: [
      { name: '读取与提取', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '按资料中给出的获取方式读取 bug 列表（链接、导出文本或接口说明）。逐条提取：编号、标题、摘要、影响模块、复现条件、当前状态、报告时间。缺失信息标注“未提供”，不要编造。本阶段只整理，不修改代码。' },
      { name: '分类与排序', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '基于提取结果输出 Markdown 表格：编号、分类（功能/界面/性能/兼容性/数据/其他）、优先级（P0-P3 及判断依据）、置信度（高/中/低及依据）、影响范围、建议处理顺序。最后给出最应先处理的 3 个问题及原因。' },
    ],
  },
  {
    id: 'issue-fix', name: 'Issue 修复', description: '针对指定 issue 定位、修复并自测。',
    stages: [
      { name: '定位与复现', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '根据任务目标中指定的 issue 信息，在工作目录中定位相关代码与配置，尝试复现并记录：现象、触发条件、涉及文件与调用链、初步根因、修复方案与风险。本阶段只排查，不修改代码。' },
      { name: '修复与自测', kind: 'agent', mode: '', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '按上一阶段的根因与方案完成最小修复，保持现有契约与可观察行为不变。修改后运行项目可用的测试或针对性验证，输出：根因、变更文件、验证方式与结果、未覆盖的风险。' },
    ],
  },
  {
    id: 'issue-triage', name: '问题分析', description: '收集线索、定位根因，并给出修复方案。',
    stages: [
      { name: '收集线索', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '结合任务目标与提供的日志、复现步骤和相关文件，收集证据：报错信息、调用链、近期变更、环境差异。列出可验证的假设，并说明每条假设的验证方式。只分析，不修改代码。' },
      { name: '根因与方案', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '逐条验证假设，给出最可能的根因（含证据与已排除项），并提供 1-3 个修复方案，比较改动范围、风险与验证成本，给出推荐方案与回归验证清单。' },
    ],
  },
  {
    id: 'implementation-plan', name: '实施计划', description: '针对特定需求给出可执行的实施计划。',
    stages: [
      { name: '范围与依赖', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '阅读需求与项目背景，明确目标、范围、排除项、依赖（接口、数据、权限、上下游）与关键不确定性，列出必须先确认的问题。只分析，不修改代码。' },
      { name: '实施计划', kind: 'agent', mode: 'ask', engineId: '', advance: 'auto', resourceIds: [], allResources: true, testCommand: null, analyzeTest: false,
        prompt: '输出 Markdown 实施计划：阶段划分与目标、各阶段的改动点（文件/模块）、任务清单与先后顺序、验证与验收方式、风险与回滚方案、需要人工决策的节点。计划需可直接执行，避免泛泛而谈。' },
    ],
  },
]
