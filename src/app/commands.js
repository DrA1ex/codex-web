'use strict';

const COMMAND_HELP = [
  {
    command: '/think <text>',
    short: 'Steer the active prompt.',
    details: 'Sends a note to the currently running turn with turn/steer. Use it when the model is working but you want to adjust direction after the next tool boundary. It does not create a queue item, change queue order, or mark the active queue item failed.',
    examples: [
      '/think Focus on the queue-state bug first.',
      '/think Ignore the styling change for now and finish the tests.',
    ],
    kind: 'Active prompt',
  },
  {
    command: '/think! <text>',
    short: 'Interrupt and send a correction.',
    details: 'Interrupts the active turn and sends the text as a follow-up prompt. Use it only when the current direction should be stopped immediately. If limits are unavailable, Codex Web asks for confirmation before interrupting because the correction may need to wait.',
    examples: [
      '/think! Stop this approach. Rework it through the backend event flow.',
    ],
    kind: 'Active prompt',
  },
  {
    command: '/compact',
    short: 'Compact the current session context.',
    details: 'Adds a queued command that asks the Codex app-server to compact the current session. It runs in queue order, reports compact usage, and the queue continues after compaction completes.',
    examples: [
      '/compact',
    ],
    kind: 'Queue command',
  },
  {
    command: '/pause',
    short: 'Pause automatic queue processing.',
    details: 'Stops countdowns and prevents the queue from sending the next pending item until you resume it. Existing active work is not interrupted by this command.',
    examples: [
      '/pause',
    ],
    kind: 'Queue control',
  },
  {
    command: '/resume',
    short: 'Resume queue processing.',
    details: 'Restarts automatic processing. During a manual send, it arms continuation so the queue resumes after the active prompt finishes.',
    examples: [
      '/resume',
    ],
    kind: 'Queue control',
  },
  {
    command: '/undo',
    short: 'Restore the last pending prompt to the composer.',
    details: 'Removes the newest pending queue item and puts its text back into the composer so it can be edited or sent again. It does not affect running or completed items.',
    examples: [
      '/undo',
    ],
    kind: 'Queue edit',
  },
  {
    command: '/clear',
    short: 'Clear pending queue items.',
    details: 'Removes all pending prompts from the queue. Completed, failed, cancelled, interrupted, and running items are left untouched.',
    examples: [
      '/clear',
    ],
    kind: 'Queue edit',
  },
  {
    command: '/send',
    short: 'Show how to send a prompt.',
    details: 'This is accepted only as a standalone helper command. To send text, type the prompt itself and press Cmd+Enter/Ctrl+Enter or use the buttons.',
    examples: [
      '/send',
      'Fix the queue rendering bug.',
    ],
    kind: 'Composer',
  },
  {
    command: '/approve',
    short: 'Approve the current request once.',
    details: 'Responds to the current approval request with a one-time accept decision. Use it when the approval prompt is visible and you want to allow only this specific action.',
    examples: [
      '/approve',
    ],
    kind: 'Approval',
  },
  {
    command: '/approve-session',
    short: 'Approve requests for the session.',
    details: 'Responds to the current approval request with an accept-for-session decision when the app-server supports it. This is useful for repeated similar actions in the same session.',
    examples: [
      '/approve-session',
    ],
    kind: 'Approval',
  },
  {
    command: '/decline',
    short: 'Decline the current approval request.',
    details: 'Responds to the current approval request with a decline decision. The active turn can continue only if the app-server can recover from the declined action.',
    examples: [
      '/decline',
    ],
    kind: 'Approval',
  },
  {
    command: '/cancel',
    short: 'Cancel the current approval request.',
    details: 'Responds to the current approval request with a cancel decision. Use it when you want to stop the pending approval flow rather than approve or decline it.',
    examples: [
      '/cancel',
    ],
    kind: 'Approval',
  },
  {
    command: '/quit',
    short: 'Stop Codex Web.',
    details: 'Shuts down the local web server and the Codex app-server process. Open a new codex-web instance to continue after this command.',
    examples: [
      '/quit',
    ],
    kind: 'Server',
  },
  {
    command: '/help',
    short: 'Show this command reference.',
    details: 'Opens the command help dialog with short descriptions, detailed explanations, and examples for every supported command.',
    examples: [
      '/help',
    ],
    kind: 'Help',
  },
];

function commandHelpPayload() {
  return COMMAND_HELP.map((entry) => ({ ...entry }));
}

module.exports = {
  COMMAND_HELP,
  commandHelpPayload,
};
