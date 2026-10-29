import {initBotId} from 'botid/client/core';
import 'mdui/components/button.js';
import 'mdui/components/button-icon.js';
import 'mdui/components/card.js';
import 'mdui/components/dialog.js';
import 'mdui/components/dropdown.js';
import 'mdui/components/linear-progress.js';
import 'mdui/components/menu.js';
import 'mdui/components/menu-item.js';
import 'mdui/components/segmented-button.js';
import 'mdui/components/segmented-button-group.js';
import 'mdui/components/select.js';
import 'mdui/components/snackbar.js';
import 'mdui/components/switch.js';
import 'mdui/components/text-field.js';
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
const cityInput = $('city');
const cityBufferInput = $('city-buffer');
const submitButton = $('submit');
const modeGroup = $('mode');
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
let sameCity = new Map();
let settingsOpen = false;
let traffic = [];
let worker;
let phase = 'loading';
let requestId = 0;
let pending = null;
let lastQuery = null;
let lastResult = null;
let faresRequest = 0;
let mode = 'fastest';
// Per station pair, keyed `from-to` by station index: minutes, or false once that transfer is removed.
let cityPairs = {};

// Query state lives in the fragment, which never reaches the server; old links with ?query still open.
const params = new URLSearchParams(location.hash.slice(1) || location.search);
const today = currentDate();
let autoRun = params.has('from') && params.has('to');
if (params.has('from')) fromInput.value = params.get('from');
if (params.has('to')) toInput.value = params.get('to');
if (params.has('transfers')) transfersSelect.value = String(Math.min(8, Math.max(0, parseInt(params.get('transfers'), 10) || 0)));
if (params.has('buffer')) bufferInput.value = params.get('buffer');
strictInput.checked = params.get('strict') === '1';
faresInput.checked = params.get('fares') === '1';
if (params.has('cityTransfer')) {
  cityInput.checked = true;
  cityBufferInput.value = params.get('cityTransfer');
}
if (params.get('mode') === 'shortest') mode = 'shortest';
let startMinute = parseTime(params.get('time') ?? '');
let endMinute = parseTime(params.get('arrivalTime') ?? '');
let departDate = isDate(params.get('date')) && params.get('date') >= today ? params.get('date') : today;
let arrivalOffset = isDate(params.get('arrivalDate'))
  ? Math.min(ARRIVAL_DAYS - 1, Math.max(0, daysBetween(departDate, params.get('arrivalDate'))))
  : 0;

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

const endPicker = timePicker($('arrival-time-field'), {
  value: () => endMinute,
  onChange: value => { endMinute = value; },
});
endPicker.render();

// mdui leaves its controls out of a novalidate form's validation, so they are checked directly.
const formFields = () => [fromInput, toInput, bufferInput, cityBufferInput];

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

// `allowed` limits the candidates to a list of stations; without one every station can match.
function findStations(query, allowed) {
  const ranked = [];
  for (const i of allowed ?? stations.keys()) {
    const [name, pinyin, abbr, code] = stations[i];
    const telecode = code.toLowerCase();
    const rank = !query || name === query || telecode === query ? 0
      : name.startsWith(query) ? 1
      : abbr.startsWith(query) || (telecode && telecode.startsWith(query)) ? 2
      : pinyin.startsWith(query) ? 3
      : name.includes(query) ? 4 : -1;
    if (rank >= 0) ranked.push([rank, i]);
  }
  ranked.sort((a, b) => a[0] - b[0] || traffic[b[1]] - traffic[a[1]]);
  return ranked.slice(0, 8).map(r => r[1]);
}

// Focus stays in the field while the menu lists matches, so the arrow keys move a highlight instead.
function setupCombobox(input, {allowed = () => null, onBlur = () => {}} = {}) {
  const menu = input.nextElementSibling;
  let matches = [], active = -1;

  function highlight(index) {
    active = index;
    menu.querySelectorAll('mdui-menu-item').forEach((item, i) => item.classList.toggle('active', i === index));
  }
  function close() {
    menu.hidden = true;
    active = -1;
  }
  function choose(index) {
    input.value = stations[matches[index]][0];
    close();
  }
  function open() {
    const query = input.value.trim().toLowerCase();
    const list = allowed();
    if ((!query && !list) || phase === 'loading') return close();
    matches = findStations(query, list);
    menu.innerHTML = matches.length
      ? matches.map((station, i) => `<mdui-menu-item data-index="${i}" end-text="${escapeHtml(stations[station][3])}">${escapeHtml(stations[station][0])}</mdui-menu-item>`).join('')
      : '<mdui-menu-item disabled>无匹配车站</mdui-menu-item>';
    menu.hidden = false;
    active = -1;
  }

  input.addEventListener('input', () => { input.setCustomValidity(''); open(); });
  input.addEventListener('focus', () => { input.select(); if (!input.value) open(); });
  input.addEventListener('blur', () => {
    const station = resolveStation(input.value);
    if (station != null) input.value = stations[station][0];
    close();
    onBlur();
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
  const pick = event => {
    const option = event.target.closest('[data-index]');
    if (option) choose(+option.dataset.index);
  };
  menu.addEventListener('pointerdown', event => event.preventDefault());
  menu.addEventListener('click', pick);
  // iOS blurs the input on the mousedown it emulates after a tap, closing the menu before the click lands,
  // so taps pick on touchend and cancel the emulated mouse events.
  let touch;
  menu.addEventListener('touchstart', event => { touch = event.changedTouches[0]; }, {passive: true});
  menu.addEventListener('touchend', event => {
    const end = event.changedTouches[0];
    if (Math.hypot(end.clientX - touch.clientX, end.clientY - touch.clientY) > 10) return;
    event.preventDefault();
    pick(event);
  });
}

setupCombobox(fromInput, {onBlur: validateStations});
setupCombobox(toInput, {onBlur: validateStations});

$('swap').addEventListener('click', () => {
  [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
  validateStations();
});

function setPhase(next) {
  phase = next;
  submitButton.textContent = {loading: '加载中', failed: '重新加载', idle: '查询', busy: '取消'}[next];
  submitButton.disabled = next === 'loading';
  submitButton.variant = next === 'busy' ? 'tonal' : 'filled';
}

const RETRY = '<mdui-button variant="text" data-retry>重试</mdui-button>';

function showState(message, detail = '', action = '') {
  resultBox.innerHTML = `<div class="state${action === RETRY ? ' error' : ''}"><p>${escapeHtml(message)}</p>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}${action}</div>`;
}

function showProgress() {
  resultBox.innerHTML = '<mdui-linear-progress class="progress" aria-label="搜索中"></mdui-linear-progress><div class="state"><p id="progress-text">正在搜索</p></div>';
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
  $('update-dialog').open = true;
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
  $('update-dialog').open = false;
});

$('update-confirm').addEventListener('click', async () => {
  const button = $('update-confirm');
  button.disabled = true;
  button.textContent = '正在更新';
  try {
    await downloadDatabase(availableVersion);
    $('update-dialog').open = false;
    // Reload the timetable in place and repeat the current search against it.
    pending = lastQuery;
    boot();
    showSnackbar('时刻表已更新');
  } catch {
    $('update-dialog').open = false;
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
    showState('时刻表加载失败');
  }
}

function handleMessage(data) {
  if (data.type === 'ready') {
    stations = data.stations;
    traffic = data.traffic;
    stationIndex = new Map(stations.map((station, i) => [station[0], i]));
    codeIndex = new Map(stations.flatMap((station, i) => station[3] ? [[station[3], i]] : []));
    sameCity = new Map(data.groups.flatMap(group => group.map(station => [station, group.filter(other => other !== station)])));
    $('version').textContent = `时刻表版本 ${data.version}`;
    setPhase('idle');
    validateStations();
    if (autoRun && formFields().every(field => field.checkValidity())) {
      let plan;
      try {
        if (params.has('pairs')) cityPairs = parsePairs(params.get('pairs'));
        if (params.has('plan')) plan = parsePlan(params.get('plan'));
      } catch (error) {
        showSnackbar(`链接中的方案有误：${error.message}`);
      }
      pending = {...readForm(), plan};
    }
    autoRun = false;
    if (pending) {
      const query = pending;
      pending = null;
      search(query);
    }
  } else if (data.id !== requestId) {
    if (data.type === 'error' && data.id == null) loadFailed();
  } else if (data.type === 'progress') {
    $('progress-text').textContent = data.stage === 'verifying' ? '正在核验开行日历' : `已排除 ${data.rejected} 个班次，正在重新搜索`;
  } else if (data.type === 'result') {
    setPhase('idle');
    lastResult = data.result;
    render(data.query, data.result);
  } else if (data.type === 'error') {
    setPhase('idle');
    if (!data.plan) return showState(data.message, '', RETRY);
    // A shared plan that no longer holds falls back to searching with the same settings.
    showSnackbar(`链接中的方案有误：${data.message}`);
    search(lastQuery);
  }
}

function readForm() {
  return {
    from: resolveStation(fromInput.value),
    to: resolveStation(toInput.value),
    date: departDate,
    startMinute: startMinute ?? 0,
    arrivalDate: addDays(departDate, arrivalOffset),
    endMinute: endMinute ?? DAY - 1,
    maxTransfers: +transfersSelect.value,
    minTransfer: +bufferInput.value,
    cityTransfer: cityInput.checked ? +cityBufferInput.value : null,
    cityPairs,
    strict: strictInput.checked,
    mode,
  };
}

// Shared links name stations, since station indices change between timetable versions.
function parsePairs(text) {
  const pairs = {};
  for (const entry of text.split(',')) {
    const [, a, b, value] = entry.match(/^(.+)>(.+):(x|\d{1,3})$/) ?? [];
    const [from, to] = [stationIndex.get(a), stationIndex.get(b)];
    if (from == null || to == null || +value > 720) throw new Error('同城换乘设置无效');
    pairs[`${from}-${to}`] = value === 'x' ? false : +value;
  }
  return pairs;
}

function parsePlan(text) {
  return text.split('_').map(leg => {
    const [code, a, b, day, extra] = leg.split('.');
    const [board, alight] = [stationIndex.get(a), stationIndex.get(b)];
    if (!code || board == null || alight == null || !/^\d$/.test(day) || extra != null) throw new Error('格式无效');
    return [code, board, alight, +day];
  });
}

const encodePlan = result => result.legs
  .map(leg => [leg.stops[0].code, leg.stops[0].station, leg.stops.at(-1).station, Math.floor(leg.departure / DAY)].join('.'))
  .join('_');

const customized = query => query.cityTransfer !== null && Object.keys(query.cityPairs).length > 0;

function queryParams(query) {
  const url = new URLSearchParams({
    from: stations[query.from][0], to: stations[query.to][0],
    date: query.date, arrivalDate: query.arrivalDate,
    transfers: query.maxTransfers, buffer: query.minTransfer, mode: query.mode,
  });
  if (query.startMinute) url.set('time', formatTime(query.startMinute));
  if (query.endMinute < DAY - 1) url.set('arrivalTime', formatTime(query.endMinute));
  if (query.strict) url.set('strict', '1');
  if (query.cityTransfer !== null) url.set('cityTransfer', query.cityTransfer);
  if (customized(query)) {
    url.set('pairs', Object.entries(query.cityPairs).map(([pair, value]) => {
      const [a, b] = pair.split('-').map(station => stations[station][0]);
      return `${a}>${b}:${value === false ? 'x' : value}`;
    }).join(','));
  }
  if (faresInput.checked) url.set('fares', '1');
  return url;
}

const writeUrl = query => history.replaceState(null, '', `${location.pathname}#${queryParams(query)}`);

function search({plan, ...query}) {
  lastQuery = query;
  $('custom-notice').hidden = !customized(query);
  $('custom-notice').querySelector('span').textContent = `已应用 ${Object.keys(query.cityPairs).length} 项自定义同城换乘设置`;
  lastResult = null;
  faresRequest++;
  mode = modeGroup.value = query.mode;
  setPhase('busy');
  $('results-bar').hidden = false;
  showProgress();
  // An opened plan link keeps its fragment until the next search replaces it.
  if (!plan) writeUrl(query);
  worker.postMessage({type: 'search', id: ++requestId, query, plan});
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
  } else {
    validateStations();
    if (formFields().every(field => field.reportValidity())) run(readForm());
  }
});

// A single-select group lets the selected segment be pressed off, which is not a valid choice here.
modeGroup.addEventListener('change', () => {
  if (!modeGroup.value) modeGroup.value = mode;
  if (modeGroup.value === mode) return;
  mode = modeGroup.value;
  if (lastQuery) run({...lastQuery, mode});
});

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

function syncCity() {
  cityBufferInput.hidden = !cityInput.checked;
  cityBufferInput.disabled = !cityInput.checked;
}
syncCity();

cityInput.addEventListener('change', () => {
  syncCity();
  if (lastQuery && cityBufferInput.checkValidity()) run({...lastQuery, cityTransfer: cityInput.checked ? +cityBufferInput.value : null});
});

faresInput.addEventListener('change', () => {
  if (!lastQuery) return;
  writeUrl(lastQuery);
  if (lastResult) render(lastQuery, lastResult);
});

function setPairs(pairs) {
  cityPairs = pairs;
  run({...lastQuery, cityPairs});
}

// A pair set back to the default time, or to undefined, is no longer a custom setting.
function setPair(pair, value) {
  const pairs = {...lastQuery.cityPairs, [pair]: value};
  if (value === undefined || value === lastQuery.cityTransfer) delete pairs[pair];
  setPairs(pairs);
}

resultBox.addEventListener('click', event => {
  if (event.target.closest('[data-retry]')) return run(lastQuery);
  const fareRetry = event.target.closest('[data-fare-retry]');
  if (fareRetry) return loadFare(lastQuery, lastResult.legs[fareRetry.dataset.fareRetry], +fareRetry.dataset.fareRetry);
  const remove = event.target.closest('[data-remove]');
  if (remove) return setPair(remove.dataset.remove, false);
  const clear = event.target.closest('[data-clear]');
  if (clear) return setPair(clear.dataset.clear, undefined);
  if (event.target.closest('[data-add]')) return addPair();
  const toggle = event.target.closest('.via-toggle, .city-toggle, [data-settings]');
  if (toggle) {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', !expanded);
    toggle.nextElementSibling.hidden = expanded;
    // The settings panel is rendered again with every result, so its state outlives the element.
    if (toggle.hasAttribute('data-settings')) settingsOpen = !expanded;
  }
});

$('custom-reset').addEventListener('click', () => setPairs({}));

function addPair() {
  const [fromField, toField, minutesField] = ['pair-from', 'pair-to', 'pair-minutes'].map($);
  const [a, b] = [fromField, toField].map(input => stationIndex.get(input.value.trim()));
  fromField.setCustomValidity(sameCity.has(a) ? '' : '请选择有同城车站的车站');
  toField.setCustomValidity(sameCity.get(a)?.includes(b) ? '' : '请选择与前一站同城的车站');
  if ([fromField, toField, minutesField].every(input => input.reportValidity())) setPair(`${a}-${b}`, +minutesField.value);
}

resultBox.addEventListener('change', event => {
  const input = event.target.closest('[data-pair]');
  if (input?.reportValidity()) setPair(input.dataset.pair, +input.value);
});

function showSnackbar(message) {
  const snackbar = $('snackbar');
  snackbar.textContent = message;
  snackbar.open = true;
}

$('share').addEventListener('click', async () => {
  try {
    const url = queryParams(lastQuery);
    if (customized(lastQuery) && lastResult?.found) url.set('plan', encodePlan(lastResult));
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${url}`);
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
    ? `<mdui-button variant="text" class="via-toggle" aria-expanded="false">经停 ${via.length} 站<svg slot="end-icon"><use href="#i-expand"/></svg></mdui-button><div hidden>${via.map(stop => viaRow(stop, base)).join('')}</div>`
    : '';
  return `<li><mdui-card variant="outlined" class="leg">
    <header>${icon('train')}<strong>${escapeHtml(codes)}</strong>${leg.unlisted ? '<span class="unlisted">12306 未收录</span>' : faresInput.checked ? `<span class="fare" data-leg="${i}"></span>` : ''}<span class="meta"><span>${duration(leg.arrival - leg.departure)}</span><span>${distance(leg.km)}</span></span></header>
    ${stopRow(leg.departure, leg.stops[0], base)}${viaBlock}${stopRow(leg.arrival, leg.stops.at(-1), base)}
  </mdui-card></li>`;
}

function transferItem(query, previous, next) {
  const [arrived, boarding] = [previous.stops.at(-1), next.stops[0]];
  const wait = duration(next.departure - previous.arrival);
  if (arrived.stationId === boarding.stationId) {
    return `<li class="transfer">${icon('transfer')}<span><b>${escapeHtml(boarding.station)}</b> 换乘</span><span>等候 ${wait}</span></li>`;
  }
  const pair = `${arrived.stationId}-${boarding.stationId}`;
  return `<li class="transfer">${icon('transfer')}<span class="transfer-text"><span><b>${escapeHtml(arrived.station)}</b> 前往 <b>${escapeHtml(boarding.station)}</b> 换乘</span><span>间隔 ${wait}</span></span>
    <mdui-button-icon class="city-toggle" aria-expanded="false" aria-label="调整同城换乘">${icon('expand')}</mdui-button-icon>
    <div class="city-edit" hidden>
      ${minutesField(`data-pair="${pair}" value="${query.cityPairs[pair] ?? query.cityTransfer}"`)}
      <mdui-button variant="text" data-remove="${pair}">移除此换乘</mdui-button>
    </div>
  </li>`;
}

const minutesField = attributes => `<mdui-text-field variant="outlined" label="同城换乘时间" type="number" min="0" max="720" step="1" inputmode="numeric" suffix="分钟" required ${attributes}></mdui-text-field>`;

// Adjusted transfers often drop out of the new result, so every setting stays reachable here.
function citySettings(query) {
  if (query.cityTransfer === null) return '';
  const rows = Object.entries(query.cityPairs).map(([pair, value]) => {
    const [a, b] = pair.split('-').map(station => escapeHtml(stations[station][0]));
    return `<div class="city-rule"><span><b>${a}</b> 前往 <b>${b}</b></span>
      ${value === false ? '<span>已移除</span>' : minutesField(`data-pair="${pair}" value="${value}"`)}
      <mdui-button variant="text" data-clear="${pair}">恢复默认</mdui-button></div>`;
  }).join('');
  return `<mdui-button variant="text" class="city-toggle-all" data-settings aria-expanded="${settingsOpen}">同城换乘设置<svg slot="end-icon"><use href="#i-expand"/></svg></mdui-button>
    <div class="city-settings"${settingsOpen ? '' : ' hidden'}>${rows}
      <div class="city-rule add">
        <div class="combobox"><mdui-text-field id="pair-from" variant="outlined" label="换乘到达站" autocomplete="off" spellcheck="false" required></mdui-text-field><mdui-menu class="menu" hidden></mdui-menu></div>
        <div class="combobox"><mdui-text-field id="pair-to" variant="outlined" label="换乘出发站" autocomplete="off" spellcheck="false" required></mdui-text-field><mdui-menu class="menu" hidden></mdui-menu></div>
        ${minutesField(`id="pair-minutes" value="${query.cityTransfer}"`)}
        <mdui-button variant="text" data-add>添加</mdui-button>
      </div>
    </div>`;
}

// The add row is rendered with each result, so its station menus are wired up again every time.
function bindSettings() {
  const [fromField, toField] = [$('pair-from'), $('pair-to')];
  if (!fromField) return;
  setupCombobox(fromField, {allowed: () => [...sameCity.keys()]});
  setupCombobox(toField, {allowed: () => sameCity.get(stationIndex.get(fromField.value.trim())) ?? []});
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

// One entry per leg of the shown result: the fare, null when 12306 has none, undefined until it arrives.
let fares = [];
let faresPending = 0;

// Each leg shows its fare as soon as it arrives; the bar stays until the last request, retries included.
async function loadFare(query, leg, i) {
  const id = faresRequest;
  const cell = resultBox.querySelector(`.fare[data-leg="${i}"]`);
  if (!faresPending++) resultBox.insertAdjacentHTML('afterbegin', '<mdui-linear-progress class="progress" aria-label="正在查询票价"></mdui-linear-progress>');
  if (cell) cell.textContent = '';
  try {
    const fare = await legFare(query, leg);
    if (id !== faresRequest) return;
    fares[i] = fare;
    if (cell) cell.textContent = fare ? `${fare.seat} ${price(fare.price)}` : '暂无票价';
  } catch {
    if (id === faresRequest && cell) cell.innerHTML = `查询失败<mdui-button variant="text" data-fare-retry="${i}">重试</mdui-button>`;
  } finally {
    if (id === faresRequest && !--faresPending) {
      resultBox.querySelector('.progress')?.remove();
      if (fares.every(Boolean)) $('total-fare').textContent = price(fares.reduce((sum, fare) => sum + fare.price, 0));
    }
  }
}

function showFares(query, result) {
  fares = Array.from(result.legs, () => undefined);
  faresPending = 0;
  result.legs.forEach((leg, i) => loadFare(query, leg, i));
}

function render(query, result) {
  faresRequest++;
  const {rejected, unlistedRejected} = result.verification;
  $('share').querySelector('span').textContent = customized(query) && result.found ? '复制方案链接' : '复制链接';
  if (!result.found) {
    showState('没有符合条件的方案', unlistedRejected ? `已排除 ${unlistedRejected} 个 12306 未收录的车次` : '可增加换乘次数或放宽到达时间', citySettings(query));
    return bindSettings();
  }
  const base = Math.floor(result.departure / DAY);
  const legs = result.legs.map((leg, i) => (i ? transferItem(query, result.legs[i - 1], leg) : '') + legItem(leg, i, base)).join('');
  const unlisted = result.legs.filter(leg => leg.unlisted).map(leg => leg.codes[0]);
  const status = unlisted.length
    ? `<span class="unverified">${icon('info')}${escapeHtml(unlisted.join('、'))} 未经 12306 核验</span>`
    : `<span class="verified">${icon('check')}开行日历已核验</span>`;
  resultBox.innerHTML = `
    <mdui-card variant="filled" class="summary">
      <strong>${clock(result.departure, base)} – ${clock(result.arrival, base)}</strong>
      <strong>${duration(result.journeyMinutes)}</strong>
      <span>${dateLabel(addDays(query.date, base), true)}</span>
      <span class="meta"><span>${result.transfers ? `换乘 ${result.transfers} 次` : '直达'}</span><span>${distance(result.km)}</span>${faresInput.checked ? '<span id="total-fare"></span>' : ''}</span>
    </mdui-card>
    <ol class="journey">${legs}</ol>
    <div class="result-foot">${status}${rejected ? `<span>已排除 ${rejected} 个停运班次</span>` : ''}${unlistedRejected ? `<span>已排除 ${unlistedRejected} 个 12306 未收录的车次</span>` : ''}${citySettings(query)}</div>`;
  bindSettings();
  if (faresInput.checked) showFares(query, result);
}

modeGroup.value = mode;
store.prune('calendar:', entry => entry.checkedOn === today);
store.prune('fares:', entry => entry.checkedOn === today);
boot();
