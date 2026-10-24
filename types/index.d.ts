export type RateLimit = { label: string; percent: number; resetsAt?: string }

export type Person = {
  id: string
  name: string
  computer: string
  limits: RateLimit[]
  updatedAt: number
}

export type CardStatus = 'working' | 'attention' | 'done'

export type DoneItem = { at: number; text: string }

export type Card = {
  id: string
  personId: string
  name: string
  computer: string
  title: string
  isTitleGuess?: boolean
  gist: string
  status: CardStatus
  done: DoneItem[]
  note: string
  model: string
  project: string
  startedAt: number
  updatedAt: number
  archived: boolean
}

export type MemoryEntry = {
  id: string
  at: number
  personId: string
  name: string
  sessionId: string
  text: string
  kind: 'auto' | 'manual'
  files?: string[]
}

// v1 wrote add/take/done/reopen/drop; v2 adds start/update/edit.
export type TaskOp = 'add' | 'start' | 'take' | 'update' | 'edit' | 'done' | 'reopen' | 'drop'

export type TaskEvent = {
  id: string
  at: number
  personId: string
  name: string
  op: TaskOp
  taskId: string
  title?: string
  context?: string
  result?: string
  files?: string[]
  sessionId?: string
  byClaude?: boolean
}

export type TaskStatus = 'open' | 'taken' | 'done' | 'dropped'

export type Task = {
  id: string
  title: string
  context: string
  result: string
  status: TaskStatus
  createdById: string
  createdBy: string
  createdAt: number
  updatedAt: number
  takenById?: string
  takenBy?: string
  doneAt?: number
  byClaude: boolean
  files: string[]
  sessions: string[]
}

export type BoardMarks = { notes: Record<string, string>; archived: string[] }

export type Profile = { personId: string; name: string; computer: string }

export type Room = {
  id: string
  title: string
  repoUrl: string
  repoName: string
  cloneDir: string
  projectDir: string
}

// A room as seen by one person: what every read and write of its data needs.
export type Config = Profile & {
  roomId: string
  roomTitle: string
  repoUrl: string
  repoName: string
  projectDir: string
  cloneDir: string
}

export type Snapshot = {
  people: Person[]
  cards: Card[]
  memory: MemoryEntry[]
  taskEvents: TaskEvent[]
  marks: Record<string, BoardMarks>
  loadedAt: number
}

export type SyncStatus = { at: number; error: string; isBusy: boolean }

export type Tab = 'board' | 'tasks' | 'memory' | 'rooms'

export type View = {
  tab: Tab
  isMine: boolean
  expanded: string[]
  showDoneTasks: boolean
  editing: string
  inputGen: number
}

export type Draft = {
  name: string
  computer: string
  repoUrl: string
  projectDir: string
  error: string
  isBusy: boolean
}

export type RoomDraft = {
  title: string
  members: string
  projectDir: string
  joinUrl: string
  joinDir: string
  error: string
  isBusy: boolean
  invite: string
}

export type TurnState = {
  prompt: string
  files: string[]
  hasToolError: boolean
  startedAt: number
  isRunning: boolean
  toolTaskIds?: string[]
  hasToolStart?: boolean
}

// A finished turn whose card line and memory entry are not written yet.
export type Pending = {
  sessionId: string
  roomId: string
  prompt: string
  answer: string
  reason: string
  files: string[]
  hasToolError: boolean
  toolTaskIds: string[]
  hasToolStart: boolean
  at: number
}

export type Injected = {
  memory: string[]
  taskEvents: string[]
  cards: Record<string, string>
  count: number
  currentTask?: string
}

declare module 'claude-code' {
  interface PluginState {
    'team-room': {
      profile: Profile | null
      rooms: Room[]
      sessionId: string
      room: string
      shown: string
      snapshots: Record<string, Snapshot>
      syncs: Record<string, SyncStatus>
      view: View
      draft: Draft
      roomDraft: RoomDraft
      card: Card | null
      turn: TurnState
      injected: Injected
      limits: RateLimit[]
      pending: Pending | null
    }
  }
}
