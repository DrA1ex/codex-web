import { attachClickHandlers } from './events/clicks.js';
import { attachFormHandlers } from './events/forms.js';
import { attachKeyboardHandlers } from './events/keyboard.js';
import { attachMediaHandlers } from './events/media.js';
import { attachQueueDragHandlers } from './events/drag.js';

export function attachEventHandlers() {
  attachClickHandlers();
  attachQueueDragHandlers();
  attachFormHandlers();
  attachKeyboardHandlers();
  attachMediaHandlers();
}
