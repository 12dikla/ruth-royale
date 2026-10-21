const express = require('express'), http = require('http'), path = require('path');
const { Server } = require('socket.io');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, r) => r.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

const W = 100, H = 160, MATCH = 180, TICK = 0.05;
const T = {
  cupcake: { cost: 2, hp: 60, dmg: 8, speed: 12, range: 5, cd: 1 },
  dragon:  { cost: 4, hp: 80, dmg: 12, speed: 18, range: 16, cd: 1, fly: 1 },
  cannon:  { cost: 3, hp: 70, dmg: 7, speed: 0, range: 30, cd: 0.6 },
  trap:    { cost: 2, hp: 10, dmg: 45, speed: 0, range: 8, cd: 1 },
  queen:   { cost: 5, hp: 160, dmg: 16, speed: 8, range: 6, cd: 1 },
  cake:    { cost: 7, hp: 320, dmg: 30, speed: 5, range: 6, cd: 1.2 },
};
const SPELL = { storm: 4, sugar: 3, mystery: 2 };
const DECK = [...Object.keys(T), ...Object.keys(SPELL)];
const cost = c => (T[c] ? T[c].cost : SPELL[c]);
const rooms = new Map();
const code = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c)); return c; };
const cleanName = n => String(n || 'Player').replace(/[<>]/g, '').trim().slice(0, 14) || 'Player';
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const TP = { L: [22, 34, 300], R: [78, 34, 300], K: [50, 14, 500] };
const mkTowers = () => [0, 1].flatMap(o => ['L', 'R', 'K'].map(k => ({ o, k, x: TP[k][0], y: o ? H - TP[k][1] : TP[k][1], hp: TP[k][2], cd: 0 })));

function lobby(r) {
  io.to(r.code).emit('room', { code: r.code, phase: r.phase, players: r.players.map(p => ({ name: p.name, ready: p.ready, connected: p.connected, rematch: p.rematch })), result: r.result });
}
function newMatch(r) {
  r.phase = 'playing'; r.result = null;
  r.m = { t: MATCH, e: [5, 5], sugar: [0, 0], tw: mkTowers(), u: [], id: 1, balloon: null, nextBalloon: MATCH - 30, msg: '', msgT: 0 };
  r.players.forEach(p => { const d = shuffle(DECK); p.hand = d.slice(0, 4); p.q = d.slice(4); p.rematch = false; });
  lobby(r); io.to(r.code).emit('start', { names: r.players.map(p => p.name) });
}
const crowns = m => [0, 1].map(o => m.tw.filter(t => t.o !== o && t.hp <= 0).length);
function finish(r, winner, why) {
  if (r.phase !== 'playing') return;
  r.phase = 'ended'; if (winner >= 0) r.wins[winner]++;
  r.result = { winner, why, names: r.players.map(p => p.name), crowns: crowns(r.m), wins: r.wins };
  r.players.forEach(p => { p.ready = false; p.rematch = false; });
  io.to(r.code).emit('end', r.result); lobby(r);
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function tick(r) {
  const m = r.m, dt = TICK; m.t -= dt;
  for (let i = 0; i < 2; i++) { m.e[i] = Math.min(10, m.e[i] + dt * 0.5 * (m.t <= 60 ? 2 : 1) * (m.sugar[i] > 0 ? 2 : 1)); m.sugar[i] = Math.max(0, m.sugar[i] - dt); }
  if (m.msgT > 0 && (m.msgT -= dt) <= 0) m.msg = '';
  if (!m.balloon && m.t <= m.nextBalloon && m.t > 10) m.balloon = { id: m.id++, x: 15 + Math.random() * 70, y: 45 + Math.random() * 70, ttl: 8 };
  if (m.balloon && (m.balloon.ttl -= dt) <= 0) { m.balloon = null; m.nextBalloon = m.t - 25; }
  for (const tw of m.tw) { // towers shoot nearest enemy unit
    if (tw.hp <= 0) continue; tw.cd -= dt; if (tw.cd > 0) continue;
    let b = null, bd = 30; for (const u of m.u) if (u.o !== tw.o && u.hp > 0) { const d = dist(u, tw); if (d < bd) { bd = d; b = u; } }
    if (b) { b.hp -= 10; tw.cd = 0.8; }
  }
  for (const u of m.u) {
    const c = T[u.t]; u.cd -= dt;
    if (u.t === 'cannon') { u.hp -= 2 * dt; }
    const en = m.u.filter(e => e.o !== u.o && e.hp > 0 && e.t !== 'trap');
    if (u.t === 'trap') { if (m.u.some(e => e.o !== u.o && e.hp > 0 && e.t !== 'trap' && dist(u, e) <= c.range)) { for (const e of en) if (dist(u, e) <= 14) e.hp -= c.dmg; u.hp = 0; } continue; }
    let tgt = null, td = 1e9; for (const e of en) { const d = dist(u, e); if (d < td) { td = d; tgt = e; } }
    const aggro = u.t === 'cannon' ? c.range : 14;
    if (tgt && td <= aggro) {
      if (td <= c.range) { if (u.cd <= 0) { tgt.hp -= c.dmg; u.cd = c.cd; } continue; }
    } else {
      const et = m.tw.filter(t => t.o !== u.o && t.hp > 0), lane = u.x < 50 ? 'L' : 'R';
      tgt = et.find(t => t.k === lane) || et.find(t => t.k === 'K');
      if (!tgt) continue; td = dist(u, tgt);
      if (td <= c.range + 5) { if (u.cd <= 0) { tgt.hp -= c.dmg; u.cd = c.cd; } continue; }
    }
    if (!c.speed) continue;
    let px = tgt.x, py = tgt.y;
    if (!c.fly && (u.y < 80) !== (py < 80) && Math.abs(u.y - 80) > 5) { px = u.x < 50 ? 22 : 78; py = 80; }
    const d = Math.hypot(px - u.x, py - u.y) || 1, s = Math.min(d, c.speed * dt);
    u.x += (px - u.x) / d * s; u.y += (py - u.y) / d * s;
  }
  m.u = m.u.filter(u => u.hp > 0);
  const kd = m.tw.filter(t => t.k === 'K' && t.hp <= 0).map(t => t.o);
  if (kd.length) return finish(r, kd.length === 2 ? -1 : 1 - kd[0], 'king');
  if (m.ot) { const c = crowns(m); if (c[0] !== c[1]) return finish(r, c[0] > c[1] ? 0 : 1, 'sudden'); }
  if (m.t <= 0) {
    const c = crowns(m); if (c[0] !== c[1]) return finish(r, c[0] > c[1] ? 0 : 1, 'time');
    if (!m.ot) { m.ot = true; m.t = 60; m.msg = '⚡ OVERTIME! First tower wins!'; m.msgT = 4; return; }
    const h = [0, 1].map(o => m.tw.filter(t => t.o === o).reduce((a, t) => a + Math.max(0, t.hp), 0));
    return finish(r, h[0] === h[1] ? -1 : h[0] > h[1] ? 0 : 1, 'time');
  }
  const base = { ot: !!m.ot, t: Math.ceil(m.t), e: m.e.map(x => +x.toFixed(1)), s: m.sugar.map(x => x > 0), tw: m.tw.map(t => [t.o, t.k, Math.max(0, Math.ceil(t.hp))]), u: m.u.map(u => [u.id, u.o, u.t, +u.x.toFixed(1), +u.y.toFixed(1), Math.ceil(u.hp)]), b: m.balloon && [m.balloon.id, m.balloon.x, m.balloon.y], msg: m.msg };
  r.players.forEach(p => p.sid && io.to(p.sid).emit('state', { ...base, hand: p.hand, next: p.q[0] }));
}
setInterval(() => { for (const [k, r] of rooms) { if (r.phase === 'playing') tick(r); if (!r.players.some(p => p.connected) && Date.now() - r.last > 600000) rooms.delete(k); } }, TICK * 1000);

io.on('connection', sock => {
  let room = null, idx = -1;
  const me = () => room && room.players[idx];
  const attach = (r, i, p) => { room = r; idx = i; p.sid = sock.id; p.connected = true; clearTimeout(p.forfeit); r.last = Date.now(); sock.join(r.code); sock.emit('joined', { code: r.code, you: i }); lobby(r); if (r.phase === 'playing') sock.emit('start', { names: r.players.map(q => q.name) }); };
  sock.on('create', ({ name, pid }) => {
    const r = { code: code(), phase: 'lobby', players: [], wins: [0, 0], m: null, result: null, last: Date.now() };
    rooms.set(r.code, r); const p = { pid, name: cleanName(name), ready: false, connected: true, rematch: false }; r.players.push(p); attach(r, 0, p);
  });
  sock.on('join', ({ code: c, name, pid }) => {
    const r = rooms.get(String(c || '').toUpperCase().trim());
    if (!r) return sock.emit('err', 'Room not found or expired. Check the code!');
    const i = r.players.findIndex(p => p.pid === pid);
    if (i >= 0) return attach(r, i, r.players[i]); // reconnect, no duplicate player
    if (r.players.length >= 2) return sock.emit('err', 'This room is full (2 players max).');
    const p = { pid, name: cleanName(name), ready: false, connected: true, rematch: false }; r.players.push(p); attach(r, r.players.length - 1, p);
  });
  sock.on('ready', () => { if (me() && room.phase === 'lobby') { me().ready = !me().ready; lobby(room); } });
  sock.on('start', () => { if (room && idx === 0 && room.phase === 'lobby' && room.players.length === 2 && room.players.every(p => p.ready)) newMatch(room); });
  sock.on('play', ({ slot, x, y }) => {
    if (!room || room.phase !== 'playing' || !Number.isInteger(slot) || slot < 0 || slot > 3) return sock.emit('rej', 'Invalid move');
    const m = room.m, p = me(), type = p.hand[slot], n = p.name;
    if (m.e[idx] < cost(type)) return sock.emit('rej', 'Not enough elixir');
    if (T[type] || type === 'storm') {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return sock.emit('rej', 'Invalid move');
      if (T[type] && !(x >= 3 && x <= W - 3 && (idx === 0 ? y >= 8 && y <= 74 : y >= 86 && y <= H - 8))) return sock.emit('rej', 'Place it on your own side!');
    }
    m.e[idx] -= cost(type);
    if (T[type]) m.u.push({ id: m.id++, o: idx, t: type, x, y, hp: T[type].hp, cd: 0.7 });
    if (type === 'storm') { m.u.forEach(u => { if (u.o !== idx && Math.hypot(u.x - x, u.y - y) <= 24) u.hp -= 45; }); m.tw.forEach(t => { if (t.o !== idx && t.hp > 0 && Math.hypot(t.x - x, t.y - y) <= 24) t.hp -= 40; }); m.msg = `🌪️ ${n}: Confetti Storm!`; }
    if (type === 'sugar') { m.sugar[idx] = 8; m.msg = `🍭 ${n} is on Sugar Rush!`; }
    if (type === 'mystery') {
      const q = Math.random();
      if (q < 0.34) { m.e[idx] = Math.min(10, m.e[idx] + 5); m.msg = `🎁 ${n}: +elixir!`; }
      else if (q < 0.67) { m.u.push({ id: m.id++, o: idx, t: 'queen', x: 50, y: idx === 0 ? 40 : H - 40, hp: T.queen.hp, cd: 0.5 }); m.msg = `🎁 ${n}: a Party Queen!`; }
      else { const et = m.tw.filter(t => t.o !== idx && t.hp > 0 && t.k !== 'K'); if (et.length) et[Math.random() * et.length | 0].hp -= 80; m.msg = `🎁 ${n}: surprise attack!`; }
    }
    if (m.msg) m.msgT = 3;
    p.hand[slot] = p.q.shift(); p.q.push(type); // card cycling
  });
  sock.on('balloon', ({ id }) => {
    if (!room || room.phase !== 'playing') return; const m = room.m;
    if (m.balloon && m.balloon.id === id) { m.balloon = null; m.nextBalloon = m.t - 25; m.e[idx] = 10; m.msg = `🎈 ${me().name} popped the Golden Balloon!`; m.msgT = 3; }
  });
  sock.on('emote', ({ i }) => { if (!room || !me() || !Number.isInteger(i) || i < 0 || i > 4) return; const p = me(); if (Date.now() - (p.lastEmote || 0) < 1200) return; p.lastEmote = Date.now(); io.to(room.code).emit('emote', { from: idx, i }); });
  sock.on('rematch', () => { if (room && room.phase === 'ended') { me().rematch = true; lobby(room); if (room.players.length === 2 && room.players.every(p => p.rematch)) newMatch(room); } });
  const leave = hard => {
    if (!room) return; const r = room, p = me(), i = idx; room = null; idx = -1; sock.leave(r.code);
    if (!p || p.sid !== sock.id) return;
    p.connected = false; lobby(r);
    if (hard) { if (r.phase === 'lobby') { if (i === 0) { io.to(r.code).emit('left', 'The host closed the room.'); rooms.delete(r.code); } else { r.players.splice(i, 1); r.players.forEach(q => (q.ready = false)); lobby(r); } } else if (r.phase === 'playing') finish(r, 1 - i, 'forfeit'); }
    else if (r.phase === 'playing') p.forfeit = setTimeout(() => finish(r, 1 - i, 'forfeit'), 20000);
    r.last = Date.now();
  };
  sock.on('leave', () => { leave(true); sock.emit('left'); });
  sock.on('disconnect', () => leave(false));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) server.listen(PORT, () => console.log('Ruth Royale on :' + PORT));
module.exports = { server, io };
