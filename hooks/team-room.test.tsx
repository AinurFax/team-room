import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { migrate, reduceTasks } from './model'

const HOME = 'C:/Users/test'
const CLONE = `${HOME}/.claude/teamroom/calories-team`
const T0 = Date.UTC(2026, 9, 23, 18, 0, 0)
const ME = 'aaaa1111'
const FRIEND = 'bbbb2222'
const SID = 'sess-1'
const TASK_TOOL = 'mcp__team-room__team_task'

const PROFILE = { personId: ME, name: 'Аня', computer: 'pc-1' }
const ROOM = {
  id: 'calories-team',
  title: 'Стартап',
  repoUrl: 'https://github.com/AinurFax/calories-team.git',
  repoName: 'calories-team',
  cloneDir: CLONE,
  projectDir: '',
}
const V1_CONFIG = { ...PROFILE, repoUrl: ROOM.repoUrl, repoName: ROOM.repoName, projectDir: 'C:/work/app', cloneDir: CLONE }

const PANE = {
  plugin: 'team-room',
  component: 'Pane',
  requestId: 'team-room',
  props: {
    title: 'Team Room',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

type Run = { exitCode: number; stdout: string }

type World = {
  files: Map<string, string>
  runs: string[][]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  json: (path: string) => unknown
}

const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

// Everything beneath the plugin, in memory: files, git and gh, the session, the model.
function world(
  on: On,
  opts: {
    store?: Record<string, unknown>
    files?: Record<string, unknown>
    summary?: string | (() => string)
    root?: string
    answer?: (argv: string[]) => Run | undefined
  },
): World {
  const files = new Map<string, string>()
  for (const [path, value] of Object.entries(opts.files ?? {})) {
    files.set(norm(`${CLONE}/${path}`), JSON.stringify(value))
  }
  const runs: string[][] = []
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  mock.env(on, { USERPROFILE: HOME })
  const clock = mock.clock(on, { now: T0 })

  on('session.id', () => ({ value: SID }))
  on('session.root', () => ({ value: opts.root ?? 'C:/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 40 },
        { kind: 'seven_day', percentUsed: 11 },
      ],
    },
  }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__team-room__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const p = norm(e.path)

    return { value: [...files.keys()].some(k => k === p || k.startsWith(p + '/')) }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e.path) + '/'
    const seen = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (key.startsWith(dir)) {
        const rest = key.slice(dir.length)
        const [head, ...tail] = rest.split('/')
        seen.set(head ?? rest, tail.length > 0 ? 'dir' : 'file')
      }
    }
    if (seen.size === 0) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const own = opts.answer?.(argv)
    const out = own ?? { exitCode: 0, stdout: argv[0] === 'hostname' ? 'test-pc\n' : argv.includes('rev-list') ? '1\n' : '' }
    if (argv[1] === 'clone' || argv.includes('clone')) {
      files.set(norm(`${argv.at(-1)}/.git/HEAD`), 'ref: refs/heads/teamroom')
    }

    return { value: { exitCode: out.exitCode, stdout: out.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: (typeof opts.summary === 'function' ? opts.summary() : opts.summary) ?? '{"title":"Камера в PWA","gist":"Делаем съёмку еды в PWA","done":"Добавил кнопку камеры","needsAttention":false,"task":{"op":"none"}}',
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return {
    files,
    runs,
    store,
    clock,
    json: path => {
      const text = files.get(norm(`${CLONE}/${path}`))

      return text === undefined ? undefined : JSON.parse(text)
    },
  }
}

const joinedStore = { profile: PROFILE, rooms: [ROOM], joined: { [SID]: ROOM.id } }

async function start($: Engine, cwd = 'C:/proj') {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
}

const COMPOSER = { kind: 'composer' } as const
const PRESENT = { isFullscreen: true, columns: 160 } as const

async function finishTurn($: Engine, w: World, answer: string) {
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.advance(100)
}

function tasksIn(w: World) {
  const events = [...w.files.entries()]
    .filter(([key]) => key.startsWith(`${CLONE}/tasks/`))
    .flatMap(([, text]) => JSON.parse(text))

  return reduceTasks(events)
}

test('the setup form draws on the terminal and the desktop', async ($, on) => {
  world(on, {})
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Input', key: 'setup-name' })).toBeDefined()
    expect((await ui.find({ key: 'setup-computer' }))?.props.value).toBe('test-pc')
    expect((await ui.find({ type: 'Button', key: 'setup-connect' }))?.text).toBe('Сохранить')
    await ui.unmount()
  }
})

test('setup with an invitation clones the room, keeps the profile and joins the chat', async ($, on) => {
  const w = world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'setup-name', text: 'Аня', kind: 'change' })
  await ui.input({ key: 'setup-repo', text: ROOM.repoUrl, kind: 'change' })
  await ui.press({ key: 'setup-connect' })
  await w.clock.settle()

  expect(w.runs.find(argv => argv.includes('clone'))).toEqual(['git', 'clone', '-q', '--branch', 'teamroom', '--single-branch', ROOM.repoUrl, CLONE])
  expect(w.store.get('profile')).toMatchObject({ name: 'Аня', computer: 'test-pc' })
  expect(w.store.get('rooms')).toEqual([expect.objectContaining({ id: 'calories-team', cloneDir: CLONE })])
  expect(w.store.get('joined')).toEqual({ [SID]: 'calories-team' })
  const person = [...w.files.keys()].find(key => key.startsWith(`${CLONE}/people/`))
  expect(JSON.parse(w.files.get(person ?? '') ?? '{}')).toMatchObject({ name: 'Аня', computer: 'test-pc' })
  expect((await ui.find({ type: 'Text', text: /комната «/ }))?.text).toBe('Этот чат: комната «calories-team»')
  await ui.unmount()
})

test('a v1 setup becomes a profile and the room «Стартап», the joined chats kept', async ($, on) => {
  const w = world(on, {
    store: { config: V1_CONFIG, joined: [SID, 'other'] },
    files: { [`memory/${FRIEND}/s9.json`]: [{ id: 'm1', at: T0, personId: FRIEND, name: 'Друг', sessionId: 's9', text: 'Старая запись', kind: 'auto' }] },
  })
  await start($)

  expect(w.store.get('profile')).toEqual(PROFILE)
  expect(w.store.get('rooms')).toEqual([{ ...ROOM, projectDir: 'C:/work/app' }])
  expect(w.store.get('joined')).toEqual({ [SID]: 'calories-team', other: 'calories-team' })
  const first = await $.prompt.submit({ text: 'Привет', wait: false, origin: COMPOSER })
  expect(first.drop === undefined ? first.context?.join('\n') : '').toContain('Друг: Старая запись')
  expect(migrate({ profile: PROFILE, rooms: [ROOM], joined: {} }).isMigrated).toBe(false)
})

test('a chat joins the room whose project folder holds it, the deepest first', async ($, on) => {
  const app = { ...ROOM, id: 'app', title: 'Приложение', repoName: 'app', cloneDir: `${HOME}/.claude/teamroom/app`, projectDir: 'C:/work/app' }
  const outer = { ...ROOM, projectDir: 'C:/work' }
  const w = world(on, { store: { profile: PROFILE, rooms: [outer, app], joined: {} }, root: 'C:/work/app/src' })
  await start($, 'C:/work/app/src')

  await $.command.run({ command: 'remember', args: 'PWA, не бот', origin: COMPOSER, presentation: PRESENT })
  expect(w.files.has(norm(`${app.cloneDir}/memory/${ME}/${SID}.json`))).toBe(true)
  expect(w.json(`memory/${ME}/${SID}.json`)).toBeUndefined()
})

test('«Новая комната» creates the repository with gh, sets up the branch, invites and clones', async ($, on) => {
  const w = world(on, {
    store: { profile: PROFILE, rooms: [], joined: {} },
    answer: argv => (argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'user' ? { exitCode: 0, stdout: 'AinurFax\n' } : argv.join(' ').includes('collaborators/ghost') ? { exitCode: 1, stdout: '' } : undefined),
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'room-new-title', text: 'Курсовая ТММ', kind: 'change' })
  await ui.input({ key: 'room-new-members', text: 'petya-dev, @ghost', kind: 'change' })
  await ui.press({ key: 'room-create' })
  await w.clock.settle()

  const dir = `${HOME}/.claude/teamroom/kursovaya-tmm`
  const argvs = w.runs.map(argv => argv.join(' '))
  expect(argvs).toContain('gh repo create AinurFax/kursovaya-tmm --private --description Team Room: Курсовая ТММ')
  expect(argvs).toContain(`git -C ${dir} init -q -b teamroom`)
  expect(argvs).toContain(`git -C ${dir} remote add -t teamroom origin https://github.com/AinurFax/kursovaya-tmm.git`)
  expect(argvs).toContain(`git -C ${dir} push -q -u origin teamroom`)
  expect(argvs).toContain('gh api -X PUT repos/AinurFax/kursovaya-tmm/collaborators/petya-dev -f permission=push')
  expect(w.files.has(`${dir}/README.md`)).toBe(true)
  expect(w.store.get('rooms')).toEqual([expect.objectContaining({ id: 'kursovaya-tmm', title: 'Курсовая ТММ', cloneDir: dir })])
  expect((await ui.find({ type: 'Text', text: /Комната «Курсовая ТММ»/ }))?.text).toMatch(/Не удалось пригласить: ghost/)
  await ui.unmount()
})

test('«Новая комната» without gh says what to do instead', async ($, on) => {
  const w = world(on, {
    store: { profile: PROFILE, rooms: [], joined: {} },
    answer: argv => (argv[0] === 'gh' ? { exitCode: 1, stdout: '' } : undefined),
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'room-new-title', text: 'Курсовая', kind: 'change' })
  await ui.press({ key: 'room-create' })
  await w.clock.settle()
  expect((await ui.find({ type: 'Text', text: /Не вышло/ }))?.text).toMatch(/войди в комнату по адресу/)
  expect(w.runs.some(argv => argv.includes('repo'))).toBe(false)
  await ui.unmount()
})

test('«Войти в комнату» clones the room and shows it', async ($, on) => {
  const w = world(on, { store: { profile: PROFILE, rooms: [ROOM], joined: { [SID]: ROOM.id } } })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-rooms' })
  await ui.input({ key: 'room-join-url', text: 'https://github.com/petya/diplom.git', kind: 'change' })
  await ui.press({ key: 'room-join' })
  await w.clock.settle()

  expect(w.runs.find(argv => argv.includes('clone'))).toEqual([
    'git', 'clone', '-q', '--branch', 'teamroom', '--single-branch', 'https://github.com/petya/diplom.git', `${HOME}/.claude/teamroom/diplom`,
  ])
  expect((w.store.get('rooms') as { id: string }[]).map(room => room.id)).toEqual(['calories-team', 'diplom'])
  // The chat stays in its own room; the pane now shows the new one.
  expect(w.store.get('joined')).toEqual({ [SID]: ROOM.id })
  expect((await ui.find({ type: 'Text', text: /^Team Room/ }))?.text).toBe('Team Room · diplom')
  await ui.unmount()
})

test('/remember writes a manual entry into this chat\'s memory file', async ($, on) => {
  const w = world(on, { store: joinedStore })
  await start($)

  const ran = await $.command.run({ command: 'remember', args: 'База КБЖУ в PostgreSQL', origin: COMPOSER, presentation: PRESENT })
  expect(ran.text).toBe('Записал в общую память комнаты «Стартап».')
  expect(w.json(`memory/${ME}/${SID}.json`)).toEqual([
    expect.objectContaining({ text: 'База КБЖУ в PostgreSQL', kind: 'manual', name: 'Аня', personId: ME, sessionId: SID }),
  ])
})

test('/remember in a chat not in the team writes nothing', async ($, on) => {
  const w = world(on, { store: { profile: PROFILE, rooms: [ROOM], joined: {} } })
  await start($)

  const ran = await $.command.run({ command: 'remember', args: 'x', origin: COMPOSER, presentation: PRESENT })
  expect(ran.text).toMatch(/не в Team Room/)
  expect(w.json(`memory/${ME}/${SID}.json`)).toBeUndefined()
})

test('team_task start and done from the tool write events, the pane shows context and result', async ($, on) => {
  const w = world(on, { store: joinedStore })
  await start($)
  await $.prompt.submit({ text: 'Сделай камеру', wait: false, origin: COMPOSER })

  const check = await $.tool.check({ tool: TASK_TOOL, input: { op: 'start' } })
  expect(check.decision).toBe('allow')
  const started = await $.tool.call({ tool: TASK_TOOL, op: 'start', title: 'Камера в PWA', context: 'Нужна съёмка еды с телефона' })
  expect(String(started.result)).toMatch(/Начал задачу \[[0-9a-f]{8}\] «Камера в PWA»/)
  const done = await $.tool.call({ tool: TASK_TOOL, op: 'done', result: 'Кнопка снимает и сохраняет фото', files: ['app/camera.js'] })
  expect(String(done.result)).toMatch(/закрыта/)

  const [task] = tasksIn(w)
  expect(task).toMatchObject({
    title: 'Камера в PWA', context: 'Нужна съёмка еды с телефона', result: 'Кнопка снимает и сохраняет фото',
    status: 'done', byClaude: true, takenBy: 'Аня', files: ['app/camera.js'], sessions: [SID],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-tasks' })
    await ui.press({ key: 'tasks-done' })
    await ui.press({ key: `task-more-${task?.id}` })
    await w.clock.settle()
    expect((await ui.find({ type: 'Text', text: /^Контекст/ }))?.text).toBe('Контекст: Нужна съёмка еды с телефона')
    expect((await ui.find({ type: 'Text', text: /^Результат/ }))?.text).toBe('Результат: Кнопка снимает и сохраняет фото')
    expect(await ui.find({ key: `reopen-${task?.id}` })).toBeDefined()
    // Put the view back for the next surface: it is the session's, not the drawing's.
    await ui.press({ key: `task-more-${task?.id}` })
    await ui.press({ key: 'tasks-done' })
    await ui.unmount()
  }
})

test('the tools refuse in a chat that is not in a room', async ($, on) => {
  const w = world(on, { store: { profile: PROFILE, rooms: [ROOM], joined: {} } })
  await start($)
  const ran = await $.tool.call({ tool: TASK_TOOL, op: 'start', title: 'X' })
  expect('deny' in ran ? ran.deny : String(ran.text ?? ran.result)).toMatch(/не подключён к Team Room/)
  expect(tasksIn(w)).toEqual([])
})

test('/task and «Беру» fold into one taken task', async ($, on) => {
  const w = world(on, { store: joinedStore })
  await start($)
  await $.command.run({ command: 'task', args: 'Камера в PWA', origin: COMPOSER, presentation: PRESENT })
  const [added] = w.json(`tasks/${ME}/${SID}.json`) as { taskId: string }[]
  expect(added).toBeDefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-tasks' })
  await w.clock.settle()
  expect((await ui.find({ type: 'Text', text: /свободна/ }))?.text).toBe('свободна')
  await ui.press({ key: `take-${added?.taskId}` })
  await w.clock.settle()
  expect((await ui.find({ type: 'Text', text: /взял/ }))?.text).toBe('взял: Аня')
  expect(await ui.find({ key: `finish-${added?.taskId}` })).toBeDefined()
  await ui.unmount()
  const events = w.json(`tasks/${ME}/${SID}.json`) as { op: string }[]
  expect(events.map(ev => ev.op)).toEqual(['add', 'take'])
})

test('reduceTasks: v1 add/take/done/drop and v2 start/update/edit/reopen', () => {
  const ev = (id: string, at: number, op: string, taskId: string, who = ME, extra = {}) => ({
    id, at, personId: who, name: who === ME ? 'Аня' : 'Друг', op: op as 'add', taskId, ...extra,
  })
  const tasks = reduceTasks([
    ev('3', 3, 'take', 't1', FRIEND),
    ev('1', 1, 'add', 't1', ME, { title: 'Камера' }),
    ev('2', 2, 'add', 't2', ME, { title: 'Лишняя' }),
    ev('4', 4, 'drop', 't2'),
    ev('5', 5, 'start', 't3', FRIEND, { title: 'Таблица КБЖУ', context: 'USDA', sessionId: 's9', byClaude: true }),
    ev('6', 6, 'update', 't3', FRIEND, { context: 'добавил FNDDS' }),
    ev('7', 7, 'done', 't3', FRIEND, { result: 'База собрана', files: ['kbju.sqlite'] }),
    ev('8', 8, 'edit', 't1', ME, { title: 'Камера в PWA' }),
    ev('9', 9, 'reopen', 't3', ME),
  ])
  expect(tasks).toEqual([
    expect.objectContaining({ id: 't1', title: 'Камера в PWA', status: 'taken', takenBy: 'Друг' }),
    expect.objectContaining({ id: 't2', status: 'dropped' }),
    expect.objectContaining({
      id: 't3', status: 'taken', context: 'USDA\nдобавил FNDDS', result: 'База собрана', files: ['kbju.sqlite'], byClaude: true, sessions: ['s9'],
    }),
  ])
})

test('the board sorts cards into «В работе», «Требует внимания», «Готово» and shows the chat\'s task', async ($, on) => {
  const card = (id: string, personId: string, name: string, status: string, updatedAt: number, extra = {}) => ({
    id, personId, name, computer: 'pc', title: `Карточка ${id}`, gist: '', status, done: [], note: '',
    model: 'm', project: 'proj', startedAt: T0 - 3_600_000, updatedAt, archived: false, ...extra,
  })
  const w = world(on, {
    store: joinedStore,
    files: {
      [`sessions/${FRIEND}/s1.json`]: card('s1', FRIEND, 'Друг', 'working', T0 - 60_000),
      [`sessions/${FRIEND}/s2.json`]: card('s2', FRIEND, 'Друг', 'working', T0 - 30 * 60_000),
      [`sessions/${ME}/s3.json`]: card('s3', ME, 'Аня', 'done', T0 - 120_000, { done: [{ at: T0, text: 'Сделал A' }] }),
      [`sessions/${ME}/s4.json`]: card('s4', ME, 'Аня', 'attention', T0 - 120_000),
      [`sessions/${ME}/s5.json`]: card('s5', ME, 'Аня', 'done', T0 - 20 * 86_400_000),
      [`board/${ME}.json`]: { notes: { s3: 'проверить на телефоне' }, archived: ['s4'] },
      [`tasks/${FRIEND}/s1.json`]: [{ id: 'e1', at: T0 - 50_000, personId: FRIEND, name: 'Друг', op: 'start', taskId: 't1', title: 'Экран дневника', sessionId: 's1' }],
    },
  })
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^В работе/ }))?.text).toBe('В работе (0)')
    expect((await ui.find({ type: 'Text', text: /^Готово/ }))?.text).toBe('Готово (1)')
    await ui.press({ key: 'filter-all' })
    await w.clock.settle()
    expect((await ui.find({ type: 'Text', text: /^В работе/ }))?.text).toBe('В работе (1)')
    expect((await ui.find({ type: 'Text', text: /^Требует внимания/ }))?.text).toBe('Требует внимания (1)')
    expect((await ui.find({ type: 'Text', text: /нет связи/ }))?.text).toBe('нет связи')
    expect((await ui.find({ type: 'Text', text: /^Задача:/ }))?.text).toBe('Задача: Экран дневника')
    expect((await ui.find({ key: 'note-s3-0' }))?.props.value).toBe('проверить на телефоне')
    await ui.press({ key: 'done-s3' })
    await w.clock.settle()
    expect((await ui.find({ type: 'Text', text: /Сделал A/ }))?.text).toBe('— Сделал A')
    await ui.press({ key: 'done-s3' })
    await ui.press({ key: 'filter-mine' })
    await w.clock.settle()
    await ui.unmount()
  }
})

test('a prompt gets the digest with the task rule first, then nothing while nothing is new', async ($, on) => {
  world(on, {
    store: joinedStore,
    files: {
      [`memory/${FRIEND}/s9.json`]: [
        { id: 'm1', at: T0 - 600_000, personId: FRIEND, name: 'Друг', sessionId: 's9', text: 'Сделал уроки 10–16', kind: 'auto' },
      ],
      [`tasks/${FRIEND}/s9.json`]: [{ id: 'e1', at: T0 - 500_000, personId: FRIEND, name: 'Друг', op: 'add', taskId: 't1', title: 'Камера', context: 'съёмка с телефона' }],
    },
  })
  await start($)

  const first = await $.prompt.submit({ text: 'Сделай уроки 1–10', wait: false, origin: COMPOSER })
  const digest = first.drop === undefined ? first.context?.join('\n') ?? '' : ''
  expect(digest).toContain('Team Room — общая память проекта')
  expect(digest).toContain('Задачи ведёшь сам инструментом team_task')
  expect(digest).toContain('Друг: Сделал уроки 10–16')
  expect(digest).toContain('[t1] «Камера» — свободна — съёмка с телефона')
  expect(digest).toContain('У этого чата пока нет задачи.')

  const second = await $.prompt.submit({ text: 'Дальше', wait: false, origin: COMPOSER })
  expect(second.drop === undefined ? second.context : 'dropped').toBeUndefined()
})

test('a finished turn becomes a card line and an auto memory entry', async ($, on) => {
  const w = world(on, { store: joinedStore })
  await start($)

  await $.prompt.submit({ text: 'Добавь кнопку камеры в PWA', wait: false, origin: COMPOSER })
  expect(w.json(`sessions/${ME}/${SID}.json`)).toMatchObject({ status: 'working', title: 'Добавь кнопку камеры в PWA' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/app/camera.js', content: 'x' })
  await finishTurn($, w, 'Готово, кнопка камеры добавлена.')

  expect(w.json(`sessions/${ME}/${SID}.json`)).toMatchObject({
    status: 'done',
    title: 'Камера в PWA',
    gist: 'Делаем съёмку еды в PWA',
    done: [expect.objectContaining({ text: 'Добавил кнопку камеры' })],
  })
  expect(w.json(`memory/${ME}/${SID}.json`)).toEqual([
    expect.objectContaining({ text: 'Добавил кнопку камеры', kind: 'auto', files: ['app/camera.js'] }),
  ])
})

test('the summary starts and closes a task when Claude did not use the tool', async ($, on) => {
  let reply = '{"title":"Камера","gist":"Камера в PWA","done":"Начал камеру","needsAttention":false,"task":{"op":"start","title":"Камера в PWA","context":"съёмка еды"}}'
  const w = world(on, { store: joinedStore, summary: () => reply })
  await start($)
  await $.prompt.submit({ text: 'Сделай камеру', wait: false, origin: COMPOSER })
  await finishTurn($, w, 'Начал делать камеру.')
  const [task] = tasksIn(w)
  expect(task).toMatchObject({ title: 'Камера в PWA', context: 'съёмка еды', status: 'taken', byClaude: true, sessions: [SID] })

  reply = `{"title":"Камера","gist":"Камера в PWA","done":"Доделал камеру","needsAttention":false,"task":{"op":"done","taskId":"${task?.id}","result":"Камера работает"}}`
  await $.prompt.submit({ text: 'Доделай', wait: false, origin: COMPOSER })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/app/camera.js', content: 'x' })
  await finishTurn($, w, 'Готово.')
  expect(tasksIn(w)).toEqual([expect.objectContaining({ id: task?.id, status: 'done', result: 'Камера работает', files: ['app/camera.js'] })])
})

test('the summary does not repeat what Claude did through the tool', async ($, on) => {
  const w = world(on, {
    store: joinedStore,
    summary: '{"title":"Камера","gist":"g","done":"Начал камеру","needsAttention":false,"task":{"op":"start","title":"Камера снова","context":"x"}}',
  })
  await start($)
  await $.prompt.submit({ text: 'Сделай камеру', wait: false, origin: COMPOSER })
  await $.tool.call({ tool: TASK_TOOL, op: 'start', title: 'Камера в PWA', context: 'съёмка' })
  await finishTurn($, w, 'Начал.')
  expect(tasksIn(w).map(task => task.title)).toEqual(['Камера в PWA'])
})

test('a summary left pending by a reload is finished at the next start', async ($, on) => {
  const w = world(on, { store: joinedStore })
  await start($)
  await $.prompt.submit({ text: 'Добавь кнопку камеры в PWA', wait: false, origin: COMPOSER })
  await $.turn.complete({ answer: 'Готово.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  // The module reloads before its timer fires: session.start runs again.
  await start($)
  await w.clock.advance(2_000)

  expect(w.json(`memory/${ME}/${SID}.json`)).toEqual([expect.objectContaining({ text: 'Добавил кнопку камеры', kind: 'auto' })])
  expect(w.json(`sessions/${ME}/${SID}.json`)).toMatchObject({ status: 'done', title: 'Камера в PWA' })
})

test('a turn that asks the person goes to «Требует внимания»', async ($, on) => {
  const w = world(on, {
    store: joinedStore,
    summary: '{"title":"Выбор БД","gist":"Где хранить данные","done":"","needsAttention":true,"task":{"op":"none"}}',
  })
  await start($)
  await $.prompt.submit({ text: 'Какую базу взять?', wait: false, origin: COMPOSER })
  await finishTurn($, w, 'PostgreSQL или SQLite?')

  expect(w.json(`sessions/${ME}/${SID}.json`)).toMatchObject({ status: 'attention', title: 'Выбор БД' })
  expect(w.json(`memory/${ME}/${SID}.json`)).toBeUndefined()
})

test('«Отключить» takes the chat out of its room and the tools stop writing', async ($, on) => {
  const w = world(on, { store: joinedStore })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'leave' }))?.text).toBe('Отключить')

  await ui.press({ key: 'leave' })
  await w.clock.settle()

  expect(w.store.get('left')).toEqual([SID])
  expect(w.store.get('joined')).toEqual({})
  expect(await ui.find({ type: 'Button', key: 'leave' })).toBeUndefined()
  const ran = await $.tool.call({ tool: TASK_TOOL, op: 'start', title: 'X' })
  expect('deny' in ran ? ran.deny : String(ran.text ?? ran.result)).toMatch(/не подключён к Team Room/)
  expect(tasksIn(w)).toEqual([])
  await ui.unmount()
})
