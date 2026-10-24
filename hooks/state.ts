// Initial values of the session's named values. The atoms themselves are
// declared in each file that reads them: the engine reads their plugin and
// key off that file's own source.

import type { Draft, RoomDraft, SyncStatus, TurnState, View } from '../types'

export const SYNC_INITIAL: SyncStatus = { at: 0, error: '', isBusy: false }

export const VIEW_INITIAL: View = {
  tab: 'board',
  isMine: true,
  expanded: [],
  showDoneTasks: false,
  editing: '',
  inputGen: 0,
}

export const DRAFT_INITIAL: Draft = {
  name: '',
  computer: '',
  repoUrl: '',
  projectDir: '',
  error: '',
  isBusy: false,
}

export const ROOM_DRAFT_INITIAL: RoomDraft = {
  title: '',
  members: '',
  projectDir: '',
  joinUrl: '',
  joinDir: '',
  error: '',
  isBusy: false,
  invite: '',
}

export const TURN_INITIAL: TurnState = {
  prompt: '',
  files: [],
  hasToolError: false,
  startedAt: 0,
  isRunning: false,
  toolTaskIds: [],
  hasToolStart: false,
}
