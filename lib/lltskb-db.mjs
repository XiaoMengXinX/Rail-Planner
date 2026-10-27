// Reads the lltskb an.db package (a ZIP of custom binary files) into the planner's timetable model.
// Layouts follow engine/{DataMgr,IndexMgr,QueryCC,Rule,Schedule}.java of the Android app.
// Runs in browsers and in Node; both provide DecompressionStream.

const utf8 = new TextDecoder('utf-8', {fatal: true});
const SHARDS = 20;
const WHOLE_TRAIN = 16384;

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('数据包不是有效的 ZIP 文件');
  const files = new Map();
  const pending = [];
  let p = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('数据包目录损坏');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLength)).toLowerCase();
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    if (name.endsWith('/')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) pending.push(inflate(data).then(out => files.set(name, out)));
    else throw new Error(`不支持的压缩方式 ${method}`);
  }
  await Promise.all(pending);
  return files;
}

class Reader {
  constructor(bytes, name) {
    this.bytes = bytes;
    this.name = name;
    this.pos = 0;
  }
  get done() { return this.pos >= this.bytes.length; }
  take(n) {
    if (this.pos + n > this.bytes.length) throw new Error(`${this.name} 数据截断`);
    return this.bytes.subarray(this.pos, this.pos += n);
  }
  byte() { return this.take(1)[0]; }
  // Two-byte numbers in T/xw/extra files are base 255, not base 256.
  b255() { const [a, b] = this.take(2); return a * 255 + b; }
  be16() { const [a, b] = this.take(2); return a * 256 + b; }
  be32() { const [a, b, c, d] = this.take(4); return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0; }
  date128() { const [a, b, c, d] = this.take(4); return a + b * 128 + c * 16384 + d * 2097152; }
  string8() { return utf8.decode(this.take(this.byte())); }
}

function file(files, name) {
  const data = files.get(name);
  if (!data) throw new Error(`数据包缺少 ${name}`);
  return data;
}

function readIndex(files, name) {
  const r = new Reader(file(files, name), name);
  return Array.from({length: r.be16()}, () => utf8.decode(r.take(r.be16())));
}

// Strips internal variant suffixes: "Y839B" is a dated variant of Y839.
function normalName(raw) {
  const name = raw.split('[')[0].trimEnd();
  const last = name.at(-1);
  return name && last >= 'B' && last < 'Z' ? name.slice(0, -1) : name;
}

// V and N codes are lltskb placeholders for trains of the next timetable change; 12306 mostly does not
// recognise them yet, so their running status cannot be verified. They are left out for now.
const isPlaceholder = code => code.startsWith('V') || code.startsWith('N');

export const readVersion = files => utf8.decode(file(files, 'ver.txt')).replace(/^\uFEFF/, '').trim();

export function readTrainCodes(files) {
  return new Set(readIndex(files, 't.i').flatMap(name => normalName(name).split('/')).filter(code => !isPlaceholder(code)));
}

function readPlatforms(files) {
  const r = new Reader(file(files, 'plat.dat'), 'plat.dat');
  const result = new Map();
  for (let i = r.be32(); i > 0; i--) {
    const train = r.be32(), station = r.be32();
    result.set(`${train}:${station}`, r.string8());
  }
  return result;
}

// Kilometre thresholds where a through train switches to another of its codes (e.g. D3068/D3069).
function readCodeChanges(files) {
  const r = new Reader(file(files, 'xw.dat'), 'xw.dat');
  const result = new Map();
  for (let i = r.b255(); i > 0; i--) {
    const train = r.b255();
    r.b255();
    result.set(train, Array.from({length: r.byte()}, () => ({distance: r.b255(), nameIndex: r.byte()})));
  }
  return result;
}

// Whole-train suspension and restoration ranges from sch.dat.
function readCancellations(files) {
  const r = new Reader(file(files, 'sch.dat'), 'sch.dat');
  const result = new Map();
  while (!r.done) {
    const train = r.b255(), station = r.b255();
    const records = [];
    for (let i = r.byte(); i > 0; i--) {
      const kind = r.byte(), from = r.date128(), to = r.date128();
      if (kind > 2) throw new Error('sch.dat 含未知调整类型');
      if (kind === 0) r.take(3);
      records.push([kind, from, to]);
    }
    if (station === WHOLE_TRAIN) result.set(train, [...(result.get(train) ?? []), ...records]);
  }
  return result;
}

function readOfficialStations(files) {
  const result = new Map();
  const text = files.get('station_name.js');
  if (!text) return result;
  for (const entry of utf8.decode(text).split('@').slice(1)) {
    const parts = entry.split('|');
    if (parts.length >= 5) result.set(parts[1], [parts[3], parts[4], parts[2]]);
  }
  return result;
}

function readTrains(files, names, stationCount, ruleCount) {
  const trains = new Array(names.length);
  for (let shard = 0; shard < SHARDS; shard++) {
    const name = `t${shard}.dat`;
    const r = new Reader(file(files, name), name);
    while (!r.done) {
      const id = r.b255();
      if (id >= names.length || trains[id] || (id + 1) % SHARDS !== shard) throw new Error(`${name} 含无效车次编号`);
      r.byte();
      r.b255();
      const train = {id, from: r.date128(), to: r.date128(), rule: r.b255(), stops: []};
      for (let i = r.b255(); i > 0; i--) {
        const stop = {station: r.b255(), hour: r.byte(), minute: r.byte(), dwell: r.byte(), km: r.b255()};
        if (stop.station >= stationCount || stop.hour >= 24 || stop.minute >= 60) throw new Error(`${name} 含无效经停`);
        train.stops.push(stop);
      }
      if (train.rule >= ruleCount || train.stops.length < 2) throw new Error(`${name} 含无效车次记录`);
      trains[id] = train;
    }
  }
  if (trains.includes(undefined)) throw new Error('车次索引与时刻表不一致');
  return trains;
}

const speedLimit = code => code.startsWith('G') ? 400 : 'DCS'.includes(code[0]) ? 350 : 'KZT'.includes(code[0]) ? 170 : 150;

export function convert(files) {
  const stationNames = readIndex(files, 's.i');
  const names = readIndex(files, 't.i');
  const rules = utf8.decode(file(files, 't.rule')).split(/\r\n|\r|\n/).filter(line => line.trim())
    .map(line => line.trim().split(/\s+/).map(Number));
  const platforms = readPlatforms(files);
  const codeChanges = readCodeChanges(files);
  const cancellations = readCancellations(files);
  const official = readOfficialStations(files);
  const incomplete = [], anomalies = [];
  let extraDays = 0;

  const trains = readTrains(files, names, stationNames.length, rules.length)
    .filter(train => !isPlaceholder(normalName(names[train.id])))
    .map(train => {
      const raw = names[train.id], stops = train.stops;
      const decreases = stops.some((s, i) => i && s.km < stops[i - 1].km);
      const zeroSegments = stops.some((s, i) => i && s.station !== stops[i - 1].station && s.km === stops[i - 1].km);
      const distanceKnown = !decreases && !zeroSegments;
      if (!distanceKnown) incomplete.push(raw);
      if (decreases) anomalies.push(raw);
      const codes = normalName(raw).split('/');
      const changes = codeChanges.get(train.id) ?? [];
      let previousDeparture = null, previousKm = null;
      const packed = stops.map((stop, i) => {
        let nameIndex = 0;
        for (const change of changes) {
          if (change.distance > stop.km) break;
          nameIndex = change.nameIndex;
        }
        const code = codes[nameIndex] ?? codes[0];
        // T files store only clock times; days are inferred from clock wrap-around and a speed ceiling.
        let arrival = stop.hour * 60 + stop.minute;
        if (previousDeparture !== null) {
          arrival += Math.max(0, Math.floor((previousDeparture - arrival + 1439) / 1440)) * 1440;
          while (distanceKnown && (arrival - previousDeparture) * speedLimit(code) < (stop.km - previousKm) * 60) {
            arrival += 1440;
            extraDays++;
          }
        }
        const departure = arrival + stop.dwell;
        previousDeparture = departure;
        previousKm = stop.km;
        return [stop.station, arrival, i === 0 || stop.dwell ? departure : -1, stop.km,
          platforms.get(`${train.id}:${stop.station}`) ?? '', codes.indexOf(code)];
      });
      const result = {id: train.id, n: raw, c: codes, d: distanceKnown, f: train.from, t: train.to, r: train.rule, s: packed};
      if (cancellations.has(train.id)) result.x = cancellations.get(train.id);
      return result;
    });

  return {
    meta: {
      version: readVersion(files),
      trains: trains.length,
      stops: trains.reduce((sum, train) => sum + train.s.length, 0),
      stations: stationNames.length,
      incompleteDistance: incomplete,
      distanceAnomalies: anomalies,
      distanceEligible: trains.length - incomplete.length,
      inferredExtraDays: extraDays,
      cancellationRecords: [...cancellations.values()].reduce((sum, records) => sum + records.length, 0),
    },
    stations: stationNames.map(name => [name, ...(official.get(name) ?? ['', '', ''])]),
    rules,
    trains,
  };
}
