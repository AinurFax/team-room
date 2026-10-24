import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Config, Pending } from '../types'
import { addMemory, addTaskEvent, hostName, reload, saveCard, snapshotOf, syncNow } from './io'
import {
  EMPTY_INJECTED,
  SUMMARY_SYSTEM,
  baseName,
  buildContext,
  currentTaskOf,
  fallbackSummary,
  findRoom,
  isActive,
  moveToApply,
  newId,
  parseSummary,
  reduceTasks,
  relativeTo,
  summaryPrompt,
} from './model'
import { drawPane } from './pane'
import { PANE, chatConfig, configFor, enter, joinSession, leaveSession, loadSettings, openPane, roomFor, shownConfig } from './session'
import { DRAFT_INITIAL, TURN_INITIAL } from './state'

const profileAtom = atom({ plugin: 'team-room', key: 'profile' } as const, null)
const roomsAtom = atom({ plugin: 'team-room', key: 'rooms' } as const, [])
const sessionIdAtom = atom({ plugin: 'team-room', key: 'sessionId' } as const, '')
const roomAtom = atom({ plugin: 'team-room', key: 'room' } as const, '')
const draftAtom = atom({ plugin: 'team-room', key: 'draft' } as const, DRAFT_INITIAL)
const cardAtom = atom({ plugin: 'team-room', key: 'card' } as const, null)
const turnAtom = atom({ plugin: 'team-room', key: 'turn' } as const, TURN_INITIAL)
const injectedAtom = atom({ plugin: 'team-room', key: 'injected' } as const, EMPTY_INJECTED)
const pendingAtom = atom({ plugin: 'team-room', key: 'pending' } as const, null)

type Engine = EngineInterface

const SYNC_EVERY_MS = 30_000
const BEAT_MS = 2 * 60_000
const FILE_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }
const SKIPPED_ORIGINS = new Set(['plugin', 'task-notification', 'scheduled-trigger'])
const NOT_JOINED = 'Этот чат не подключён к Team Room, ничего не записано. Подключить: /teamroom join'

let isSummarizing = false

async function tick($: Engine): Promise<void> {
  void runPending($)
  const own = await chatConfig($)
  if (own !== null) {
    await syncNow($, own, 'full')
  }
  const shown = await shownConfig($)
  if (shown !== null && shown.roomId !== own?.roomId && (await $.ui.panes()).some(pane => pane.id === PANE)) {
    await syncNow($, shown, 'pull')
  }
}

async function tasksOf($: Engine, cfg: Config) {
  const tasks = reduceTasks((await snapshotOf($, cfg.roomId)).taskEvents)

  return { tasks, current: currentTaskOf(tasks, await read($, sessionIdAtom)) }
}

// A finished turn's card line, memory entry and task move. The turn waits in
// `pending` until this is done, so a reload in between does not lose it.
async function runPending($: Engine): Promise<void> {
  if (isSummarizing) {
    return
  }
  const job = await read($, pendingAtom)
  if (job === null) {
    return
  }
  isSummarizing = true
  try {
    await summarize($, job)
  } finally {
    await update($, pendingAtom, was => (was !== null && was.at === job.at ? null : was))
    isSummarizing = false
  }
}

async function summarize($: Engine, job: Pending): Promise<void> {
  const cfg = await configFor($, job.roomId)
  const was = await read($, cardAtom)
  if (cfg === null || was === null || was.id !== job.sessionId) {
    return
  }
  const { tasks, current } = await tasksOf($, cfg)
  const fallback = fallbackSummary(job.prompt, job.answer)
  let summary = fallback
  if (job.answer.trim() !== '') {
    try {
      const reply = await $.model.complete({
        model: 'haiku',
        system: SUMMARY_SYSTEM,
        prompt: summaryPrompt(was, job.prompt, job.answer, job.files, job.hasToolError, {
          current,
          open: tasks.filter(isActive),
          toolTaskIds: job.toolTaskIds,
          hasToolStart: job.hasToolStart,
        }),
        maxTokens: 600,
        effort: 'low',
        timeoutMs: 30_000,
      })
      summary = (reply.isAnswered ? parseSummary(reply.text) : undefined) ?? fallback
    } catch {
      summary = fallback
    }
  }
  const now = await $.clock.now()
  const isBroken = job.reason !== 'answer'
  const card: Card = {
    ...was,
    title: was.title === '' || was.isTitleGuess === true ? summary.title || was.title : was.title,
    isTitleGuess: was.title === '' || was.isTitleGuess === true ? summary.title === '' : false,
    gist: summary.gist || was.gist,
    status: isBroken || summary.needsAttention ? 'attention' : 'done',
    done: summary.done !== '' ? [...was.done, { at: now, text: summary.done }].slice(-100) : was.done,
    model: await $.session.model(),
    updatedAt: now,
  }
  await saveCard($, cfg, card)
  if (summary.done !== '') {
    await addMemory($, cfg, job.sessionId, {
      text: summary.done,
      kind: 'auto',
      ...(job.files.length > 0 ? { files: job.files.slice(0, 20) } : {}),
    })
  }
  const move = moveToApply(summary.task, tasks, current, job)
  if (move.op === 'start') {
    await addTaskEvent($, cfg, job.sessionId, {
      op: 'start', taskId: newId(), title: move.title, context: move.context, sessionId: job.sessionId, byClaude: true,
    })
  } else if (move.op === 'update' && move.context !== '') {
    await addTaskEvent($, cfg, job.sessionId, { op: 'update', taskId: move.taskId, context: move.context, sessionId: job.sessionId, byClaude: true })
  } else if (move.op === 'done') {
    await addTaskEvent($, cfg, job.sessionId, {
      op: 'done', taskId: move.taskId, result: move.result || summary.done, files: job.files.slice(0, 30), sessionId: job.sessionId, byClaude: true,
    })
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

async function noteToolTask($: Engine, taskId: string, isStart: boolean): Promise<void> {
  await update($, turnAtom, t => ({
    ...t,
    toolTaskIds: [...new Set([...(t.toolTaskIds ?? []), taskId])],
    hasToolStart: (t.hasToolStart ?? false) || isStart,
  }))
}

// The model's own task moves through the team_task tool.
async function taskTool($: Engine, args: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  const cfg = await chatConfig($)
  if (cfg === null) {
    return { deny: NOT_JOINED }
  }
  const sid = await read($, sessionIdAtom)
  const { tasks, current } = await tasksOf($, cfg)
  const op = text(args.op, 10)
  const taskId = text(args.taskId, 40)
  const context = text(args.context, 2000)
  const named = taskId === '' ? undefined : tasks.find(task => task.id === taskId)

  if (op === 'start') {
    if (named !== undefined && isActive(named)) {
      await addTaskEvent($, cfg, sid, { op: 'take', taskId: named.id, sessionId: sid, byClaude: true, ...(context ? { context } : {}) })
      await noteToolTask($, named.id, false)

      return { result: `Взял задачу [${named.id}] «${named.title}».` }
    }
    const title = text(args.title, 160)
    if (title === '') {
      return { deny: 'Для op=start нужен title (или taskId задачи из списка).' }
    }
    const id = newId()
    await addTaskEvent($, cfg, sid, { op: 'start', taskId: id, title, context, sessionId: sid, byClaude: true })
    await noteToolTask($, id, true)

    return { result: `Начал задачу [${id}] «${title}». Напарник видит её на доске.` }
  }
  if (op !== 'update' && op !== 'done' && op !== 'drop') {
    return { deny: 'op должен быть start, update, done или drop.' }
  }
  const target = named ?? (taskId === '' ? current : undefined)
  if (target === undefined) {
    return { deny: taskId === '' ? 'У этого чата нет текущей задачи: сначала op=start.' : `Нет задачи ${taskId}.` }
  }
  if (op === 'update') {
    if (context === '') {
      return { deny: 'Для op=update нужен context.' }
    }
    await addTaskEvent($, cfg, sid, { op: 'update', taskId: target.id, context, sessionId: sid, byClaude: true })
    await noteToolTask($, target.id, false)

    return { result: `Дописал контекст задачи [${target.id}] «${target.title}».` }
  }
  if (op === 'drop') {
    await addTaskEvent($, cfg, sid, { op: 'drop', taskId: target.id, sessionId: sid, byClaude: true })
    await noteToolTask($, target.id, false)

    return { result: `Убрал задачу [${target.id}] «${target.title}».` }
  }
  const given = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : []
  const files = given.length > 0 ? given : (await read($, turnAtom)).files
  await addTaskEvent($, cfg, sid, {
    op: 'done', taskId: target.id, result: text(args.result, 2000), files: files.slice(0, 30), sessionId: sid, byClaude: true,
  })
  await noteToolTask($, target.id, false)

  return { result: `Задача [${target.id}] «${target.title}» закрыта.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const sid = await $.session.id()
    await update($, sessionIdAtom, () => sid)
    await $.command.register({ name: 'teamroom', description: 'Team Room: открыть панель (join <комната> — подключить чат, leave — отключить)', argumentHint: '[join <комната>|leave]' })
    await $.command.register({ name: 'remember', description: 'Team Room: записать в общую память комнаты', argumentHint: '<текст>' })
    await $.command.register({ name: 'task', description: 'Team Room: добавить общую задачу', argumentHint: '<текст>' })

    const { profile, rooms } = await loadSettings($)
    if (profile === null) {
      const computer = await hostName($)
      await update($, draftAtom, d => ({ ...d, computer: d.computer || computer }))

      return next(e)
    }
    const room = await roomFor($, sid, [e.cwd, await $.session.root()])
    if (room !== undefined) {
      const cfg = await configFor($, room.id)
      if (cfg !== null) {
        await enter($, cfg)
        if (e.surface !== 'terminal') {
          void openPane($)
        }
      }
    } else {
      await update($, roomAtom, () => '')
    }
    const shown = await shownConfig($)
    for (const one of rooms.filter(r => r.id === room?.id || r.id === shown?.roomId)) {
      await reload($, one)
    }
    $.clock.every(SYNC_EVERY_MS, () => void tick($))
    $.clock.after(1_000, () => void tick($))

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    if (e.surface === 'desktop' && (await read($, roomAtom)) !== '') {
      void openPane($)
    }

    return next(e)
  })

  on('command.run', { command: 'teamroom' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = verb.toLowerCase()
    if (arg === 'leave') {
      await leaveSession($)

      return { text: 'Этот чат отключён от Team Room.' }
    }
    await openPane($)
    if ((await read($, profileAtom)) === null) {
      return { text: 'Team Room: заполни настройки в панели.' }
    }
    if (arg === 'join') {
      const rooms = await read($, roomsAtom)
      const query = rest.join(' ')
      const shown = await shownConfig($)
      const room = query !== '' ? findRoom(rooms, query) : rooms.find(r => r.id === shown?.roomId) ?? (rooms.length === 1 ? rooms[0] : undefined)
      if (room === undefined) {
        return { text: rooms.length === 0 ? 'Комнат пока нет: создай или войди во вкладке «Комнаты».' : `Какая комната? ${rooms.map(r => r.title).join(', ')}` }
      }
      await joinSession($, room.id)

      return { text: `Этот чат подключён к комнате «${room.title}».` }
    }

    return { text: 'Team Room открыт.' }
  })

  on('command.run', { command: 'remember' }, async ($, e) => {
    const cfg = await chatConfig($)
    const said = e.args.trim()
    if (cfg === null) {
      return { text: 'Этот чат не в Team Room. Подключи: /teamroom join' }
    }
    if (said === '') {
      return { text: 'Напиши, что запомнить: /remember <текст>' }
    }
    await addMemory($, cfg, await read($, sessionIdAtom), { text: said, kind: 'manual' })

    return { text: `Записал в общую память комнаты «${cfg.roomTitle}».` }
  })

  on('command.run', { command: 'task' }, async ($, e) => {
    const cfg = await chatConfig($)
    const title = e.args.trim()
    if (cfg === null) {
      return { text: 'Этот чат не в Team Room. Подключи: /teamroom join' }
    }
    if (title === '') {
      return { text: 'Напиши задачу: /task <текст>' }
    }
    await addTaskEvent($, cfg, await read($, sessionIdAtom), { op: 'add', taskId: newId(), title })

    return { text: `Задача добавлена: ${title}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const cfg = await chatConfig($)
    const isOwnWork = e.command === undefined && e.isMeta !== true && !SKIPPED_ORIGINS.has(e.origin.kind)
    if (cfg === null || !isOwnWork) {
      return next(e)
    }
    const sid = await read($, sessionIdAtom)
    const now = await $.clock.now()
    const root = await $.session.root()
    // The host may add <system-reminder> and similar blocks to the typed text.
    const said = e.text.replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/\s+/g, ' ').trim()
    await update($, turnAtom, () => ({ ...TURN_INITIAL, prompt: said.slice(0, 500), startedAt: now, isRunning: true }))

    const was = await read($, cardAtom)
    const guess = said.split(' ').slice(0, 6).join(' ').slice(0, 80)
    const card: Card = was ?? {
      id: sid,
      personId: cfg.personId,
      name: cfg.name,
      computer: cfg.computer,
      title: guess,
      isTitleGuess: true,
      gist: '',
      status: 'working',
      done: [],
      note: '',
      model: await $.session.model(),
      project: baseName(root),
      startedAt: now,
      updatedAt: now,
      archived: false,
    }
    await saveCard($, cfg, { ...card, status: 'working', updatedAt: now })

    const built = buildContext(await snapshotOf($, cfg.roomId), { personId: cfg.personId, sessionId: sid }, await read($, injectedAtom))
    await update($, injectedAtom, () => built.injected)

    return next(built.text === undefined ? e : { ...e, context: [...(e.context ?? []), built.text] })
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: 'mcp__team-room__team_task' }, () => ({ decision: 'allow', reason: 'Team Room: доска задач команды' }))
  on('tool.check', { tool: 'mcp__team-room__team_remember' }, () => ({ decision: 'allow', reason: 'Team Room: общая память команды' }))

  on('tool.call', { tool: 'mcp__team-room__team_task' }, async ($, e) => taskTool($, e as unknown as Record<string, unknown>))

  on('tool.call', { tool: 'mcp__team-room__team_remember' }, async ($, e) => {
    const cfg = await chatConfig($)
    if (cfg === null) {
      return { deny: NOT_JOINED }
    }
    const said = text((e as unknown as Record<string, unknown>).text, 1000)
    if (said === '') {
      return { deny: 'Нужен text.' }
    }
    await addMemory($, cfg, await read($, sessionIdAtom), { text: said, kind: 'auto' })

    return { result: 'Записал в общую память команды.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const field = FILE_TOOLS[String(e.tool)]
    const isTracked = (await read($, roomAtom)) !== '' && (await read($, turnAtom)).isRunning
    if (!isTracked) {
      return ran
    }
    const input = e as unknown as Record<string, unknown>
    const path = field === undefined ? undefined : input[field]
    const root = await $.session.root()
    if (typeof path === 'string' || ran.isError === true) {
      await update($, turnAtom, t => ({
        ...t,
        files: typeof path === 'string' ? [...new Set([...t.files, relativeTo(path, root)])] : t.files,
        hasToolError: t.hasToolError || ran.isError === true,
      }))
    }
    const cfg = await chatConfig($)
    const card = await read($, cardAtom)
    const now = await $.clock.now()
    if (cfg !== null && card !== null && now - card.updatedAt > BEAT_MS) {
      await saveCard($, cfg, { ...card, status: 'working', updatedAt: now })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const turn = await read($, turnAtom)
    const roomId = await read($, roomAtom)
    if (e.agentId !== undefined || !turn.isRunning || roomId === '') {
      return done
    }
    await update($, turnAtom, t => ({ ...t, isRunning: false }))
    const job: Pending = {
      sessionId: await read($, sessionIdAtom),
      roomId,
      prompt: turn.prompt,
      answer: e.answer,
      reason: e.reason,
      files: turn.files,
      hasToolError: turn.hasToolError,
      toolTaskIds: turn.toolTaskIds ?? [],
      hasToolStart: turn.hasToolStart ?? false,
      at: await $.clock.now(),
    }
    await update($, pendingAtom, () => job)
    $.clock.after(10, () => void runPending($))

    return done
  })

  on('ui.render', { component: 'Pane', requestId: 'team-room' }, async ($, e) => drawPane($, e))
}
