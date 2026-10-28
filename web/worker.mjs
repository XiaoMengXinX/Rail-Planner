import {convert, unzip} from '../lib/lltskb-db.mjs';
import {createNetwork} from './router.mjs';
import {searchVerified, verifyPlan} from './verified-search.mjs';

let network;
let calendarId = 0;
const calendarRequests = new Map();

// Network requests run on the main thread, where BotID attaches its verification headers.
function fetchCalendar(code, date) {
  return new Promise((resolve, reject) => {
    calendarRequests.set(++calendarId, {resolve, reject});
    postMessage({type: 'calendar', id: calendarId, code, date});
  });
}

async function load(buffer) {
  const data = convert(await unzip(buffer));
  network = createNetwork(data);
  const traffic = new Array(data.stations.length).fill(0);
  for (const train of data.trains) for (const stop of train.s) traffic[stop[0]]++;
  postMessage({type: 'ready', version: data.version, stations: data.stations, groups: data.groups, traffic});
}

onmessage = async ({data}) => {
  if (data.type === 'calendar') {
    const request = calendarRequests.get(data.id);
    calendarRequests.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
    return;
  }
  try {
    if (data.type === 'load') await load(data.buffer);
    else {
      const options = {fetchCalendar, onProgress: progress => postMessage({type: 'progress', id: data.id, ...progress})};
      const result = data.plan
        ? await verifyPlan(network, data.query, data.plan, options)
        : await searchVerified(network, data.query, options);
      postMessage({type: 'result', id: data.id, query: data.query, result});
    }
  } catch (error) {
    postMessage({type: 'error', id: data.id, message: error.message, plan: Boolean(data.plan)});
  }
};
