export const QUEUE_MOVE_ANIMATION_MS = 180;

export const state = {
  token: '',
  snap: null,
  clientNetwork: { status: 'connecting', message: 'connecting', updatedAt: 0 },

  expandedQueueItems: Object.create(null),
  completedQueueArchiveLevel: 0,
  completedArchiveCache: {
    sessionId: '',
    items: [],
    hasMore: false,
    totalCompleted: 0,
    cursor: null,
    loading: false,
  },
  editingQueueItemId: null,
  editDrafts: Object.create(null),
  savingQueueEdits: Object.create(null),
  pendingEditFocusId: null,

  pendingQueueScrollId: null,
  pendingQueueScrollKind: '',
  pendingQueueScrollReady: false,
  pendingQueueScrollTimer: null,
  queueFlashId: null,
  didInitialQueueScroll: false,

  expandedDiffOutput: Object.create(null),
  expandedToolOutput: Object.create(null),
  expandedOutputGroups: Object.create(null),
  outputUnread: false,
  activeQueueFilter: 'all',
  renderKeys: Object.create(null),
  lastNoticeKey: '',
  noticeTimer: null,
  noticeArmed: false,
  previousNoticeSnapshot: null,

  confirmAction: null,
  modalMessage: null,
  help: {
    open: false,
    commands: [],
  },
  expandedHelpCommands: Object.create(null),
  limitReset: {
    open: false,
    loading: false,
    error: '',
    request: null,
  },
  limitResetTimer: null,
  limitResetSerial: 0,
  scheduleOpen: false,
  scheduleDraft: null,
  mobileCollapsed: { header: false, limits: false, queue: false, output: false },

  queueDragId: null,
  queueDropBeforeId: undefined,
  queueTouchDragId: null,

  composer: null,
  composerGhost: null,
  composerCommandStack: null,
  composerArgHint: null,
  composerCommands: [],
  composerSuggest: { open: false, matches: [], activeIndex: 0, prefix: '', suffix: '', argumentHint: '', argumentMissing: false, mode: 'command', command: null, anchorIndex: 0 },
  composerSuggestDismissedText: null,
  outputEl: null,
  compactHeaderQuery: null,
  queueMoveAnimationMs: QUEUE_MOVE_ANIMATION_MS,
};

export function initDomRefs() {
  state.token = window.CODEX_LIMIT_WATCH_TOKEN || '';
  state.composer = document.getElementById('composer');
  state.composerGhost = document.getElementById('composerGhost');
  state.composerCommandStack = document.getElementById('composerCommandStack');
  state.composerArgHint = document.getElementById('composerArgHint');
  state.outputEl = document.getElementById('output');
  state.compactHeaderQuery = window.matchMedia ? window.matchMedia('(max-width: 1780px)') : null;
}
