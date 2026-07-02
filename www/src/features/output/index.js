import { state } from '#core/state';
import { esc } from '#utils/format';

function outputLabel(type, text){
  var labels = { error:'Error', stderr:'Stderr', system:'System', turn:'Turn', send:'Send', prompt:'Prompt', tool:'Tool', 'tool-delta':'Tool', reasoning:'Reasoning', 'reasoning-delta':'Reasoning', plan:'Plan', diff:'Diff', item:'Item', event:'Event', delta:'Assistant', 'context-delta':'Context' };
  var label = labels[type] || 'Output';
  var body = String(text == null ? '' : text);
  var m = body.match(/^\[([^\]]+)\]\s*/);
  if(m && type !== 'diff') {
    label = labels[m[1]] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
    body = body.slice(m[0].length);
  }
  return { label:label, body:body };
}

function renderOutputLine(l){
  var type = l.type || 'text';
  var meta = outputLabel(type, l.text);
  if(type === 'diff') {
    var diffId = esc(l.id || '');
    var expanded = !!state.expandedDiffOutput[l.id];
    var lineCount = String(meta.body || '').split(/\r?\n/).length;
    var firstLine = String(meta.body || '').split(/\r?\n/).find(function(line){ return line.trim(); }) || 'Diff updated';
    return '<div class="out-line diff ' + (expanded ? 'expanded' : 'collapsed') + '"><div class="out-diff-card"><button type="button" class="out-diff-toggle" data-output-diff="' + diffId + '"><span>' + (expanded ? 'Collapse' : 'Expand') + ' diff</span><b>' + lineCount + ' lines</b><em>' + esc(firstLine) + '</em></button>' + (expanded ? '<pre class="out-body">' + esc(meta.body) + '</pre>' : '') + '</div></div>';
  }
  var block = type === 'diff' || type === 'prompt' || type === 'plan' || type === 'tool-delta' || type === 'delta' || type === 'reasoning-delta' || type === 'context-delta';
  return '<div class="out-line ' + esc(type) + '"><span class="out-label">' + esc(meta.label) + '</span>' + (block ? '<pre class="out-body">' + esc(meta.body) + '</pre>' : '<span class="out-body">' + esc(meta.body) + '</span>') + '</div>';
}

export function renderOutput(){
  var outputEl = state.outputEl;
  if(!outputEl) return;
  var atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 30;
  outputEl.innerHTML = ((state.snap && state.snap.output) || []).map(renderOutputLine).join('');
  if(atBottom) outputEl.scrollTop = outputEl.scrollHeight;
}
