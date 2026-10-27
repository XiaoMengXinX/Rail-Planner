const WEEKDAYS = '日一二三四五六';

export const pad = n => String(n).padStart(2, '0');
export const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekday = iso => `周${WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]}`;
export const monthLabel = iso => `${+iso.slice(0, 4)}年${+iso.slice(5, 7)}月`;

export function dateLabel(iso, withWeekday = false) {
  const label = `${+iso.slice(5, 7)}月${+iso.slice(8, 10)}日`;
  return withWeekday ? `${label} ${weekday(iso)}` : label;
}

export function parseTime(value) {
  const match = value.trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!match || +match[1] > 23 || +match[2] > 59) return null;
  return +match[1] * 60 + +match[2];
}

export const formatTime = minute => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
