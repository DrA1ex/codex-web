export function isCommandContext(text, caretIndex) {
  const value = String(text || '');
  const caret = Number.isFinite(caretIndex) ? caretIndex : value.length;
  if (!value.startsWith('/')) return false;
  if (caret < 1) return false;
  const firstLineEnd = value.indexOf('\n');
  if (firstLineEnd >= 0 && caret > firstLineEnd) return false;
  const firstSpace = value.search(/\s/);
  return firstSpace < 0 || caret <= firstSpace;
}

export function currentCommandPrefix(text, caretIndex) {
  if (!isCommandContext(text, caretIndex)) return '';
  return String(text || '').slice(0, caretIndex);
}

export function getCommandMatches(prefix, commandMetadata = []) {
  const raw = String(prefix || '');
  if (!raw.startsWith('/')) return [];
  return commandMetadata
    .filter((command) => command.autocomplete !== false && String(command.name || '').startsWith(raw))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function activeCommandMatch(state) {
  if (!state?.matches?.length) return null;
  return state.matches[((state.activeIndex % state.matches.length) + state.matches.length) % state.matches.length];
}

export function cycleCommandMatch(suggest, direction) {
  if (!suggest?.matches?.length) return suggest;
  const count = suggest.matches.length;
  return { ...suggest, activeIndex: Math.min(Math.max(suggest.activeIndex + direction, 0), count - 1) };
}

export function applyCommandCompletion(text, selectedCommand) {
  if (!selectedCommand?.name) return String(text || '');
  const value = String(text || '');
  const firstSpace = value.search(/\s/);
  const spacer = selectedCommand.requiresArgs ? ' ' : '';
  if (firstSpace < 0) return `${selectedCommand.name}${spacer}`;
  return `${selectedCommand.name}${value.slice(firstSpace)}`;
}

export function commandForInput(text, commandMetadata = []) {
  const first = String(text || '').trim().split(/\s+/, 1)[0];
  return commandMetadata.find((command) => command.name === first) || null;
}

export function getArgumentHint(command, currentText = '') {
  if (!command?.argumentHint) return '';
  const text = String(currentText || '').trim();
  if (!text.startsWith(command.name)) return '';
  const rest = text.slice(command.name.length).trim();
  return rest ? '' : command.argumentHint;
}

export function commandHintText(command, currentText = '') {
  const parts = commandHintParts(command, currentText);
  if (!parts) return '';
  return [parts.behavior, parts.command, parts.description].filter(Boolean).join(' — ');
}

export function commandHintParts(command, currentText = '') {
  if (!command) return '';
  const hint = getCommandDisplayArgumentHint(command, currentText);
  const commandText = `${command.name}${hint ? ` ${hint}` : ''}`;
  const behavior = commandBehaviorHint(command, currentText);
  return {
    behavior,
    command: commandText,
    description: command.shortDescription || '',
  };
}

function getCommandDisplayArgumentHint(command, currentText = '') {
  const hint = command?.displayArgumentHint || command?.argumentHint || '';
  if (!hint) return '';

  const text = String(currentText || '').trim();
  if (!text) return hint;
  if (text.startsWith(command.name)) return hint;

  const firstToken = text.split(/\s+/, 1)[0];
  return command.name.startsWith(firstToken) ? hint : '';
}

function commandBehaviorHint(command, currentText = '') {
  const name = command?.name || '';
  const text = String(currentText || '').trim();
  const hasArgs = text.length > name.length && text.slice(name.length).trim().length > 0;

  if (name === '/compact') return 'Queued';
  if (name === '/schedule') return hasArgs ? 'Runs now' : 'Opens dialog';
  if (name === '/think') return 'Steers active prompt';
  if (name === '/think!') return 'Interrupts active prompt';
  if (name === '/quit') return 'Stops Codex Web';
  if (name === '/stop') return 'Runs now';
  if (name === '/help') return 'Opens dialog';
  if (command?.execution === 'queued') return 'Queued';
  if (command?.execution === 'frontend-only') return 'Opens UI';
  if (command?.execution === 'steer') return 'Steers active prompt';
  if (command?.execution === 'backend-executed') return 'Runs now';
  return '';
}

export function isCommandNameComplete(text, command) {
  return !!command && String(text || '').trim().split(/\s+/, 1)[0] === command.name;
}

export function hasRequiredArguments(command, text) {
  if (!command?.requiresArgs) return true;
  const value = String(text || '').trim();
  return value.length > String(command.name || '').length && value.slice(command.name.length).trim().length > 0;
}

export function buildSuggestState(text, caretIndex, commandMetadata, previous = {}) {
  const value = String(text || '');
  if (value.includes('\n') && value.trim()) {
    return {
      open: false,
      matches: [],
      activeIndex: 0,
      prefix: '',
      suffix: '',
      argumentHint: '',
      argumentMissing: false,
    };
  }

  const prefix = currentCommandPrefix(text, caretIndex);
  if (!prefix) {
    const command = commandForInput(text, commandMetadata);
    return {
      open: false,
      matches: [],
      activeIndex: 0,
      prefix: '',
      suffix: '',
      argumentHint: getArgumentHint(command, text),
      argumentMissing: false,
    };
  }

  const matches = getCommandMatches(prefix, commandMetadata);
  if (!matches.length) return { open: false, matches: [], activeIndex: 0, prefix, suffix: '', argumentHint: '', argumentMissing: false };

  const previousName = previous.matches?.[previous.activeIndex]?.name || '';
  let activeIndex = matches.findIndex((command) => command.name === previousName);
  if (activeIndex < 0) activeIndex = 0;
  const active = matches[activeIndex];
  const suffix = active.name.slice(prefix.length);
  const open = Boolean(suffix || matches.length > 1);

  return {
    open,
    matches,
    activeIndex,
    prefix,
    suffix,
    argumentHint: suffix ? '' : getArgumentHint(active, text),
    argumentMissing: false,
  };
}
