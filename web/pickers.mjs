import 'cally';
import {dateLabel, formatTime, monthLabel, pad, weekday} from './dates.mjs';

// Both pickers sit in an mdui-dropdown, which handles opening, outside presses and Escape.
const opened = (field, handler) => field.addEventListener('open', event => { if (event.target === field) handler(); });

export function datePicker(field, {value, min, max, onChange}) {
  const trigger = field.querySelector('[slot="trigger"]');
  const calendar = field.querySelector('calendar-date');
  const heading = calendar.querySelector('[slot="heading"]');
  calendar.addEventListener('focusday', () => { heading.textContent = monthLabel(calendar.focusedDate); });
  opened(field, () => {
    calendar.min = min();
    calendar.max = max();
    calendar.value = value();
    calendar.focusedDate = value();
    heading.textContent = monthLabel(value());
    requestAnimationFrame(() => calendar.focus());
  });
  calendar.addEventListener('change', () => {
    onChange(calendar.value);
    field.open = false;
  });
  return {render: () => { trigger.value = `${dateLabel(value())} ${weekday(value())}`; }};
}

// Two scrollable columns (hours, minutes); a pick applies immediately. `value` is minutes or null.
export function timePicker(field, {value, onChange}) {
  const trigger = field.querySelector('[slot="trigger"]');
  const panel = field.querySelector('.popover');
  const column = (name, label, count) => `<div class="time-column" role="listbox" aria-label="${label}">${
    Array.from({length: count}, (_, n) => `<button type="button" role="option" data-${name}="${n}">${pad(n)}</button>`).join('')}</div>`;
  panel.innerHTML = `<div class="time-columns">${column('hour', '时', 24)}${column('minute', '分', 60)}</div>`
    + '<div class="picker-actions"><mdui-button variant="text" data-action="clear">不限</mdui-button>'
    + '<mdui-button variant="text" data-action="done">确定</mdui-button></div>';
  const [hours, minutes] = panel.querySelectorAll('.time-column');

  function render() {
    const minute = value();
    trigger.value = minute == null ? '不限' : formatTime(minute);
    for (const [list, selected] of [[hours, minute == null ? null : Math.floor(minute / 60)], [minutes, minute == null ? null : minute % 60]]) {
      [...list.children].forEach((option, n) => {
        option.setAttribute('aria-selected', n === selected);
        option.tabIndex = n === (selected ?? 0) ? 0 : -1;
      });
    }
  }
  function select(minute) {
    onChange(minute);
    render();
  }

  opened(field, () => requestAnimationFrame(() => {
    for (const list of [hours, minutes]) list.scrollTop = list.querySelector('[tabindex="0"]').offsetTop - list.offsetTop;
    hours.querySelector('[tabindex="0"]').focus({preventScroll: true});
  }));
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-hour], [data-minute], [data-action]');
    const current = value();
    if (button?.dataset.hour) select(+button.dataset.hour * 60 + (current ?? 0) % 60);
    else if (button?.dataset.minute) select((current == null ? 0 : current - current % 60) + +button.dataset.minute);
    else if (button?.dataset.action === 'clear') {
      select(null);
      field.open = false;
    } else if (button?.dataset.action === 'done') field.open = false;
  });
  panel.addEventListener('keydown', event => {
    const option = event.target.closest('[role="option"]');
    const next = event.key === 'ArrowDown' ? option?.nextElementSibling : event.key === 'ArrowUp' ? option?.previousElementSibling : null;
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  });
  return {render};
}
