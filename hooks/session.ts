// The person's rooms, and which room this chat is in: the one whose project
// folder holds it, or the one it was joined to by hand.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Config, Profile, Room } from '../types'
import { readOwnCard, scheduleSync, writePerson } from './io'
import { EMPTY_INJECTED, REMEMBER_TOOL_SPEC, TASK_TOOL_SPEC, configOf, migrate, roomByFolder } from './model'

const profileAtom = atom({ plugin: 'team-room', key: 'profile' } as const, null)
const roomsAtom = atom({ plugin: 'team-room', key: 'rooms' } as const, [])
const sessionIdAtom = atom({ plugin: 'team-room', key: 'sessionId' } as const, '')
const roomAtom = atom({ plugin: 'team-room', key: 'room' } as const, '')
const shownAtom = atom({ plugin: 'team-room', key: 'shown' } as const, '')
const cardAtom = atom({ plugin: 'team-room', key: 'card' } as const, null)
const injectedAtom = atom({ plugin: 'team-room', key: 'injected' } as const, EMPTY_INJECTED)

type Engine = EngineInterface

export const PANE = 'team-room'

async function leftList($: Engine): Promise<string[]> {
  const value = await $.store.get('left')

  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

async function joinedMap($: Engine): Promise<Record<string, string>> {
  const value = await $.store.get('joined')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
}

// Reads the settings, turning v1's single room into the first of the list.
export async function loadSettings($: Engine): Promise<{ profile: Profile | null; rooms: Room[] }> {
  const got = migrate({
    config: await $.store.get('config'),
    profile: await $.store.get('profile'),
    rooms: await $.store.get('rooms'),
    joined: await $.store.get('joined'),
  })
  if (got.isMigrated) {
    await $.store.set('profile', got.profile)
    await $.store.set('rooms', got.rooms)
    await $.store.set('joined', got.joined)
  }
  await update($, profileAtom, () => got.profile)
  await update($, roomsAtom, () => got.rooms)

  return { profile: got.profile, rooms: got.rooms }
}

export async function saveProfile($: Engine, profile: Profile): Promise<void> {
  await $.store.set('profile', profile)
  await update($, profileAtom, () => profile)
}

export async function saveRooms($: Engine, rooms: Room[]): Promise<void> {
  await $.store.set('rooms', rooms)
  await update($, roomsAtom, () => rooms)
}

export async function roomFor($: Engine, sid: string, dirs: readonly string[]): Promise<Room | undefined> {
  const rooms = await read($, roomsAtom)
  if ((await leftList($)).includes(sid)) {
    return undefined
  }
  const byHand = (await joinedMap($))[sid]
  const joined = byHand === undefined ? undefined : rooms.find(room => room.id === byHand)

  return joined ?? roomByFolder(rooms, dirs)
}

export async function configFor($: Engine, roomId: string): Promise<Config | null> {
  const profile = await read($, profileAtom)
  const room = (await read($, roomsAtom)).find(one => one.id === roomId)

  return profile === null || room === undefined ? null : configOf(profile, room)
}

// The chat's own room, the one it writes to.
export async function chatConfig($: Engine): Promise<Config | null> {
  const roomId = await read($, roomAtom)

  return roomId === '' ? null : configFor($, roomId)
}

// The room the pane shows: the chosen one, else the chat's, else the first.
export async function shownConfig($: Engine): Promise<Config | null> {
  const rooms = await read($, roomsAtom)
  const chosen = await read($, shownAtom)
  const own = await read($, roomAtom)
  const id = [chosen, own, rooms[0]?.id ?? ''].find(one => one !== '' && rooms.some(room => room.id === one)) ?? ''

  return id === '' ? null : configFor($, id)
}

export async function openPane($: Engine): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Team Room' })
}

export async function registerTools($: Engine): Promise<void> {
  try {
    await $.tool.register(TASK_TOOL_SPEC)
    await $.tool.register(REMEMBER_TOOL_SPEC)
  } catch {
    // Not bound yet: session.start registers them again.
  }
}

// Puts the chat in a room as it stands now (at start, or after a join).
export async function enter($: Engine, cfg: Config): Promise<void> {
  const sid = await read($, sessionIdAtom)
  const was = await read($, roomAtom)
  await update($, roomAtom, () => cfg.roomId)
  await update($, shownAtom, () => cfg.roomId)
  if (was !== cfg.roomId) {
    await update($, injectedAtom, () => EMPTY_INJECTED)
  }
  const own = await readOwnCard($, cfg, sid)
  await update($, cardAtom, () => own)
  await registerTools($)
}

export async function joinSession($: Engine, roomId: string): Promise<Config | null> {
  const cfg = await configFor($, roomId)
  const sid = await read($, sessionIdAtom)
  if (cfg === null || sid === '') {
    return null
  }
  const joined = await joinedMap($)
  await $.store.set('joined', Object.fromEntries([...Object.entries(joined).filter(([id]) => id !== sid), [sid, roomId]].slice(-500)))
  await $.store.set('left', (await leftList($)).filter(id => id !== sid))
  await enter($, cfg)
  await writePerson($, cfg)
  scheduleSync($, cfg)

  return cfg
}

export async function leaveSession($: Engine): Promise<void> {
  const sid = await read($, sessionIdAtom)
  if (sid === '') {
    return
  }
  const joined = await joinedMap($)
  delete joined[sid]
  await $.store.set('joined', joined)
  await $.store.set('left', [...new Set([...(await leftList($)), sid])].slice(-500))
  await update($, roomAtom, () => '')
  await update($, cardAtom, () => null)
}
