// The Team Room pane: setup form, room switcher, board, tasks, memory, rooms.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { CardStatus, Config, Room, Tab, Task } from '../types'
import { addMemory, addTaskEvent, createRoom, enterRoom, markCard, reload, syncNow } from './io'
import type { TaskChange } from './io'
import { joinSession, leaveSession, saveProfile, saveRooms, shownConfig } from './session'
import { EMPTY_SNAPSHOT, ago, agoSeconds, boardOf, formatLimits, inviteText, isActive, newId, reduceTasks, stamp } from './model'
import type { BoardCard } from './model'
import { DRAFT_INITIAL, ROOM_DRAFT_INITIAL, SYNC_INITIAL, VIEW_INITIAL } from './state'

const profileAtom = atom({ plugin: 'team-room', key: 'profile' } as const, null)
const roomsAtom = atom({ plugin: 'team-room', key: 'rooms' } as const, [])
const sessionIdAtom = atom({ plugin: 'team-room', key: 'sessionId' } as const, '')
const roomAtom = atom({ plugin: 'team-room', key: 'room' } as const, '')
const shownAtom = atom({ plugin: 'team-room', key: 'shown' } as const, '')
const snapshotsAtom = atom({ plugin: 'team-room', key: 'snapshots' } as const, {})
const syncsAtom = atom({ plugin: 'team-room', key: 'syncs' } as const, {})
const viewAtom = atom({ plugin: 'team-room', key: 'view' } as const, VIEW_INITIAL)
const draftAtom = atom({ plugin: 'team-room', key: 'draft' } as const, DRAFT_INITIAL)
const roomDraftAtom = atom({ plugin: 'team-room', key: 'roomDraft' } as const, ROOM_DRAFT_INITIAL)
const limitsAtom = atom({ plugin: 'team-room', key: 'limits' } as const, [])

type Engine = EngineInterface

const COLUMNS: { status: CardStatus; title: string }[] = [
  { status: 'working', title: 'В работе' },
  { status: 'attention', title: 'Требует внимания' },
  { status: 'done', title: 'Готово' },
]

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'board', label: 'Доска' },
  { tab: 'tasks', label: 'Задачи' },
  { tab: 'memory', label: 'Память' },
  { tab: 'rooms', label: 'Комнаты' },
]

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function addRoom($: Engine, room: Room): Promise<void> {
  const rooms = await read($, roomsAtom)
  await saveRooms($, [...rooms.filter(one => one.id !== room.id), room])
  await update($, shownAtom, () => room.id)
  await reload($, room)
  if ((await read($, roomAtom)) === '') {
    await joinSession($, room.id)
  }
}

// The first-run form: who you are, and the room you were invited to, if any.
async function saveSetup($: Engine): Promise<void> {
  const form = await read($, draftAtom)
  if (form.name.trim() === '') {
    await update($, draftAtom, d => ({ ...d, error: 'Нужно имя.' }))

    return
  }
  await update($, draftAtom, d => ({ ...d, error: '', isBusy: true }))
  try {
    await saveProfile($, { personId: newId(), name: form.name.trim(), computer: form.computer.trim() })
    if (form.repoUrl.trim() !== '') {
      await addRoom($, await enterRoom($, { repoUrl: form.repoUrl, projectDir: form.projectDir }))
    } else {
      await update($, viewAtom, v => ({ ...v, tab: 'rooms' }))
    }
    await update($, draftAtom, d => ({ ...d, isBusy: false }))
  } catch (err) {
    await update($, draftAtom, d => ({ ...d, error: `Не вышло: ${errorText(err)}`, isBusy: false }))
  }
}

async function makeRoom($: Engine): Promise<void> {
  const profile = await read($, profileAtom)
  const form = await read($, roomDraftAtom)
  if (profile === null || form.title.trim() === '') {
    await update($, roomDraftAtom, d => ({ ...d, error: 'Нужно название комнаты.' }))

    return
  }
  await update($, roomDraftAtom, d => ({ ...d, error: '', invite: '', isBusy: true }))
  try {
    const { room, failed } = await createRoom($, profile, { title: form.title, members: form.members, projectDir: form.projectDir })
    await addRoom($, room)
    const missed = failed.length > 0 ? `\nНе удалось пригласить: ${failed.join(', ')} — проверь ники.` : ''
    await update($, roomDraftAtom, () => ({ ...ROOM_DRAFT_INITIAL, invite: `${inviteText(room)}${missed}` }))
    await update($, viewAtom, v => ({ ...v, tab: 'rooms' }))
  } catch (err) {
    await update($, roomDraftAtom, d => ({ ...d, error: `Не вышло: ${errorText(err)}`, isBusy: false }))
  }
}

async function goIntoRoom($: Engine): Promise<void> {
  const form = await read($, roomDraftAtom)
  if (form.joinUrl.trim() === '') {
    await update($, roomDraftAtom, d => ({ ...d, error: 'Нужен адрес репозитория комнаты.' }))

    return
  }
  await update($, roomDraftAtom, d => ({ ...d, error: '', invite: '', isBusy: true }))
  try {
    await addRoom($, await enterRoom($, { repoUrl: form.joinUrl, projectDir: form.joinDir }))
    await update($, roomDraftAtom, () => ROOM_DRAFT_INITIAL)
  } catch (err) {
    await update($, roomDraftAtom, d => ({ ...d, error: `Не вышло: ${errorText(err)}`, isBusy: false }))
  }
}

async function forgetRoom($: Engine, roomId: string): Promise<void> {
  const rooms = await read($, roomsAtom)
  if ((await read($, roomAtom)) === roomId) {
    await leaveSession($)
  }
  await saveRooms($, rooms.filter(room => room.id !== roomId))
  await update($, shownAtom, was => (was === roomId ? '' : was))
}

async function bumpInputs($: Engine): Promise<void> {
  await update($, viewAtom, v => ({ ...v, inputGen: v.inputGen + 1 }))
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter(one => one !== id) : [...list, id]
}

export async function drawPane($: Engine, e: RenderInput<'Pane'>) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const profile = await read($, profileAtom)

  if (profile === null) {
    const form = await read($, draftAtom)

    return (
      <Box flexDirection="column">
        <Text bold>Team Room · настройка</Text>
        <Text dimColor>Один раз на этом компьютере. Комнаты добавишь потом.</Text>
        {Input === undefined ? (
          <Text>Настройка возможна только в приложении на компьютере.</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Input key="setup-name" label="Имя" placeholder="как подписывать тебя" value={form.name}
              onInput={v => update($, draftAtom, d => ({ ...d, name: v }))} onSubmit={() => saveSetup($)} />
            <Input key="setup-computer" label="Компьютер" value={form.computer}
              onInput={v => update($, draftAtom, d => ({ ...d, computer: v }))} onSubmit={() => saveSetup($)} />
            <Input key="setup-repo" label="Комната" placeholder="адрес репозитория, если тебя пригласили" value={form.repoUrl}
              onInput={v => update($, draftAtom, d => ({ ...d, repoUrl: v }))} onSubmit={() => saveSetup($)} />
            <Input key="setup-dir" label="Папка проекта" placeholder="необязательно" value={form.projectDir}
              onInput={v => update($, draftAtom, d => ({ ...d, projectDir: v }))} onSubmit={() => saveSetup($)} />
          </Box>
        )}
        {form.error !== '' && <Text color="error">{form.error}</Text>}
        <Box marginTop={1}>
          <Button key="setup-connect" variant="primary" label={form.isBusy ? 'Подключаю…' : 'Сохранить'}
            onPress={() => saveSetup($)} />
        </Box>
      </Box>
    )
  }

  const now = await $.clock.now()
  const rooms = await read($, roomsAtom)
  const cfg = await shownConfig($)
  const chatRoom = await read($, roomAtom)
  const view = await read($, viewAtom)
  const tab: Tab = cfg === null ? 'rooms' : view.tab
  const snap = cfg === null ? EMPTY_SNAPSHOT : (await read($, snapshotsAtom))[cfg.roomId] ?? EMPTY_SNAPSHOT
  const sync = cfg === null ? SYNC_INITIAL : (await read($, syncsAtom))[cfg.roomId] ?? SYNC_INITIAL
  const ownLimits = await read($, limitsAtom)
  const canWrite = cfg !== null && chatRoom === cfg.roomId
  const chatRoomTitle = rooms.find(room => room.id === chatRoom)?.title

  return (
    <Box flexDirection="column">
      <Text bold>Team Room{cfg !== null ? ` · ${cfg.roomTitle}` : ''}</Text>
      {rooms.length > 1 && (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {rooms.map(room => (
            <Button key={`room-${room.id}`} label={room.title} variant={room.id === cfg?.roomId ? 'primary' : 'secondary'}
              onPress={() => update($, shownAtom, () => room.id)} />
          ))}
        </Box>
      )}
      {cfg !== null && drawHeader(cfg)}
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        <Text>{chatRoomTitle !== undefined ? `Этот чат: комната «${chatRoomTitle}»` : 'Этот чат не подключён'}</Text>
        {chatRoomTitle !== undefined ? (
          <Button key="leave" plain dimColor label="Отключить" onPress={() => leaveSession($)} />
        ) : (
          cfg !== null && (
            <Button key="join" variant="primary" label={`Подключить к «${cfg.roomTitle}»`} onPress={() => joinSession($, cfg.roomId)} />
          )
        )}
        {cfg !== null && (
          <Button key="refresh" plain dimColor label="Обновить" onPress={() => syncNow($, cfg, canWrite ? 'full' : 'pull', true)} />
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {TABS.map(t => (
          <Button key={`tab-${t.tab}`} label={t.label} variant={tab === t.tab ? 'primary' : 'secondary'}
            onPress={() => update($, viewAtom, v => ({ ...v, tab: t.tab }))} />
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {tab === 'board' && cfg !== null && drawBoard(cfg)}
        {tab === 'tasks' && cfg !== null && drawTasks(cfg)}
        {tab === 'memory' && cfg !== null && drawMemory(cfg)}
        {tab === 'rooms' && (await drawRooms())}
      </Box>
    </Box>
  )

  function drawHeader(cfg: Config) {
    const syncLine = sync.isBusy
      ? 'синхронизация…'
      : sync.error !== ''
        ? `ошибка: ${sync.error}`
        : sync.at > 0
          ? `обновлено ${agoSeconds(now - sync.at)}`
          : 'ещё не синхронизировано'
    const people = snap.people.some(p => p.id === cfg.personId)
      ? snap.people
      : [...snap.people, { id: cfg.personId, name: cfg.name, computer: cfg.computer, limits: [], updatedAt: 0 }]

    return (
      <Box flexDirection="column">
        {sync.error !== '' ? <Text color="error">{syncLine}</Text> : <Text dimColor>{syncLine}</Text>}
        {people.map(p => (
          <Text dimColor>
            {p.name}: {formatLimits(p.id === cfg.personId && ownLimits.length > 0 ? ownLimits : p.limits)}
          </Text>
        ))}
      </Box>
    )
  }

  function drawBoard(cfg: Config) {
    const columns = boardOf(snap, cfg, now, view.isMine)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key="filter-mine" label="Мои" variant={view.isMine ? 'primary' : 'secondary'}
            onPress={() => update($, viewAtom, v => ({ ...v, isMine: true }))} />
          <Button key="filter-all" label="Все" variant={view.isMine ? 'secondary' : 'primary'}
            onPress={() => update($, viewAtom, v => ({ ...v, isMine: false }))} />
        </Box>
        {COLUMNS.map(col => (
          <Box key={`col-${col.status}`} flexDirection="column" marginTop={1}>
            <Text bold>
              {col.title} ({columns[col.status].length})
            </Text>
            {columns[col.status].map(card => drawCard(cfg, card))}
          </Box>
        ))}
      </Box>
    )
  }

  function drawCard(cfg: Config, card: BoardCard) {
    const isOpen = view.expanded.includes(card.id)
    const canEdit = card.personId === cfg.personId && canWrite

    return (
      <Box key={`card-${card.id}`} flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{card.title || 'Без названия'}</Text>
        <Text dimColor>
          {card.name} · {card.computer} · {ago(now - card.updatedAt)}
          {card.project !== '' ? ` · ${card.project}` : ''}
        </Text>
        {card.isStale && <Text color="warning">нет связи</Text>}
        {card.task !== undefined && <Text>Задача: {card.task.title}</Text>}
        {card.gist !== '' && <Text>{card.gist}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button key={`done-${card.id}`} plain label={`Сделано · ${card.done.length}`}
            onPress={() => update($, viewAtom, v => ({ ...v, expanded: toggle(v.expanded, card.id) }))} />
          {canEdit && (
            <Button key={`archive-${card.id}`} plain dimColor label="Убрать"
              onPress={() => markCard($, cfg, card.id, { archived: true })} />
          )}
        </Box>
        {isOpen && card.done.slice(-30).map(item => <Text dimColor>— {item.text}</Text>)}
        {canEdit && Input !== undefined ? (
          <Input key={`note-${card.id}-${view.inputGen}`} placeholder="Моя пометка" value={card.note}
            submitLabel="сохранить"
            onSubmit={async v => {
              await markCard($, cfg, card.id, { note: v.trim() })
              await bumpInputs($)
            }} />
        ) : (
          card.note !== '' && <Text italic>Пометка: {card.note}</Text>
        )}
      </Box>
    )
  }

  function drawTasks(cfg: Config) {
    const tasks = reduceTasks(snap.taskEvents)
    const open = tasks.filter(isActive)
    const done = tasks.filter(t => t.status === 'done').reverse()
    const titleOf = (sid: string) => snap.cards.find(card => card.id === sid)?.title
    const act = (change: TaskChange) => async () => {
      await addTaskEvent($, cfg, await read($, sessionIdAtom), change)
    }

    return (
      <Box flexDirection="column">
        {canWrite && Input !== undefined && (
          <Input key={`task-new-${view.inputGen}`} placeholder="Новая задача (обычно их пишет Claude)" submitLabel="добавить"
            onSubmit={async v => {
              const title = v.trim()
              if (title !== '') await addTaskEvent($, cfg, await read($, sessionIdAtom), { op: 'add', taskId: newId(), title })
              await bumpInputs($)
            }} />
        )}
        {open.length === 0 && <Text dimColor>Открытых задач нет.</Text>}
        {open.map(task => drawTask(task, titleOf, act))}
        {done.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Button key="tasks-done" plain dimColor label={`Сделано (${done.length})`}
              onPress={() => update($, viewAtom, v => ({ ...v, showDoneTasks: !v.showDoneTasks }))} />
            {view.showDoneTasks && done.map(task => drawTask(task, titleOf, act))}
          </Box>
        )}
      </Box>
    )

    function drawTask(task: Task, titleOf: (sid: string) => string | undefined, act: (change: TaskChange) => () => Promise<void>) {
      const isOpen = view.expanded.includes(`task-${task.id}`)
      const isEditing = view.editing === task.id
      const chats = task.sessions.map(titleOf).filter((t): t is string => t !== undefined && t !== '')
      const who = task.status === 'done'
        ? `сделал: ${task.takenBy ?? task.createdBy}`
        : task.takenBy === undefined ? 'свободна' : `взял: ${task.takenBy}`

      return (
        <Box key={`task-${task.id}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key={`task-more-${task.id}`} plain label={`${task.status === 'done' ? '✓ ' : ''}${task.title}`}
              onPress={() => update($, viewAtom, v => ({ ...v, expanded: toggle(v.expanded, `task-${task.id}`) }))} />
            <Text dimColor>{who}</Text>
            {task.byClaude && <Text dimColor>· Claude</Text>}
          </Box>
          {chats.length > 0 && <Text dimColor>из чата: {chats.join(', ')}</Text>}
          {isOpen && task.context !== '' && <Text>Контекст: {task.context}</Text>}
          {isOpen && task.result !== '' && <Text>Результат: {task.result}</Text>}
          {isOpen && task.files.length > 0 && <Text dimColor>файлы: {task.files.join(', ')}</Text>}
          {canWrite && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {task.status === 'open' && <Button key={`take-${task.id}`} plain label="Беру" onPress={act({ op: 'take', taskId: task.id })} />}
              {task.status === 'taken' && task.takenById === cfg.personId && (
                <Button key={`finish-${task.id}`} plain label="Готово" onPress={act({ op: 'done', taskId: task.id })} />
              )}
              {task.status === 'done' && <Button key={`reopen-${task.id}`} plain dimColor label="Снова открыть" onPress={act({ op: 'reopen', taskId: task.id })} />}
              <Button key={`edit-${task.id}`} plain dimColor label="Править"
                onPress={() => update($, viewAtom, v => ({ ...v, editing: v.editing === task.id ? '' : task.id }))} />
              <Button key={`drop-${task.id}`} plain dimColor label="Удалить" onPress={act({ op: 'drop', taskId: task.id })} />
            </Box>
          )}
          {canWrite && isEditing && Input !== undefined && (
            <Box flexDirection="column">
              <Input key={`edit-title-${task.id}-${view.inputGen}`} label="Название" value={task.title} submitLabel="сохранить"
                onSubmit={async v => {
                  await act({ op: 'edit', taskId: task.id, title: v.trim() })()
                  await bumpInputs($)
                }} />
              <Input key={`edit-context-${task.id}-${view.inputGen}`} label="Контекст" value={task.context} submitLabel="сохранить"
                onSubmit={async v => {
                  await act({ op: 'edit', taskId: task.id, context: v.trim() })()
                  await update($, viewAtom, w => ({ ...w, editing: '' }))
                  await bumpInputs($)
                }} />
            </Box>
          )}
        </Box>
      )
    }
  }

  function drawMemory(cfg: Config) {
    const entries = [...snap.memory].sort((a, b) => b.at - a.at).slice(0, 50)

    return (
      <Box flexDirection="column">
        {canWrite && Input !== undefined && (
          <Input key={`memory-new-${view.inputGen}`} placeholder="Запомнить…" submitLabel="записать"
            onSubmit={async v => {
              const said = v.trim()
              if (said !== '') await addMemory($, cfg, await read($, sessionIdAtom), { text: said, kind: 'manual' })
              await bumpInputs($)
            }} />
        )}
        {entries.length === 0 && <Text dimColor>В памяти пока пусто.</Text>}
        {entries.map(entry => (
          <Box key={`mem-${entry.id}`} flexDirection="column" marginTop={1}>
            <Text dimColor>
              {stamp(entry.at)} · {entry.name}
              {entry.personId === cfg.personId ? '' : ' (напарник)'}
              {entry.kind === 'manual' ? ' · вручную' : ''} · {ago(now - entry.at)}
            </Text>
            <Text>{entry.text}</Text>
            {entry.files !== undefined && entry.files.length > 0 && <Text dimColor>файлы: {entry.files.join(', ')}</Text>}
          </Box>
        ))}
      </Box>
    )
  }

  async function drawRooms() {
    const form = await read($, roomDraftAtom)
    const all = await read($, snapshotsAtom)

    return (
      <Box flexDirection="column">
        {rooms.length === 0 && <Text dimColor>Комнат пока нет. Создай свою или войди в ту, куда тебя пригласили.</Text>}
        {rooms.map(room => {
          const people = (all[room.id] ?? EMPTY_SNAPSHOT).people.map(p => p.name)

          return (
            <Box key={`roomrow-${room.id}`} flexDirection="column" borderStyle="round" paddingX={1}>
              <Text bold>{room.title}</Text>
              <Text dimColor>{room.repoUrl}</Text>
              {people.length > 0 && <Text dimColor>участники: {people.join(', ')}</Text>}
              {room.projectDir !== '' && <Text dimColor>папка: {room.projectDir}</Text>}
              <Button key={`room-remove-${room.id}`} plain dimColor label="Удалить у себя" onPress={() => forgetRoom($, room.id)} />
            </Box>
          )
        })}
        {form.error !== '' && <Text color="error">{form.error}</Text>}
        {form.invite !== '' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Отправь участникам:</Text>
            <Text>{form.invite}</Text>
          </Box>
        )}
        {Input !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Новая комната</Text>
            <Input key="room-new-title" label="Название" value={form.title}
              onInput={v => update($, roomDraftAtom, d => ({ ...d, title: v }))} onSubmit={() => makeRoom($)} />
            <Input key="room-new-members" label="Участники" placeholder="ники GitHub через запятую" value={form.members}
              onInput={v => update($, roomDraftAtom, d => ({ ...d, members: v }))} onSubmit={() => makeRoom($)} />
            <Input key="room-new-dir" label="Папка проекта" placeholder="необязательно" value={form.projectDir}
              onInput={v => update($, roomDraftAtom, d => ({ ...d, projectDir: v }))} onSubmit={() => makeRoom($)} />
            <Box>
              <Button key="room-create" variant="primary" label={form.isBusy ? 'Создаю…' : 'Создать комнату'} onPress={() => makeRoom($)} />
            </Box>
            <Text bold>Войти в комнату</Text>
            <Input key="room-join-url" label="Адрес" placeholder="https://github.com/…/….git" value={form.joinUrl}
              onInput={v => update($, roomDraftAtom, d => ({ ...d, joinUrl: v }))} onSubmit={() => goIntoRoom($)} />
            <Input key="room-join-dir" label="Папка проекта" placeholder="необязательно" value={form.joinDir}
              onInput={v => update($, roomDraftAtom, d => ({ ...d, joinDir: v }))} onSubmit={() => goIntoRoom($)} />
            <Box>
              <Button key="room-join" label={form.isBusy ? 'Подключаю…' : 'Войти в комнату'} onPress={() => goIntoRoom($)} />
            </Box>
          </Box>
        )}
      </Box>
    )
  }
}
