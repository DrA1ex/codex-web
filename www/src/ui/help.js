import { state } from '#core/state';
import { esc } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

export function openHelp(commands = []) {
  state.help.open = true;
  state.help.commands = Array.isArray(commands) ? commands : [];
  state.expandedHelpCommands = Object.create(null);
  renderHelpModal();
}

export function closeHelp() {
  state.help.open = false;
  renderHelpModal();
}

export function toggleHelpCommand(index) {
  const command = flattenedCommands()[Number(index)] || null;
  const key = helpCommandKey(command, index);
  const expanded = !state.expandedHelpCommands[key];
  state.expandedHelpCommands[key] = expanded;
  renderHelpModal({ focusCommandIndex: expanded ? Number(index) : null });
}

function flattenedCommands() {
  return state.help.commands || [];
}

export function renderHelpModal(options = {}) {
  const box = byId('helpBox');
  if (!box) return;
  const previousScrollTop = box.querySelector('.help-list')?.scrollTop || 0;

  if (!state.help.open) {
    setHidden(box, true);
    box.innerHTML = '';
    return;
  }

  const commands = flattenedCommands();
  setHidden(box, false);
  box.innerHTML = `
    <div class="confirm-modal help-modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <div class="confirm-head help-head">
        <b id="helpTitle">Commands</b>
        <button id="helpCloseBtn" class="icon-only" title="Close command help"><span class="icon icon-close" aria-hidden="true"></span></button>
      </div>
      <div class="help-list">
        ${renderCommandGroups(commands)}
      </div>
    </div>
  `;

  const list = box.querySelector('.help-list');
  if (list) list.scrollTop = previousScrollTop;
  if (Number.isInteger(options.focusCommandIndex)) {
    window.requestAnimationFrame(() => keepHelpCommandVisible(options.focusCommandIndex));
  }
}

function keepHelpCommandVisible(index) {
  const list = byId('helpBox')?.querySelector('.help-list');
  const item = byId(`helpCommand${index}`);
  if (!list || !item) return;

  const listRect = list.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const margin = 8;

  if (itemRect.height > list.clientHeight) {
    const head = item.querySelector('.help-command-head') || item;
    const headRect = head.getBoundingClientRect();
    list.scrollTop += headRect.top - listRect.top - margin;
    return;
  }

  if (itemRect.top < listRect.top + margin) {
    list.scrollTop -= listRect.top + margin - itemRect.top;
  } else if (itemRect.bottom > listRect.bottom - margin) {
    list.scrollTop += itemRect.bottom - (listRect.bottom - margin);
  }
}

function renderCommandGroups(commands) {
  const groups = new Map();
  commands.forEach((command, index) => {
    const category = command.category || command.kind || 'Commands';
    const bucket = groups.get(category) || [];
    bucket.push({ command, index });
    groups.set(category, bucket);
  });
  return [...groups.entries()].map(([category, items]) => `
    <section class="help-category">
      <h3>${esc(category)}</h3>
      ${items.map(({ command, index }) => renderCommand(command, index)).join('')}
    </section>
  `).join('');
}

function renderCommand(command, index) {
  const key = helpCommandKey(command, index);
  const expanded = Boolean(state.expandedHelpCommands[key]);
  const detailsId = `helpCommandDetails${index}`;
  const label = command.command || `${command.name || ''}${command.argumentHint ? ` ${command.argumentHint}` : ''}`;
  const short = command.short || command.shortDescription || '';
  const execution = command.execution || '';
  return `
    <section id="helpCommand${index}" class="help-command ${expanded ? 'expanded' : ''}">
      <button type="button" class="help-command-head" data-help-command="${index}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailsId}">
        <span class="icon icon-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></span>
        <b class="help-command-name">${esc(label)}</b>
        <span>${esc(short)}</span>
        ${execution ? `<em>${esc(execution)}</em>` : ''}
      </button>
      ${expanded ? renderCommandDetails(command, detailsId) : ''}
    </section>
  `;
}

function renderCommandDetails(command, detailsId) {
  const examples = Array.isArray(command.examples) ? command.examples.filter(Boolean) : [];
  const details = command.details || command.description || 'No extended description is available for this command.';
  return `
    <div id="${detailsId}" class="help-command-details">
      <p>${esc(details)}</p>
      ${examples.length ? `
        <div class="help-examples">
          <span>Examples</span>
          ${examples.map((example) => `<pre><code>${esc(example)}</code></pre>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function helpCommandKey(command, fallback) {
  return String(command?.command || command?.name || fallback || '');
}
