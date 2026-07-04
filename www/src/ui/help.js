import { state } from '#core/state';
import { esc } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

export function openHelp(commands = []) {
  state.help.open = true;
  state.help.commands = Array.isArray(commands) ? commands : [];
  renderHelpModal();
}

export function closeHelp() {
  state.help.open = false;
  renderHelpModal();
}

export function toggleHelpCommand(index) {
  state.expandedHelpCommands[index] = !state.expandedHelpCommands[index];
  renderHelpModal();
}

export function renderHelpModal() {
  const box = byId('helpBox');
  if (!box) return;

  if (!state.help.open) {
    setHidden(box, true);
    box.innerHTML = '';
    return;
  }

  const commands = state.help.commands || [];
  setHidden(box, false);
  box.innerHTML = `
    <div class="confirm-modal help-modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <div class="confirm-head help-head">
        <b id="helpTitle">Commands</b>
        <button id="helpCloseBtn" class="icon-only" title="Close command help"><span class="icon icon-close" aria-hidden="true"></span></button>
      </div>
      <div class="help-list">
        ${commands.map(renderCommand).join('')}
      </div>
    </div>
  `;
}

function renderCommand(command, index) {
  const expanded = Boolean(state.expandedHelpCommands[index]);
  const detailsId = `helpCommandDetails${index}`;
  return `
    <section class="help-command ${expanded ? 'expanded' : ''}">
      <button type="button" class="help-command-head" data-help-command="${index}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailsId}">
        <span class="icon icon-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></span>
        <b class="help-command-name">${esc(command.command || '')}</b>
        <span>${esc(command.short || '')}</span>
        ${command.kind ? `<em>${esc(command.kind)}</em>` : ''}
      </button>
      ${expanded ? renderCommandDetails(command, detailsId) : ''}
    </section>
  `;
}

function renderCommandDetails(command, detailsId) {
  const examples = Array.isArray(command.examples) ? command.examples.filter(Boolean) : [];
  return `
    <div id="${detailsId}" class="help-command-details">
      <p>${esc(command.details || '')}</p>
      ${examples.length ? `
        <div class="help-examples">
          <span>Examples</span>
          ${examples.map((example) => `<pre><code>${esc(example)}</code></pre>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}
