import { state } from '#core/state';
import { renderHeader } from '#ui/header';

export function attachMediaHandlers() {
  const query = state.compactHeaderQuery;
  if (!query) return;

  const rerenderHeader = () => {
    if (state.snap) renderHeader();
  };

  if (query.addEventListener) query.addEventListener('change', rerenderHeader);
  else if (query.addListener) query.addListener(rerenderHeader);
}
