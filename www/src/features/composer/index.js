import { state } from '#core/state';
import { api, getCommandMetadata, getState, isNetworkError, writeOutputError } from '#core/api';
import { setButtonState } from '#ui/header';
import { openConfirm, openMessage } from '#ui/confirm';
import { openHelp } from '#ui/help';
import { openScheduleModal } from '#ui/schedule';
import { requestQueueScroll } from '#features/queue';
import {
  activeCommandMatch,
  applyCommandCompletion,
  buildSuggestState,
  commandHintParts,
  commandForInput,
  completionLabel,
  completionValue,
  cycleCommandMatch,
  hasRequiredArguments,
  isCommandNameComplete,
} from './commands.js';

function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : 'unknown';
}

function applyComposerResponse(response) {
  const composer = state.composer;
  if (!composer) return;

  if (response.clearComposer) composer.value = '';
  if (response.composerText !== undefined) composer.value = response.composerText;
  autosizeComposer();
  updateAutocomplete();
}

function handleComposerResponse(response) {
  if (response.help?.commands) openHelp(response.help.commands);
  if (response.openScheduleModal) openScheduleModal();
  applyComposerResponse(response);
  if (response.message && !response.commandError) openMessage('Composer', response.message);
}

function handleComposerError(error) {
  if (isNetworkError(error)) return;
  writeOutputError(error);
}

export function updateCounter() {
  const composer = state.composer;
  if (!composer) return;

  const text = composer.value;
  const lines = text ? text.split(/\r?\n/).length : 0;
  const counter = document.getElementById('counter');

  if (counter) {
    const context = formatCount(state.snap?.app?.contextTokens);
    counter.textContent = `Context: ${context} · Lines: ${lines} · Chars: ${text.length}`;
  }
  setButtonState('addBtn', !text.trim(), false);
}

export function autosizeComposer() {
  const composer = state.composer;
  if (!composer) return;
  const style = window.getComputedStyle(composer);
  const minHeight = Number.parseFloat(style.minHeight) || 0;
  const rawMaxHeight = Number.parseFloat(style.maxHeight) || Number.POSITIVE_INFINITY;
  const maxHeight = Math.max(rawMaxHeight, minHeight);
  composer.style.height = 'auto';
  const nextHeight = clamp(composer.scrollHeight, minHeight, maxHeight);
  composer.style.height = `${nextHeight}px`;
  renderGhost();
}

export async function loadComposerCommands() {
  const response = await getCommandMetadata().catch(() => null);
  if (response?.commands) {
    state.composerCommands = response.commands;
    updateAutocomplete();
  }
}

function hideAutocomplete() {
  state.composerSuggestDismissedText = state.composer?.value ?? '';
  state.composerSuggest = { open: false, matches: [], activeIndex: 0, prefix: '', suffix: '', argumentHint: '', argumentMissing: false, mode: 'command', command: null, anchorIndex: 0 };
  renderGhost();
}

function updateAutocomplete() {
  const composer = state.composer;
  if (!composer) return;

  if (composer.value !== state.composerSuggestDismissedText) {
    state.composerSuggestDismissedText = null;
  }

  if (composer.value === state.composerSuggestDismissedText || isMultilineCommandSuppressed(composer.value)) {
    state.composerSuggest = { open: false, matches: [], activeIndex: 0, prefix: '', suffix: '', argumentHint: '', argumentMissing: false, mode: 'command', command: null, anchorIndex: composer.value.length };
    renderGhost();
    return;
  }

  state.composerSuggest = buildSuggestState(composer.value, composer.selectionStart || 0, state.composerCommands, state.composerSuggest);
  renderGhost();
}

function isMultilineCommandSuppressed(text) {
  const value = String(text || '');
  return value.includes('\n') && value.trim().length > 0;
}

function ensureCaretProbe() {
  let probe = document.getElementById('composerCaretProbe');
  if (probe) return probe;
  probe = document.createElement('div');
  probe.id = 'composerCaretProbe';
  probe.className = 'composer-caret-probe';
  document.body.appendChild(probe);
  return probe;
}

function copyTextareaMetrics(source, target) {
  const style = window.getComputedStyle(source);
  for (const name of ['font', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'whiteSpace', 'wordBreak']) {
    target.style[name] = style[name];
  }
  target.style.width = `${source.clientWidth}px`;
}

function caretCoordinates(textarea, anchorIndex = null) {
  const probe = ensureCaretProbe();
  copyTextareaMetrics(textarea, probe);
  probe.style.boxSizing = 'border-box';
  probe.style.overflowWrap = 'break-word';
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  const offset = Number.isFinite(anchorIndex) ? anchorIndex : textarea.selectionStart || 0;
  const text = textarea.value.slice(0, offset);
  probe.textContent = text;
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  probe.appendChild(marker);
  const probeRect = probe.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  return {
    left: textarea.offsetLeft + markerRect.left - probeRect.left - textarea.scrollLeft,
    top: textarea.offsetTop + markerRect.top - probeRect.top - textarea.scrollTop,
  };
}

function commandLabel(command) {
  if (!command) return '';
  const hint = command.displayArgumentHint || command.argumentHint || '';
  return `${command.name}${hint ? ` ${hint}` : ''}`;
}

function suggestionStackMatches(suggest) {
  if (!suggest?.open || !suggest.matches?.length) return [];
  return suggest.matches.filter((match) => completionValue(match));
}

function commandRest(command, text) {
  if (!command?.name) return '';
  const value = String(text || '');
  if (!value.startsWith(command.name)) return '';
  return value.slice(command.name.length);
}

function hasRealArgument(command, text) {
  return commandRest(command, text).trim().length > 0;
}

function argumentHintForGhost(command, text) {
  if (!command?.argumentHint || hasRealArgument(command, text)) return '';
  return command.displayArgumentHint || command.argumentHint;
}

function ghostParts(command, suggest, text) {
  if (!command && suggest?.mode !== 'option') return { commandSuffix: '', argumentHint: '' };
  const isActive = suggest.open && activeCommandMatch(suggest);
  const commandSuffix = isActive ? suggest.suffix || '' : '';
  if (suggest?.mode === 'option') return { commandSuffix, argumentHint: '' };
  const argumentHint = argumentHintForGhost(command, text);
  const needsArgumentSpacer = Boolean(commandSuffix) || !/\s$/.test(String(text || ''));
  return {
    commandSuffix,
    argumentHint: argumentHint ? `${needsArgumentSpacer ? ' ' : ''}${argumentHint}` : '',
  };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function renderCommandHint(command, text, option = null) {
  const parts = commandHintParts(command, text, option);
  if (!parts) return '';
  return [
    parts.behavior ? `<span class="composer-command-mode">${esc(parts.behavior)}</span>` : '',
    parts.command ? `<code>${esc(parts.command)}</code>` : '',
    parts.description ? `<span>${esc(parts.description)}</span>` : '',
  ].filter(Boolean).join(' ');
}

function renderGhostParts(parts) {
  return [
    parts.commandSuffix ? `<span>${esc(parts.commandSuffix)}</span>` : '',
    parts.argumentHint ? `<span class="composer-ghost-arg">${esc(parts.argumentHint)}</span>` : '',
  ].filter(Boolean).join('');
}

function hasDismissibleAutocomplete() {
  const composer = state.composer;
  if (!composer) return false;
  if (composer.value === state.composerSuggestDismissedText || isMultilineCommandSuppressed(composer.value)) return false;
  if (state.composerSuggest.open) return true;
  return Boolean(commandForInput(composer.value, state.composerCommands));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positionCommandStack(stack, composer) {
  const rect = composer.getBoundingClientRect();
  const style = window.getComputedStyle(composer);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const margin = 8;
  const gap = 8;
  const availableAbove = Math.max(0, rect.top - margin);
  const availableBelow = Math.max(0, viewportHeight - rect.bottom - margin);
  const placeAbove = availableAbove >= 96 || availableAbove >= availableBelow;
  const availableVertical = Math.max(80, (placeAbove ? availableAbove : availableBelow) - gap);
  const maxHeight = Math.min(260, availableVertical);
  const left = clamp(rect.left + paddingLeft, margin, Math.max(margin, viewportWidth - margin - 160));
  const maxWidth = Math.max(160, Math.min(rect.width - paddingLeft - paddingRight, viewportWidth - left - margin));

  stack.style.left = `${left}px`;
  stack.style.maxWidth = `${maxWidth}px`;
  stack.style.maxHeight = `${maxHeight}px`;
  stack.style.visibility = 'hidden';
  stack.classList.add('visible');

  const height = Math.min(stack.scrollHeight || stack.offsetHeight || 0, maxHeight);
  const rawTop = placeAbove ? rect.top - height - gap : rect.bottom + gap;
  stack.style.top = `${clamp(rawTop, margin, Math.max(margin, viewportHeight - margin - height))}px`;
  stack.style.visibility = '';
}

function syncCommandStackSelection(stack) {
  const activeButton = stack.querySelector('[data-active="true"]');
  if (!activeButton) return;
  activeButton.scrollIntoView({ block: 'nearest' });
}

function renderGhost() {
  const composer = state.composer;
  const ghost = state.composerGhost;
  const stack = state.composerCommandStack;
  const hint = state.composerArgHint;
  if (!composer || !ghost || !stack || !hint) return;

  ghost.textContent = '';
  stack.innerHTML = '';
  hint.innerHTML = '';
  ghost.classList.remove('visible');
  stack.classList.remove('visible');
  hint.classList.toggle('missing', Boolean(state.composerSuggest.argumentMissing));

  const suggest = state.composerSuggest;
  const active = activeCommandMatch(suggest);
  const coords = caretCoordinates(composer, Number.isFinite(suggest?.anchorIndex) ? suggest.anchorIndex : null);

  const suggestionsAllowed = !isMultilineCommandSuppressed(composer.value)
    && composer.value !== state.composerSuggestDismissedText;
  const command = suggestionsAllowed
    ? (suggest.mode === 'option' ? suggest.command : active || commandForInput(composer.value, state.composerCommands))
    : null;
  const activeOption = suggestionsAllowed && suggest.mode === 'option'
    ? active || suggest.selectedOption
    : suggest.selectedOption;
  const inlineGhost = ghostParts(command, suggest, composer.value);

  if (inlineGhost.commandSuffix || inlineGhost.argumentHint) {
    ghost.innerHTML = renderGhostParts(inlineGhost);
    ghost.style.left = `${coords.left + 2}px`;
    ghost.style.top = `${coords.top - 1.5}px`;
    ghost.classList.add('visible');
  }

  const stackMatches = suggestionsAllowed ? suggestionStackMatches(suggest) : [];
  if (stackMatches.length) {
    stack.innerHTML = stackMatches.map((match, index) => {
      const selected = index === suggest.activeIndex;
      const label = suggest.mode === 'option' ? completionLabel(match) : commandLabel(match);
      return `<button type="button" class="${selected ? 'active' : ''}" data-active="${selected ? 'true' : 'false'}" data-suggest-index="${esc(index)}">${esc(label)}</button>`;
    }).join('');
    positionCommandStack(stack, composer);
    syncCommandStackSelection(stack);
  }

  const hintHtml = renderCommandHint(command, composer.value, activeOption);
  if (hintHtml) hint.innerHTML = hintHtml;
}

function applyActiveCompletion() {
  const composer = state.composer;
  const active = activeCommandMatch(state.composerSuggest);
  if (!composer || !active) return false;
  composer.value = applyCommandCompletion(composer.value, active);
  composer.selectionStart = composer.selectionEnd = composer.value.length;
  autosizeComposer();
  updateCounter();
  updateAutocomplete();
  return true;
}

function ensureArgumentSpace(command) {
  const composer = state.composer;
  if (!composer || !command?.requiresArgs) return false;
  const value = composer.value;
  const trimmed = value.trim();
  if (trimmed !== command.name || /\s$/.test(value)) return false;
  composer.value = `${trimmed} `;
  composer.selectionStart = composer.selectionEnd = composer.value.length;
  autosizeComposer();
  updateCounter();
  updateAutocomplete();
  return true;
}

function blinkArgumentHint() {
  state.composerSuggest = { ...state.composerSuggest, argumentMissing: true };
  renderGhost();
  window.setTimeout(() => {
    state.composerSuggest = { ...state.composerSuggest, argumentMissing: false };
    renderGhost();
  }, 450);
}

export function handleComposerKeydown(event) {
  if (!state.composer) return false;

  if (event.key === 'Escape' && hasDismissibleAutocomplete()) {
    event.preventDefault();
    event.stopPropagation();
    hideAutocomplete();
    return true;
  }

  if (event.key === 'Tab' && state.composerSuggest.open) {
    event.preventDefault();
    applyActiveCompletion();
    return true;
  }

  if (event.key === 'Tab') {
    const command = commandForInput(state.composer.value, state.composerCommands);
    if (command?.requiresArgs && !hasRequiredArguments(command, state.composer.value)) {
      event.preventDefault();
      ensureArgumentSpace(command);
      blinkArgumentHint();
      return true;
    }
  }

  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.composerSuggest.open && state.composerSuggest.matches.length > 1) {
    event.preventDefault();
    state.composerSuggest = cycleCommandMatch(state.composerSuggest, event.key === 'ArrowDown' ? 1 : -1);
    renderGhost();
    return true;
  }

  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;

  const active = activeCommandMatch(state.composerSuggest);
  if (state.composerSuggest.open && active && (state.composerSuggest.mode === 'option' || !isCommandNameComplete(state.composer.value, active))) {
    event.preventDefault();
    applyActiveCompletion();
    return true;
  }

  const command = commandForInput(state.composer.value, state.composerCommands);
  if (command) {
    event.preventDefault();
    if (!hasRequiredArguments(command, state.composer.value)) {
      sendComposerNow();
      return true;
    }
    sendComposerNow();
    return true;
  }

  return false;
}

export function initComposerUi() {
  const composer = state.composer;
  if (!composer) return;
  composer.addEventListener('input', () => {
    updateCounter();
    autosizeComposer();
    updateAutocomplete();
  });
  composer.addEventListener('click', updateAutocomplete);
  composer.addEventListener('keyup', updateAutocomplete);
  composer.addEventListener('scroll', renderGhost, { passive: true });
  window.addEventListener('resize', () => {
    autosizeComposer();
    updateAutocomplete();
  });
  state.composerGhost?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    applyActiveCompletion();
    composer.focus();
  });
  state.composerCommandStack?.addEventListener('pointerdown', (event) => {
    const button = event.target?.closest?.('[data-suggest-index]');
    if (!button) return;
    const index = Number(button.dataset.suggestIndex);
    const match = Number.isFinite(index) ? state.composerSuggest.matches[index] : null;
    if (!match) return;
    event.preventDefault();
    state.composerSuggest = { ...state.composerSuggest, matches: [match], activeIndex: 0 };
    applyActiveCompletion();
    composer.focus();
  });
  autosizeComposer();
  updateAutocomplete();
}

export async function addQueue() {
  const response = await api('/api/queue/add', { text: state.composer?.value || '' }).catch(handleComposerError);
  if (!response) return;

  if (response.item?.id) requestQueueScroll(response.item.id, '', true);
  handleComposerResponse(response);
  updateCounter();
  getState().catch(handleComposerError);
}

export async function sendComposerNow() {
  const response = await api('/api/queue/send-composer', { text: state.composer?.value || '' }).catch(handleComposerError);
  if (!response) return;

  if (response.needsConfirmation && response.confirmAction === 'force-steer') {
    openConfirm(
      'force-steer',
      'Interrupt active prompt?',
      response.message,
      'Interrupt anyway',
      true,
      { text: response.text || state.composer?.value || '' },
    );
    updateCounter();
    return;
  }

  handleComposerResponse(response);
  updateCounter();
  getState().catch(handleComposerError);
}
