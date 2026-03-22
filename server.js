const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true,
  transports: ['polling', 'websocket'],
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.get('/',       (_req, res) => res.sendFile(path.join(__dirname, 'dawn-game.html')));
app.get('/health', (_req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const rooms = {};

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)]; return c;
}
function makeCode()       { let c; do { c = randCode(); } while (rooms[c]); return c; }
function getRoom(code)    { return rooms[code] || null; }
function playerList(r)    { return Object.values(r.players); }
function alivePlayers(r)  { return Object.values(r.players).filter(p => p.alive); }
function clearTimer(room) { if (room.timerHandle) { clearTimeout(room.timerHandle); room.timerHandle = null; } }

function emitLobbyState(room) {
  io.to(room.code).emit('lobbyState', { players: playerList(room), settings: room.settings, hostId: room.hostId });
}

function assignRoles(room) {
  const count  = Object.keys(room.players).length;
  const wCount = Math.min(room.settings.wolfCount, Math.max(1, Math.floor(count / 3)));
  const roles  = [];
  for (let i = 0; i < wCount; i++) roles.push('wolf');
  if (count >= 4) roles.push('witch');
  if (count >= 5) roles.push('seeker');
  if (count >= 6) roles.push('hunter');
  while (roles.length < count) roles.push('villager');
  for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [roles[i],roles[j]]=[roles[j],roles[i]]; }
  return roles;
}

function checkWin(room) {
  const alive = alivePlayers(room);
  const wolves = alive.filter(p => p.role === 'wolf');
  const others = alive.filter(p => p.role !== 'wolf');
  if (wolves.length === 0) return 'village';
  if (wolves.length >= others.length) return 'wolves';
  return null;
}

function eliminate(room, targetId, reason) {
  const t = room.players[targetId];
  if (!t || !t.alive) return false;
  t.alive = false;
  io.to(room.code).emit('playerEliminated', { playerId: targetId, playerName: t.name, role: t.role, reason });
  io.to(targetId).emit('youAreDead', { role: t.role });
  const w = checkWin(room); if (w) { endGame(room, w); return true; } return false;
}

function endGame(room, winner) {
  clearTimer(room); room.phase = 'ended';
  const wolves = playerList(room).filter(p => p.role === 'wolf').map(p => p.name);
  io.to(room.code).emit('gameOver', { winner, wolves });
  console.log(`[game] ${room.code} ended — ${winner} wins`);
}

function resolveNight(room) {
  clearTimer(room);
  const wolves = alivePlayers(room).filter(p => p.role === 'wolf');
  const votes  = {};
  wolves.forEach(w => { const t = room.wolfTargets[w.id]; if (t) votes[t] = (votes[t]||0)+1; });
  let killId = null;
  const maxV = Math.max(0, ...Object.values(votes));
  if (maxV > 0) { const tied = Object.keys(votes).filter(id => votes[id]===maxV); killId = tied[Math.floor(Math.random()*tied.length)]; }
  room.nightKillId = killId;
  const witch = alivePlayers(room).find(p => p.role === 'witch');
  if (witch && killId) {
    const victim = room.players[killId];
    io.to(witch.id).emit('witchWakeUp', { victimId: killId, victimName: victim?.name, hasSave: !room.witchUsed.save, hasKill: !room.witchUsed.kill });
    room.timerHandle = setTimeout(() => applyNightKill(room, room.nightKillId, null), room.settings.nightDuration*60*1000);
  } else {
    applyNightKill(room, killId, null);
  }
}

function applyNightKill(room, killId, witchKillId) {
  clearTimer(room);
  let over = killId ? eliminate(room, killId, 'night') : false;
  if (!over) over = witchKillId ? eliminate(room, witchKillId, 'witch') : false;
  if (!over) startMorning(room);
}

const DISCUSSION_SECS = 30; // discussion window before voting opens

function startMorning(room) {
  const w = checkWin(room); if (w) { endGame(room, w); return; }
  room.phase='day'; room.dayNum=(room.dayNum||1)+1; room.wolfTargets={}; room.dayVotes={}; room.seekerUsed=false; room.nightKillId=null;
  io.to(room.code).emit('morningTransition', { dayNum: room.dayNum });

  // Step 1: 30 second discussion window
  room.timerHandle = setTimeout(() => {
    io.to(room.code).emit('votingOpen', {
      duration: room.settings.morningDuration * 60, // full morningDuration for voting
    });
    room.phase = 'voting';

    // Step 2: voting timer — auto-resolve when it expires
    room.timerHandle = setTimeout(() => {
      if (Object.keys(room.dayVotes).length > 0) resolveVote(room);
      else startNight(room);
    }, room.settings.morningDuration * 60 * 1000);

  }, DISCUSSION_SECS * 1000);
}

function startNight(room) {
  const w = checkWin(room); if (w) { endGame(room, w); return; }
  room.phase='night'; room.wolfTargets={};
  io.to(room.code).emit('nightBegins', { nightDuration: room.settings.nightDuration });
  room.timerHandle = setTimeout(() => resolveNight(room), room.settings.nightDuration*60*1000);
}

function buildVoteTally(room) {
  const alive = alivePlayers(room); const aliveIds = alive.map(p=>p.id); const counts = {};
  alive.forEach(p => { counts[p.id]=0; });
  Object.entries(room.dayVotes).forEach(([vid,tid]) => { if (!aliveIds.includes(vid)) return; if (tid && counts[tid]!==undefined) counts[tid]++; });
  return { counts, voted: Object.keys(room.dayVotes).filter(id=>aliveIds.includes(id)).length, total: alive.length, names: Object.fromEntries(alive.map(p=>[p.id,p.name])) };
}

function resolveVote(room) {
  clearTimer(room);
  const alive=alivePlayers(room); const aliveIds=alive.map(p=>p.id); const counts={};
  alive.forEach(p=>{counts[p.id]=0;});
  Object.entries(room.dayVotes).forEach(([vid,tid])=>{ if(!aliveIds.includes(vid))return; if(tid&&counts[tid]!==undefined)counts[tid]++; });
  const maxV=Math.max(0,...Object.values(counts)); room.dayVotes={};
  if (maxV===0) { io.to(room.code).emit('voteResult',{eliminated:false}); startNight(room); return; }
  const top=Object.keys(counts).filter(id=>counts[id]===maxV);
  if (top.length>1) { io.to(room.code).emit('voteResult',{eliminated:false,tie:true}); startNight(room); return; }
  const targetId=top[0]; const target=room.players[targetId];
  io.to(room.code).emit('voteResult',{eliminated:true,playerId:targetId,playerName:target.name,role:target.role,votes:maxV,total:alive.length});
  if (target.role==='hunter') {
    target.alive=false; room.hunterPending=true;
    io.to(room.code).emit('playerEliminated',{playerId:targetId,playerName:target.name,role:target.role,reason:'vote'});
    io.to(room.code).emit('hunterActive',{hunterName:target.name});
    io.to(targetId).emit('youAreDead',{role:'hunter',hunterMode:true}); return;
  }
  const over=eliminate(room,targetId,'vote'); if(!over) startNight(room);
}

// ══════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  socket.on('host', ({ playerName }) => {
    const code = makeCode();
    rooms[code] = {
      code, hostId: socket.id,
      players: { [socket.id]: { id:socket.id, name:playerName||'Host', house:0, role:null, alive:true, dc:false } },
      settings: { wolfCount:1, maxPlayers:10, morningDuration:5, nightDuration:2 },
      phase:'lobby', cardRoles:[], picks:{}, wolfTargets:{}, dayVotes:{},
      witchUsed:{save:false,kill:false}, seekerUsed:false, nightKillId:null, hunterPending:false, dayNum:1, timerHandle:null,
    };
    socket.join(code); socket.data.code = code;
    socket.emit('roomCreated', { code, playerId: socket.id });
    emitLobbyState(rooms[code]);
    console.log(`[host] ${playerName} created ${code}`);
  });

  socket.on('join', ({ code, playerName }) => {
    console.log(`[join] ${playerName} → ${code} | active: ${Object.keys(rooms).join(', ')||'none'}`);
    const room = getRoom(code);
    if (!room)                          return socket.emit('joinError', { message:'No room matches the code you provided.', errorId:'#00001' });
    if (room.phase !== 'lobby')         return socket.emit('joinError', { message:'This game has already started.', errorId:'#00002' });
    if (Object.keys(room.players).length >= room.settings.maxPlayers) return socket.emit('joinError', { message:'This room is full.', errorId:'#00003' });
    const taken = new Set(Object.values(room.players).map(p=>p.house)); let house=0; while(taken.has(house))house++;
    room.players[socket.id] = { id:socket.id, name:playerName||'Player', house, role:null, alive:true, dc:false };
    socket.join(code); socket.data.code = code;
    socket.emit('roomJoined', { code, playerId: socket.id });
    emitLobbyState(room);
    console.log(`[join] ${playerName} joined ${code}`);
  });

  socket.on('updateSettings', (s) => {
    const room = getRoom(socket.data.code); if (!room||socket.id!==room.hostId) return;
    Object.assign(room.settings, s); io.to(room.code).emit('settingsUpdated', room.settings);
  });

  socket.on('startGame', () => {
    const room = getRoom(socket.data.code); if (!room||socket.id!==room.hostId||room.phase!=='lobby') return;
    if (Object.keys(room.players).length < 2) return socket.emit('startError', { message:'Need at least 2 players.' });
    room.phase='pregame'; room.cardRoles=assignRoles(room); room.picks={};
    io.to(room.code).emit('gameStarting', { countdown:5 });
    setTimeout(() => { io.to(room.code).emit('dealCards', { cardCount:Object.keys(room.players).length }); room.phase='cardpick'; }, 5000);
  });

  socket.on('pickCard', ({ index }) => {
    const room = getRoom(socket.data.code); if (!room||room.phase!=='cardpick') return;
    if (Object.values(room.picks).includes(index)) return;
    if (room.picks[socket.id]!==undefined) return;
    room.picks[socket.id] = index;
    io.to(room.code).emit('cardClaimed', { index, playerId:socket.id });
    if (Object.keys(room.picks).length >= Object.keys(room.players).length) {
      Object.entries(room.picks).forEach(([pid,idx]) => { room.players[pid].role = room.cardRoles[idx]; });
      Object.entries(room.picks).forEach(([pid,idx]) => { io.to(pid).emit('yourRole', { role:room.cardRoles[idx] }); });
      io.to(room.code).emit('allCardsPicked');
    }
  });

  socket.on('wolfTarget', ({ targetId }) => {
    const room=getRoom(socket.data.code); if(!room||room.phase!=='night') return;
    const p=room.players[socket.id]; if(!p||p.role!=='wolf') return;
    room.wolfTargets[socket.id]=targetId;
    alivePlayers(room).filter(w=>w.role==='wolf'&&w.id!==socket.id).forEach(w=>io.to(w.id).emit('wolfCoTargeted',{targetId,byName:p.name}));
  });

  socket.on('witchAction', ({ action, targetId }) => {
    const room=getRoom(socket.data.code); if(!room) return;
    const p=room.players[socket.id]; if(!p||p.role!=='witch') return;
    clearTimer(room);
    if (action==='save'&&!room.witchUsed.save&&room.nightKillId) { room.witchUsed.save=true; room.nightKillId=null; applyNightKill(room,null,null); }
    else if (action==='kill'&&!room.witchUsed.kill&&targetId)     { room.witchUsed.kill=true; applyNightKill(room,room.nightKillId,targetId); }
    else                                                           { applyNightKill(room,room.nightKillId,null); }
  });

  socket.on('seekerCheck', ({ targetId }) => {
    const room=getRoom(socket.data.code); if(!room||room.seekerUsed) return;
    const t=room.players[targetId]; if(!t) return;
    room.seekerUsed=true; socket.emit('seekerResult',{targetId,role:t.role,name:t.name});
  });

  socket.on('hunterTarget', ({ targetId }) => {
    const room=getRoom(socket.data.code); if(!room) return;
    const p=room.players[socket.id]; if(!p||p.role!=='hunter') return;
    room.hunterPending=false; eliminate(room,targetId,'hunter');
    if(room.phase!=='ended') startMorning(room);
  });

  socket.on('castVote', ({ targetId }) => {
    const room=getRoom(socket.data.code); if(!room||(room.phase!=='day'&&room.phase!=='voting')) return;
    const voter=room.players[socket.id]; const target=room.players[targetId];
    if(!voter||!voter.alive||!target||!target.alive||targetId===socket.id) return;
    room.dayVotes[socket.id]=targetId; io.to(room.code).emit('voteUpdate',buildVoteTally(room));
    const aliveIds=alivePlayers(room).map(p=>p.id);
    if(Object.keys(room.dayVotes).filter(id=>aliveIds.includes(id)).length>=aliveIds.length) resolveVote(room);
  });

  socket.on('skipVote', () => {
    const room=getRoom(socket.data.code); if(!room||(room.phase!=='day'&&room.phase!=='voting')) return;
    const voter=room.players[socket.id]; if(!voter||!voter.alive) return;
    room.dayVotes[socket.id]=null; io.to(room.code).emit('voteUpdate',buildVoteTally(room));
    const aliveIds=alivePlayers(room).map(p=>p.id);
    if(Object.keys(room.dayVotes).filter(id=>aliveIds.includes(id)).length>=aliveIds.length) resolveVote(room);
  });

  socket.on('chatMessage', ({ text }) => {
    const room=getRoom(socket.data.code); if(!room) return;
    const p=room.players[socket.id]; if(!p) return;
    io.to(room.code).emit('chatMessage',{senderId:socket.id,name:p.name,text});
  });

  socket.on('wolfChat', ({ text }) => {
    const room=getRoom(socket.data.code); if(!room) return;
    const p=room.players[socket.id]; if(!p||p.role!=='wolf') return;
    alivePlayers(room).filter(w=>w.role==='wolf').forEach(w=>io.to(w.id).emit('wolfChat',{senderId:socket.id,name:p.name,text}));
  });

  socket.on('deadChat', ({ text }) => {
    const room=getRoom(socket.data.code); if(!room) return;
    const p=room.players[socket.id]; if(!p) return;
    Object.values(room.players).filter(x=>!x.alive).forEach(x=>io.to(x.id).emit('deadChat',{senderId:socket.id,name:p.name,text}));
  });

  socket.on('disconnect', () => {
    const room=getRoom(socket.data.code); if(!room) return;
    const p=room.players[socket.id];
    if(p) {
      if(room.phase==='lobby') { delete room.players[socket.id]; emitLobbyState(room); }
      else { p.dc=true; io.to(room.code).emit('playerDC',{playerId:socket.id,name:p.name}); }
    }
    if(socket.id===room.hostId) {
      const rest=Object.keys(room.players).filter(id=>id!==socket.id);
      if(rest.length>0) { room.hostId=rest[0]; io.to(rest[0]).emit('youAreHost'); }
      else { clearTimer(room); delete rooms[room.code]; console.log(`[room] ${room.code} deleted`); }
    }
    console.log(`[-] ${socket.id} disconnected`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌑 Dawn server running on port ${PORT}\n`);
});
