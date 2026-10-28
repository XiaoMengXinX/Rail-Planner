import {dateDay} from './router.mjs';

const DAY = 1440;
const WORD = 2**32;

// Copies a network from createNetwork into the WebAssembly router (router-wasm/src/lib.rs) and returns a
// drop-in replacement for searchWindow(network, query).
export async function wasmRouter(network, bytes) {
  const {instance} = await WebAssembly.instantiate(bytes, {env: {now: () => performance.now()}});
  const wasm = instance.exports;
  const codes = new Map();
  for (const train of network.trains) if (!codes.has(train.c[0])) codes.set(train.c[0], codes.size);

  function call(fn, words, ...args) {
    const pointer = wasm.reserve(words.length);
    new Int32Array(wasm.memory.buffer, pointer, words.length).set(words);
    try {
      return fn(...args, pointer, words.length);
    } finally {
      wasm.release(pointer, words.length);
    }
  }

  const stations = network.stations.length;
  const lists = (rows, width) => {
    const offsets = [0];
    for (const row of rows) offsets.push(offsets.at(-1) + row.length);
    return [offsets, rows.flat(width)];
  };
  const [departureOffsets, departures] = lists(network.departures, 2);
  const [cityOffsets, cities] = lists(network.sameCity, 1);
  const trains = [], stops = [], cancels = [];
  for (const train of network.trains) {
    trains.push(stops.length / 4, train.s.length, train.fromDay, train.toDay, train.r, train.d === false ? 0 : 1,
      cancels.length / 3, train.cancellations.length, codes.get(train.c[0]));
    for (const stop of train.s) stops.push(stop[0], stop[1], stop[2], stop[3]);
    for (const {kind, from, to} of train.cancellations) cancels.push(kind, from, to);
  }
  const rules = network.rules.flatMap(([period, mask]) => [period, mask % WORD, Math.floor(mask / WORD)]);
  const header = [stations, network.trains.length, stops.length / 4, network.rules.length, cancels.length / 3, departures.length / 2, cities.length, codes.size];
  const handle = call(wasm.load, [...header, ...trains, ...stops, ...rules, ...cancels, ...departureOffsets, ...departures, ...cityOffsets, ...cities]);

  return function searchWindow(query) {
    const {from, to, date, arrivalDate, maxTransfers, minTransfer, mode, startMinute = 0, endMinute = DAY - 1, cityTransfer = null, cityPairs = {}} = query;
    const queryDay = dateDay(date);
    const pairs = Object.entries(cityPairs).flatMap(([pair, minutes]) => [...pair.split('-').map(Number), minutes === false ? -1 : minutes]);
    const calendars = [];
    for (const [code, calendar] of network.serviceCalendars) {
      const id = codes.get(code);
      if (id == null) continue;
      if (calendar.excluded) calendars.push(id, -1);
      else for (const [day, flag] of Object.entries(calendar.days)) if (flag === '0') calendars.push(id, dateDay(day));
    }
    const status = call(wasm.search, [from, to, queryDay, (dateDay(arrivalDate) - queryDay) * DAY + endMinute + 1, maxTransfers, minTransfer,
      mode === 'shortest' ? 1 : 0, startMinute, cityTransfer ?? -1, pairs.length / 3, calendars.length / 2, ...pairs, ...calendars], handle);
    if (status === 1) {
      const error = new Error('搜索超时，请缩小日期范围或减少换乘次数');
      error.code = 'TIMEOUT';
      throw error;
    }
    const out = new Float64Array(wasm.memory.buffer, wasm.result(handle));
    if (!out[0]) return {found: false};
    const km = value => Number.isNaN(value) ? null : value;
    const legs = Array.from({length: out[5]}, (_, i) => {
      const [trainIndex, board, alight, originDay, departure, arrival, legKm] = out.subarray(6 + i * 7, 13 + i * 7);
      return {trainIndex, board, alight, originDay, departure, arrival, km: km(legKm)};
    });
    return {found: true, legs, departure: out[1], arrival: out[2], journeyMinutes: out[2] - out[1], km: km(out[3]), transfers: out[4]};
  };
}
