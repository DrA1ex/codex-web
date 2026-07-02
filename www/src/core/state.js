export const QUEUE_MOVE_ANIMATION_MS = 180;

export const state = {
  token: '',
  snap: null,
  clientNetwork: { status: 'connecting', message: 'connecting', updatedAt: 0 },

  expandedQueueItems: Object.create(null),
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
  activeQueueFilter: 'all',
  renderKeys: Object.create(null),

  confirmAction: null,
  scheduleOpen: false,
  scheduleDraft: null,
  mobileCollapsed: { header: false, limits: false, queue: false },

  queueDragId: null,
  queueDropBeforeId: undefined,

  composer: null,
  outputEl: null,
  compactHeaderQuery: null,
  queueMoveAnimationMs: QUEUE_MOVE_ANIMATION_MS,
};

export function initDomRefs() {
  state.token = window.CODEX_LIMIT_WATCH_TOKEN || '';
  state.composer = document.getElementById('composer');
  state.outputEl = document.getElementById('output');
  state.compactHeaderQuery = window.matchMedia ? window.matchMedia('(max-width: 1780px)') : null;
}
