const { server } = require('./server'); const { io: C } = require('socket.io-client');
const assert = require('assert'); const sleep = ms => new Promise(r => setTimeout(r, ms));
server.listen(0, async () => {
  const url = 'http://localhost:' + server.address().port;
  const mk = () => { const s = C(url, { forceNew: true }); s.log = []; s.onAny((e, d) => s.log.push([e, d])); s.last = e => [...s.log].reverse().find(x => x[0] === e)?.[1]; return s; };
  const a = mk(), b = mk(), c = mk(); let ok = 0; const t = (n, f) => { f(); console.log('PASS', n); ok++; };
  a.emit('create', { name: 'Dikla', pid: 'A' }); await sleep(150); const code = a.last('joined').code;
  b.emit('join', { code, name: 'Friend', pid: 'B' }); await sleep(150);
  t('two clients join same room', () => assert.equal(a.last('room').players.length, 2));
  c.emit('join', { code, name: 'Third', pid: 'C' }); await sleep(100);
  t('third player rejected', () => assert.match(c.last('err'), /full/));
  c.emit('join', { code: 'ZZZZ', name: 'x', pid: 'C' }); await sleep(100);
  t('invalid room rejected', () => assert.match(c.last('err'), /not found/));
  a.emit('start'); await sleep(100); t('start blocked until ready', () => assert.equal(a.last('start'), undefined));
  a.emit('ready'); b.emit('ready'); await sleep(100); b.emit('start'); await sleep(100);
  t('guest cannot start', () => assert.equal(a.last('start'), undefined));
  a.emit('start'); await sleep(200); t('host starts, both get start', () => assert(a.last('start') && b.last('start')));
  a.emit('deploy', { type: 'cupcake', x: 50, y: 120 }); await sleep(100);
  t('wrong-side deploy rejected', () => assert.match(a.last('rej'), /own side/));
  a.emit('deploy', { type: 'cupcake', x: 50, y: 30 }); await sleep(150);
  t('deploy appears on BOTH clients', () => { assert.equal(a.last('state').u.length, 1); assert.equal(b.last('state').u.length, 1); assert.equal(b.last('state').u[0][1], 0); });
  t('energy deducted & synced', () => assert.equal(a.last('state').e[0], b.last('state').e[0]));
  a.emit('deploy', { type: 'cake', x: 50, y: 30 }); a.emit('deploy', { type: 'cake', x: 50, y: 30 }); await sleep(100);
  t('insufficient energy rejected', () => assert.match(a.last('rej'), /energy/));
  a.emit('deploy', { type: 'bogus', x: 1, y: 1 }); await sleep(100); t('unknown unit rejected', () => assert.match(a.last('rej'), /Invalid/));
  a.disconnect(); await sleep(100); const a2 = mk(); a2.emit('join', { code, name: 'Dikla', pid: 'A' }); await sleep(200);
  t('reconnect keeps 2 players, no dupes', () => { assert.equal(a2.last('room').players.length, 2); assert.equal(a2.last('joined').you, 0); });
  // force a win: spam units from A until B's castle falls (fast-forward by many deploys over time)
  let res = null; b.on('end', r => (res = r)); a2.on('end', () => {});
  for (let i = 0; i < 400 && !res; i++) { for (const k of ['queen', 'cake', 'cupcake']) a2.emit('deploy', { type: k, x: 50, y: 70 }); a2.emit('spell', { type: 'sugar' }); await sleep(500); }
  t('both clients get the same winner', () => { assert(res); assert.equal(res.winner, 0); assert.deepEqual(a2.last('end'), b.last('end')); });
  a2.emit('rematch'); await sleep(100); b.emit('rematch'); await sleep(300);
  t('rematch resets match', () => { const s = b.last('state'); assert(s.t >= 178 && s.c[0] === 500 && s.c[1] === 500 && s.u.length === 0); });
  console.log(ok + ' checks passed'); process.exit(0);
});
