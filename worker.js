/* ============================================================
   CACTUC LUDO — Cloudflare Worker backend
   - Serves the multiplayer game page
   - Handles Telegram bot webhook (/start -> opens the game)
   - Runs a Durable Object "LudoRoom" per room code for live
     4-player sync over WebSocket
   ============================================================

   DEPLOY NOTES (read before pasting into Cloudflare):
   1. This needs a Durable Object binding named LUDO_ROOM
      pointing at the class LudoRoom below.
   2. Set a secret env var BOT_TOKEN = your bot token from BotFather.
   3. After deploy, visit once in Safari:
      https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>/webhook
      (replace <YOUR_TOKEN> and <YOUR_WORKER_URL> — do this from your phone)
   Full step-by-step is in the chat reply.
============================================================ */

/* ---------------- shared game rules (also duplicated in client) ---------------- */
const COLORS = ['red','green','yellow','blue'];
function rot(r,c){ return [c, 14-r]; }
let baseArm = [[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8]];
let PATH = [];
{ let cur = baseArm; for(let q=0;q<4;q++){ PATH = PATH.concat(cur); cur = cur.map(([r,c])=>rot(r,c)); } }
const START_IDX = { red:0, green:13, yellow:26, blue:39 };
const SAFE_IDX = new Set([0,8,13,21,26,34,39,47]);
const FINISH_POS = 55;

function isSafeRel(color, rel){
  if(rel > 50) return true;
  const idx = (START_IDX[color] + rel) % 52;
  return SAFE_IDX.has(idx);
}
function createGame(activeColors){
  const g = { order: activeColors.slice(), turn:0, pieces:{}, finished:{}, finishOrder:[],
    diceValue:null, canRoll:true, movable:[], gameOver:false, prize:'' };
  activeColors.forEach(c=>{ g.pieces[c]=[-1,-1,-1,-1]; g.finished[c]=0; });
  return g;
}
function computeMovable(g,color,val){
  const movable=[];
  g.pieces[color].forEach((pos,idx)=>{
    if(pos===-1){ if(val===6) movable.push({piece:idx}); }
    else if(pos<FINISH_POS){ if(pos+val<=FINISH_POS) movable.push({piece:idx}); }
  });
  return movable;
}
function applyMove(g,color,idx,val){
  const startPos = g.pieces[color][idx];
  const target = startPos===-1?0:startPos+val;
  const forwardPath = startPos===-1 ? [0] : [];
  if(startPos!==-1){ for(let p=startPos+1;p<=target;p++) forwardPath.push(p); }
  g.pieces[color][idx] = target;

  let captures = [];
  if(target<=50 && !isSafeRel(color,target)){
    const abs=(START_IDX[color]+target)%52;
    g.order.forEach(oc=>{
      if(oc===color) return;
      g.pieces[oc].forEach((opos,oidx)=>{
        if(opos!==-1 && opos<=50 && (START_IDX[oc]+opos)%52===abs){
          captures.push({color:oc, piece:oidx, fromPos:opos});
          g.pieces[oc][oidx] = -1;
        }
      });
    });
  }
  let finishedNow=false;
  if(target===FINISH_POS){
    finishedNow=true;
    g.finished[color]++;
    if(g.finished[color]===4 && !g.finishOrder.includes(color)){
      g.finishOrder.push(color);
      const remaining = g.order.filter(c=>!g.finishOrder.includes(c));
      if(remaining.length<=1){
        if(remaining.length===1) g.finishOrder.push(remaining[0]);
        g.gameOver=true;
      }
    }
  }
  const bonus = (val===6)||(captures.length>0)||finishedNow;
  g.diceValue=null; g.movable=[];
  if(!g.gameOver){
    if(!bonus){
      let guard=0;
      do{ g.turn=(g.turn+1)%g.order.length; guard++; } while(g.finished[g.order[g.turn]]===4 && guard<10);
    }
    g.canRoll=true;
  }
  return {forwardPath, captures, finishedNow};
}

/* ---------------- Durable Object: one live room ---------------- */
export class LudoRoom {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.sessions = [];   // {ws, color}
    this.joined = [];     // colors in join order
    this.game = null;
  }

  async fetch(request){
    if(request.headers.get('Upgrade') === 'websocket'){
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('LudoRoom alive', { status: 200 });
  }

  handleSession(ws){
    ws.accept();
    let color = COLORS.find(c => !this.joined.includes(c));
    if(!color){
      ws.send(JSON.stringify({type:'full'}));
      ws.close();
      return;
    }
    this.joined.push(color);
    const session = { ws, color };
    this.sessions.push(session);

    if(this.joined.length >= 2 && !this.game){
      this.game = createGame(this.joined.slice());
    }

    ws.send(JSON.stringify({type:'welcome', color, joined:this.joined.slice(), game:this.game}));
    this.broadcastLobby();

    ws.addEventListener('message', (evt)=>{
      let data; try{ data = JSON.parse(evt.data); }catch(e){ return; }
      this.handleMessage(session, data);
    });
    ws.addEventListener('close', ()=>{
      this.sessions = this.sessions.filter(s=>s!==session);
    });
  }

  broadcastLobby(){
    this.broadcastAll({type:'lobby', joined:this.joined.slice(), started: !!this.game});
  }
  broadcastAll(obj){
    const str = JSON.stringify(obj);
    this.sessions.forEach(s=>{ try{ s.ws.send(str); }catch(e){} });
  }

  handleMessage(session, data){
    const g = this.game;
    if(data.type==='setPrize'){
      if(g && !g.prize) g.prize = String(data.prize||'').slice(0,60);
      this.broadcastAll({type:'action', actionKind:'prize', game:this.game});
      return;
    }
    if(!g) return;
    if(data.type==='roll'){
      if(g.order[g.turn]!==session.color || !g.canRoll) return;
      const val = 1+Math.floor(Math.random()*6);
      g.diceValue = val; g.canRoll = false;
      g.movable = computeMovable(g, session.color, val);
      let noMoves = false;
      if(g.movable.length===0){
        noMoves = true;
        const wasSix = val===6;
        g.diceValue=null; g.movable=[];
        if(!wasSix){
          let guard=0;
          do{ g.turn=(g.turn+1)%g.order.length; guard++; } while(g.finished[g.order[g.turn]]===4 && guard<10);
        }
        g.canRoll=true;
      }
      this.broadcastAll({type:'action', actionKind:'roll', color:session.color, val, noMoves, game:this.game});
    } else if(data.type==='move'){
      if(g.order[g.turn]!==session.color) return;
      if(!g.movable.some(m=>m.piece===data.piece)) return;
      const val = g.diceValue;
      const result = applyMove(g, session.color, data.piece, val);
      this.broadcastAll({type:'action', actionKind:'move', color:session.color, piece:data.piece,
        forwardPath:result.forwardPath, captures:result.captures, finishedNow:result.finishedNow,
        game:this.game});
    }
  }
}

/* ---------------- main Worker fetch handler ---------------- */
export default {
  async fetch(request, env){
    const url = new URL(request.url);

    // Telegram webhook
    if(url.pathname === '/webhook'){
      return handleTelegramWebhook(request, env);
    }

    // WebSocket room connections: /room/ABCD
    if(url.pathname.startsWith('/room/')){
      const code = url.pathname.split('/room/')[1];
      if(!code) return new Response('missing room code', {status:400});
      const id = env.LUDO_ROOM.idFromName(code.toUpperCase());
      const stub = env.LUDO_ROOM.get(id);
      return stub.fetch(request);
    }

    // everything else: serve the game page
    return new Response(GAME_HTML, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }
};

async function handleTelegramWebhook(request, env){
  let update;
  try{ update = await request.json(); }catch(e){ return new Response('ok'); }
  const msg = update.message;
  if(msg && msg.text === '/start'){
    const chatId = msg.chat.id;
    const workerUrl = new URL(request.url).origin;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({
        chat_id: chatId,
        text: 'به CACTUC لودو خوش اومدی! 🎲',
        reply_markup: { inline_keyboard: [[
          { text: '🎲 بازی کن', web_app: { url: workerUrl } }
        ]]}
      })
    });
  }
  return new Response('ok');
}

/* ---------------- client page (multiplayer) ---------------- */
const GAME_HTML = `<!DOCTYPE html>
<html lang="fa">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>CACTUC Ludo Online</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: 0; font-family: -apple-system, Tahoma, sans-serif;
    background-color: #142055;
    background-image:
      linear-gradient(45deg, rgba(255,255,255,0.035) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.035) 75%, rgba(255,255,255,0.035)),
      linear-gradient(45deg, rgba(255,255,255,0.035) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.035) 75%, rgba(255,255,255,0.035)),
      radial-gradient(circle at 50% 0%, #35468a, #0d0f24 75%);
    background-size: 42px 42px, 42px 42px, cover;
    background-position: 0 0, 21px 21px, 0 0;
    color: #fff; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; padding-bottom: 26px; touch-action: manipulation;
  }
  #brandTitle { font-size: 28px; font-weight: 900; letter-spacing: 4px; margin: 14px 0 0;
    background: linear-gradient(160deg,#ffe9ad,#ffc93c); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #subTitle { font-size: 13px; opacity: 0.9; margin: 0 0 6px; }
  #status { font-size: 14px; margin-bottom: 4px; min-height: 20px; text-align: center; padding: 0 16px; font-weight: bold; color: #fff; }
  #prizeBanner { font-size: 12px; opacity: 0.95; margin-bottom: 6px; padding: 3px 12px; background: rgba(255,209,102,0.18); border-radius: 12px; display: none; }

  #lobby { padding: 20px; text-align: center; max-width: 380px; }
  #lobby h2 { font-size: 22px; margin-bottom: 4px; }
  #lobby p { opacity: 0.85; font-size: 14px; }
  .lobby-btn { display:block; width:100%; margin:10px 0; padding:14px; border-radius: 16px; border:none;
    background: linear-gradient(160deg,#ffe08a,#ffc93c); font-weight:bold; font-size:16px; color:#2a1e00; }
  #joinCodeInput, #prizeSetupInput { width:100%; padding:12px; border-radius:12px; border:2px solid #3d4270;
    background:#171a35; color:#fff; font-size:16px; text-align:center; margin-top:8px; text-transform:uppercase; }
  #roomCodeShow { font-size: 34px; font-weight:900; letter-spacing:6px; color:#ffd166; margin:14px 0; }
  #waitingNote { font-size: 13px; opacity:0.8; margin-top:10px; }

  .ctrl-bar { direction: ltr; display: flex; justify-content: space-between; width: 94vw; max-width: 430px; margin: 4px 0; }
  .ctrl-slot { display: flex; align-items: center; gap: 4px; opacity: 0.45; transition: opacity 0.25s;
    background: rgba(255,255,255,0.08); padding: 5px 8px; border-radius: 12px; position: relative; }
  .ctrl-slot.slot-hidden { visibility: hidden; }
  .ctrl-slot.enabled { opacity: 1; background: rgba(255,209,102,0.18); }
  .pin-ico { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.4); flex-shrink:0; }
  .mini-dice { width: 38px; height: 38px; background: linear-gradient(160deg,#ffffff,#e7e9f2); border-radius: 9px;
    display: grid; grid-template-columns: repeat(3,1fr); grid-template-rows: repeat(3,1fr); padding: 5px; border: 2px solid #c9cee0; }
  .ctrl-slot.enabled .mini-dice { cursor: pointer; border-color: #ffd166; box-shadow: 0 0 10px rgba(255,209,102,0.65); }
  .mini-dice.rolling { animation: spin 0.42s linear infinite; }
  @keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
  .pip { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .pip span { width: 5.5px; height: 5.5px; border-radius: 50%; background: #222; display: none; }
  .pip.on span { display: block; }
  .tap-hint { position: absolute; top: 50%; left: -18px; transform: translateY(-50%); font-size: 15px; opacity: 0; animation: sideHint 1s infinite; }
  .ctrl-slot.enabled .tap-hint { opacity: 1; }
  @keyframes sideHint { 0%,100%{transform:translateY(-50%) translateX(0)} 50%{transform:translateY(-50%) translateX(4px)} }

  #board-wrap { width: 94vw; max-width: 430px; aspect-ratio: 1/1; position: relative; border-radius: 16px; overflow: hidden;
    box-shadow: 0 12px 32px rgba(0,0,0,0.55), 0 0 0 4px #1c2040; margin: 6px 0; }
  svg { width: 100%; height: 100%; display: block; background: #f3f5fb; }
  .piece.movable { cursor: pointer; }
  .piece .pin { transition: transform 0.25s; transform-box: fill-box; transform-origin: center; }
  .piece.movable .pin { filter: drop-shadow(0 4px 5px rgba(0,0,0,0.35)) drop-shadow(0 0 6px #fff); transform: translateY(-3px); }
  .piece.hop { animation: hop 0.3s ease-out; }
  @keyframes hop { 0%{transform:translateY(0)} 40%{transform:translateY(-9px)} 100%{transform:translateY(0)} }
  .btn-row { display: flex; gap: 10px; margin-top: 6px; }
  .small-btn { background: #1e2240; color: #fff; border: 1px solid #3d4270; padding: 8px 18px; border-radius: 20px; font-size: 13px; }
</style>
</head>
<body>

<div id="brandTitle">CACTUC</div>
<div id="subTitle">🎲 Ludo Online</div>

<div id="lobby">
  <h2>بازی آنلاین لودو</h2>
  <p>با دوستات از گوشی‌های جدا بازی کن</p>
  <button class="lobby-btn" id="createBtn">🎲 ساخت اتاق جدید</button>
  <input id="joinCodeInput" placeholder="کد اتاق رو وارد کن" maxlength="4">
  <button class="lobby-btn" id="joinBtn">پیوستن به اتاق</button>
  <input id="prizeSetupInput" placeholder="جایزه (اختیاری)" maxlength="40" style="margin-top:14px">
  <div id="waitingNote"></div>
</div>

<div id="gameArea" style="display:none; width:100%; align-items:center; flex-direction:column;">
  <div id="roomCodeShow"></div>
  <div id="status"></div>
  <div id="prizeBanner"></div>
  <div class="ctrl-bar" id="topBar"></div>
  <div id="board-wrap"><svg id="board" viewBox="0 0 400 400"><g id="staticLayer"></g><g id="piecesLayer"></g></svg></div>
  <div class="ctrl-bar" id="bottomBar"></div>
</div>

<script>
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let actx;
function ensureAudio(){ if(!actx) actx = new (window.AudioContext||window.webkitAudioContext)(); }
function droplet(freq, dur, vol, delay, type){
  ensureAudio();
  const t0 = actx.currentTime + (delay||0);
  const osc = actx.createOscillator(); const gain = actx.createGain();
  osc.type = type||'sine'; osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(50,freq*0.6), t0+dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol||0.16, t0+0.018);
  gain.gain.exponentialRampToValueAtTime(0.0007, t0+dur);
  osc.connect(gain); gain.connect(actx.destination);
  osc.start(t0); osc.stop(t0+dur+0.03);
}
function sndDiceRoll(){ for(let i=0;i<6;i++) droplet(230-i*14, 0.10, 0.085, i*0.07, 'triangle'); droplet(130, 0.22, 0.14, 0.44, 'sine'); }
function sndStep(){ droplet(680, 0.13, 0.13); }
function sndSix(){ droplet(760,0.16,0.14); droplet(980,0.18,0.1,0.1); }
function sndHome(){ droplet(760,0.17,0.14); droplet(980,0.19,0.12,0.1); }
function sndWin(){ [523,659,784,1046].forEach((f,i)=>droplet(f,0.34,0.17,i*0.18)); }
function sndSlither(duration){
  ensureAudio(); const t0 = actx.currentTime;
  const osc = actx.createOscillator(); const gain = actx.createGain();
  osc.type='sine'; osc.frequency.setValueAtTime(480, t0);
  osc.frequency.exponentialRampToValueAtTime(140, t0+duration);
  gain.gain.setValueAtTime(0.001,t0);
  gain.gain.exponentialRampToValueAtTime(0.11, t0+0.06);
  gain.gain.exponentialRampToValueAtTime(0.0006, t0+duration);
  osc.connect(gain); gain.connect(actx.destination);
  osc.start(t0); osc.stop(t0+duration+0.05);
}

const CELL = 400/15;
const COLORS = ['red','green','yellow','blue'];
const HEX = { red:'#e84040', green:'#2fae5a', yellow:'#f0c419', blue:'#2f7fe0' };
const DARK = { red:'#a82424', green:'#1c7a3c', yellow:'#b8930a', blue:'#1c5aa8' };
const CORNER = { red:[0,0], green:[0,9], yellow:[9,9], blue:[9,0] };
function rot(r,c){ return [c, 14-r]; }
let base = [[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8]];
let PATH = []; { let cur = base; for(let q=0;q<4;q++){ PATH = PATH.concat(cur); cur = cur.map(([r,c])=>rot(r,c)); } }
const START_IDX = { red:0, green:13, yellow:26, blue:39 };
const SAFE_IDX = new Set([0,8,13,21,26,34,39,47]);
let baseStretch = [[7,1],[7,2],[7,3],[7,4],[7,5]];
let STRETCH = {}; { let curS = baseStretch; COLORS.forEach((c)=>{ STRETCH[c] = curS; curS = curS.map(([r,c2])=>rot(r,c2)); }); }
function cellXY(row,col){ return [ (col+0.5)*CELL, (row+0.5)*CELL ]; }
function relToAbsCell(color, rel){
  if(rel <= 50){ const idx = (START_IDX[color] + rel) % 52; return cellXY(PATH[idx][0], PATH[idx][1]); }
  const s = rel - 51; const [r,c] = STRETCH[color][s]; return cellXY(r,c);
}
function yardXY(color, slot){
  const [r0,c0] = CORNER[color];
  const offs = [[1.6,1.6],[1.6,4.4],[4.4,1.6],[4.4,4.4]];
  const [dr,dc] = offs[slot];
  return [ (c0+dc)*CELL, (r0+dr)*CELL ];
}

const FINISH_POS = 55;
let myColor = null, activeColors = [], state = null, animating=false, ws=null, roomCode='';

function drawStatic(){
  let html = '<rect x="0" y="0" width="400" height="400" fill="#f3f5fb"/>';
  COLORS.forEach(c=>{
    const [r0,c0] = CORNER[c];
    const active = activeColors.includes(c);
    const hex = active ? HEX[c] : '#ccd0e4';
    html += \`<rect x="\${c0*CELL}" y="\${r0*CELL}" width="\${6*CELL}" height="\${6*CELL}" fill="\${hex}" opacity="\${active?1:0.4}"/>\`;
    html += \`<rect x="\${(c0+0.85)*CELL}" y="\${(r0+0.85)*CELL}" width="\${4.3*CELL}" height="\${4.3*CELL}" rx="12" fill="#fff"/>\`;
    if(active){ [0,1,2,3].forEach(slot=>{
      const [x,y] = yardXY(c, slot);
      html += \`<circle cx="\${x}" cy="\${y}" r="14" fill="\${hex}" opacity="0.14"/>\`;
      html += \`<circle cx="\${x}" cy="\${y}" r="14" fill="none" stroke="\${hex}" stroke-width="1.4" opacity="0.4"/>\`;
    }); }
  });
  PATH.forEach((cell, idx)=>{
    const [x,y] = cellXY(cell[0], cell[1]);
    const safe = SAFE_IDX.has(idx);
    let fill = '#fff';
    COLORS.forEach(c=>{ if(START_IDX[c]===idx && activeColors.includes(c)) fill = HEX[c]; });
    html += \`<rect x="\${x-CELL/2}" y="\${y-CELL/2}" width="\${CELL}" height="\${CELL}" fill="\${fill}" stroke="#9096b3" stroke-width="1"/>\`;
    if(safe) html += \`<text x="\${x}" y="\${y+4}" text-anchor="middle" font-size="13" fill="#333">★</text>\`;
  });
  COLORS.forEach(c=>{
    if(!activeColors.includes(c)) return;
    STRETCH[c].forEach(([r,cc])=>{
      const [x,y] = cellXY(r,cc);
      html += \`<rect x="\${x-CELL/2}" y="\${y-CELL/2}" width="\${CELL}" height="\${CELL}" fill="\${HEX[c]}" opacity="0.78" stroke="#9096b3" stroke-width="1"/>\`;
    });
  });
  const cx=200, cy=200, s=3*CELL/2;
  html += \`<polygon points="\${cx-s},\${cy-s} \${cx},\${cy} \${cx-s},\${cy+s}" fill="\${HEX.red}"/>\`;
  html += \`<polygon points="\${cx-s},\${cy-s} \${cx},\${cy} \${cx+s},\${cy-s}" fill="\${HEX.green}"/>\`;
  html += \`<polygon points="\${cx+s},\${cy-s} \${cx},\${cy} \${cx+s},\${cy+s}" fill="\${HEX.yellow}"/>\`;
  html += \`<polygon points="\${cx-s},\${cy+s} \${cx},\${cy} \${cx+s},\${cy+s}" fill="\${HEX.blue}"/>\`;
  html += \`<text x="\${cx}" y="\${cy+7}" text-anchor="middle" font-size="20">🏆</text>\`;
  document.getElementById('staticLayer').innerHTML = html;
}

function pinSVG(x, y, color, cls, showRing){
  const hex = HEX[color], dark = DARK[color];
  let ring = '';
  if(showRing){
    ring = \`<circle cx="\${x}" cy="\${y-5}" r="15" fill="none" stroke="#111319" stroke-width="2.4" stroke-dasharray="6 5" opacity="0.9">
      <animateTransform attributeName="transform" type="rotate" from="0 \${x} \${y-5}" to="360 \${x} \${y-5}" dur="1.6s" repeatCount="indefinite"/>
    </circle>\`;
  }
  return \`<g class="piece \${cls}" data-color="\${color}">
    \${ring}
    <ellipse cx="\${x}" cy="\${y+9}" rx="7.5" ry="2.4" fill="#000" opacity="0.2"/>
    <g class="pin">
      <path d="M \${x} \${y+9} L \${x-10.5} \${y-6} A 10.5 10.5 0 1 1 \${x+10.5} \${y-6} Z" fill="#ffffff" stroke="#c3c7db" stroke-width="1.2"/>
      <circle cx="\${x}" cy="\${y-5}" r="7" fill="\${hex}" stroke="\${dark}" stroke-width="1.6"/>
      <circle cx="\${x-2}" cy="\${y-7}" r="2" fill="#fff" opacity="0.6"/>
    </g>
  </g>\`;
}

function drawPiecesFixed(){
  if(!state) return;
  let html = '';
  const meta = [];
  activeColors.forEach(c=>{
    if(state.finished[c]===4) return;
    state.pieces[c].forEach((pos, idx)=>{
      let x,y;
      if(pos===-1){ [x,y]=yardXY(c,idx); } else { [x,y]=relToAbsCell(c,pos); }
      const isMovable = myColor===c && state.movable.some(m=>m.piece===idx) && state.order[state.turn]===c;
      const cls = isMovable ? 'piece-normal movable' : 'piece-normal';
      html += pinSVG(x,y,c,cls, isMovable);
      meta.push({c,idx});
    });
  });
  activeColors.forEach(c=>{
    if(state.finished[c]===4){
      const [r0,c0] = CORNER[c];
      const rank = state.finishOrder.indexOf(c)+1;
      html += \`<rect x="\${c0*CELL}" y="\${r0*CELL}" width="\${6*CELL}" height="\${6*CELL}" fill="#0a0d1f" opacity="0.6"/>\`;
      html += \`<text x="\${(c0+3)*CELL}" y="\${(r0+2.7)*CELL}" text-anchor="middle" font-size="22">👑</text>\`;
      html += \`<text x="\${(c0+3)*CELL}" y="\${(r0+3.6)*CELL}" text-anchor="middle" font-size="15" fill="#ffd166" font-weight="bold">King (\${rank})</text>\`;
    }
  });
  const layer = document.getElementById('piecesLayer');
  layer.innerHTML = html;
  layer.querySelectorAll('.piece.movable').forEach((el,i)=>{
    const m = meta.filter((mm,ix)=> layer.querySelectorAll('.piece')[ix]===el)[0];
  });
  const groups = layer.querySelectorAll('.piece');
  groups.forEach((el,i)=>{
    if(el.classList.contains('movable')){
      const m = meta[i];
      el.addEventListener('click', ()=> sendMove(m.idx));
    }
  });
}

function celebrationBurst(x,y,color){
  const layer = document.getElementById('piecesLayer');
  let extra = '';
  for(let i=0;i<12;i++){
    const ang = (i/12)*360;
    const dx = Math.cos(ang*Math.PI/180)*46, dy = Math.sin(ang*Math.PI/180)*46;
    extra += \`<circle cx="\${x}" cy="\${y}" r="3.4" fill="\${HEX[color]}">
      <animate attributeName="cx" from="\${x}" to="\${x+dx}" dur="0.75s" fill="freeze"/>
      <animate attributeName="cy" from="\${y}" to="\${y+dy}" dur="0.75s" fill="freeze"/>
      <animate attributeName="opacity" from="1" to="0" dur="0.75s" fill="freeze"/>
    </circle>\`;
  }
  layer.insertAdjacentHTML('beforeend', extra);
}

const COLOR_NAME = { red:'قرمز', green:'سبز', yellow:'زرد', blue:'آبی' };

function renderUI(){
  const st = document.getElementById('status');
  const pb = document.getElementById('prizeBanner');
  if(state && state.prize){ pb.style.display='inline-block'; pb.textContent = '🏆 جایزه: '+state.prize; }
  else pb.style.display='none';

  if(!state){ st.textContent=''; return; }
  if(state.gameOver) return;
  const curC = state.order[state.turn];
  const name = COLOR_NAME[curC] + (curC===myColor?' (تو)':'');
  if(state.diceValue===null) st.textContent = 'نوبت '+name+': تاس بزن';
  else if(state.movable.length===0) st.textContent = name+': حرکتی نیست...';
  else st.textContent = name+': مهره رو انتخاب کن (تاس: '+state.diceValue+')';

  COLORS.forEach(c=>{
    const slot = document.getElementById('slot-'+c);
    if(!slot) return;
    const active = activeColors.includes(c);
    slot.classList.toggle('slot-hidden', !active);
    if(!active) return;
    const isTurn = state.order[state.turn]===c && state.canRoll && !animating && !state.gameOver && c===myColor;
    slot.classList.toggle('enabled', isTurn);
  });
}

const DICE_PATTERNS = { 1:['p5'], 2:['p1','p9'], 3:['p1','p5','p9'], 4:['p1','p3','p7','p9'], 5:['p1','p3','p5','p7','p9'], 6:['p1','p3','p4','p6','p7','p9'] };
function setDiceFace(color, val){
  const dice = document.getElementById('dice-'+color);
  if(!dice) return;
  dice.querySelectorAll('.pip').forEach(p=>p.classList.remove('on'));
  if(!val) return;
  DICE_PATTERNS[val].forEach(cls=>{ const el=dice.querySelector('.pip.'+cls); if(el) el.classList.add('on'); });
}
function clearAllDiceFaces(){ COLORS.forEach(c=> setDiceFace(c,null)); }

function render(){ drawPiecesFixed(); renderUI(); }

function pipGridHTML(){ return ['p1','p2','p3','p4','p5','p6','p7','p8','p9'].map(cls=>\`<div class="pip \${cls}"><span></span></div>\`).join(''); }
function buildBars(){
  const top = document.getElementById('topBar'), bottom = document.getElementById('bottomBar');
  top.innerHTML=''; bottom.innerHTML='';
  function makeSlot(c){
    const slot = document.createElement('div');
    slot.className='ctrl-slot'; slot.id='slot-'+c;
    slot.innerHTML = \`<div class="pin-ico" style="background:\${HEX[c]}"></div>
      <div class="mini-dice" id="dice-\${c}">\${pipGridHTML()}</div>
      <div class="tap-hint">👈</div>\`;
    slot.querySelector('.mini-dice').addEventListener('click', ()=> sendRoll(c));
    return slot;
  }
  top.appendChild(makeSlot('red')); top.appendChild(makeSlot('green'));
  bottom.appendChild(makeSlot('blue')); bottom.appendChild(makeSlot('yellow'));
}

function sendRoll(color){
  if(color!==myColor) return;
  if(!state || state.order[state.turn]!==myColor || !state.canRoll || animating) return;
  ws.send(JSON.stringify({type:'roll'}));
}
function sendMove(piece){
  if(!state || state.order[state.turn]!==myColor || animating) return;
  ws.send(JSON.stringify({type:'move', piece}));
}

async function retreatToYard(color, idx, fromPos){
  const dist = fromPos+1;
  const duration = Math.min(1.7, Math.max(0.5, dist*0.045));
  sndSlither(duration);
  const stepDelay = Math.max(16,(duration*1000)/dist);
  for(let p=fromPos-1; p>=-1; p--){
    state.pieces[color][idx] = p;
    drawPiecesFixed();
    await sleep(stepDelay);
  }
}

async function replayAction(action){
  animating = true;
  if(action.actionKind==='roll'){
    const diceEl = document.getElementById('dice-'+action.color);
    if(diceEl) diceEl.classList.add('rolling');
    sndDiceRoll();
    for(let i=0;i<6;i++){ setDiceFace(action.color, 1+Math.floor(Math.random()*6)); await sleep(70); }
    if(diceEl) diceEl.classList.remove('rolling');
    if(action.val===6) sndSix();
    setDiceFace(action.color, action.val);
    if(action.noMoves){ await sleep(700); clearAllDiceFaces(); }
    state = action.game;
    animating=false;
    render();
    return;
  }
  if(action.actionKind==='move'){
    const color = action.color, idx = action.piece;
    for(const p of action.forwardPath){
      state.pieces[color][idx] = p;
      drawPiecesFixed();
      document.querySelectorAll('#piecesLayer .piece').forEach(el=>{ if(el.getAttribute('data-color')===color) el.classList.add('hop'); });
      sndStep();
      await sleep(300);
    }
    for(const cap of action.captures){ await retreatToYard(cap.color, cap.piece, cap.fromPos); }
    if(action.finishedNow){ celebrationBurst(200,200,color); sndHome(); }
    clearAllDiceFaces();
    state = action.game;
    animating=false;
    if(state.gameOver){ sndWin(); document.getElementById('status').textContent = '🎉 '+COLOR_NAME[state.finishOrder[0]]+' پادشاه شد! 🎉' + (state.prize? ' — 🏆 '+state.prize:''); }
    render();
  } else if(action.actionKind==='prize'){
    state = action.game; render();
  }
}

function connect(code, prize){
  roomCode = code.toUpperCase();
  document.getElementById('lobby').style.display='none';
  document.getElementById('gameArea').style.display='flex';
  document.getElementById('roomCodeShow').textContent = roomCode;
  const proto = location.protocol==='https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto+'//'+location.host+'/room/'+roomCode);
  ws.addEventListener('open', ()=>{
    if(prize) ws.send(JSON.stringify({type:'setPrize', prize}));
  });
  ws.addEventListener('message', (evt)=>{
    const data = JSON.parse(evt.data);
    if(data.type==='full'){ document.getElementById('status').textContent='اتاق پره 😅'; return; }
    if(data.type==='welcome'){
      myColor = data.color;
      document.getElementById('waitingNote').textContent = '';
      if(data.game){
        activeColors = data.game.order.slice();
        state = data.game;
        buildBars(); drawStatic(); render();
      } else {
        document.getElementById('status').textContent = 'منتظر بقیه‌ی بازیکنا... ('+data.joined.length+'/4)';
      }
      return;
    }
    if(data.type==='lobby'){
      if(!state){
        document.getElementById('status').textContent = 'منتظر بقیه‌ی بازیکنا... ('+data.joined.length+'/4)';
        if(data.started){
          // game just started from someone else joining — we need our own welcome's game; ask server implicitly via next action, or just reload state on first action.
        }
      }
      return;
    }
    if(data.type==='action'){
      if(!activeColors.length && data.game){ activeColors = data.game.order.slice(); buildBars(); drawStatic(); }
      replayAction(data);
    }
  });
  ws.addEventListener('close', ()=>{
    document.getElementById('status').textContent = 'اتصال قطع شد 😔';
  });
}

function randomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
document.getElementById('createBtn').addEventListener('click', ()=>{
  ensureAudio();
  const code = randomCode();
  const prize = document.getElementById('prizeSetupInput').value.trim();
  connect(code, prize);
});
document.getElementById('joinBtn').addEventListener('click', ()=>{
  ensureAudio();
  const code = document.getElementById('joinCodeInput').value.trim();
  if(code.length!==4){ alert('کد ۴ کاراکتریه'); return; }
  connect(code, '');
});
</script>
</body>
</html>`;
// v2
