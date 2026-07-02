export function byId(id) {
  return document.getElementById(id);
}

export function html(strings, ...values) {
  return strings.reduce((result, part, index) => result + part + (values[index] ?? ''), '');
}

export function setHidden(element, hidden) {
  if (element) element.classList.toggle('hidden', Boolean(hidden));
}

export function setDisabled(element, disabled) {
  if (element) element.disabled = Boolean(disabled);
}

export function setText(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
}

export function toArray(list) {
  return Array.prototype.slice.call(list || []);
}

export function closest(target, selector) {
  return target && target.closest ? target.closest(selector) : null;
}
