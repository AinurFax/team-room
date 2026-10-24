// Pure helpers: no `$`, no I/O. Everything here is about the shared data.

import type {
  Card,
  CardStatus,
  Config,
  Injected,
  MemoryEntry,
  Profile,
  RateLimit,
  Room,
  Snapshot,
  Task,
  TaskEvent,
} from '../types'

export const DEFAULT_REPO = 'https://github.com/AinurFax/calories-team.git'
export const BRANCH = 'teamroom'
export const PLUGIN = 'team-room'
export const TASK_TOOL_NAME = 'team_task'
export const REMEMBER_TOOL_NAME = 'team_remember'
export const TASK_TOOL = `mcp__${PLUGIN}__${TASK_TOOL_NAME}`
export const REMEMBER_TOOL = `mcp__${PLUGIN}__${REMEMBER_TOOL_NAME}`

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const STALE_MS = 10 * MINUTE
export const BOARD_DAYS = 14

export const EMPTY_SNAPSHOT: Snapshot = {
  people: [],
  cards: [],
  memory: [],
  taskEvents: [],
  marks: {},
  loadedAt: 0,
}

export const EMPTY_INJECTED: Injected = {
  memory: [],
  taskEvents: [],
  cards: {},
  count: 0,
}

export function newId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)

  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function join(...parts: string[]): string {
  return parts
    .filter(part => part !== '')
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')
}

export function repoNameOf(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? 'team'

  return last.replace(/\.git$/, '') || 'team'
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

// A room's title as a repository name: latin, lowercase, digits and hyphens.
export function slugOf(title: string): string {
  const latin = [...title.toLowerCase()].map(ch => TRANSLIT[ch] ?? ch).join('')

  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export function membersOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(nick => nick.replace(/^@/, '').trim()).filter(nick => /^[A-Za-z0-9-]+$/.test(nick)))]
}

function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function isInside(path: string, dir: string): boolean {
  if (dir.trim() === '') {
    return false
  }
  const p = normPath(path)
  const d = normPath(dir.trim())

  return p === d || p.startsWith(d + '/')
}

// The room whose project folder holds one of the chat's folders, the deepest first.
export function roomByFolder(rooms: readonly Room[], dirs: readonly string[]): Room | undefined {
  return [...rooms]
    .filter(room => room.projectDir.trim() !== '' && dirs.some(dir => isInside(dir, room.projectDir)))
    .sort((a, b) => normPath(b.projectDir).length - normPath(a.projectDir).length)[0]
}

export function findRoom(rooms: readonly Room[], query: string): Room | undefined {
  const q = query.trim().toLowerCase()
  if (q === '') {
    return undefined
  }

  return (
    rooms.find(room => room.id.toLowerCase() === q || room.title.toLowerCase() === q) ??
    rooms.find(room => room.title.toLowerCase().startsWith(q) || room.id.toLowerCase().startsWith(q))
  )
}

export function configOf(profile: Profile, room: Room): Config {
  return {
    ...profile,
    roomId: room.id,
    roomTitle: room.title,
    repoUrl: room.repoUrl,
    repoName: room.repoName,
    projectDir: room.projectDir,
    cloneDir: room.cloneDir,
  }
}

export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

export function relativeTo(path: string, root: string): string {
  return isInside(path, root) ? path.replace(/\\/g, '/').slice(root.replace(/[\\/]+$/, '').length + 1) : path
}

export function ago(ms: number): string {
  if (ms < MINUTE) {
    return 'только что'
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)} мин назад`
  }
  if (ms < DAY) {
    return `${Math.floor(ms / HOUR)} ч назад`
  }

  return `${Math.floor(ms / DAY)} дн назад`
}

export function agoSeconds(ms: number): string {
  return ms < MINUTE ? `${Math.max(0, Math.round(ms / 1000))} с назад` : ago(ms)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function stamp(at: number): string {
  const d = new Date(at)

  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function limitsOf(raw: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): RateLimit[] {
  const label = (kind: string) => (kind === 'seven_day' ? 'неделя' : kind === 'five_hour' ? '5 ч' : kind)
  const order = (kind: string) => (kind === 'seven_day' ? 0 : kind === 'five_hour' ? 1 : 2)

  return [...raw]
    .sort((a, b) => order(a.kind) - order(b.kind))
    .map(one => ({ label: label(one.kind), percent: Math.round(one.percentUsed), resetsAt: one.resetsAt }))
}

export function limitsChanged(before: readonly RateLimit[], after: readonly RateLimit[]): boolean {
  if (before.length !== after.length) {
    return true
  }

  return after.some(one => {
    const was = before.find(b => b.label === one.label)

    return was === undefined || Math.abs(was.percent - one.percent) >= 1
  })
}

export function formatLimits(limits: readonly RateLimit[]): string {
  return limits.length === 0 ? 'нет данных' : limits.map(one => `${one.label} ${one.percent}%`).join(' · ')
}

function withSession(list: readonly string[], sid: string | undefined): string[] {
  return sid === undefined || sid === '' || list.includes(sid) ? [...list] : [...list, sid]
}

// Every person's task journal folded into the tasks as they stand now.
export function reduceTasks(events: readonly TaskEvent[]): Task[] {
  const tasks = new Map<string, Task>()
  // Stable: events of the same millisecond keep the order they were written in.
  const sorted = [...events].sort((a, b) => a.at - b.at)

  for (const ev of sorted) {
    const task = tasks.get(ev.taskId)
    const isClaude = ev.byClaude === true

    if (task === undefined) {
      if (ev.op === 'add' || ev.op === 'start') {
        const isTaken = ev.op === 'start'
        tasks.set(ev.taskId, {
          id: ev.taskId,
          title: ev.title ?? '',
          context: ev.context ?? '',
          result: '',
          status: isTaken ? 'taken' : 'open',
          createdById: ev.personId,
          createdBy: ev.name,
          createdAt: ev.at,
          updatedAt: ev.at,
          ...(isTaken ? { takenById: ev.personId, takenBy: ev.name } : {}),
          byClaude: isClaude,
          files: [],
          sessions: withSession([], ev.sessionId),
        })
      }
      continue
    }
    const base = { ...task, updatedAt: ev.at, sessions: withSession(task.sessions, ev.sessionId) }

    if (ev.op === 'add') {
      continue
    } else if (ev.op === 'take' || ev.op === 'start') {
      tasks.set(ev.taskId, {
        ...base,
        status: task.status === 'done' ? 'done' : 'taken',
        takenById: ev.personId,
        takenBy: ev.name,
        context: ev.context ? (task.context ? `${task.context}\n${ev.context}` : ev.context) : task.context,
      })
    } else if (ev.op === 'update') {
      tasks.set(ev.taskId, {
        ...base,
        context: ev.context ? (task.context ? `${task.context}\n${ev.context}` : ev.context) : task.context,
      })
    } else if (ev.op === 'edit') {
      tasks.set(ev.taskId, {
        ...base,
        title: ev.title?.trim() ? ev.title.trim() : task.title,
        context: ev.context ?? task.context,
      })
    } else if (ev.op === 'done') {
      tasks.set(ev.taskId, {
        ...base,
        status: 'done',
        doneAt: ev.at,
        result: ev.result ?? task.result,
        files: [...new Set([...task.files, ...(ev.files ?? [])])],
        takenById: task.takenById ?? ev.personId,
        takenBy: task.takenBy ?? ev.name,
      })
    } else if (ev.op === 'reopen') {
      tasks.set(ev.taskId, { ...base, status: task.takenById === undefined ? 'open' : 'taken', doneAt: undefined })
    } else if (ev.op === 'drop') {
      tasks.set(ev.taskId, { ...base, status: 'dropped' })
    }
  }

  return [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export function isActive(task: Task): boolean {
  return task.status === 'open' || task.status === 'taken'
}

// The task a chat is on: the newest active one it took part in.
export function currentTaskOf(tasks: readonly Task[], sessionId: string): Task | undefined {
  return [...tasks]
    .filter(task => isActive(task) && task.sessions.includes(sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export type BoardCard = Card & { shown: CardStatus; isStale: boolean; isMine: boolean; task?: Task }

export function boardOf(
  snap: Snapshot,
  me: { personId: string; name: string },
  now: number,
  isMineOnly: boolean,
): Record<CardStatus, BoardCard[]> {
  const columns: Record<CardStatus, BoardCard[]> = { working: [], attention: [], done: [] }
  const myName = me.name.trim().toLowerCase()
  const tasks = reduceTasks(snap.taskEvents)

  for (const card of snap.cards) {
    const marks = snap.marks[card.personId]
    const isArchived = card.archived || (marks?.archived.includes(card.id) ?? false)
    const isOld = now - card.updatedAt > BOARD_DAYS * DAY
    const isMine = card.personId === me.personId || (myName !== '' && card.name.trim().toLowerCase() === myName)

    if (isArchived || isOld || (isMineOnly && !isMine)) {
      continue
    }
    const isStale = card.status === 'working' && now - card.updatedAt > STALE_MS
    const shown: CardStatus = isStale ? 'attention' : card.status
    const note = marks?.notes[card.id] ?? card.note
    const task = currentTaskOf(tasks, card.id)

    columns[shown].push({ ...card, note, shown, isStale, isMine, ...(task === undefined ? {} : { task }) })
  }
  for (const list of Object.values(columns)) {
    list.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  return columns
}

export const CONTEXT_HEADER =
  'Team Room — общая память проекта. Не повторяй то, что уже сделал напарник; задачу, которую взял другой, не бери без согласования.'

export const TASK_RULE =
  'Задачи ведёшь сам инструментом team_task: начал новую работу — start с контекстом, закончил — done с результатом. Человек их не пишет. Важную договорённость запиши через team_remember.'

function memoryLine(entry: MemoryEntry): string {
  const files = entry.files !== undefined && entry.files.length > 0 ? ` (файлы: ${entry.files.join(', ')})` : ''

  return `- ${stamp(entry.at)} · ${entry.name}: ${entry.text}${files}`
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function taskLine(task: Task): string {
  const who = task.takenBy === undefined ? 'свободна' : `взял ${task.takenBy}`
  const context = task.context.trim() !== '' ? ` — ${short(task.context, 140)}` : ''

  return `- [${task.id}] «${task.title}» — ${who}${context}`
}

const MAX_SEEN = 2000

// What to hand Claude beside a prompt: the whole digest on the first prompt,
// then only what is new since the last one; undefined when nothing is.
export function buildContext(
  snap: Snapshot,
  me: { personId: string; sessionId: string },
  injected: Injected,
): { text: string | undefined; injected: Injected } {
  const isFirst = injected.count === 0
  const seenMemory = new Set(injected.memory)
  const seenTasks = new Set(injected.taskEvents)
  const visible = snap.memory
    .filter(entry => !(entry.sessionId === me.sessionId && entry.personId === me.personId && entry.kind === 'auto'))
    .sort((a, b) => a.at - b.at)
  const newMemory = isFirst ? visible.slice(-30) : visible.filter(entry => !seenMemory.has(entry.id))
  const hasNewTasks = snap.taskEvents.some(ev => !seenTasks.has(ev.id))
  const tasks = reduceTasks(snap.taskEvents)
  const openTasks = tasks.filter(isActive)
  const current = currentTaskOf(tasks, me.sessionId)
  const currentKey = current === undefined ? '' : `${current.id}:${current.title}`
  const partnerWorking = snap.cards.filter(
    card => card.personId !== me.personId && card.status === 'working' && !card.archived,
  )
  const newPartner = partnerWorking.filter(card => isFirst || injected.cards[card.id] !== card.gist)

  const parts: string[] = []
  if (isFirst) {
    parts.push(TASK_RULE)
  }
  if (newMemory.length > 0) {
    parts.push(`${isFirst ? 'Память проекта (последнее):' : 'Новое в памяти:'}\n${newMemory.map(memoryLine).join('\n')}`)
  }
  if ((isFirst || hasNewTasks) && openTasks.length > 0) {
    parts.push(`Открытые задачи:\n${openTasks.slice(-30).map(taskLine).join('\n')}`)
  }
  if (isFirst || currentKey !== (injected.currentTask ?? '')) {
    parts.push(
      current === undefined
        ? 'У этого чата пока нет задачи.'
        : `Текущая задача этого чата: [${current.id}] «${current.title}»`,
    )
  }
  if (newPartner.length > 0) {
    parts.push(
      `Сейчас в работе у напарника:\n${newPartner
        .map(card => `- ${card.name} · «${card.title || 'без названия'}»${card.gist ? `: ${card.gist}` : ''}`)
        .join('\n')}`,
    )
  }

  const cards = { ...injected.cards }
  for (const card of partnerWorking) {
    cards[card.id] = card.gist
  }
  const next: Injected = {
    memory: [...injected.memory, ...visible.map(entry => entry.id).filter(id => !seenMemory.has(id))].slice(-MAX_SEEN),
    taskEvents: [...injected.taskEvents, ...snap.taskEvents.map(ev => ev.id).filter(id => !seenTasks.has(id))].slice(-MAX_SEEN),
    cards,
    count: injected.count + 1,
    currentTask: currentKey,
  }

  return { text: parts.length > 0 ? `${CONTEXT_HEADER}\n\n${parts.join('\n\n')}` : undefined, injected: next }
}

export type TaskMove = { op: 'none' | 'start' | 'update' | 'done'; taskId: string; title: string; context: string; result: string }

export type Summary = { title: string; gist: string; done: string; needsAttention: boolean; task: TaskMove }

export const NO_MOVE: TaskMove = { op: 'none', taskId: '', title: '', context: '', result: '' }

export const SUMMARY_SYSTEM = `Ты ведёшь доску задач команды. По одному ходу работы ассистента верни только JSON без пояснений:
{"title": "...", "gist": "...", "done": "...", "needsAttention": false, "task": {"op": "none", "taskId": "", "title": "", "context": "", "result": ""}}
title — название сессии по-русски, до 6 слов.
gist — о чём вся сессия, до 20 слов.
done — что сделано за этот ход, до 20 слов, в прошедшем времени; "" если ход ничего не изменил.
needsAttention — true, если ассистент задал вопрос, ждёт решения человека или упёрся в ошибку.
task — что сделать с задачами команды:
- "start": ассистент взялся за новую работу, которой нет в списке задач; title до 8 слов, context — зачем, что известно, принятые решения (до 60 слов).
- "update": продвинулся по задаче из списка (taskId), context — что нового (до 40 слов).
- "done": закончил задачу из списка (taskId), result — что получилось (до 40 слов).
- "none": иначе, а также если ассистент уже сам вызвал team_task в этом ходу для этой работы.`

export function summaryPrompt(
  card: Card | null,
  prompt: string,
  answer: string,
  files: readonly string[],
  hasToolError: boolean,
  tasks: { current: Task | undefined; open: readonly Task[]; toolTaskIds: readonly string[]; hasToolStart: boolean },
): string {
  const touched = tasks.toolTaskIds.length > 0 || tasks.hasToolStart
    ? `Ассистент сам вызвал team_task в этом ходу${tasks.toolTaskIds.length > 0 ? ` для задач: ${tasks.toolTaskIds.join(', ')}` : ''}${tasks.hasToolStart ? ' (начал новую задачу)' : ''}.`
    : 'Ассистент не вызывал team_task в этом ходу.'

  return [
    `Текущее название: ${card?.title || '(нет)'}`,
    `Текущая суть: ${card?.gist || '(нет)'}`,
    `Текущая задача чата: ${tasks.current === undefined ? '(нет)' : `[${tasks.current.id}] «${tasks.current.title}»`}`,
    `Открытые задачи команды:\n${tasks.open.length === 0 ? '(нет)' : tasks.open.slice(-20).map(taskLine).join('\n')}`,
    touched,
    `Запрос человека: ${prompt.slice(0, 500)}`,
    `Изменённые файлы: ${files.length > 0 ? files.join(', ') : 'нет'}`,
    hasToolError ? 'Были ошибки инструментов.' : '',
    `Ответ ассистента:\n${answer.slice(0, 3000)}`,
  ]
    .filter(line => line !== '')
    .join('\n')
}

function clip(text: unknown, max: number): string {
  return typeof text === 'string' ? text.trim().slice(0, max) : ''
}

function moveOf(raw: unknown): TaskMove {
  if (typeof raw !== 'object' || raw === null) {
    return NO_MOVE
  }
  const t = raw as Record<string, unknown>
  const op = t.op === 'start' || t.op === 'update' || t.op === 'done' ? t.op : 'none'

  return { op, taskId: clip(t.taskId, 40), title: clip(t.title, 120), context: clip(t.context, 600), result: clip(t.result, 600) }
}

export function parseSummary(text: string): Summary | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return undefined
  }
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>

    return {
      title: clip(raw.title, 80),
      gist: clip(raw.gist, 200),
      done: clip(raw.done, 200),
      needsAttention: raw.needsAttention === true,
      task: moveOf(raw.task),
    }
  } catch {
    return undefined
  }
}

export function fallbackSummary(prompt: string, answer: string): Summary {
  const trimmed = answer.trim()
  const sentence = trimmed.split(/(?<=[.!?…])\s|\n/)[0] ?? ''

  return {
    title: prompt.trim().split(/\s+/).slice(0, 6).join(' '),
    gist: '',
    done: sentence.slice(0, 160),
    needsAttention: trimmed.endsWith('?'),
    task: NO_MOVE,
  }
}

// The summary's task move as it may be applied: never one the assistant
// already made itself this turn through the tool.
export function moveToApply(
  move: TaskMove,
  tasks: readonly Task[],
  current: Task | undefined,
  turn: { toolTaskIds: readonly string[]; hasToolStart: boolean },
): TaskMove {
  if (move.op === 'none') {
    return NO_MOVE
  }
  if (move.op === 'start') {
    return turn.hasToolStart || move.title === '' ? NO_MOVE : move
  }
  const known = tasks.find(task => task.id === move.taskId && isActive(task))
  const target = known ?? current
  if (target === undefined || turn.toolTaskIds.includes(target.id)) {
    return NO_MOVE
  }

  return { ...move, taskId: target.id }
}

// v1 kept one room's settings under `config` and the joined chats as a list.
export function migrate(raw: { config?: unknown; profile?: unknown; rooms?: unknown; joined?: unknown }): {
  profile: Profile | null
  rooms: Room[]
  joined: Record<string, string>
  isMigrated: boolean
} {
  const rooms = Array.isArray(raw.rooms) ? raw.rooms.filter(isRoom) : []
  const joinedMap = isRecordOfStrings(raw.joined) ? { ...raw.joined } : {}
  const profile = isProfile(raw.profile) ? raw.profile : null
  if (profile !== null) {
    return { profile, rooms, joined: joinedMap, isMigrated: false }
  }
  const old = raw.config as Record<string, unknown> | undefined
  if (typeof old !== 'object' || old === null || typeof old.personId !== 'string' || typeof old.name !== 'string' || typeof old.cloneDir !== 'string') {
    return { profile: null, rooms, joined: joinedMap, isMigrated: false }
  }
  const repoUrl = typeof old.repoUrl === 'string' ? old.repoUrl : DEFAULT_REPO
  const repoName = typeof old.repoName === 'string' ? old.repoName : repoNameOf(repoUrl)
  const room: Room = {
    id: slugOf(repoName) || 'room',
    title: 'Стартап',
    repoUrl,
    repoName,
    cloneDir: old.cloneDir,
    projectDir: typeof old.projectDir === 'string' ? old.projectDir : '',
  }
  const joined: Record<string, string> = {}
  for (const sid of Array.isArray(raw.joined) ? raw.joined : []) {
    if (typeof sid === 'string') {
      joined[sid] = room.id
    }
  }

  return {
    profile: { personId: old.personId, name: old.name, computer: typeof old.computer === 'string' ? old.computer : '' },
    rooms: [room, ...rooms.filter(one => one.id !== room.id)],
    joined,
    isMigrated: true,
  }
}

function isProfile(value: unknown): value is Profile {
  const v = value as Partial<Profile> | null
  return typeof v === 'object' && v !== null && typeof v.personId === 'string' && typeof v.name === 'string'
}

function isRoom(value: unknown): value is Room {
  const v = value as Partial<Room> | null
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.cloneDir === 'string' && typeof v.repoUrl === 'string'
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string')
}

export function inviteText(room: Room): string {
  const web = room.repoUrl.replace(/\.git$/, '')

  return `Комната «${room.title}»: ${web}\n1. Прими приглашение в репозиторий на GitHub (придёт на почту).\n2. Поставь мод team-room: в приложении Claude + → Plugins → Add marketplace → AinurFax/team-room → Add plugin.\n3. Напиши /teamroom → вкладка «Комнаты» → «Войти в комнату» → вставь адрес ${room.repoUrl}`
}

export const TASK_TOOL_SPEC = {
  name: TASK_TOOL_NAME,
  description:
    'Team Room: ведёт общую доску задач команды (её видят напарник и его Claude). Вызывай сам, человек задачи не пишет. ' +
    'op=start — взялся за новую работу: title (до 8 слов) и context (зачем, что известно, решения); чтобы взять готовую задачу из списка, передай её taskId. ' +
    'op=update — важный промежуточный итог: context. ' +
    'op=done — закончил: result (что получилось) и files (изменённые файлы). ' +
    'op=drop — задача больше не нужна. Без taskId работает с текущей задачей этого чата.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['start', 'update', 'done', 'drop'] },
      taskId: { type: 'string', description: 'id задачи из списка; без него — текущая задача чата' },
      title: { type: 'string' },
      context: { type: 'string' },
      result: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['op'],
  },
  isDeferred: false,
}

export const REMEMBER_TOOL_SPEC = {
  name: REMEMBER_TOOL_NAME,
  description:
    'Team Room: записывает в общую память проекта важную договорённость или решение (их видит напарник и его Claude). Одна запись — одна мысль, до 40 слов.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  isDeferred: false,
}
