import {initBotId} from 'botid/client/core';
import * as store from './store.mjs';
import {addDays, dateLabel, daysBetween, formatTime, isDate, pad, parseTime, today as currentDate} from './dates.mjs';
import {datePicker, timePicker} from './pickers.mjs';

// BOTID is defined at build time; local builds turn it off.
if (BOTID) {
  initBotId({
    protect: [
      {path: '/api/version', method: 'GET'},
      {path: '/api/database', method: 'GET'},
      {path: '/api/service-calendar', method: 'GET'},
      {path: '/api/fares', method: 'GET'},
    ],
  });
}

const DAY = 1440;
const ARRIVAL_DAYS = 5;
const BOOKABLE_DAYS = 14;

const $ = id => document.getElementById(id);
const form = $('form');
const fromInput = $('from');
const toInput = $('to');
const transfersSelect = $('transfers');
const bufferInput = $('buffer');
const strictInput = $('strict');
const faresInput = $('fares');
const submitButton = $('submit');
const resultBox = $('result');

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

function duration(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return `${m}分钟`;
  return m ? `${h}小时${m}分钟` : `${h}小时`;
}

const distance = km => km == null ? '里程未知' : `${km.toLocaleString('zh-CN')} km`;

// Minutes are relative to the query date; `base` is the day the journey starts.
function clock(minute, base) {
  const day = Math.floor(minute / DAY), rest = minute - day * DAY;
  const offset = day - base;
  return `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}${offset ? `<span class="day">+${offset}</span>` : ''}`;
}

function platform(value) {
  const text = value?.trim();
  if (!text || text === '待定' || text === '未定') return '';
  return /^\d+$/.test(text) ? `${text} 站台` : text;
}

let stations = [];
let stationIndex = new Map();
let codeIndex = new Map();
let traffic = [];
let worker;
let phase = 'loading';
let requestId = 0;
let pending = null;
let lastQuery = null;
let lastResult = null;
let faresRequest = 0;
let mode = 'fastest';
let snackbarTimer;

const params = new URLSearchParams(location.search);
const today = currentDate();
let autoRun = params.has('from') && params.has('to');
if (params.has('from')) fromInput.value = params.get('from');
if (params.has('to')) toInput.value = params.get('to');
if (params.has('transfers')) transfersSelect.value = String(Math.min(8, Math.max(0, parseInt(params.get('transfers'), 10) || 0)));
if (params.has('buffer')) bufferInput.value = params.get('buffer');
strictInput.checked = params.get('strict') === '1';
faresInput.checked = params.get('fares') === '1';
if (params.get('mode') === 'shortest') mode = 'shortest';
let startMinute = parseTime(params.get('time') ?? '');
let departDate = isDate(params.get('date')) && params.get('date') >= today ? params.get('date') : today;
let arrivalOffset = isDate(params.get('arrivalDate'))
  ? Math.min(ARRIVAL_DAYS - 1, Math.max(0, daysBetween(departDate, params.get('arrivalDate'))))
  : 1;

const departPicker = datePicker($('date-field'), {
  value: () => departDate,
  min: () => today,
  max: () => addDays(today, BOOKABLE_DAYS - 1),
  onChange: value => { departDate = value; syncDates(); },
});
const arrivalPicker = datePicker($('arrival-field'), {
  value: () => addDays(departDate, arrivalOffset),
  min: () => departDate,
  max: () => addDays(departDate, ARRIVAL_DAYS - 1),
  onChange: value => { arrivalOffset = daysBetween(departDate, value); syncDates(); },
});

function syncDates() {
  departPicker.render();
  arrivalPicker.render();
}
syncDates();

const startPicker = timePicker($('time-field'), {
  value: () => startMinute,
  onChange: value => { startMinute = value; },
});
startPicker.render();

// Accepts a station name or its telegraph code.
function resolveStation(value) {
  const text = value.trim();
  return stationIndex.get(text) ?? codeIndex.get(text.toUpperCase());
}

function validateStations() {
  for (const input of [fromInput, toInput]) {
    input.setCustomValidity(resolveStation(input.value) == null ? '请从列表中选择车站' : '');
  }
  if (!toInput.validationMessage && resolveStation(fromInput.value) === resolveStation(toInput.value)) {
    toInput.setCustomValidity('到达站不能与出发站相同');
  }
}

function findStations(query) {
  const ranked = [];
  stations.forEach(([name, pinyin, abbr, code], i) => {
    const telecode = code.toLowerCase();
    const rank = name === query || telecode === query ? 0
      : name.startsWith(query) ? 1
      : abbr.startsWith(query) || (telecode && telecode.startsWith(query)) ? 2
      : pinyin.startsWith(query) ? 3
      : name.includes(query) ? 4 : -1;
    if (rank >= 0) ranked.push([rank, i]);
  });
  ranked.sort((a, b) => a[0] - b[0] || traffic[b[1]] - traffic[a[1]]);
  return ranked.slice(0, 8).map(r => r[1]);
}

function setupCombobox(input) {
  const menu = $(`${input.id}-menu`);
  let matches = [], active = -1;

  function highlight(index) {
    active = index;
    menu.querySelectorAll('[role="option"]').forEach((option, i) => option.setAttribute('aria-selected', i === index));
    input.setAttribute('aria-activedescendant', `${input.id}-option-${index}`);
  }
  function close() {
    menu.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    input.value = stations[matches[index]][0];
    validateStations();
    close();
  }
  function open() {
    const query = input.value.trim().toLowerCase();
    if (!query || phase === 'loading') return close();
    matches = findStations(query);
    menu.innerHTML = matches.length
      ? matches.map((station, i) => `<button type="button" role="option" tabindex="-1" id="${input.id}-option-${i}" data-index="${i}" aria-selected="false">${escapeHtml(stations[station][0])}<span>${escapeHtml(stations[station][3])}</span></button>`).join('')
      : '<p>无匹配车站</p>';
    menu.hidden = false;
    active = -1;
    input.setAttribute('aria-expanded', 'true');
  }

  input.addEventListener('input', () => { validateStations(); open(); });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => {
    const station = resolveStation(input.value);
    if (station != null) input.value = stations[station][0];
    close();
  });
  input.addEventListener('keydown', event => {
    if (menu.hidden || !matches.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(Math.max(active, 0));
    } else if (event.key === 'Escape') {
      close();
    }
  });
  menu.addEventListener('pointerdown', event => event.preventDefault());
  menu.addEventListener('click', event => {
    const option = event.target.closest('[data-index]');
    if (option) choose(+option.dataset.index);
  });
}

setupCombobox(fromInput);
setupCombobox(toInput);

$('swap').addEventListener('click', () => {
  [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
  validateStations();
});

function setPhase(next) {
  phase = next;
  submitButton.textContent = {loading: '加载中', failed: '重新加载', idle: '查询', busy: '取消'}[next];
  submitButton.disabled = next === 'loading';
  submitButton.classList.toggle('busy', next === 'busy');
}

function syncTabs() {
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-checked', button.dataset.mode === mode));
}

function showState(message, detail = '', retry = false) {
  resultBox.innerHTML = `<div class="state${retry ? ' error' : ''}"><p>${escapeHtml(message)}</p>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}${retry ? '<button type="button" class="text-button" data-retry>重试</button>' : ''}</div>`;
}

function showProgress() {
  resultBox.innerHTML = '<div class="progress" role="progressbar" aria-label="搜索中"></div><div class="state"><p id="progress-text">正在搜索</p></div>';
}

async function getJson(url, timeout) {
  let response;
  try {
    response = await fetch(url, {cache: 'no-store', signal: timeout ? AbortSignal.timeout(timeout) : undefined});
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '请求超时' : '网络连接失败');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `服务异常 ${response.status}`);
  return result;
}

// Requests that reach 12306 leave one at a time with a randomised gap, so they never arrive as a burst.
const GAP_MIN = 200;
const GAP_MAX = 800;
let queue = Promise.resolve();
const pause = () => new Promise(resolve => setTimeout(resolve, GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN)));

function queued(url) {
  const request = queue.then(() => getJson(url, 15000));
  queue = request.catch(() => {}).then(pause);
  return request;
}

// Calendars and fares are kept for the rest of the day they were fetched on.
async function requestCalendar(code, date) {
  const key = `calendar:${code}`;
  const cached = await store.get(key);
  if (cached?.checkedOn === today && (cached.unlisted || cached.days[date] != null)) return cached;
  const result = await queued(`/api/service-calendar?code=${encodeURIComponent(code)}`);
  await store.set(key, {...result, checkedOn: today});
  return result;
}

async function requestFares(from, to, date) {
  const key = `fares:${from}:${to}:${date}`;
  const cached = await store.get(key);
  if (cached?.checkedOn === today) return cached.fares;
  const {fares} = await queued(`/api/fares?${new URLSearchParams({from, to, date})}`);
  await store.set(key, {fares, checkedOn: today});
  return fares;
}

async function downloadDatabase(version) {
  const response = await fetch(`/api/database?v=${encodeURIComponent(version)}`, {cache: 'no-store'});
  if (!response.ok) throw new Error(response.statusText);
  const bytes = await response.arrayBuffer();
  await store.set('database', {version, bytes, checkedOn: today});
  return bytes;
}

async function markChecked() {
  const record = await store.get('database');
  if (record) await store.set('database', {...record, checkedOn: today});
}

// A stored package is used immediately. On the first visit of each day the version is checked in the
// background, and a newer one is offered rather than forced.
let availableVersion = null;

async function checkForUpdate(current) {
  try {
    ({version: availableVersion} = await getJson('/api/version'));
  } catch {
    return;
  }
  if (availableVersion === current) return markChecked();
  $('update-detail').textContent = `${current} → ${availableVersion}`;
  const dialog = $('update-dialog');
  dialog.showModal();
  dialog.focus();
}

let updateChecked = false;

async function loadDatabase() {
  const cached = await store.get('database');
  if (!cached) {
    const {version} = await getJson('/api/version');
    return downloadDatabase(version);
  }
  if (cached.checkedOn !== today && !updateChecked) {
    updateChecked = true;
    checkForUpdate(cached.version);
  }
  return cached.bytes;
}

$('update-later').addEventListener('click', () => {
  markChecked();
  $('update-dialog').close();
});

$('update-confirm').addEventListener('click', async () => {
  const button = $('update-confirm');
  button.disabled = true;
  button.textContent = '正在更新';
  try {
    await downloadDatabase(availableVersion);
    $('update-dialog').close();
    // Reload the timetable in place and repeat the current search against it.
    pending = lastQuery;
    boot();
    showSnackbar('时刻表已更新');
  } catch {
    $('update-dialog').close();
    showSnackbar('更新失败，明天会再次提示');
  } finally {
    button.disabled = false;
    button.textContent = '更新';
  }
});

function boot() {
  worker?.terminate();
  setPhase('loading');
  const current = worker = new Worker('./worker.js', {type: 'module'});
  current.onmessage = ({data}) => {
    if (current !== worker) return;
    if (data.type !== 'calendar') return handleMessage(data);
    requestCalendar(data.code, data.date).then(
      result => current.postMessage({type: 'calendar', id: data.id, result}),
      error => current.postMessage({type: 'calendar', id: data.id, error: error.message}),
    );
  };
  current.onerror = () => { if (current === worker) loadFailed(); };
  loadDatabase().then(
    buffer => { if (current === worker) current.postMessage({type: 'load', buffer}, [buffer]); },
    () => { if (current === worker) loadFailed(); },
  );
}

function loadFailed() {
  setPhase('failed');
  if (pending) {
    pending = null;
    showState('时刻表加载失败', '', false);
  }
}

function handleMessage(data) {
  if (data.type === 'ready') {
    stations = data.stations;
    traffic = data.traffic;
    stationIndex = new Map(stations.map((station, i) => [station[0], i]));
    codeIndex = new Map(stations.flatMap((station, i) => station[3] ? [[station[3], i]] : []));
    $('version').textContent = `时刻表版本 ${data.meta.version}`;
    setPhase('idle');
    validateStations();
    if (autoRun && form.checkValidity()) pending = readForm();
    autoRun = false;
    if (pending) {
      const query = pending;
      pending = null;
      search(query);
    }
  } else if (data.id !== requestId) {
    if (data.type === 'error' && data.id == null) loadFailed();
  } else if (data.type === 'progress') {
    const text = $('progress-text');
    if (text) {
      text.textContent = data.stage === 'verifying' ? '正在核验开行日历'
        : data.stage === 'rerouting' ? `已排除 ${data.rejected} 个班次，正在重新搜索`
        : '正在搜索';
    }
  } else if (data.type === 'result') {
    setPhase('idle');
    lastResult = data.result;
    render(data.query, data.result);
  } else if (data.type === 'error') {
    setPhase('idle');
    showState(data.message, '', true);
  }
}

function readForm() {
  return {
    from: resolveStation(fromInput.value),
    to: resolveStation(toInput.value),
    date: departDate,
    startMinute: startMinute ?? 0,
    endDate: departDate,
    arrivalDate: addDays(departDate, arrivalOffset),
    maxTransfers: +transfersSelect.value,
    minTransfer: +bufferInput.value,
    strict: strictInput.checked,
    mode,
  };
}

function writeUrl(query) {
  const url = new URLSearchParams({
    from: stations[query.from][0], to: stations[query.to][0],
    date: query.date, arrivalDate: query.arrivalDate,
    transfers: query.maxTransfers, buffer: query.minTransfer, mode: query.mode,
  });
  if (query.startMinute) url.set('time', formatTime(query.startMinute));
  if (query.strict) url.set('strict', '1');
  if (faresInput.checked) url.set('fares', '1');
  history.replaceState(null, '', `?${url}`);
}

function search(query) {
  lastQuery = query;
  lastResult = null;
  faresRequest++;
  mode = query.mode;
  syncTabs();
  setPhase('busy');
  $('results-bar').hidden = false;
  showProgress();
  writeUrl(query);
  worker.postMessage({type: 'search', id: ++requestId, query});
}

// A running search can only be stopped by replacing the worker.
function run(query) {
  if (phase === 'idle') return search(query);
  pending = query;
  showProgress();
  if (phase !== 'loading') boot();
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (phase === 'busy') {
    pending = null;
    boot();
    showState('已取消搜索');
  } else if (phase === 'failed') {
    boot();
  } else if (form.reportValidity()) {
    run(readForm());
  }
});

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.mode === mode) return;
  mode = button.dataset.mode;
  syncTabs();
  if (lastQuery) run({...lastQuery, mode});
}));

// Strict verification only changes a result that used, or excluded, a train 12306 does not list.
strictInput.addEventListener('change', () => {
  if (!lastQuery) return;
  const query = {...lastQuery, strict: strictInput.checked};
  const affected = !lastResult || (query.strict
    ? lastResult.legs?.some(leg => leg.unlisted)
    : lastResult.verification.unlistedRejected > 0);
  if (affected) return run(query);
  lastQuery = query;
  writeUrl(query);
});

faresInput.addEventListener('change', () => {
  if (!lastQuery) return;
  writeUrl(lastQuery);
  if (lastResult) render(lastQuery, lastResult);
});

resultBox.addEventListener('click', event => {
  if (event.target.closest('[data-retry]')) return run(lastQuery);
  const toggle = event.target.closest('.via-toggle');
  if (toggle) {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', !expanded);
    toggle.nextElementSibling.hidden = expanded;
  }
});

function showSnackbar(message) {
  clearTimeout(snackbarTimer);
  const snackbar = $('snackbar');
  snackbar.textContent = message;
  snackbar.hidden = false;
  snackbarTimer = setTimeout(() => snackbar.hidden = true, 2400);
}

$('share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    showSnackbar('链接已复制');
  } catch {
    showSnackbar('复制失败，请从地址栏复制');
  }
});

function stopRow(minute, stop, base) {
  const label = platform(stop.platform);
  return `<div class="stop"><time>${clock(minute, base)}</time><span>${escapeHtml(stop.station)}</span><small>${escapeHtml(label)}</small></div>`;
}

function viaRow(stop, base) {
  const dwell = stop.arrival != null && stop.departure != null ? `停 ${stop.departure - stop.arrival} 分钟` : '';
  return `<div class="stop via"><time>${clock(stop.arrival ?? stop.departure, base)}</time><span>${escapeHtml(stop.station)}</span><small>${dwell}</small></div>`;
}

function legItem(leg, i, base) {
  const via = leg.stops.slice(1, -1);
  const codes = [...new Set(leg.stops.map(stop => stop.code))].join('/');
  const viaBlock = via.length
    ? `<button type="button" class="text-button via-toggle" aria-expanded="false">经停 ${via.length} 站${icon('expand')}</button><div hidden>${via.map(stop => viaRow(stop, base)).join('')}</div>`
    : '';
  return `<li class="card leg">
    <header>${icon('train')}<strong>${escapeHtml(codes)}</strong>${leg.unlisted ? '<span class="unlisted">12306 未收录</span>' : faresInput.checked ? `<span class="fare" data-leg="${i}"></span>` : ''}<span class="meta"><span>${duration(leg.arrival - leg.departure)}</span><span>${distance(leg.km)}</span></span></header>
    ${stopRow(leg.departure, leg.stops[0], base)}${viaBlock}${stopRow(leg.arrival, leg.stops.at(-1), base)}
  </li>`;
}

function transferItem(previous, next) {
  return `<li class="transfer">${icon('transfer')}<span><b>${escapeHtml(next.stops[0].station)}</b> 换乘</span><span>等候 ${duration(next.departure - previous.arrival)}</span></li>`;
}

const price = value => `¥${Math.round(value * 10) / 10}`;

// Fares come from 12306 left-ticket data for the boarding date; trains 12306 does not list have none.
async function legFare(query, leg) {
  if (leg.unlisted) return null;
  const [from, to] = [leg.stops[0], leg.stops.at(-1)].map(stop => stations[stop.stationId][3]);
  if (!from || !to) return null;
  const fares = await requestFares(from, to, addDays(query.date, Math.floor(leg.departure / DAY)));
  return fares[leg.stops[0].code] ?? leg.codes.map(code => fares[code]).find(Boolean) ?? null;
}

async function showFares(query, result) {
  const id = faresRequest;
  const fares = await Promise.all(result.legs.map(leg => legFare(query, leg).catch(() => null)));
  if (id !== faresRequest) return;
  resultBox.querySelectorAll('.fare').forEach(cell => {
    const fare = fares[cell.dataset.leg];
    cell.textContent = fare ? `${fare.seat} ${price(fare.price)}` : '暂无票价';
  });
  if (fares.every(Boolean)) $('total-fare').textContent = price(fares.reduce((sum, fare) => sum + fare.price, 0));
}

function render(query, result) {
  faresRequest++;
  const {rejected, unlistedRejected} = result.verification;
  if (!result.found) {
    return showState('没有符合条件的方案', unlistedRejected ? `已排除 ${unlistedRejected} 个 12306 未收录的车次` : '可增加换乘次数或放宽到达日期');
  }
  const base = Math.floor(result.departure / DAY);
  const legs = result.legs.map((leg, i) => (i ? transferItem(result.legs[i - 1], leg) : '') + legItem(leg, i, base)).join('');
  const unlisted = result.legs.filter(leg => leg.unlisted).map(leg => leg.codes[0]);
  const status = unlisted.length
    ? `<span class="unverified">${icon('info')}${escapeHtml(unlisted.join('、'))} 未经 12306 核验</span>`
    : `<span class="verified">${icon('check')}开行日历已核验</span>`;
  resultBox.innerHTML = `
    <div class="card summary">
      <strong>${clock(result.departure, base)} – ${clock(result.arrival, base)}</strong>
      <strong>${duration(result.journeyMinutes)}</strong>
      <span>${dateLabel(addDays(query.date, base), true)}</span>
      <span class="meta"><span>${result.transfers ? `换乘 ${result.transfers} 次` : '直达'}</span><span>${distance(result.km)}</span>${faresInput.checked ? '<span id="total-fare"></span>' : ''}</span>
    </div>
    <ol class="journey">${legs}</ol>
    <p class="result-foot">${status}${rejected ? `<span>已排除 ${rejected} 个停运班次</span>` : ''}${unlistedRejected ? `<span>已排除 ${unlistedRejected} 个 12306 未收录的车次</span>` : ''}</p>`;
  if (faresInput.checked) showFares(query, result);
}

syncTabs();
store.prune('calendar:', entry => entry.checkedOn === today);
store.prune('fares:', entry => entry.checkedOn === today);
boot();
