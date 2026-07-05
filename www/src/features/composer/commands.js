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

function emptySuggestState(overrides = {}) {
  return {
    open: false,
    matches: [],
    activeIndex: 0,
    prefix: '',
    suffix: '',
    argumentHint: '',
    argumentMissing: false,
    mode: 'command',
    command: null,
    anchorIndex: String(overrides.text || '').length,
    ...overrides,
  };
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

export function completionValue(match) {
  return String(match?.completion || match?.value || match?.name || '');
}

export function completionLabel(match) {
  return String(match?.label || completionValue(match));
}

export function cycleCommandMatch(suggest, direction) {
  if (!suggest?.matches?.length) return suggest;
  const count = suggest.matches.length;
  return { ...suggest, activeIndex: Math.min(Math.max(suggest.activeIndex + direction, 0), count - 1) };
}

export function applyCommandCompletion(text, selectedCommand) {
  if (!selectedCommand) return String(text || '');
  const value = String(text || '');

  if (selectedCommand.type === 'option') {
    const command = selectedCommand.command;
    const option = completionValue(selectedCommand);
    if (!command?.name || !option) return value;
    return `${command.name} ${option}`;
  }

  if (!selectedCommand?.name) return value;
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

export function commandHintParts(command, currentText = '', option = null) {
  if (!command) return '';
  const hint = getCommandDisplayArgumentHint(command, currentText);
  const optionValue = option ? completionValue(option) : '';
  const commandText = optionValue ? `${command.name} ${optionValue}` : `${command.name}${hint ? ` ${hint}` : ''}`;
  const behavior = commandBehaviorHint(command, currentText);
  return {
    behavior,
    command: commandText,
    description: option?.description || command.shortDescription || '',
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

function commandTokenForText(value) {
  const match = String(value || '').match(/^\/\S*/);
  return match ? match[0] : '';
}

function getOptionMatches(command, prefix = '') {
  const raw = String(prefix || '');
  const descriptions = command?.optionDescriptions || {};
  return (command?.options || [])
    .filter((option) => String(option).startsWith(raw))
    .map((option) => ({
      type: 'option',
      value: String(option),
      completion: String(option),
      label: String(option),
      description: descriptions[option] || '',
      command,
    }));
}

function shortPreview(value, limit = 96) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function getQueueIdMatches(command, prefix = '', queueItems = []) {
  if (!['/send', '/next'].includes(command?.name)) return [];
  const raw = String(prefix || '');
  return (queueItems || [])
    .filter((item) => ['pending', 'next'].includes(item?.status))
    .filter((item) => String(item?.id || '').startsWith(raw))
    .map((item) => ({
      type: 'option',
      value: String(item.id),
      completion: String(item.id),
      label: String(item.id),
      description: shortPreview(item.text) || `Queue item ${item.id}`,
      command,
    }));
}

function getArgumentMatches(command, prefix = '', context = {}) {
  const optionMatches = getOptionMatches(command, prefix);
  if (optionMatches.length || command?.options?.length) return optionMatches;
  return getQueueIdMatches(command, prefix, context.queueItems || []);
}

function selectedOptionForText(command, value) {
  if (!command?.options?.length) return null;
  const commandToken = commandTokenForText(value);
  if (commandToken !== command.name) return null;
  const rest = String(value || '').slice(command.name.length);
  const argument = rest.trim().split(/\s+/, 1)[0] || '';
  if (!argument) return null;
  return getOptionMatches(command, argument).find((option) => option.value === argument) || null;
}

export function buildSuggestState(text, caretIndex, commandMetadata, previous = {}, context = {}) {
  const value = String(text || '');
  if (value.includes('\n') && value.trim()) {
    return emptySuggestState({ text: value });
  }

  if (!value.startsWith('/')) return emptySuggestState({ text: value });

  const commandToken = commandTokenForText(value);
  if (!commandToken) return emptySuggestState({ text: value });

  const hasCommandSpace = /\s/.test(value.slice(commandToken.length, commandToken.length + 1));
  const command = commandMetadata.find((entry) => entry.name === commandToken) || null;

  if (hasCommandSpace && command) {
    const rest = value.slice(commandToken.length);
    const leading = rest.match(/^\s*/)?.[0] || '';
    const argumentText = rest.slice(leading.length);
    const argument = argumentText.match(/^\S*/)?.[0] || '';
    const trailing = argumentText.slice(argument.length);

    if (trailing.trim()) {
      return emptySuggestState({
        text: value,
        command,
        mode: 'option',
        anchorIndex: commandToken.length + leading.length + argument.length,
      });
    }

    const matches = getArgumentMatches(command, argument, context);
    if (!matches.length) {
      return emptySuggestState({
        text: value,
        command,
        mode: 'option',
        prefix: argument,
        anchorIndex: commandToken.length + leading.length + argument.length,
      });
    }

    const previousValue = previous.mode === 'option' ? completionValue(previous.matches?.[previous.activeIndex]) : '';
    let activeIndex = matches.findIndex((option) => option.value === previousValue);
    if (activeIndex < 0) activeIndex = 0;
    const active = matches[activeIndex];
    const suffix = active.value.slice(argument.length);
    return emptySuggestState({
      text: value,
      open: Boolean(suffix || matches.length > 1),
      matches,
      activeIndex,
      prefix: argument,
      suffix,
      mode: 'option',
      command,
      anchorIndex: commandToken.length + leading.length + argument.length,
    });
  }

  const matches = getCommandMatches(commandToken, commandMetadata);
  if (!matches.length) {
    return emptySuggestState({
      text: value,
      prefix: commandToken,
      anchorIndex: commandToken.length,
    });
  }

  const previousName = previous.mode === 'command' ? previous.matches?.[previous.activeIndex]?.name || '' : '';
  let activeIndex = matches.findIndex((command) => command.name === previousName);
  if (activeIndex < 0) activeIndex = 0;
  const active = matches[activeIndex];
  const suffix = active.name.slice(commandToken.length);
  const open = Boolean(suffix || matches.length > 1);
  const rest = value.slice(commandToken.length);
  const anchorIndex = active.name === commandToken && /^\s*$/.test(rest)
    ? value.length
    : commandToken.length;

  return emptySuggestState({
    text: value,
    open,
    matches,
    activeIndex,
    prefix: commandToken,
    suffix,
    argumentHint: suffix ? '' : getArgumentHint(active, text),
    mode: 'command',
    command: active,
    anchorIndex,
    selectedOption: command ? selectedOptionForText(command, value) : null,
  });
}
