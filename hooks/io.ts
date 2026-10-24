// The shared data on disk and its trip through git, one clone per room. Each
// person writes only their own files, so a rebase never conflicts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Timer } from 'claude-code'

import type {
  BoardMarks,
  Card,
  Config,
  MemoryEntry,
  Person,
  Profile,
  Room,
  Snapshot,
  SyncStatus,
  TaskEvent,
} from '../types'
import { BRANCH, EMPTY_SNAPSHOT, join, limitsChanged, limitsOf, membersOf, newId, repoNameOf, slugOf } from './model'
import { SYNC_INITIAL } from './state'

const snapshotsAtom = atom({ plugin: 'team-room', key: 'snapshots' } as const, {})
const syncsAtom = atom({ plugin: 'team-room', key: 'syncs' } as const, {})
const cardAtom = atom({ plugin: 'team-room', key: 'card' } as const, null)
const limitsAtom = atom({ plugin: 'team-room', key: 'limits' } as const, [])

type Engine = EngineInterface

const SYNC_GAP_MS = 20_000
const DEBOUNCE_MS = 3_000
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' }

const syncing = new Set<string>()
const pending = new Map<string, Timer>()

function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, 160)
}

async function run($: Engine, argv: readonly string[], timeoutMs = 60_000) {
  return $.process.run(argv, { timeoutMs, env: GIT_ENV })
}

async function runOk($: Engine, argv: readonly string[], timeoutMs?: number): Promise<string> {
  const ran = await run($, argv, timeoutMs)
  if (ran.exitCode !== 0) {
    throw new Error(firstLine(ran.stderr) || firstLine(ran.stdout) || `${argv[0]} ${argv[1] ?? ''}: код ${ran.exitCode}`)
  }

  return ran.stdout
}

async function gitOk($: Engine, dir: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  return runOk($, ['git', '-C', dir, ...args], timeoutMs)
}

function identity(profile: Profile): string[] {
  return ['-c', `user.name=${profile.name}`, '-c', `user.email=${profile.personId}@teamroom.local`]
}

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function writeJson($: Engine, path: string, value: unknown): Promise<void> {
  await $.fs.write(path, JSON.stringify(value, null, 1) + '\n')
}

async function listDir($: Engine, path: string): Promise<FsEntry[]> {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

async function readAll<T>($: Engine, dir: string, nested: boolean): Promise<T[]> {
  const out: T[] = []
  for (const entry of await listDir($, dir)) {
    if (nested && entry.kind === 'dir') {
      out.push(...(await readAll<T>($, join(dir, entry.name), false)))
    } else if (!nested && entry.kind === 'file' && entry.name.endsWith('.json')) {
      const value = await readJson<T>($, join(dir, entry.name))
      if (value !== undefined) {
        out.push(value)
      }
    }
  }

  return out
}

async function readMarks($: Engine, root: string): Promise<Record<string, BoardMarks>> {
  const marks: Record<string, BoardMarks> = {}
  for (const entry of await listDir($, join(root, 'board'))) {
    if (entry.kind === 'file' && entry.name.endsWith('.json')) {
      const value = await readJson<BoardMarks>($, join(root, 'board', entry.name))
      if (value !== undefined) {
        marks[entry.name.replace(/\.json$/, '')] = { notes: value.notes ?? {}, archived: value.archived ?? [] }
      }
    }
  }

  return marks
}

export async function loadSnapshot($: Engine, root: string): Promise<Snapshot> {
  const memory = (await readAll<MemoryEntry[]>($, join(root, 'memory'), true)).flat()
  const taskEvents = (await readAll<TaskEvent[]>($, join(root, 'tasks'), true)).flat()

  return {
    people: await readAll<Person>($, join(root, 'people'), false),
    cards: await readAll<Card>($, join(root, 'sessions'), true),
    memory: memory.filter(entry => typeof entry?.id === 'string'),
    taskEvents: taskEvents.filter(ev => typeof ev?.id === 'string'),
    marks: await readMarks($, root),
    loadedAt: await $.clock.now(),
  }
}

export async function snapshotOf($: Engine, roomId: string): Promise<Snapshot> {
  return (await read($, snapshotsAtom))[roomId] ?? EMPTY_SNAPSHOT
}

async function setSnapshot($: Engine, roomId: string, fn: (snap: Snapshot) => Snapshot): Promise<void> {
  await update($, snapshotsAtom, all => ({ ...all, [roomId]: fn(all[roomId] ?? EMPTY_SNAPSHOT) }))
}

export async function reload($: Engine, room: Pick<Room, 'id' | 'cloneDir'>): Promise<void> {
  const snap = await loadSnapshot($, room.cloneDir)
  await setSnapshot($, room.id, () => snap)
}

async function setSync($: Engine, roomId: string, patch: Partial<SyncStatus>) {
  await update($, syncsAtom, all => ({ ...all, [roomId]: { ...(all[roomId] ?? SYNC_INITIAL), ...patch } }))
}

// One round for one room: own changes up (`full`, the chat's own room only),
// everyone's down.
export async function syncNow($: Engine, cfg: Config, mode: 'full' | 'pull', force = false): Promise<void> {
  if (syncing.has(cfg.roomId)) {
    return
  }
  syncing.add(cfg.roomId)
  try {
    const now = await $.clock.now()
    const stampPath = join(cfg.cloneDir, '.git', 'teamroom-sync-stamp')
    const last = Number((await readJson<number>($, stampPath)) ?? 0)
    if (!force && now - last < SYNC_GAP_MS) {
      await reload($, { id: cfg.roomId, cloneDir: cfg.cloneDir })

      return
    }
    await writeJson($, stampPath, now)
    await setSync($, cfg.roomId, { isBusy: true })

    if (mode === 'full') {
      await refreshLimits($, cfg)
      await gitOk($, cfg.cloneDir, ['add', '-A'])
      const changes = await gitOk($, cfg.cloneDir, ['status', '--porcelain'])
      if (changes.trim() !== '') {
        await gitOk($, cfg.cloneDir, [...identity(cfg), 'commit', '-q', '-m', `teamroom: ${cfg.name} @ ${cfg.computer}`])
      }
    }
    await gitOk($, cfg.cloneDir, ['pull', '--rebase', '--autostash', '-q', 'origin', BRANCH], 90_000)
    if (mode === 'full') {
      const ahead = Number((await gitOk($, cfg.cloneDir, ['rev-list', '--count', `origin/${BRANCH}..HEAD`])).trim() || '0')
      if (ahead > 0) {
        await gitOk($, cfg.cloneDir, ['push', '-q', 'origin', `HEAD:${BRANCH}`], 90_000)
      }
    }
    await reload($, { id: cfg.roomId, cloneDir: cfg.cloneDir })
    const was = (await read($, syncsAtom))[cfg.roomId]
    if (was !== undefined && was.error !== '') {
      $.ui.status(undefined)
    }
    await setSync($, cfg.roomId, { at: await $.clock.now(), error: '', isBusy: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await setSync($, cfg.roomId, { error: message.slice(0, 160), isBusy: false })
    $.ui.status('Team Room: ошибка синхронизации')
    await reload($, { id: cfg.roomId, cloneDir: cfg.cloneDir })
  } finally {
    syncing.delete(cfg.roomId)
  }
}

// After a local write: push it soon, once the burst of writes settles.
export function scheduleSync($: Engine, cfg: Config): void {
  pending.get(cfg.roomId)?.cancel()
  pending.set(cfg.roomId, $.clock.after(DEBOUNCE_MS, () => void syncNow($, cfg, 'full', true)))
}

async function refreshLimits($: Engine, cfg: Config): Promise<void> {
  let usage
  try {
    usage = await $.session.usage()
  } catch {
    return
  }
  const fresh = limitsOf(usage.rateLimits)
  if (fresh.length === 0) {
    return
  }
  const before = await read($, limitsAtom)
  await update($, limitsAtom, () => fresh)
  const path = join(cfg.cloneDir, 'people', `${cfg.personId}.json`)
  const was = await readJson<Person>($, path)
  if (limitsChanged(before, fresh) || limitsChanged(was?.limits ?? [], fresh)) {
    await writePerson($, cfg, fresh)
  }
}

export async function writePerson($: Engine, cfg: Config, limits?: Person['limits']): Promise<void> {
  const path = join(cfg.cloneDir, 'people', `${cfg.personId}.json`)
  const was = await readJson<Person>($, path)
  const person: Person = {
    id: cfg.personId,
    name: cfg.name,
    computer: cfg.computer,
    limits: limits ?? was?.limits ?? [],
    updatedAt: await $.clock.now(),
  }
  await writeJson($, path, person)
  await setSnapshot($, cfg.roomId, snap => ({ ...snap, people: [...snap.people.filter(p => p.id !== person.id), person] }))
}

function cardPath(cfg: Config, id: string): string {
  return join(cfg.cloneDir, 'sessions', cfg.personId, `${id}.json`)
}

export async function readOwnCard($: Engine, cfg: Config, id: string): Promise<Card | null> {
  return (await readJson<Card>($, cardPath(cfg, id))) ?? null
}

export async function saveCard($: Engine, cfg: Config, next: Card): Promise<void> {
  await writeJson($, cardPath(cfg, next.id), next)
  await update($, cardAtom, () => next)
  await setSnapshot($, cfg.roomId, snap => ({
    ...snap,
    cards: [...snap.cards.filter(one => !(one.id === next.id && one.personId === next.personId)), next],
  }))
  scheduleSync($, cfg)
}

export async function addMemory(
  $: Engine,
  cfg: Config,
  sessionId: string,
  entry: Pick<MemoryEntry, 'text' | 'kind' | 'files'>,
): Promise<MemoryEntry> {
  const path = join(cfg.cloneDir, 'memory', cfg.personId, `${sessionId}.json`)
  const full: MemoryEntry = {
    id: newId(),
    at: await $.clock.now(),
    personId: cfg.personId,
    name: cfg.name,
    sessionId,
    ...entry,
  }
  const list = (await readJson<MemoryEntry[]>($, path)) ?? []
  await writeJson($, path, [...list, full])
  await setSnapshot($, cfg.roomId, snap => ({ ...snap, memory: [...snap.memory, full] }))
  scheduleSync($, cfg)

  return full
}

export type TaskChange = Omit<TaskEvent, 'id' | 'at' | 'personId' | 'name'>

export async function addTaskEvent($: Engine, cfg: Config, sessionId: string, change: TaskChange): Promise<TaskEvent> {
  const path = join(cfg.cloneDir, 'tasks', cfg.personId, `${sessionId}.json`)
  const ev: TaskEvent = {
    id: newId(),
    at: await $.clock.now(),
    personId: cfg.personId,
    name: cfg.name,
    ...change,
  }
  const list = (await readJson<TaskEvent[]>($, path)) ?? []
  await writeJson($, path, [...list, ev])
  await setSnapshot($, cfg.roomId, snap => ({ ...snap, taskEvents: [...snap.taskEvents, ev] }))
  scheduleSync($, cfg)

  return ev
}

export async function markCard(
  $: Engine,
  cfg: Config,
  cardId: string,
  change: { note?: string; archived?: boolean },
): Promise<void> {
  const path = join(cfg.cloneDir, 'board', `${cfg.personId}.json`)
  const was = (await readJson<BoardMarks>($, path)) ?? { notes: {}, archived: [] }
  const marks: BoardMarks = {
    notes: change.note === undefined ? was.notes ?? {} : { ...was.notes, [cardId]: change.note },
    archived:
      change.archived === true ? [...new Set([...(was.archived ?? []), cardId])] : was.archived ?? [],
  }
  await writeJson($, path, marks)
  await setSnapshot($, cfg.roomId, snap => ({ ...snap, marks: { ...snap.marks, [cfg.personId]: marks } }))
  scheduleSync($, cfg)
}

export async function homeDir($: Engine): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

export async function hostName($: Engine): Promise<string> {
  try {
    const ran = await $.process.run(['hostname'], { timeoutMs: 5_000 })

    return ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function cloneDirOf($: Engine, repoName: string): Promise<string> {
  return join(await homeDir($), '.claude', 'teamroom', repoName)
}

// «Войти в комнату»: clone the room's branch once and describe the room.
export async function enterRoom($: Engine, input: { repoUrl: string; projectDir: string; title?: string }): Promise<Room> {
  const repoUrl = input.repoUrl.trim()
  const repoName = repoNameOf(repoUrl)
  const cloneDir = await cloneDirOf($, repoName)
  if (!(await $.fs.exists(join(cloneDir, '.git')))) {
    const ran = await run($, ['git', 'clone', '-q', '--branch', BRANCH, '--single-branch', repoUrl, cloneDir], 180_000)
    if (ran.exitCode !== 0) {
      throw new Error(firstLine(ran.stderr) || `git clone: код ${ran.exitCode}`)
    }
  }

  return {
    id: slugOf(repoName) || newId(),
    title: input.title?.trim() || repoName,
    repoUrl,
    repoName,
    cloneDir,
    projectDir: input.projectDir.trim(),
  }
}

const ROOM_README = `# Team Room data

This branch holds the shared state of the Team Room mod: project memory,
the session board, tasks and limits. The mod reads and writes it by itself;
do not edit by hand.

Layout:
- \`people/<person>.json\` - name, computer, rate limits
- \`sessions/<person>/<session>.json\` - board cards
- \`memory/<person>/<session>.json\` - project memory entries
- \`tasks/<person>/<session>.json\` - task events
- \`board/<person>.json\` - own notes and archived cards
`

// «Новая комната»: a private repository with the data branch, the people invited.
export async function createRoom(
  $: Engine,
  profile: Profile,
  input: { title: string; members: string; projectDir: string },
): Promise<{ room: Room; failed: string[] }> {
  const title = input.title.trim()
  const slug = slugOf(title) || `team-${newId()}`
  let owner: string
  try {
    owner = (await runOk($, ['gh', 'api', 'user', '--jq', '.login'], 30_000)).trim()
  } catch {
    throw new Error('gh не установлен или не вошёл в GitHub. Создай приватный репозиторий сам и войди в комнату по адресу.')
  }
  if (owner === '') {
    throw new Error('gh не вошёл в GitHub. Создай приватный репозиторий сам и войди в комнату по адресу.')
  }
  const repoUrl = `https://github.com/${owner}/${slug}.git`
  const cloneDir = await cloneDirOf($, slug)
  if (await $.fs.exists(join(cloneDir, '.git'))) {
    throw new Error(`Папка ${cloneDir} уже есть. Выбери другое название.`)
  }
  await runOk($, ['gh', 'repo', 'create', `${owner}/${slug}`, '--private', '--description', `Team Room: ${title}`], 60_000)
  await $.fs.write(join(cloneDir, 'README.md'), ROOM_README)
  await gitOk($, cloneDir, ['init', '-q', '-b', BRANCH])
  await gitOk($, cloneDir, ['remote', 'add', '-t', BRANCH, 'origin', repoUrl])
  await gitOk($, cloneDir, ['add', '-A'])
  await gitOk($, cloneDir, [...identity(profile), 'commit', '-q', '-m', 'teamroom: init branch'])
  await gitOk($, cloneDir, ['push', '-q', '-u', 'origin', BRANCH], 90_000)

  const failed: string[] = []
  for (const nick of membersOf(input.members)) {
    const ran = await run($, ['gh', 'api', '-X', 'PUT', `repos/${owner}/${slug}/collaborators/${nick}`, '-f', 'permission=push'], 30_000)
    if (ran.exitCode !== 0) {
      failed.push(nick)
    }
  }

  return {
    room: { id: slug, title: title || slug, repoUrl, repoName: slug, cloneDir, projectDir: input.projectDir.trim() },
    failed,
  }
}
