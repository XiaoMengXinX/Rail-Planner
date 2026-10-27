import 'cally';
import {dateLabel, formatTime, monthLabel, pad, weekday} from './dates.mjs';

// MD3 docked popover anchored under an outlined field; closes on outside press or Escape.
function popover(field, trigger) {
  const panel = field.querySelector('.popover');
  const close = (restoreFocus = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  };
  const open = () => {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('pointerdown', event => { if (!field.contains(event.target)) close(); });
  field.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) close(true);
  });
  return {panel, open, close};
}

export function datePicker(field, {value, min, max, onChange}) {
  const trigger = field.querySelector('.field-button');
  const calendar = field.querySelector('calendar-date');
  const heading = calendar.querySelector('[slot="heading"]');
  const {panel, open, close} = popover(field, trigger);
  calendar.addEventListener('focusday', () => { heading.textContent = monthLabel(calendar.focusedDate); });
  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close();
    calendar.min = min();
    calendar.max = max();
    calendar.value = value();
    calendar.focusedDate = value();
    heading.textContent = monthLabel(value());
    open();
    calendar.focus();
  });
  calendar.addEventListener('change', () => {
    onChange(calendar.value);
    close(true);
  });
  return {render: () => { trigger.innerHTML = `${dateLabel(value())}<span>${weekday(value())}</span>`; }};
}

// Two scrollable columns (hours, minutes); a pick applies immediately. `value` is minutes or null.
export function timePicker(field, {value, onChange}) {
  const trigger = field.querySelector('.field-button');
  const {panel, open, close} = popover(field, trigger);
  const column = (name, label, count) => `<div class="time-column" role="listbox" aria-label="${label}">${
    Array.from({length: count}, (_, n) => `<button type="button" role="option" data-${name}="${n}">${pad(n)}</button>`).join('')}</div>`;
  panel.innerHTML = `<div class="time-columns">${column('hour', '时', 24)}${column('minute', '分', 60)}</div>`
    + '<div class="picker-actions"><button type="button" class="text-button" data-action="clear">不限</button>'
    + '<button type="button" class="text-button" data-action="done">确定</button></div>';
  const [hours, minutes] = panel.querySelectorAll('.time-column');

  function render() {
    const minute = value();
    trigger.textContent = minute == null ? '不限' : formatTime(minute);
    trigger.classList.toggle('empty', minute == null);
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

  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close();
    open();
    for (const list of [hours, minutes]) list.scrollTop = list.querySelector('[tabindex="0"]').offsetTop - list.offsetTop;
    hours.querySelector('[tabindex="0"]').focus({preventScroll: true});
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    const current = value();
    if (button?.dataset.hour) select(+button.dataset.hour * 60 + (current ?? 0) % 60);
    else if (button?.dataset.minute) select((current == null ? 0 : current - current % 60) + +button.dataset.minute);
    else if (button?.dataset.action === 'clear') {
      select(null);
      close(true);
    } else if (button?.dataset.action === 'done') close(true);
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
