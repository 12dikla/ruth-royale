const express = require('express'), http = require('http'), path = require('path');
const { Server } = require('socket.io');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, r) => r.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

const W = 100, H = 160, MATCH = 180, CASTLE_HP = 500, TICK = 0.05;
// speed = units/sec, range = attack range, cd = seconds between hits
const T = {
  cupcake: { cost: 2, hp: 60, dmg: 8, speed: 12, range: 5, cd: 1 },
  dragon:  { cost: 4, hp: 80, dmg: 12, speed: 18, range: 18, cd: 1 },
  cannon:  { cost: 3, hp: 50, dmg: 6, speed: 0, range: 30, cd: 0.6 },
  trap:    { cost: 2, hp: 10, dmg: 40, speed: 0, range: 8, cd: 1 },
  queen:   { cost: 5, hp: 150, dmg: 15, speed: 8, range: 6, cd: 1 },
  cake:    { cost: 7, hp: 300, dmg: 30, speed: 5, range: 6, cd: 1.2 },
};
const SPELL = { storm: 4, sugar: 3, mystery: 2 };
const rooms = new Map();
const castleY = o => (o === 0 ? 4 : H - 4);
const code = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms.has(c)); return c; };
const cleanName = n => String(n || 'Player').replace(/[<>]/g, '').trim().slice(0, 14) || 'Player';

function lobby(r) {
  io.to(r.code).emit('room', { code: r.code, phase: r.phase, players: r.players.map(p => ({ name: p.name, ready: p.ready, connected: p.connected, rematch: p.rematch })), result: r.result });
}
function newMatch(r) {
  r.phase = 'playing'; r.result = null;
  r.m = { t: MATCH, e: [5, 5], sugar: [0, 0], c: [CASTLE_HP, CASTLE_HP], u: [], id: 1, balloon: null, nextBalloon: MATCH - 30, msg: '', msgT: 0 };
  r.players.forEach(p => (p.rematch = false));
  lobby(r);
  io.to(r.code).emit('start', { names: r.players.map(p => p.name) });
}
function finish(r, winner, why) {
  if (r.phase !== 'playing') return;
  r.phase = 'ended';
  r.result = { winner, why, names: r.players.map(p => p.name) };
  r.players.forEach(p => { p.ready = false; p.rematch = false; });
  io.to(r.code).emit('end', r.result); lobby(r);
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function tick(r) {
  const m = r.m, dt = TICK; m.t -= dt;
  for (let i = 0; i < 2; i++) { m.e[i] = Math.min(10, m.e[i] + dt * (m.sugar[i] > 0 ? 2 : 1)); m.sugar[i] = Math.max(0, m.sugar[i] - dt); }
  if (m.msgT > 0 && (m.msgT -= dt) <= 0) m.msg = '';
  if (!m.balloon && m.t <= m.nextBalloon && m.t > 10) m.balloon = { id: m.id++, x: 15 + Math.random() * 70, y: 40 + Math.random() * 80, ttl: 8 };
  if (m.balloon && (m.balloon.ttl -= dt) <= 0) { m.balloon = null; m.nextBalloon = m.t - 25; }
  for (const u of m.u) {
    const c = T[u.t], en = m.u.filter(e => e.o !== u.o && e.hp > 0);
    let tgt = null, td = 1e9; for (const e of en) { const d = dist(u, e); if (d < td) { td = d; tgt = e; } }
    u.cd -= dt;
    if (u.t === 'trap') { if (tgt && td <= c.range) { for (const e of en) if (dist(u, e) <= 12) e.hp -= c.dmg; u.hp = 0; } continue; }
    if (tgt && td <= c.range) { if (u.cd <= 0) { tgt.hp -= c.dmg; u.cd = c.cd; } continue; }
    const cd = Math.abs(u.y - castleY(1 - u.o));
    if (cd <= c.range) { if (u.cd <= 0) { m.c[1 - u.o] -= c.dmg; u.cd = c.cd; } continue; }
    if (c.speed) {
      u.y += (u.o === 0 ? 1 : -1) * c.speed * dt;
      if (tgt && td < 30) u.x += Math.sign(tgt.x - u.x) * Math.min(Math.abs(tgt.x - u.x), c.speed * dt * 0.6);
      u.x = Math.max(2, Math.min(W - 2, u.x));
    }
  }
  m.u = m.u.filter(u => u.hp > 0);
  if (m.c[0] <= 0 || m.c[1] <= 0) return finish(r, m.c[0] <= 0 && m.c[1] <= 0 ? -1 : m.c[0] <= 0 ? 1 : 0, 'castle');
  if (m.t <= 0) return finish(r, m.c[0] === m.c[1] ? -1 : m.c[0] > m.c[1] ? 0 : 1, 'time');
  io.to(r.code).emit('state', { t: Math.ceil(m.t), e: m.e.map(x => +x.toFixed(1)), s: m.sugar.map(x => x > 0), c: m.c, u: m.u.map(u => [u.id, u.o, u.t, +u.x.toFixed(1), +u.y.toFixed(1), Math.ceil(u.hp)]), b: m.balloon && [m.balloon.id, m.balloon.x, m.balloon.y], msg: m.msg });
}
setInterval(() => { for (const [k, r] of rooms) { if (r.phase === 'playing') tick(r); if (!r.players.some(p => p.connected) && Date.now() - r.last > 600000) rooms.delete(k); } }, TICK * 1000);

io.on('connection', sock => {
  let room = null, idx = -1;
  const me = () => room && room.players[idx];
  const attach = (r, i, p) => { room = r; idx = i; p.sid = sock.id; p.connected = true; clearTimeout(p.forfeit); r.last = Date.now(); sock.join(r.code); sock.emit('joined', { code: r.code, you: i }); lobby(r); if (r.phase === 'playing') sock.emit('start', { names: r.players.map(q => q.name) }); };
  sock.on('create', ({ name, pid }) => {
    const r = { code: code(), phase: 'lobby', players: [], m: null, result: null, last: Date.now() };
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
  sock.on('deploy', ({ type, x, y }) => {
    if (!room || room.phase !== 'playing' || !T[type] || !Number.isFinite(x) || !Number.isFinite(y)) return sock.emit('rej', 'Invalid move');
    const m = room.m, c = T[type];
    const ok = x >= 2 && x <= W - 2 && (idx === 0 ? y >= 8 && y <= H / 2 - 4 : y >= H / 2 + 4 && y <= H - 8);
    if (!ok) return sock.emit('rej', 'Deploy on your own side!');
    if (m.e[idx] < c.cost) return sock.emit('rej', 'Not enough energy');
    m.e[idx] -= c.cost; m.u.push({ id: m.id++, o: idx, t: type, x, y, hp: c.hp, cd: 0.5 });
  });
  sock.on('spell', ({ type }) => {
    if (!room || room.phase !== 'playing' || !SPELL[type]) return sock.emit('rej', 'Invalid spell');
    const m = room.m; if (m.e[idx] < SPELL[type]) return sock.emit('rej', 'Not enough energy');
    m.e[idx] -= SPELL[type]; const n = me().name;
    if (type === 'storm') { m.u.forEach(u => { if (u.o !== idx) u.hp -= 25; }); m.msg = `🎊 ${n} cast Confetti Storm!`; }
    if (type === 'sugar') { m.sugar[idx] = 8; m.msg = `🍭 ${n} is on Sugar Rush!`; }
    if (type === 'mystery') {
      const r = Math.random();
      if (r < 0.34) { m.e[idx] = Math.min(10, m.e[idx] + 5); m.msg = `🎁 ${n}'s present: +energy!`; }
      else if (r < 0.67) { m.u.push({ id: m.id++, o: idx, t: 'queen', x: 50, y: idx === 0 ? 30 : H - 30, hp: T.queen.hp, cd: 0.5 }); m.msg = `🎁 ${n}'s present: a Party Queen!`; }
      else { m.c[1 - idx] -= 40; m.msg = `🎁 ${n}'s present: a surprise attack!`; }
    }
    m.msgT = 3;
  });
  sock.on('balloon', ({ id }) => {
    if (!room || room.phase !== 'playing') return; const m = room.m;
    if (m.balloon && m.balloon.id === id) { m.balloon = null; m.nextBalloon = m.t - 25; m.e[idx] = 10; m.c[idx] = Math.min(CASTLE_HP, m.c[idx] + 60); m.msg = `🎈 ${me().name} popped the Golden Balloon!`; m.msgT = 3; }
  });
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
