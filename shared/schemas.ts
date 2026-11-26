import { z } from 'zod'

import { approvalModes, engineProviders } from './engines.ts'
import { continuationModes } from './continuations.ts'
const modes = ['agent', 'plan', 'ask'] as const
const name = z.string().trim().min(1, '请输入名称').max(150)
const id = z.string().min(1).max(100)
const path = z.string().trim().min(1).max(1000).refine(value => !value.includes('\0'))
const notes = z.string().max(100_000)
const projectContext = z.object({ scope: notes, conventions: notes, constraints: notes, validation: notes }).partial()
const taskContext = z.object({ scope: notes, requirements: notes, constraints: notes, references: notes, output: notes }).partial()
const testCommand = z.object({ program: path, args: z.array(z.string().max(4000).refine(value => !value.includes('\0'))).max(100) })

export const configSchemas = {
  projects: z.object({ name, directory: path, description: notes.default(''), context: projectContext.optional(), testCommand: testCommand.nullable().default(null) }),
  iterations: z.object({ projectId: id, name, description: notes.default('') }),
  resources: z.object({
    projectId: id, iterationId: id.optional(), name, category: name, kind: z.enum(['url', 'text', 'file']),
    value: notes.refine(value => value.trim().length > 0, '请输入资源内容'), prompt: notes,
    fetch: z.boolean(), accountId: z.string(),
  }),
  accounts: z.object({
    name, origin: z.url(), type: z.enum(['bearer', 'basic', 'header']),
    credentialSource: z.enum(['environment', 'saved']).optional(), secretEnv: z.string().max(100).default(''),
    username: z.string().max(200), header: z.string().max(100), usage: notes.default(''),
  }),
  engines: z.object({
    name, provider: z.enum(engineProviders), executable: z.string().trim().max(1000).refine(value => !value.includes('\0')),
    model: z.string().trim().max(200), mode: z.enum(modes), approvalMode: z.enum(approvalModes).optional(),
  }),
  templates: z.object({ name, description: notes, stages: z.array(z.object({
    name, kind: z.enum(['agent', 'test']), prompt: notes, engineId: z.string(), mode: z.enum(['', ...modes]).default(''),
    resourceIds: z.array(id).max(100), allResources: z.boolean(), advance: z.enum(['auto', 'manual']),
    testCommand: testCommand.nullable(), analyzeTest: z.boolean(),
  })).min(1).max(25) }),
}

export const accountWriteSchema = configSchemas.accounts.extend({ password: z.string().min(1).max(4000).optional() })

export const dispatchSchema = z.object({
  requestId: z.uuid(), projectId: id, iterationId: id.optional(), goal: notes.trim().min(1).optional(), title: name.optional(),
  taskType: z.string().trim().max(100).optional(), details: taskContext.optional(), brief: notes.default(''),
  templateId: id.optional(), engineId: z.string().optional(), approvalMode: z.enum(approvalModes).optional(),
  continuation: z.object({ parentId: id, mode: z.enum(continuationModes).default('auto') }).optional(),
}).refine(input => input.goal || input.title, { message: '请输入任务目标' })
