//! Port of `searchWindow` in web/router.mjs. It must return exactly what the JS search returns, ties
//! included, so the heap, the comparators and every iteration order follow the JS code step by step.

use std::collections::HashMap;
use std::rc::Rc;

const DAY: i32 = 1440;

extern "C" {
    fn now() -> f64;
}

struct Train {
    stops: usize,
    len: usize,
    from_day: i32,
    to_day: i32,
    rule: usize,
    distance: bool,
    cancels: usize,
    cancel_len: usize,
    code: usize,
}

#[derive(Clone, Copy)]
struct Stop {
    station: u32,
    arrival: i32,
    departure: i32,
    km: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Mode {
    Fastest,
    Shortest,
}

#[derive(PartialEq, Eq, Hash)]
struct BoundKey {
    mode: Mode,
    to: u32,
    city_transfer: Option<i32>,
    pairs: Vec<(u32, u32, Option<i32>)>,
}

pub struct Network {
    trains: Vec<Train>,
    stops: Vec<Stop>,
    rules: Vec<(i32, u64)>,
    cancels: Vec<[i32; 3]>,
    departures: Vec<Vec<(u32, u32)>>,
    same_city: Vec<Vec<u32>>,
    reverse: [Option<Vec<Vec<(u32, i32)>>>; 2],
    bounds: HashMap<BoundKey, Rc<Vec<f64>>>,
    // 12306 calendars of the running search, by code: 0 none, 1 never runs, 2 stops on `stopped` days.
    blocked: Vec<u8>,
    stopped: Vec<(usize, i32)>,
    out: Vec<f64>,
}

#[derive(Clone)]
struct Query {
    from: u32,
    to: u32,
    query_day: i32,
    deadline: i32,
    max_transfers: u32,
    min_transfer: i32,
    mode: Mode,
    start_minute: i32,
    city_transfer: Option<i32>,
    pairs: Vec<(u32, u32, Option<i32>)>,
}

#[derive(Clone, Copy)]
struct Leg {
    train: u32,
    board: u32,
    alight: u32,
    origin_day: i32,
    departure: i32,
    arrival: i32,
    km: Option<i32>,
}

#[derive(Clone, Copy)]
struct Label {
    station: u32,
    time: i32,
    start: i32,
    km: f64,
    legs: u32,
    parent: Option<u32>,
    dead: bool,
    moved: bool,
    ready: i32,
    estimate: f64,
    leg: Option<Leg>,
}

struct Found {
    legs: Vec<Leg>,
    departure: i32,
    arrival: i32,
    km: f64,
    transfers: u32,
}

struct Timeout;

fn floor_div(a: i32, b: i32) -> i32 {
    a.div_euclid(b)
}

fn ceil_div(a: i32, b: i32) -> i32 {
    -(-a).div_euclid(b)
}

// JS `a || b` on numbers: 0 and NaN fall through.
fn or(a: f64, b: impl FnOnce() -> f64) -> f64 {
    if a != 0.0 && !a.is_nan() { a } else { b() }
}

fn heap_push<T: Copy>(items: &mut Vec<T>, item: T, compare: impl Fn(&T, &T) -> f64) {
    items.push(item);
    let mut i = items.len() - 1;
    while i > 0 {
        let p = (i - 1) >> 1;
        if compare(&items[p], &item) <= 0.0 {
            break;
        }
        items[i] = items[p];
        i = p;
    }
    items[i] = item;
}

fn heap_pop<T: Copy>(items: &mut Vec<T>, compare: impl Fn(&T, &T) -> f64) -> Option<T> {
    let top = *items.first()?;
    let last = items.pop().unwrap();
    if !items.is_empty() {
        let len = items.len();
        let mut i = 0;
        while i * 2 + 1 < len {
            let mut j = i * 2 + 1;
            if j + 1 < len && compare(&items[j + 1], &items[j]) < 0.0 {
                j += 1;
            }
            if compare(&last, &items[j]) <= 0.0 {
                break;
            }
            items[i] = items[j];
            i = j;
        }
        items[i] = last;
    }
    Some(top)
}

fn move_cost(city_transfer: i32, pairs: &[(u32, u32, Option<i32>)], from: u32, to: u32) -> Option<i32> {
    match pairs.iter().find(|p| p.0 == from && p.1 == to) {
        Some(p) => p.2,
        None => Some(city_transfer),
    }
}

impl Network {
    fn train_stops(&self, train: &Train) -> &[Stop] {
        &self.stops[train.stops..train.stops + train.len]
    }

    fn operates(&self, train: &Train, origin_day: i32) -> bool {
        if origin_day < train.from_day || origin_day > train.to_day {
            return false;
        }
        let mut state = -1;
        for &[kind, from, to] in &self.cancels[train.cancels..train.cancels + train.cancel_len] {
            if origin_day < from || origin_day > to {
                continue;
            }
            if state == -1 && kind != 2 {
                state = kind;
            } else if state == 0 && kind == 1 {
                state = 1;
            } else if state == 1 && kind == 2 {
                state = 2;
            } else if state == 2 && kind == 0 {
                state = 0;
            }
        }
        if state == 1 {
            return false;
        }
        match self.blocked[train.code] {
            1 => return false,
            2 if self.stopped.contains(&(train.code, origin_day)) => return false,
            _ => {}
        }
        let (raw, mask) = self.rules[train.rule];
        let period = if raw == 0 { 1 } else { raw };
        if period == 1 {
            return true;
        }
        let bit = (origin_day - train.from_day) % period;
        bit < 64 && (mask >> bit) & 1 == 1
    }

    fn next_departure(&self, train: &Train, stop: usize, ready: i32, deadline: i32, query_day: i32) -> Option<(i32, i32)> {
        let minute = self.train_stops(train)[stop].departure;
        let mut day = ceil_div(ready - minute, DAY).max(train.from_day - query_day);
        let end = floor_div(deadline - minute, DAY).min(train.to_day - query_day);
        while day <= end {
            if self.operates(train, query_day + day) {
                return Some((minute + day * DAY, day));
            }
            day += 1;
        }
        None
    }

    fn remaining_bound(&mut self, q: &Query) -> Rc<Vec<f64>> {
        let key = BoundKey { mode: q.mode, to: q.to, city_transfer: q.city_transfer, pairs: q.pairs.clone() };
        if let Some(bound) = self.bounds.get(&key) {
            return bound.clone();
        }
        let slot = q.mode as usize;
        if self.reverse[slot].is_none() {
            let mut edges = vec![Vec::new(); self.departures.len()];
            for train in &self.trains {
                if q.mode == Mode::Shortest && !train.distance {
                    continue;
                }
                let stops = self.train_stops(train);
                for i in 1..stops.len() {
                    let (a, b) = (stops[i - 1], stops[i]);
                    let cost = if q.mode == Mode::Shortest { b.km - a.km } else { b.arrival - if a.departure >= 0 { a.departure } else { a.arrival } };
                    edges[b.station as usize].push((a.station, cost.max(0)));
                }
            }
            self.reverse[slot] = Some(edges);
        }
        let edges = self.reverse[slot].as_ref().unwrap();
        let mut bound = vec![f64::INFINITY; self.departures.len()];
        let mut queue: Vec<(f64, u32)> = Vec::new();
        let compare = |a: &(f64, u32), b: &(f64, u32)| a.0 - b.0;
        bound[q.to as usize] = 0.0;
        heap_push(&mut queue, (0.0, q.to), compare);
        while let Some((cost, station)) = heap_pop(&mut queue, compare) {
            if cost > bound[station as usize] {
                continue;
            }
            let mut relax = |next: u32, value: f64| {
                if value < bound[next as usize] {
                    bound[next as usize] = value;
                    heap_push(&mut queue, (value, next), compare);
                }
            };
            for &(next, edge) in &edges[station as usize] {
                relax(next, cost + edge as f64);
            }
            let Some(city_transfer) = q.city_transfer else { continue };
            for &other in &self.same_city[station as usize] {
                if let Some(cost_move) = move_cost(city_transfer, &q.pairs, other, station) {
                    relax(other, cost + if q.mode == Mode::Shortest { 0.0 } else { cost_move as f64 });
                }
            }
        }
        let bound = Rc::new(bound);
        self.bounds.insert(key, bound.clone());
        bound
    }

    fn search_window(&mut self, q: &Query, upper: Option<f64>) -> Result<Option<Found>, Timeout> {
        // Changing station can only improve on staying put, so the cheaper search without it gives an upper bound.
        if q.city_transfer.is_some() && upper.is_none() {
            let base = self.search_window(&Query { city_transfer: None, ..q.clone() }, None)?;
            if let Some(base) = base {
                let upper = if q.mode == Mode::Shortest { base.km } else { (base.arrival - base.departure) as f64 };
                return self.search_window(q, Some(upper));
            }
        }
        let bound = self.remaining_bound(q);
        let mut search = Search {
            net: self,
            q,
            bound: &bound,
            labels: Vec::new(),
            frontiers: vec![Vec::new(); self.departures.len()],
            queue: Vec::new(),
            best: upper.unwrap_or(f64::INFINITY),
            checks: 0,
            started: unsafe { now() },
        };
        search.run()
    }
}

struct Search<'a> {
    net: &'a Network,
    q: &'a Query,
    bound: &'a [f64],
    labels: Vec<Label>,
    frontiers: Vec<Vec<u32>>,
    queue: Vec<u32>,
    best: f64,
    checks: u32,
    started: f64,
}

fn primary(mode: Mode, l: &Label) -> f64 {
    if mode == Mode::Shortest { l.km } else { (l.time - l.start) as f64 }
}

fn compare(mode: Mode, a: &Label, b: &Label) -> f64 {
    or(a.estimate - b.estimate, || {
        let second = if mode == Mode::Shortest { ((a.time - a.start) - (b.time - b.start)) as f64 } else { a.km - b.km };
        or(second, || or((a.legs as f64) - (b.legs as f64), || (a.time - b.time) as f64))
    })
}

fn covers(l: &Label, c: &Label) -> bool {
    l.ready <= c.ready && l.start >= c.start && l.km <= c.km && l.legs <= c.legs && (!l.moved || c.moved)
}

impl Search<'_> {
    fn check_time(&mut self) -> Result<(), Timeout> {
        self.checks += 1;
        if self.checks % 1000 == 0 && unsafe { now() } - self.started > 60000.0 {
            return Err(Timeout);
        }
        Ok(())
    }

    fn keep(&mut self, mut c: Label) -> Result<(), Timeout> {
        self.check_time()?;
        let station = c.station as usize;
        c.estimate = primary(self.q.mode, &c) + self.bound[station];
        if self.bound[station] == f64::INFINITY || c.estimate > self.best {
            return Ok(());
        }
        // A label reached by changing station can board at once but cannot change station again.
        c.ready = if c.moved { c.time } else { c.time + self.q.min_transfer };
        // The frontier is an antichain, so a covered candidate covers none of it and nothing is dropped early.
        let frontier = &mut self.frontiers[station];
        let mut kept = 0;
        for i in 0..frontier.len() {
            let l = &mut self.labels[frontier[i] as usize];
            if covers(l, &c) {
                return Ok(());
            }
            if covers(&c, l) {
                l.dead = true;
            } else {
                frontier[kept] = frontier[i];
                kept += 1;
            }
        }
        frontier.truncate(kept);
        let index = self.labels.len() as u32;
        self.labels.push(c);
        frontier.push(index);
        let (labels, mode) = (&self.labels, self.q.mode);
        heap_push(&mut self.queue, index, |a, b| compare(mode, &labels[*a as usize], &labels[*b as usize]));
        if c.station == self.q.to {
            self.best = self.best.min(primary(mode, &c));
        }
        Ok(())
    }

    fn ride(&mut self, train_index: u32, board: usize, departure: i32, origin_day: i32, parent: Option<u32>) -> Result<(), Timeout> {
        let train = &self.net.trains[train_index as usize];
        let stops = self.net.train_stops(train);
        let from = parent.map(|p| self.labels[p as usize]);
        let start = from.map_or(departure, |p| p.start);
        for alight in board + 1..stops.len() {
            let stop = stops[alight];
            let arrival = stop.arrival + origin_day * DAY;
            if arrival >= self.q.deadline {
                break;
            }
            let km = stop.km - stops[board].km;
            if arrival < departure || (train.distance && km < 0) {
                continue;
            }
            self.keep(Label {
                station: stop.station,
                time: arrival,
                start,
                km: if train.distance { from.map_or(0.0, |p| p.km) + km as f64 } else { f64::INFINITY },
                legs: from.map_or(0, |p| p.legs) + 1,
                parent,
                dead: false,
                moved: false,
                ready: 0,
                estimate: 0.0,
                leg: Some(Leg {
                    train: train_index,
                    board: board as u32,
                    alight: alight as u32,
                    origin_day,
                    departure,
                    arrival,
                    km: train.distance.then_some(km),
                }),
            })?;
        }
        Ok(())
    }

    fn run(&mut self) -> Result<Option<Found>, Timeout> {
        let (net, q) = (self.net, self.q);
        // Boarding minutes are relative to the train's origin day, which may precede the departure date.
        for &(train_index, board) in &net.departures[q.from as usize] {
            let train = &net.trains[train_index as usize];
            if q.mode == Mode::Shortest && !train.distance {
                continue;
            }
            let minute = net.train_stops(train)[board as usize].departure;
            let day = ceil_div(q.start_minute - minute, DAY);
            if minute + day * DAY < DAY && net.operates(train, q.query_day + day) {
                self.ride(train_index, board as usize, minute + day * DAY, day, None)?;
            }
        }
        loop {
            let (labels, mode) = (&self.labels, q.mode);
            let Some(index) = heap_pop(&mut self.queue, |a, b| compare(mode, &labels[*a as usize], &labels[*b as usize])) else { break };
            let current = self.labels[index as usize];
            if current.dead {
                continue;
            }
            if current.station == q.to {
                let mut legs = Vec::new();
                let mut label = Some(index);
                while let Some(i) = label {
                    let l = &self.labels[i as usize];
                    legs.extend(l.leg);
                    label = l.parent;
                }
                legs.reverse();
                return Ok(Some(Found { legs, departure: current.start, arrival: current.time, km: current.km, transfers: current.legs - 1 }));
            }
            if current.legs >= q.max_transfers + 1 {
                continue;
            }
            self.check_time()?;
            for &(train_index, board) in &net.departures[current.station as usize] {
                let train = &net.trains[train_index as usize];
                if q.mode == Mode::Shortest && !train.distance {
                    continue;
                }
                if let Some((departure, day)) = net.next_departure(train, board as usize, current.ready, q.deadline - 1, q.query_day) {
                    self.ride(train_index, board as usize, departure, day, Some(index))?;
                }
            }
            let Some(city_transfer) = q.city_transfer else { continue };
            if current.moved {
                continue;
            }
            for &station in &net.same_city[current.station as usize] {
                let Some(cost) = move_cost(city_transfer, &q.pairs, current.station, station) else { continue };
                if current.time + cost >= q.deadline || station == q.to || net.departures[station as usize].is_empty() {
                    continue;
                }
                self.keep(Label { station, time: current.time + cost, parent: Some(index), leg: None, moved: true, dead: false, ..current })?;
            }
        }
        Ok(None)
    }
}

/// Memory for the JS side to fill before `load` or `search`; `release` returns it.
#[no_mangle]
pub extern "C" fn reserve(words: usize) -> *mut i32 {
    let mut buffer = Vec::<i32>::with_capacity(words);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn release(pointer: *mut i32, words: usize) {
    drop(Vec::from_raw_parts(pointer, 0, words));
}

unsafe fn slice<'a>(pointer: *const i32, words: usize) -> &'a [i32] {
    if words == 0 { &[] } else { std::slice::from_raw_parts(pointer, words) }
}

/// Layout, all i32: header [stations, trains, stops, rules, cancels, departures, sameCity, codes], then
/// trains × [stopOffset, stopCount, fromDay, toDay, rule, distance, cancelOffset, cancelCount, code],
/// stops × [station, arrival, departure, km], rules × [period, maskLow, maskHigh], cancels × [kind, from, to],
/// departures and sameCity as stations + 1 offsets followed by their items ([train, stop] pairs, stations).
#[no_mangle]
pub unsafe extern "C" fn load(pointer: *const i32, words: usize) -> *mut Network {
    let data = slice(pointer, words);
    let [stations, trains, stops, rules, cancels, departures, same_city, codes] = [0, 1, 2, 3, 4, 5, 6, 7].map(|i| data[i] as usize);
    let mut at = 8;
    let mut take = |count: usize| {
        let part = &data[at..at + count];
        at += count;
        part
    };
    let trains = take(trains * 9).chunks(9).map(|t| Train {
        stops: t[0] as usize,
        len: t[1] as usize,
        from_day: t[2],
        to_day: t[3],
        rule: t[4] as usize,
        distance: t[5] == 1,
        cancels: t[6] as usize,
        cancel_len: t[7] as usize,
        code: t[8] as usize,
    }).collect();
    let stops = take(stops * 4).chunks(4).map(|s| Stop { station: s[0] as u32, arrival: s[1], departure: s[2], km: s[3] }).collect();
    let rules = take(rules * 3).chunks(3).map(|r| (r[0], r[1] as u32 as u64 | (r[2] as u32 as u64) << 32)).collect();
    let cancels = take(cancels * 3).chunks(3).map(|c| [c[0], c[1], c[2]]).collect();
    let mut lists = |items: usize, width: usize| {
        let offsets = take(stations + 1).to_vec();
        let flat = take(items * width);
        (0..stations).map(|s| flat[offsets[s] as usize * width..offsets[s + 1] as usize * width].to_vec()).collect::<Vec<_>>()
    };
    let departures = lists(departures, 2).into_iter().map(|d| d.chunks(2).map(|p| (p[0] as u32, p[1] as u32)).collect()).collect();
    let same_city = lists(same_city, 1).into_iter().map(|c| c.into_iter().map(|s| s as u32).collect()).collect();
    Box::into_raw(Box::new(Network {
        trains,
        stops,
        rules,
        cancels,
        departures,
        same_city,
        reverse: [None, None],
        bounds: HashMap::new(),
        blocked: vec![0; codes],
        stopped: Vec::new(),
        out: Vec::new(),
    }))
}

/// Query, all i32: [from, to, queryDay, deadline, maxTransfers, minTransfer, shortest, startMinute,
/// cityTransfer (-1 without), pairs, calendars], pairs × [from, to, minutes (-1 removed)], calendars ×
/// [code, day (-1 never runs)]. Returns 0 when done, 1 on timeout; the result is at `result`.
#[no_mangle]
pub unsafe extern "C" fn search(network: *mut Network, pointer: *const i32, words: usize) -> i32 {
    let net = &mut *network;
    let data = slice(pointer, words);
    let pairs = (0..data[9] as usize).map(|i| {
        let p = &data[11 + i * 3..14 + i * 3];
        (p[0] as u32, p[1] as u32, (p[2] >= 0).then_some(p[2]))
    }).collect();
    net.blocked.fill(0);
    net.stopped.clear();
    let calendars = 11 + data[9] as usize * 3;
    for c in data[calendars..calendars + data[10] as usize * 2].chunks(2) {
        let code = c[0] as usize;
        if c[1] < 0 {
            net.blocked[code] = 1;
        } else {
            if net.blocked[code] == 0 {
                net.blocked[code] = 2;
            }
            net.stopped.push((code, c[1]));
        }
    }
    let query = Query {
        from: data[0] as u32,
        to: data[1] as u32,
        query_day: data[2],
        deadline: data[3],
        max_transfers: data[4] as u32,
        min_transfer: data[5],
        mode: if data[6] == 1 { Mode::Shortest } else { Mode::Fastest },
        start_minute: data[7],
        city_transfer: (data[8] >= 0).then_some(data[8]),
        pairs,
    };
    let found = match net.search_window(&query, None) {
        Ok(found) => found,
        Err(Timeout) => return 1,
    };
    // [found, departure, arrival, km (NaN unknown), transfers, legs], legs × [train, board, alight,
    // originDay, departure, arrival, km (NaN unknown)].
    net.out.clear();
    match found {
        None => net.out.push(0.0),
        Some(f) => {
            net.out.extend([1.0, f.departure as f64, f.arrival as f64, if f.km.is_finite() { f.km } else { f64::NAN }, f.transfers as f64, f.legs.len() as f64]);
            for leg in f.legs {
                net.out.extend([leg.train as f64, leg.board as f64, leg.alight as f64, leg.origin_day as f64, leg.departure as f64, leg.arrival as f64, leg.km.map_or(f64::NAN, |k| k as f64)]);
            }
        }
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn result(network: *const Network) -> *const f64 {
    (*network).out.as_ptr()
}
