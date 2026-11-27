import { isApiExecutor, terminalStatuses } from '../shared/contracts.ts'
import type { Conversation, ConversationBranch, ConversationTurn, Run, StageSnapshot } from '../shared/contracts.ts'
import { sessionFrom } from '../shared/continuations.ts'
import { sameSessionEngine } from './continuations.ts'
import { object, string } from './rpc.ts'
import type { Store } from './storage.ts'

export function conversationTurns(store: Store, run: Run): ConversationTurn[] {
  const events = store.conversationEvents(run.id)
  const turns: ConversationTurn[] = []
  const recorded = new Map<number, ConversationTurn>()
  for (const event of events) {
    if (event.kind !== 'turn') continue
    const data = object(event.data)
    const stage = run.stages[event.stageIndex]
    const attempt = run.attempts[event.stageIndex]?.find(item => item.number === event.attempt)
    if (!stage || !attempt) continue
    if (event.name === 'started') {
      recorded.set(event.seq, {
        id: `${run.id}-${event.seq}`, runId: run.id, stage: event.stageIndex, stageName: run.templateName ? stage.name : undefined,
        attempt: event.attempt, seq: event.seq, input: string(data.text), at: event.at,
        status: attempt.status === 'running' && event.stageIndex === run.stageIndex ? run.status : attempt.status,
      })
      continue
    }
    const turn = recorded.get(Number(data.turn))
    if (!turn) continue
    if (event.name === 'supplement') (turn.supplements ??= []).push(string(data.text))
    if (event.name === 'finished') {
      turn.end = event.seq
      turn.status = data.status === 'succeeded' ? 'succeeded' : data.status === 'failed' ? 'failed' : attempt.status
      turn.reply = string(data.text)
      turn.nativeId = data.status === 'succeeded' ? string(data.nativeId) || undefined : undefined
    }
  }
  for (const [stageIndex, stage] of run.stages.entries()) {
    const attempt = run.attempts[stageIndex]?.at(-1)
    if (!attempt || (stage.kind !== 'agent' && !stage.analyzeTest)) continue
    const engine = stage.engine && store.getExecutor(stage.engine.id)
    const allowFork = !run.templateName && run.stages.length === 1 && !!attempt.sessionId && !run.archivedAt
      && (run.status === 'succeeded' || run.status === 'interrupted') && !!engine && !isApiExecutor(engine) && engine.provider === 'codex'
    const evidence = { files: attempt.fileChanges?.total, test: attempt.test && { code: attempt.test.code, ms: attempt.test.ms } }
    const current = [...recorded.values()].filter(turn => turn.stage === stageIndex && turn.attempt === attempt.number)
    if (current.length) {
      for (const turn of current) {
        turn.canFork = !!turn.nativeId && allowFork
        turns.push(turn)
      }
      Object.assign(current.at(-1)!, evidence)
      continue
    }
    const legacyEvents = allowFork ? events.filter(event => event.kind === 'native' && event.name === 'turn/completed'
      && event.stageIndex === stageIndex && event.attempt === attempt.number) : []
    const legacyTurn = legacyEvents.length === 1 ? object(object(legacyEvents[0].data).turn) : {}
    const nativeId = legacyTurn.status === 'completed' ? string(legacyTurn.id) || undefined : undefined
    turns.push({
      id: `${run.id}-stage-${stageIndex}`, runId: run.id, stage: stageIndex, stageName: run.templateName ? stage.name : undefined,
      attempt: attempt.number, input: run.goal || run.title, reply: attempt.output,
      at: attempt.startedAt, status: attempt.status === 'running' && stageIndex === run.stageIndex ? run.status : attempt.status,
      legacy: terminalStatuses.has(run.status), ...evidence, ...(nativeId && { nativeId, canFork: true, seq: legacyEvents[0].seq }),
    })
  }
  if (!turns.length) turns.push({
    id: run.id, runId: run.id, stage: run.stageIndex, attempt: 0, input: run.goal || run.title,
    at: run.createdAt, status: run.status, legacy: terminalStatuses.has(run.status),
  })
  return turns
}

export function conversation(store: Store, id: string): Conversation | undefined {
  const group = store.relatedRuns(id)
  if (!group) return undefined
  const runs = new Map(group.runs.flatMap(summary => {
    const run = store.getRun(summary.id)
    return run && !run.archivedAt ? [[run.id, run] as const] : []
  }))
  const branches = new Map<string, ConversationBranch>()
  const branchIds = new Map<string, string>()
  const turnsByRun = new Map([...runs].map(([runId, run]) => [runId, conversationTurns(store, run)]))
  function place(run: Run): ConversationBranch {
    const existing = branchIds.get(run.id)
    if (existing) return branches.get(existing)!
    const parent = run.continuation && runs.get(run.continuation.parentId)
    const prior = parent && place(parent)
    const sourceAttempt = parent && sessionFrom(parent)?.attempt
    const attempt = run.attempts.flat().findLast(item => item.contextMode)
    const match = attempt?.contextMode === 'resume' && !!attempt.sessionId && attempt.sessionId === sourceAttempt?.sessionId
    const pending = !attempt && !terminalStatuses.has(run.status) && prior && ['resume', 'auto'].includes(run.continuation!.mode)
    if (prior && (match || pending)) {
      branchIds.set(run.id, prior.id)
      return prior
    }
    const priorTurns = parent && turnsByRun.get(parent.id)
    const fork = run.continuation?.mode === 'fork'
    const sourceTurn = fork ? priorTurns?.find(turn => turn.seq === run.continuation?.turn) : priorTurns?.at(-1)
    const kind = attempt?.contextMode === 'fork' || (fork && !terminalStatuses.has(run.status)) ? 'fork'
      : attempt?.contextMode === 'handoff' || run.continuation?.mode === 'handoff' ? 'handoff' : 'unknown'
    const branch: ConversationBranch = { id: run.id, title: run.title, latestRunId: run.id, turns: [],
      ...(prior && { source: { branchId: prior.id, turnId: sourceTurn?.id, kind } }),
    }
    branches.set(run.id, branch)
    branchIds.set(run.id, branch.id)
    return branch
  }

  const inserted = new Set<string>()
  function append(run: Run) {
    if (inserted.has(run.id)) return
    const parent = run.continuation && runs.get(run.continuation.parentId)
    if (parent) append(parent)
    const branch = place(run)
    branch.turns.push(...turnsByRun.get(run.id)!)
    branch.latestRunId = run.id
    inserted.add(run.id)
  }
  for (const run of [...runs.values()].reverse()) append(run)
  return { id: group.source.id, title: group.source.title, activeBranchId: branchIds.get(id) ?? group.source.id, branches: [...branches.values()] }
}

export function forkSource(store: Store, parent: Run, directory: string, stage: StageSnapshot, seq: number | undefined) {
  const turn = conversationTurns(store, parent).find(item => item.seq === seq && item.canFork && item.nativeId)
  if (!turn || !stage.engine || parent.project.directory !== directory) return
  const sourceStage = parent.stages[turn.stage]
  const attempt = parent.attempts[turn.stage]?.find(item => item.number === turn.attempt)
  if (!sourceStage.engine || !attempt?.sessionId || !sameSessionEngine(sourceStage.engine, stage.engine)) return
  return { index: turn.stage, stage: sourceStage, engine: sourceStage.engine, attempt, nativeId: turn.nativeId! }
}
