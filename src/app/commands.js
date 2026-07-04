'use strict';

const COMMAND_HELP = [
  {
    command: '/think <text>',
    short: 'Steer the active prompt.',
    details: 'Sends a note to the currently running turn with turn/steer. It does not create a queue item, change queue order, or mark the active queue item failed.',
    kind: 'Active prompt',
  },
  {
    command: '/think! <text>',
    short: 'Interrupt and send a correction.',
    details: 'Interrupts the active turn and sends the text as a follow-up prompt. If limits are unavailable, Codex Web asks for confirmation before interrupting because the correction may need to wait.',
    kind: 'Active prompt',
  },
  {
    command: '/compact',
    short: 'Compact the current session context.',
    details: 'Adds a queued command that asks the Codex app-server to compact the current session. The queue continues after compaction completes.',
    kind: 'Queue command',
  },
  {
    command: '/pause',
    short: 'Pause automatic queue processing.',
    details: 'Stops countdowns and prevents the queue from sending the next pending item until you resume it.',
    kind: 'Queue control',
  },
  {
    command: '/resume',
    short: 'Resume queue processing.',
    details: 'Restarts automatic processing. During a manual send, it arms continuation so the queue resumes after the active prompt finishes.',
    kind: 'Queue control',
  },
  {
    command: '/undo',
    short: 'Restore the last pending prompt to the composer.',
    details: 'Removes the newest pending queue item and puts its text back into the composer so it can be edited or sent again.',
    kind: 'Queue edit',
  },
  {
    command: '/clear',
    short: 'Clear pending queue items.',
    details: 'Removes all pending prompts from the queue. Completed, failed, cancelled, and running items are left untouched.',
    kind: 'Queue edit',
  },
  {
    command: '/send',
    short: 'Show how to send a prompt.',
    details: 'This is accepted only as a standalone helper command. To send text, type the prompt itself and press Cmd+Enter/Ctrl+Enter or use the buttons.',
    kind: 'Composer',
  },
  {
    command: '/approve',
    short: 'Approve the current request once.',
    details: 'Responds to the current approval request with a one-time accept decision.',
    kind: 'Approval',
  },
  {
    command: '/approve-session',
    short: 'Approve requests for the session.',
    details: 'Responds to the current approval request with an accept-for-session decision when the app-server supports it.',
    kind: 'Approval',
  },
  {
    command: '/decline',
    short: 'Decline the current approval request.',
    details: 'Responds to the current approval request with a decline decision.',
    kind: 'Approval',
  },
  {
    command: '/cancel',
    short: 'Cancel the current approval request.',
    details: 'Responds to the current approval request with a cancel decision.',
    kind: 'Approval',
  },
  {
    command: '/quit',
    short: 'Stop Codex Web.',
    details: 'Shuts down the local web server and the Codex app-server process.',
    kind: 'Server',
  },
  {
    command: '/help',
    short: 'Show this command reference.',
    details: 'Opens the command help dialog with short descriptions and expandable details.',
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
