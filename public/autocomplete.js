// A small suggestion dropdown for text inputs. Used instead of <datalist>,
// whose keyboard behavior differs by browser (in Safari, Enter after arrowing
// to a suggestion still delivers what was typed).
//
//   attachAutocomplete(input, {
//     items: () => ['QBRs', 'Pipeline', …],   // current suggestions
//     onPick: (value) => …,                    // default: put value in the input
//   })
//
// The top suggestion is highlighted as you type, so Enter/Tab picks it; ↑/↓
// move the highlight. Esc dismisses the list, after which Enter keeps exactly
// what was typed (e.g. to create a new tag "Q" when "QBRs" exists).
// Attach before any other keydown handlers on the input.

const MAX = 8;

export function attachAutocomplete(input, { items, onPick, exclude = () => [] }) {
  input.removeAttribute('list');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');
  const host = input.closest('dialog') || document.body;
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  host.append(list);

  let shown = [];
  let active = -1;

  const pick = (value) => {
    close();
    if (onPick) onPick(value);
    else {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const position = () => {
    const r = input.getBoundingClientRect();
    const box = host === document.body ? { left: -window.scrollX, top: -window.scrollY } : host.getBoundingClientRect();
    list.style.left = `${r.left - box.left}px`;
    list.style.top = `${r.bottom - box.top + 4}px`;
    list.style.minWidth = `${Math.max(200, r.width)}px`;
  };

  const render = () => {
    list.innerHTML = shown.map((v, i) => `<li role="option" class="ac-item${i === active ? ' active' : ''}" data-i="${i}" aria-selected="${i === active}">${mark(v, input.value)}</li>`).join('');
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const open = () => {
    const q = input.value.trim().toLowerCase();
    const skip = new Set(exclude().map((x) => x.toLowerCase()));
    const all = items().filter((v) => !skip.has(v.toLowerCase()));
    // Prefix matches first, then matches anywhere; nothing until something is typed.
    shown = q
      ? [...all.filter((v) => v.toLowerCase().startsWith(q)), ...all.filter((v) => !v.toLowerCase().startsWith(q) && v.toLowerCase().includes(q))]
        .filter((v) => v.toLowerCase() !== q).slice(0, MAX)
      : [];
    active = 0;
    if (!shown.length) return close();
    position();
    render();
    list.hidden = false;
  };

  const close = () => {
    list.hidden = true;
    active = -1;
  };

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = shown.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      render();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  // mousedown (not click) so the input doesn't lose focus first.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]');
    if (!li) return;
    e.preventDefault();
    pick(shown[Number(li.dataset.i)]);
  });
  window.addEventListener('resize', () => { if (!list.hidden) position(); });
  host.addEventListener('scroll', () => { if (!list.hidden) position(); }, true);

  return { close, refresh: open };
}

function mark(text, q) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  q = q.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<b>${esc(text.slice(i, i + q.length))}</b>${esc(text.slice(i + q.length))}`;
}
