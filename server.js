import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// ===== game constants =====
const W = 1000, H = 600;
const TICK_HZ = 60;
const SEND_HZ = 20;
const DT = 1 / TICK_HZ;
const SEND_EVERY = Math.round(TICK_HZ / SEND_HZ);

const rooms = new Map();

function makeRoomId(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function norm(x,y){ const l = Math.hypot(x,y)||1; return {x:x/l,y:y/l}; }

function emptyInput(){ return {up:0,down:0,left:0,right:0,hit:0,ability:0,seq:0}; }

function initState(matchSeconds=120, winBy=2){
  return {
    t: 0,
    running: false,
    paused: false,
    gameOver: false,
    matchTime: matchSeconds,
    winBy,
    p1: { x:140, y:H/2, vx:0, vy:0, score:0 },
    p2: { x:W-140, y:H/2, vx:0, vy:0, score:0 },
    ball:{ x:W/2, y:H/2, vx:3.2, vy:2.0 }
  };
}

function resetBall(s){
  s.ball.x = W/2; s.ball.y = H/2;
  s.ball.vx = (Math.random()<0.5?-1:1)*3.2;
  s.ball.vy = (Math.random()*2-1)*2.2;
}

function step(s, in1, in2, dt){
  s.t += dt;
  if(!s.running || s.paused || s.gameOver) return;

  // players
  const speed = 260; // px/sec
  function move(p, inp, side){
    const mx = (inp.right - inp.left);
    const my = (inp.down - inp.up);
    const d = norm(mx,my);
    p.vx = d.x * speed;
    p.vy = d.y * speed;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const r = 26, mid = W/2;
    if(side==="p1") p.x = clamp(p.x, r, mid-r);
    else p.x = clamp(p.x, mid+r, W-r);
    p.y = clamp(p.y, r, H-r);
  }
  move(s.p1, in1, "p1");
  move(s.p2, in2, "p2");

  // ball
  s.ball.x += s.ball.vx * 60 * dt;
  s.ball.y += s.ball.vy * 60 * dt;

  if(s.ball.y < 14){ s.ball.y=14; s.ball.vy *= -1; }
  if(s.ball.y > H-14){ s.ball.y=H-14; s.ball.vy *= -1; }

  // score
  if(s.ball.x < -20){ s.p2.score++; resetBall(s); }
  if(s.ball.x > W+20){ s.p1.score++; resetBall(s); }

  // timer
  s.matchTime -= dt;
  if(s.matchTime <= 0){
    s.gameOver = true;
    s.running = false;
  }
}

// room loop
function startRoomLoop(roomId){
  const room = rooms.get(roomId);
  if(!room || room.loop) return;
  room.loop = true;
  let ticks = 0;

  room.timer = setInterval(()=>{
    const r = rooms.get(roomId);
    if(!r){ clearInterval(room.timer); return; }

    // delete empty rooms
    if(!r.players.p1 && !r.players.p2){
      rooms.delete(roomId);
      clearInterval(room.timer);
      return;
    }

    step(r.state, r.inputs.p1, r.inputs.p2, DT);
    ticks++;

    if(ticks % SEND_EVERY === 0){
      io.to(roomId).emit("state", r.state);
    }
  }, 1000/TICK_HZ);
}

io.on("connection", (socket) => {
  socket.on("createRoom", (cb) => {
    const roomId = makeRoomId();
    rooms.set(roomId, {
      players: { p1: socket.id, p2: null },
      inputs: { p1: emptyInput(), p2: emptyInput() },
      state: initState()
    });
    socket.join(roomId);
    startRoomLoop(roomId);
    cb?.({ roomId, side:"p1" });
    io.to(roomId).emit("state", rooms.get(roomId).state);
  });

  socket.on("joinRoom", ({roomId}, cb) => {
    const room = rooms.get(roomId);
    if(!room) return cb?.({ok:false, error:"Room not found"});
    if(room.players.p2) return cb?.({ok:false, error:"Room full"});
    room.players.p2 = socket.id;
    socket.join(roomId);
    cb?.({ok:true, roomId, side:"p2"});
    io.to(roomId).emit("state", room.state);
  });

  socket.on("startMatch", ({roomId, matchSeconds=120, winBy=2}) => {
    const room = rooms.get(roomId);
    if(!room) return;
    if(room.players.p1 !== socket.id) return; // only host starts
    room.state = initState(matchSeconds, winBy);
    room.state.running = true;
    io.to(roomId).emit("state", room.state);
  });

  socket.on("pause", ({roomId, paused}) => {
    const room = rooms.get(roomId);
    if(!room) return;
    room.state.paused = !!paused;
    io.to(roomId).emit("state", room.state);
  });

  socket.on("input", ({roomId, input}) => {
    const room = rooms.get(roomId);
    if(!room) return;

    const side = (room.players.p1 === socket.id) ? "p1"
               : (room.players.p2 === socket.id) ? "p2"
               : null;
    if(!side) return;

    room.inputs[side] = {
      up: input?.up ? 1:0,
      down: input?.down ? 1:0,
      left: input?.left ? 1:0,
      right: input?.right ? 1:0,
      hit: input?.hit ? 1:0,
      ability: input?.ability ? 1:0,
      seq: Number(input?.seq||0)
    };
  });

  socket.on("disconnect", () => {
    for(const [roomId, room] of rooms){
      if(room.players.p1 === socket.id) room.players.p1 = null;
      if(room.players.p2 === socket.id) room.players.p2 = null;
    }
  });
});

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));