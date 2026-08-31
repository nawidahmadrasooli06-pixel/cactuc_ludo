/* ============================================================
   CACTUC LUDO — Cloudflare Worker backend (v5)
   New in this version:
   - "Play vs Computer" button: instant solo game, no code needed
   - Real reconnection fix: the browser remembers your room code
     and color (localStorage), so if the app reloads or the
     connection drops, reopening it shows "Resume game" and you
     rejoin with the SAME color — never "room full" again
   - Server-side rejoin is now more forceful: it reclaims your
     color even if the old connection hadn't fully closed yet
   Everything from v4 (reconnect-on-drop, stuck-piece fix, ring
   visible to everyone, prize fix, face-to-face 2-player, i18n,
   settings, rating, share/copy code, footer, channel button)
   is kept.
   ============================================================
   DEPLOY: replace the ENTIRE contents of worker.js in GitHub with
   this file and commit. Nothing else needs to change.
============================================================ */

const COLORS = ['red','green','yellow','blue'];
const BOT_COLOR = 'yellow';
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
function poolFor(max){
  if(max===2) return ['red','yellow'];
  if(max===3) return ['red','green','yellow'];
  return COLORS;
}
function pickBotMove(g, color, movable, val){
  for(const m of movable){
    const cur = g.pieces[color][m.piece];
    const target = cur===-1?0:cur+val;
    if(target<=50 && !isSafeRel(color,target)){
      const abs=(START_IDX[color]+target)%52;
      let capture=false;
      g.order.forEach(oc=>{ if(oc===color) return; g.pieces[oc].forEach(opos=>{ if(opos!==-1&&opos<=50&&(START_IDX[oc]+opos)%52===abs) capture=true; }); });
      if(capture) return m;
    }
  }
  for(const m of movable){ const cur=g.pieces[color][m.piece]; const target=cur===-1?0:cur+val; if(target===FINISH_POS) return m; }
  const onBoard = movable.filter(m=>g.pieces[color][m.piece]!==-1);
  if(onBoard.length){ onBoard.sort((a,b)=> g.pieces[color][b.piece]-g.pieces[color][a.piece]); return onBoard[0]; }
  return movable[0];
}

export class LudoRoom {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.joined = [];
    this.game = null;
    this.maxPlayers = null;
    this.pendingPrize = '';
    this.isBotRoom = false;
  }

  async fetch(request){
    const url = new URL(request.url);

    if(request.headers.get('Upgrade') === 'websocket'){
      const maxParam = parseInt(url.searchParams.get('max'));
      if(!this.maxPlayers && maxParam>=2 && maxParam<=4) this.maxPlayers = maxParam;
      const rejoin = url.searchParams.get('rejoin');
      if(url.searchParams.get('bot')==='1') this.isBotRoom = true;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server, rejoin);
      return new Response(null, { status: 101, webSocket: client });
    }

    if(url.pathname === '/rate'){
      if(request.method === 'POST'){
        const body = await request.json().catch(()=>({}));
        const stars = Math.max(1, Math.min(5, parseInt(body.stars)||0));
        if(stars>0){
          let stats = (await this.state.storage.get('stats')) || {count:0,sum:0,b1:0,b2:0,b3:0,b4:0,b5:0};
          stats.count++; stats.sum += stars; stats['b'+stars] = (stats['b'+stars]||0)+1;
          await this.state.storage.put('stats', stats);
        }
        return new Response('{"ok":true}', {headers:{'content-type':'application/json'}});
      }
      if(request.method === 'GET'){
        const key = url.searchParams.get('key');
        if(key !== 'cactuc580-report') return new Response('forbidden', {status:403});
        let stats = (await this.state.storage.get('stats')) || {count:0,sum:0,b1:0,b2:0,b3:0,b4:0,b5:0};
        const avg = stats.count ? (stats.sum/stats.count).toFixed(2) : '0';
        return new Response(JSON.stringify({...stats, average:avg}, null, 2), {headers:{'content-type':'application/json'}});
      }
    }

    return new Response('LudoRoom alive', { status: 200 });
  }

  handleSession(ws, rejoinColor){
    ws.accept();
    let color;
    let isReconnect = false;
    if(rejoinColor && this.joined.includes(rejoinColor)){
      color = rejoinColor;
      isReconnect = true;
      this.sessions = this.sessions.filter(s=>{
        if(s.color===color){ try{ s.ws.close(); }catch(e){} return false; }
        return true;
      });
    } else {
      const pool = this.isBotRoom ? ['red'] : poolFor(this.maxPlayers||4);
      color = pool.find(c => !this.joined.includes(c));
      if(!color){
        ws.send(JSON.stringify({type:'full'}));
        ws.close();
        return;
      }
      this.joined.push(color);
    }
    const session = { ws, color };
    this.sessions.push(session);

    let justStarted = false;
    if(!isReconnect && !this.game){
      if(this.isBotRoom){
        this.maxPlayers = 2;
        this.joined.push(BOT_COLOR);
        this.game = createGame([color, BOT_COLOR]);
        if(this.pendingPrize) this.game.prize = this.pendingPrize;
        justStarted = true;
      } else {
        const need = this.maxPlayers || 4;
        if(this.joined.length >= need){
          this.game = createGame(this.joined.slice());
          if(this.pendingPrize) this.game.prize = this.pendingPrize;
          justStarted = true;
        }
      }
    }

    ws.send(JSON.stringify({type:'welcome', color, joined:this.joined.slice(), game:this.game, max:this.maxPlayers||4}));

    if(justStarted){
      this.broadcastAll({type:'action', actionKind:'start', game:this.game});
      this.maybeBotMove();
    } else if(!isReconnect){
      this.broadcastLobby();
    }

    ws.addEventListener('message', (evt)=>{
      let data; try{ data = JSON.parse(evt.data); }catch(e){ return; }
      this.handleMessage(session, data);
    });
    ws.addEventListener('close', ()=>{
      this.sessions = this.sessions.filter(s=>s!==session);
    });
  }

  broadcastLobby(){
    this.broadcastAll({type:'lobby', joined:this.joined.slice(), started: !!this.game, max:this.maxPlayers||4});
  }
  broadcastAll(obj){
    const str = JSON.stringify(obj);
    this.sessions.forEach(s=>{ try{ s.ws.send(str); }catch(e){} });
  }

  async maybeBotMove(){
    if(!this.isBotRoom || !this.game || this.game.gameOver) return;
    if(this.game.order[this.game.turn] !== BOT_COLOR) return;
    if(!this.game.canRoll) return;
    await new Promise(r=>setTimeout(r,700));
    const g = this.game;
    if(!g || g.gameOver || g.order[g.turn]!==BOT_COLOR || !g.canRoll) return;
    const val = 1+Math.floor(Math.random()*6);
    g.diceValue=val; g.canRoll=false;
    g.movable = computeMovable(g, BOT_COLOR, val);
    let noMoves=false;
    if(g.movable.length===0){
      noMoves=true; const wasSix=val===6; g.diceValue=null; g.movable=[];
      if(!wasSix){ let guard=0; do{ g.turn=(g.turn+1)%g.order.length; guard++; } while(g.finished[g.order[g.turn]]===4 && guard<10); }
      g.canRoll=true;
    }
    this.broadcastAll({type:'action', actionKind:'roll', color:BOT_COLOR, val, noMoves, game:this.game});
    if(!noMoves){
      await new Promise(r=>setTimeout(r,650));
      const m = pickBotMove(g, BOT_COLOR, g.movable, val);
      const result = applyMove(g, BOT_COLOR, m.piece, val);
      this.broadcastAll({type:'action', actionKind:'move', color:BOT_COLOR, piece:m.piece,
        forwardPath:result.forwardPath, captures:result.captures, finishedNow:result.finishedNow, game:this.game});
    }
    this.maybeBotMove();
  }

  handleMessage(session, data){
    const g = this.game;
    if(data.type==='setPrize'){
      const prize = String(data.prize||'').slice(0,60);
      if(prize) this.pendingPrize = prize;
      if(g && !g.prize && prize) g.prize = prize;
      if(g) this.broadcastAll({type:'action', actionKind:'prize', game:this.game});
      return;
    }
    if(!g) return;
    if(data.type==='roll'){
      if(g.order[g.turn]!==session.color || !g.canRoll || !Number.isInteger(g.turn)) return;
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
      this.maybeBotMove();
    } else if(data.type==='move'){
      if(g.order[g.turn]!==session.color) return;
      if(!Number.isInteger(data.piece) || data.piece<0 || data.piece>3) return;
      if(!g.movable.some(m=>m.piece===data.piece)) return;
      const val = g.diceValue;
      const result = applyMove(g, session.color, data.piece, val);
      this.broadcastAll({type:'action', actionKind:'move', color:session.color, piece:data.piece,
        forwardPath:result.forwardPath, captures:result.captures, finishedNow:result.finishedNow,
        game:this.game});
      this.maybeBotMove();
    }
  }
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if(url.pathname === '/webhook'){
      return handleTelegramWebhook(request, env);
    }
    if(url.pathname === '/rate'){
      const id = env.LUDO_ROOM.idFromName('__stats__');
      const stub = env.LUDO_ROOM.get(id);
      return stub.fetch(request);
    }
    if(url.pathname.startsWith('/room/')){
      const code = url.pathname.split('/room/')[1];
      if(!code) return new Response('missing room code', {status:400});
      const id = env.LUDO_ROOM.idFromName(code.toUpperCase());
      const stub = env.LUDO_ROOM.get(id);
      return stub.fetch(request);
    }
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
        text: '🌵 به CACTUC لودو خوش اومدی!\n\nبا دوستات یه اتاق آنلاین بساز، جایزه‌ای برای برنده بذار، یا اگه تنهایی با کامپیوتر بازی کن. ببین امروز کی پادشاهه 👑🎲',
        reply_markup: { inline_keyboard: [
          [{ text: '🎲 بازی کن', web_app: { url: workerUrl } }],
          [{ text: '📢 کانال ما', url: 'https://t.me/CROOK_Cake' }]
        ]}
      })
    });
  }
  return new Response('ok');
}

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
  #topRow { display:flex; align-items:center; justify-content:center; gap:10px; margin-top:14px; position:relative; width:100%; }
  #brandTitle { font-size: 28px; font-weight: 900; letter-spacing: 4px;
    background: linear-gradient(160deg,#ffe9ad,#ffc93c); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #gearBtn { position:absolute; right:16px; top:0; font-size:22px; background:rgba(255,255,255,0.1); border:none; border-radius:50%; width:36px; height:36px; color:#fff; }
  [dir="rtl"] #gearBtn { right:auto; left:16px; }
  #subTitle { font-size: 13px; opacity: 0.9; margin: 0 0 6px; }
  #status { font-size: 14px; margin-bottom: 4px; min-height: 20px; text-align: center; padding: 0 16px; font-weight: bold; color: #fff; }
  #prizeBanner { font-size: 12px; opacity: 0.95; margin-bottom: 6px; padding: 3px 12px; background: rgba(255,209,102,0.18); border-radius: 12px; display: none; }

  #lobby { padding: 20px; text-align: center; max-width: 380px; }
  #lobby h2 { font-size: 22px; margin-bottom: 4px; }
  #lobby p { opacity: 0.85; font-size: 14px; }
  .lobby-btn { display:block; width:100%; margin:8px 0; padding:13px; border-radius: 16px; border:none;
    background: linear-gradient(160deg,#ffe08a,#ffc93c); font-weight:bold; font-size:15px; color:#2a1e00; }
  .lobby-btn.alt { background:#2c3160; color:#fff; }
  .lobby-sub { font-size: 12px; opacity: 0.7; margin: 14px 0 4px; }
  .opt-row { display:flex; gap:8px; justify-content:center; margin-bottom: 10px; }
  .opt-btn { flex:1; padding: 11px 6px; border-radius: 14px; border: 2px solid #3d4270;
    background:#171a35; color:#fff; font-size: 14px; font-weight:bold; }
  .opt-btn.sel { border-color:#ffd166; background:#2c3160; }
  #joinCodeInput, #prizeSetupInput { width:100%; padding:12px; border-radius:12px; border:2px solid #3d4270;
    background:#171a35; color:#fff; font-size:16px; text-align:center; margin-top:8px; text-transform:uppercase; }
  #roomCodeShow { font-size: 34px; font-weight:900; letter-spacing:6px; color:#ffd166; margin:12px 0 4px; }
  #shareNote { font-size: 13px; opacity: 0.9; max-width: 320px; margin: 0 auto 8px; line-height:1.6; }
  #copyBtn { padding: 8px 20px; border-radius: 14px; border: 1px solid #3d4270; background:#1e2240; color:#fff; font-size:13px; margin-bottom: 10px; }
  #footerCredit { margin-top: 18px; font-size: 11px; opacity: 0.55; line-height: 1.7; text-align:center; }
  #footerCredit .handle { direction: ltr; unicode-bidi: isolate; display: inline-block; }
  #resumeBox { display:none; margin-bottom: 12px; padding: 12px; background: rgba(255,209,102,0.14); border-radius: 14px; }
  #resumeText { font-size: 13px; margin: 0 0 8px; }

  .ctrl-bar { direction: ltr; display: flex; justify-content: space-between; width: 94vw; max-width: 430px; margin: 4px 0; }
  .ctrl-slot { display: flex; align-items: center; gap: 4px; opacity: 0.45; transition: opacity 0.25s;
    background: rgba(255,255,255,0.08); padding: 5px 8px; border-radius: 12px; position: relative; }
  .ctrl-slot.slot-hidden { visibility: hidden; }
  .ctrl-slot.current-turn { opacity: 1; background: rgba(10,12,28,0.55); }
  .ctrl-slot.current-turn .mini-dice { border-color: #ffd166; background: linear-gradient(160deg,#fff3d0,#ffe08a); }
  .ctrl-slot.enabled { background: rgba(255,209,102,0.22); }
  .pin-ico { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.4); flex-shrink:0; }
  .mini-dice { width: 38px; height: 38px; background: linear-gradient(160deg,#ffffff,#e7e9f2); border-radius: 9px;
    display: grid; grid-template-columns: repeat(3,1fr); grid-template-rows: repeat(3,1fr); padding: 5px; border: 2px solid #c9cee0; }
  .ctrl-slot.enabled .mini-dice { cursor: pointer; box-shadow: 0 0 10px rgba(255,209,102,0.65); }
  .mini-dice.rolling { animation: spin 0.42s linear infinite; }
  @keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
  .pip { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .pip span { width: 5.5px; height: 5.5px; border-radius: 50%; background: #222; display: none; }
  .pip.on span { display: block; }
  .tap-hint { position: absolute; top: -14px; right: -6px; font-size: 15px; opacity: 0; animation: bounceHint 1s infinite; }
  .ctrl-slot.enabled .tap-hint { opacity: 1; }
  @keyframes bounceHint { 0%,100%{transform:translateY(0)} 50%{transform:translateY(4px)} }

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

  #settingsOverlay { position: fixed; inset:0; background: rgba(6,8,22,0.95); display:none; align-items:center; justify-content:center; z-index:80; padding:24px; }
  #settingsOverlay.show { display:flex; }
  #settingsBox { max-width: 320px; width:100%; text-align:center; }
  #settingsBox h3 { font-size: 18px; margin-bottom: 14px; }
  .lang-btn { display:block; width:100%; margin:6px 0; padding:11px; border-radius:12px; border:2px solid #3d4270; background:#171a35; color:#fff; font-size:14px; }
  .lang-btn.sel { border-color:#ffd166; background:#2c3160; }
  #closeSettings { margin-top: 16px; padding: 10px 26px; border-radius: 18px; border:none; background:#2c3160; color:#fff; }

  #ratingBox { display:none; text-align:center; margin-top: 14px; padding: 14px; background: rgba(255,255,255,0.06); border-radius: 16px; max-width: 340px; }
  #ratingBox p { font-size: 13px; margin: 0 0 8px; }
  .star { font-size: 30px; cursor: pointer; opacity: 0.35; padding: 0 2px; }
  .star.on { opacity: 1; }
</style>
</head>
<body>

<div id="topRow">
  <div id="brandTitle">CACTUC</div>
  <button id="gearBtn">⚙️</button>
</div>
<div id="subTitle">🎲 Ludo Online</div>

<div id="lobby">
  <h2 id="lobbyHeading">بازی آنلاین لودو</h2>
  <p id="lobbySub">با دوستات از گوشی‌های جدا بازی کن</p>

  <div id="resumeBox">
    <p id="resumeText"></p>
    <button class="lobby-btn" id="resumeBtn"></button>
  </div>

  <div class="lobby-sub" id="playersLabel">چند نفره بسازیم؟</div>
  <div class="opt-row">
    <div class="opt-btn sel" id="opt2">۲ نفره</div>
    <div class="opt-btn" id="opt3">۳ نفره</div>
    <div class="opt-btn" id="opt4">۴ نفره</div>
  </div>
  <button class="lobby-btn" id="createBtn">🎲 ساخت اتاق جدید</button>
  <button class="lobby-btn alt" id="botBtn">🤖 بازی با کامپیوتر (تنها)</button>

  <input id="joinCodeInput" placeholder="کد اتاق رو وارد کن" maxlength="4">
  <button class="lobby-btn" id="joinBtn">پیوستن به اتاق</button>
  <input id="prizeSetupInput" placeholder="جایزه (اختیاری)" maxlength="40" style="margin-top:14px">
  <div id="waitingNote"></div>
  <div id="footerCredit"></div>
</div>

<div id="gameArea" style="display:none; width:100%; align-items:center; flex-direction:column;">
  <div id="roomCodeShow"></div>
  <div id="shareNote"></div>
  <button id="copyBtn" style="display:none">📋 کپی کد</button>
  <div id="status"></div>
  <div id="prizeBanner"></div>
  <div class="ctrl-bar" id="topBar"></div>
  <div id="board-wrap"><svg id="board" viewBox="0 0 400 400"><g id="staticLayer"></g><g id="piecesLayer"></g></svg></div>
  <div class="ctrl-bar" id="bottomBar"></div>
  <div id="ratingBox">
    <p id="ratePrompt"></p>
    <div>
      <span class="star" data-v="1">★</span><span class="star" data-v="2">★</span><span class="star" data-v="3">★</span><span class="star" data-v="4">★</span><span class="star" data-v="5">★</span>
    </div>
  </div>
</div>

<div id="settingsOverlay">
  <div id="settingsBox">
    <h3 id="settingsTitle">Language</h3>
    <div id="langList"></div>
    <button id="closeSettings">OK</button>
  </div>
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

/* ---------- i18n ---------- */
const I18N = {
  en: { dir:'ltr', langName:'English', title:'🎲 Ludo Online', lobbyHeading:'Play Ludo Online', lobbySub:'Play with friends on separate phones',
    playersLabel:'How many players?', p2:'2 Players', p3:'3 Players', p4:'4 Players', createBtn:'🎲 Create New Room',
    botBtn:'🤖 Play vs Computer (solo)', joinPlaceholder:'Enter room code', joinBtn:'Join Room', prizePlaceholder:"Set the winner's prize (optional)",
    shareNote:'Share this code with your friends and ask them to enter it under "Join Room".',
    copyBtn:'📋 Copy Code', copied:'✅ Copied!', waiting:'Waiting for other players... ({j}/{m})',
    turnRoll:"{n}'s turn — tap your dice", pickPiece:'{n}: pick a piece (dice: {v})', noMove:'{n}: no moves, next turn...',
    win:'🎉 {n} is King! 🎉', presentPrize:'Prize for the winner: {p}', roomFull:'Room is full 😅', disconnected:'Connection lost 😔',
    reconnecting:'Reconnecting...', resumeText:'You have an unfinished game (code: {c})', resumeBtn:'▶️ Resume Game',
    settingsTitle:'Language', ok:'OK', footerLine1:'Creator: Nawid=cactuc', footerLine2:'Hope you enjoy the bot!',
    ratePrompt:'How was it? Rate us!', rateThanks:'🙏 Thanks for your feedback!', loser:'Last Place',
    red:'Red', green:'Green', yellow:'Yellow', blue:'Blue' },
  fa: { dir:'rtl', langName:'فارسی', title:'🎲 لودو آنلاین', lobbyHeading:'بازی آنلاین لودو', lobbySub:'با دوستات از گوشی‌های جدا بازی کن',
    playersLabel:'چند نفره بسازیم؟', p2:'۲ نفره', p3:'۳ نفره', p4:'۴ نفره', createBtn:'🎲 ساخت اتاق جدید',
    botBtn:'🤖 بازی با کامپیوتر (تنها)', joinPlaceholder:'کد اتاق رو وارد کن', joinBtn:'پیوستن به اتاق', prizePlaceholder:'جایزه‌ی برنده رو تعیین کن (اختیاری)',
    shareNote:'این کد رو به رفیقت بده و بگو تو «پیوستن به اتاق» واردش کنه.',
    copyBtn:'📋 کپی کد', copied:'✅ کپی شد!', waiting:'منتظر بقیه‌ی بازیکنا... ({j}/{m})',
    turnRoll:'نوبت {n}: تاس خودتو بزن', pickPiece:'{n}: مهره رو انتخاب کن (تاس: {v})', noMove:'{n}: حرکتی نداری، نوبت بعدی...',
    win:'🎉 {n} پادشاه شد! 🎉', presentPrize:'جایزه رو تقدیم بقیه کن: {p}', roomFull:'اتاق پره 😅', disconnected:'اتصال قطع شد 😔',
    reconnecting:'در حال وصل شدن دوباره...', resumeText:'یه بازی نیمه‌کاره داری (کد: {c})', resumeBtn:'▶️ ادامه‌ی بازی',
    settingsTitle:'زبان', ok:'باشه', footerLine1:'سازنده: Nawid=cactuc', footerLine2:'امیدوارم از ربات لذت ببرید 🥹',
    ratePrompt:'بازی چطور بود؟ بهمون امتیاز بده', rateThanks:'🙏 ممنون از نظرت!', loser:'بازنده میدان',
    red:'قرمز', green:'سبز', yellow:'زرد', blue:'آبی' },
  ru: { dir:'ltr', langName:'Русский', title:'🎲 Лудо Онлайн', lobbyHeading:'Игра Лудо Онлайн', lobbySub:'Играйте с друзьями на разных телефонах',
    playersLabel:'Сколько игроков?', p2:'2 игрока', p3:'3 игрока', p4:'4 игрока', createBtn:'🎲 Создать комнату',
    botBtn:'🤖 Игра против компьютера', joinPlaceholder:'Введите код комнаты', joinBtn:'Присоединиться', prizePlaceholder:'Приз для победителя (необязательно)',
    shareNote:'Отправьте этот код друзьям и попросите ввести его в «Присоединиться к комнате».',
    copyBtn:'📋 Копировать код', copied:'✅ Скопировано!', waiting:'Ожидание игроков... ({j}/{m})',
    turnRoll:'Ход {n} — нажмите свой кубик', pickPiece:'{n}: выберите фишку (кубик: {v})', noMove:'{n}: нет ходов, следующий ход...',
    win:'🎉 {n} — король! 🎉', presentPrize:'Приз победителю: {p}', roomFull:'Комната заполнена 😅', disconnected:'Соединение потеряно 😔',
    reconnecting:'Переподключение...', resumeText:'У вас есть незавершённая игра (код: {c})', resumeBtn:'▶️ Продолжить игру',
    settingsTitle:'Язык', ok:'ОК', footerLine1:'Автор: Nawid=cactuc', footerLine2:'Надеемся, вам понравится бот!',
    ratePrompt:'Как вам игра? Оцените нас!', rateThanks:'🙏 Спасибо за отзыв!', loser:'Последнее место',
    red:'Красный', green:'Зелёный', yellow:'Жёлтый', blue:'Синий' },
  ar: { dir:'rtl', langName:'العربية', title:'🎲 لودو أونلاين', lobbyHeading:'العب لودو أونلاين', lobbySub:'العب مع أصدقائك من هواتف منفصلة',
    playersLabel:'كم عدد اللاعبين؟', p2:'لاعبان', p3:'٣ لاعبين', p4:'٤ لاعبين', createBtn:'🎲 إنشاء غرفة جديدة',
    botBtn:'🤖 العب ضد الكمبيوتر', joinPlaceholder:'أدخل رمز الغرفة', joinBtn:'الانضمام إلى الغرفة', prizePlaceholder:'حدد جائزة الفائز (اختياري)',
    shareNote:'شارك هذا الرمز مع أصدقائك واطلب منهم إدخاله في «الانضمام إلى الغرفة».',
    copyBtn:'📋 نسخ الرمز', copied:'✅ تم النسخ!', waiting:'بانتظار بقية اللاعبين... ({j}/{m})',
    turnRoll:'دور {n} — اضغط على نردك', pickPiece:'{n}: اختر قطعة (النرد: {v})', noMove:'{n}: لا حركة، الدور التالي...',
    win:'🎉 {n} أصبح الملك! 🎉', presentPrize:'الجائزة للفائز: {p}', roomFull:'الغرفة ممتلئة 😅', disconnected:'انقطع الاتصال 😔',
    reconnecting:'إعادة الاتصال...', resumeText:'لديك لعبة غير مكتملة (الرمز: {c})', resumeBtn:'▶️ متابعة اللعبة',
    settingsTitle:'اللغة', ok:'حسناً', footerLine1:'صانع اللعبة: Nawid=cactuc', footerLine2:'نتمنى أن تستمتع بالبوت!',
    ratePrompt:'كيف كانت اللعبة؟ قيّمنا!', rateThanks:'🙏 شكراً لتقييمك!', loser:'الخاسر',
    red:'أحمر', green:'أخضر', yellow:'أصفر', blue:'أزرق' },
  de: { dir:'ltr', langName:'Deutsch', title:'🎲 Ludo Online', lobbyHeading:'Ludo Online spielen', lobbySub:'Spiele mit Freunden auf getrennten Handys',
    playersLabel:'Wie viele Spieler?', p2:'2 Spieler', p3:'3 Spieler', p4:'4 Spieler', createBtn:'🎲 Neuen Raum erstellen',
    botBtn:'🤖 Gegen Computer spielen', joinPlaceholder:'Raumcode eingeben', joinBtn:'Raum beitreten', prizePlaceholder:'Preis für den Gewinner festlegen (optional)',
    shareNote:'Teile diesen Code mit deinen Freunden und lass sie ihn unter „Raum beitreten" eingeben.',
    copyBtn:'📋 Code kopieren', copied:'✅ Kopiert!', waiting:'Warte auf weitere Spieler... ({j}/{m})',
    turnRoll:'{n} ist dran — eigenen Würfel tippen', pickPiece:'{n}: Figur wählen (Würfel: {v})', noMove:'{n}: kein Zug möglich, nächster...',
    win:'🎉 {n} ist König! 🎉', presentPrize:'Preis für den Gewinner: {p}', roomFull:'Raum ist voll 😅', disconnected:'Verbindung verloren 😔',
    reconnecting:'Verbinde erneut...', resumeText:'Du hast ein unbeendetes Spiel (Code: {c})', resumeBtn:'▶️ Spiel fortsetzen',
    settingsTitle:'Sprache', ok:'OK', footerLine1:'Erstellt von: Nawid=cactuc', footerLine2:'Wir hoffen, der Bot gefällt dir!',
    ratePrompt:'Wie war es? Bewerte uns!', rateThanks:'🙏 Danke für dein Feedback!', loser:'Letzter Platz',
    red:'Rot', green:'Grün', yellow:'Gelb', blue:'Blau' }
};
let lang = (()=>{ try{ return localStorage.getItem('cactuc_lang') || 'fa'; }catch(e){ return 'fa'; } })();
function t(key, params){
  let s = I18N[lang][key] || key;
  if(params) for(const k in params) s = s.replace('{'+k+'}', params[k]);
  return s;
}
function meWord(){ return {fa:'تو',en:'you',ru:'ты',ar:'أنت',de:'du'}[lang]; }

/* ---------- session persistence (fixes reconnect / room-full bug) ---------- */
function saveSession(){ try{ localStorage.setItem('cactuc_session', JSON.stringify({code:roomCode, color:myColor, ts:Date.now()})); }catch(e){} }
function loadSession(){ try{ const raw=localStorage.getItem('cactuc_session'); if(!raw) return null; const obj=JSON.parse(raw); if(Date.now()-obj.ts > 3*60*60*1000) return null; return obj; }catch(e){ return null; } }
function clearSession(){ try{ localStorage.removeItem('cactuc_session'); }catch(e){} }

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
let chosenMax = 2;
let ratingGiven = false;
let reconnecting = false;

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

function pinSVG(x, y, color, idx, cls, showRing){
  const hex = HEX[color], dark = DARK[color];
  let ring = '';
  let hitArea = '';
  if(showRing){
    ring = \`<circle cx="\${x}" cy="\${y-5}" r="15" fill="none" stroke="#111319" stroke-width="2.4" stroke-dasharray="6 5" opacity="0.9">
      <animateTransform attributeName="transform" type="rotate" from="0 \${x} \${y-5}" to="360 \${x} \${y-5}" dur="1.6s" repeatCount="indefinite"/>
    </circle>\`;
  }
  if(cls.indexOf('movable')!==-1){
    hitArea = \`<circle cx="\${x}" cy="\${y}" r="17" fill="#000" opacity="0.001"/>\`;
  }
  return \`<g class="piece \${cls}" data-color="\${color}" data-idx="\${idx}">
    \${hitArea}
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
  const curColor = state.order[state.turn];
  let entries = [];
  activeColors.forEach(c=>{
    state.pieces[c].forEach((pos, idx)=>{
      if(pos===FINISH_POS) return;
      let x,y;
      if(pos===-1){ [x,y]=yardXY(c,idx); } else { [x,y]=relToAbsCell(c,pos); }
      const isMovableVisual = c===curColor && state.movable.some(m=>m.piece===idx);
      const isClickable = isMovableVisual && myColor===c;
      entries.push({c, idx, x, y, isMovableVisual, isClickable, pos});
    });
  });
  const groups = {};
  entries.forEach(e=>{
    if(e.pos===-1) return;
    const key = Math.round(e.x)+'_'+Math.round(e.y);
    (groups[key] = groups[key]||[]).push(e);
  });
  Object.values(groups).forEach(grp=>{
    if(grp.length<2) return;
    grp.forEach((e,i)=>{
      const ang = (i/grp.length)*2*Math.PI;
      e.x += Math.cos(ang)*7;
      e.y += Math.sin(ang)*7;
    });
  });
  entries.sort((a,b)=> (a.isClickable?1:0) - (b.isClickable?1:0));

  let html = '';
  entries.forEach(e=>{
    const cls = e.isClickable ? 'piece-normal movable' : 'piece-normal';
    html += pinSVG(e.x, e.y, e.c, e.idx, cls, e.isMovableVisual);
  });
  activeColors.forEach(c=>{
    if(state.finished[c]===4){
      const [r0,c0] = CORNER[c];
      const rank = state.finishOrder.indexOf(c)+1;
      html += \`<rect x="\${c0*CELL}" y="\${r0*CELL}" width="\${6*CELL}" height="\${6*CELL}" fill="#0a0d1f" opacity="0.6"/>\`;
      html += \`<text x="\${(c0+3)*CELL}" y="\${(r0+2.7)*CELL}" text-anchor="middle" font-size="22">👑</text>\`;
      html += \`<text x="\${(c0+3)*CELL}" y="\${(r0+3.6)*CELL}" text-anchor="middle" font-size="15" fill="#ffd166" font-weight="bold">King (\${rank})</text>\`;
    } else if(state.gameOver){
      const [r0,c0] = CORNER[c];
      html += \`<rect x="\${c0*CELL}" y="\${r0*CELL}" width="\${6*CELL}" height="\${6*CELL}" fill="#3a0d0d" opacity="0.65"/>\`;
      html += \`<text x="\${(c0+3)*CELL}" y="\${(r0+2.7)*CELL}" text-anchor="middle" font-size="22">😢</text>\`;
      html += \`<text x="\${(c0+3)*CELL}" y="\${(r0+3.6)*CELL}" text-anchor="middle" font-size="14" fill="#ffb3b3" font-weight="bold">\${t('loser')}</text>\`;
    }
  });
  const layer = document.getElementById('piecesLayer');
  layer.innerHTML = html;
  layer.querySelectorAll('.piece.movable').forEach(el=>{
    const idx = parseInt(el.getAttribute('data-idx'));
    el.addEventListener('click', ()=> sendMove(idx));
  });
}

function celebrationBurst(x,y,color){
  const layer = document.getElementById('piecesLayer');
  let extra = '';
  for(let i=0;i<20;i++){
    const ang = (i/20)*360;
    const dist = 55 + Math.random()*20;
    const dx = Math.cos(ang*Math.PI/180)*dist, dy = Math.sin(ang*Math.PI/180)*dist;
    const r = 2.5 + Math.random()*2.5;
    extra += \`<circle cx="\${x}" cy="\${y}" r="\${r}" fill="\${HEX[color]}">
      <animate attributeName="cx" from="\${x}" to="\${x+dx}" dur="0.85s" fill="freeze"/>
      <animate attributeName="cy" from="\${y}" to="\${y+dy}" dur="0.85s" fill="freeze"/>
      <animate attributeName="opacity" from="1" to="0" dur="0.85s" fill="freeze"/>
    </circle>\`;
  }
  layer.insertAdjacentHTML('beforeend', extra);
}
async function fireworksShow(){
  for(let i=0;i<7;i++){
    const x = 50+Math.random()*300, y=50+Math.random()*300;
    const col = COLORS[Math.floor(Math.random()*COLORS.length)];
    celebrationBurst(x,y,col);
    await sleep(230);
  }
}

function colorName(c){ return t(c); }

function renderUI(){
  const st = document.getElementById('status');
  const pb = document.getElementById('prizeBanner');
  if(state && state.prize){ pb.style.display='inline-block'; pb.textContent = '🏆 '+state.prize; }
  else pb.style.display='none';

  if(!state){ return; }
  if(!state.gameOver){
    const curC = state.order[state.turn];
    const name = colorName(curC) + (curC===myColor?' ('+meWord()+')':'');
    if(state.diceValue===null) st.textContent = t('turnRoll',{n:name});
    else if(state.movable.length===0) st.textContent = t('noMove',{n:name});
    else st.textContent = t('pickPiece',{n:name, v:state.diceValue});
  }

  COLORS.forEach(c=>{
    const slot = document.getElementById('slot-'+c);
    if(!slot) return;
    const active = activeColors.includes(c);
    slot.classList.toggle('slot-hidden', !active);
    if(!active) return;
    const isCurrentTurn = state.order[state.turn]===c && !state.gameOver;
    const isClickable = isCurrentTurn && state.canRoll && !animating && c===myColor;
    slot.classList.toggle('current-turn', isCurrentTurn);
    slot.classList.toggle('enabled', isClickable);
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
      <div class="tap-hint">👆</div>\`;
    slot.querySelector('.mini-dice').addEventListener('click', ()=> sendRoll(c));
    return slot;
  }
  top.appendChild(makeSlot('red')); top.appendChild(makeSlot('green'));
  bottom.appendChild(makeSlot('blue')); bottom.appendChild(makeSlot('yellow'));
}

function sendRoll(color){
  if(color!==myColor) return;
  if(!ws || ws.readyState!==WebSocket.OPEN) return;
  if(!state || state.order[state.turn]!==myColor || !state.canRoll || animating) return;
  ws.send(JSON.stringify({type:'roll'}));
}
function sendMove(piece){
  if(!ws || ws.readyState!==WebSocket.OPEN) return;
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

function enterGame(game){
  activeColors = game.order.slice();
  state = game;
  document.getElementById('lobby').style.display='none';
  document.getElementById('gameArea').style.display='flex';
  buildBars(); drawStatic(); render();
}

function showRatingBox(){
  ratingGiven = false;
  const box = document.getElementById('ratingBox');
  document.getElementById('ratePrompt').textContent = t('ratePrompt');
  box.querySelectorAll('.star').forEach(s=> s.classList.remove('on'));
  box.style.display = 'block';
}
document.querySelectorAll('.star').forEach(star=>{
  star.addEventListener('click', ()=>{
    if(ratingGiven) return;
    ratingGiven = true;
    const v = parseInt(star.getAttribute('data-v'));
    document.querySelectorAll('.star').forEach(s=>{
      s.classList.toggle('on', parseInt(s.getAttribute('data-v'))<=v);
    });
    fetch('/rate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({stars:v}) }).catch(()=>{});
    document.getElementById('ratePrompt').textContent = t('rateThanks');
  });
});

async function replayAction(action){
  if(action.actionKind==='start'){
    enterGame(action.game);
    return;
  }
  if(action.actionKind==='prize'){
    state = action.game; render();
    return;
  }
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
    if(state.gameOver){
      sndWin();
      let msg = t('win',{n:colorName(state.finishOrder[0])});
      if(state.prize) msg += ' — ' + t('presentPrize',{p:state.prize});
      document.getElementById('status').textContent = msg;
      showRatingBox();
      clearSession();
      render();
      fireworksShow();
      return;
    }
  }
}

function scheduleReconnect(){
  if(reconnecting || !myColor || !roomCode) return;
  reconnecting = true;
  const st = document.getElementById('status');
  if(st) st.textContent = t('reconnecting');
  setTimeout(()=>{ reconnecting = false; connect(roomCode, '', null, myColor); }, 1500);
}

function connect(code, prize, max, rejoinColor, botMode){
  if(ws){ try{ ws.close(); }catch(e){} ws=null; }
  roomCode = code.toUpperCase();
  document.getElementById('lobby').style.display='none';
  document.getElementById('gameArea').style.display='flex';
  document.getElementById('roomCodeShow').textContent = roomCode;
  if(max && !botMode){
    document.getElementById('shareNote').textContent = t('shareNote');
    const cbtn = document.getElementById('copyBtn');
    cbtn.style.display='inline-block';
    cbtn.textContent = t('copyBtn');
    cbtn.onclick = ()=>{
      const ta=document.createElement('textarea'); ta.value=roomCode; document.body.appendChild(ta);
      ta.select(); try{ document.execCommand('copy'); }catch(e){}
      document.body.removeChild(ta);
      cbtn.textContent = t('copied');
      setTimeout(()=> cbtn.textContent = t('copyBtn'), 1500);
    };
  } else {
    document.getElementById('shareNote').textContent = '';
    document.getElementById('copyBtn').style.display = 'none';
  }
  const proto = location.protocol==='https:' ? 'wss:' : 'ws:';
  let wsUrl = proto+'//'+location.host+'/room/'+roomCode;
  const params = [];
  if(max) params.push('max='+max);
  if(rejoinColor) params.push('rejoin='+rejoinColor);
  if(botMode) params.push('bot=1');
  if(params.length) wsUrl += '?'+params.join('&');
  ws = new WebSocket(wsUrl);
  ws.addEventListener('open', ()=>{
    if(prize) ws.send(JSON.stringify({type:'setPrize', prize}));
  });
  ws.addEventListener('message', (evt)=>{
    let data; try{ data = JSON.parse(evt.data); }catch(e){ return; }
    if(data.type==='full'){ alert(t('roomFull')); return; }
    if(data.type==='welcome'){
      myColor = data.color;
      saveSession();
      if(data.game){
        enterGame(data.game);
      } else {
        document.getElementById('status').textContent = t('waiting',{j:data.joined.length, m:data.max});
      }
      return;
    }
    if(data.type==='lobby'){
      if(!state){
        document.getElementById('status').textContent = t('waiting',{j:data.joined.length, m:data.max});
      }
      return;
    }
    if(data.type==='action'){
      replayAction(data);
    }
  });
  ws.addEventListener('close', ()=>{
    if(myColor && roomCode && !(state && state.gameOver)){
      scheduleReconnect();
    } else if(document.getElementById('status') && !state){
      document.getElementById('status').textContent = t('disconnected');
    }
  });
}

function randomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

['opt2','opt3','opt4'].forEach((id,i)=>{
  document.getElementById(id).addEventListener('click', ()=>{
    chosenMax = i+2;
    ['opt2','opt3','opt4'].forEach(x=> document.getElementById(x).classList.remove('sel'));
    document.getElementById(id).classList.add('sel');
  });
});

document.getElementById('createBtn').addEventListener('click', ()=>{
  ensureAudio();
  const code = randomCode();
  const prize = document.getElementById('prizeSetupInput').value.trim();
  connect(code, prize, chosenMax);
});
document.getElementById('botBtn').addEventListener('click', ()=>{
  ensureAudio();
  const code = randomCode();
  connect(code, '', 2, null, true);
});
document.getElementById('joinBtn').addEventListener('click', ()=>{
  ensureAudio();
  const code = document.getElementById('joinCodeInput').value.trim();
  if(code.length!==4){ alert(lang==='fa'?'کد ۴ کاراکتریه':'Code is 4 characters'); return; }
  connect(code, '', null);
});

function checkResume(){
  const s = loadSession();
  const box = document.getElementById('resumeBox');
  if(s){
    box.style.display='block';
    document.getElementById('resumeText').textContent = t('resumeText',{c:s.code});
    document.getElementById('resumeBtn').textContent = t('resumeBtn');
    document.getElementById('resumeBtn').onclick = ()=>{ ensureAudio(); connect(s.code, '', null, s.color); };
  } else {
    box.style.display='none';
  }
}

function applyLangToLobby(){
  document.documentElement.dir = I18N[lang].dir;
  document.getElementById('subTitle').textContent = t('title');
  document.getElementById('lobbyHeading').textContent = t('lobbyHeading');
  document.getElementById('lobbySub').textContent = t('lobbySub');
  document.getElementById('playersLabel').textContent = t('playersLabel');
  document.getElementById('opt2').textContent = t('p2');
  document.getElementById('opt3').textContent = t('p3');
  document.getElementById('opt4').textContent = t('p4');
  document.getElementById('createBtn').textContent = t('createBtn');
  document.getElementById('botBtn').textContent = t('botBtn');
  document.getElementById('joinCodeInput').placeholder = t('joinPlaceholder');
  document.getElementById('joinBtn').textContent = t('joinBtn');
  document.getElementById('prizeSetupInput').placeholder = t('prizePlaceholder');
  document.getElementById('footerCredit').innerHTML = t('footerLine1').replace('Nawid=cactuc','<span class="handle">Nawid=cactuc</span>') + '<br>' + t('footerLine2');
  document.getElementById('settingsTitle').textContent = t('settingsTitle');
  document.getElementById('closeSettings').textContent = t('ok');
  checkResume();
  if(state) render();
}
function buildLangList(){
  const box = document.getElementById('langList');
  box.innerHTML = '';
  Object.keys(I18N).forEach(code=>{
    const b = document.createElement('div');
    b.className = 'lang-btn' + (code===lang?' sel':'');
    b.textContent = I18N[code].langName;
    b.onclick = ()=>{ lang=code; try{ localStorage.setItem('cactuc_lang', lang); }catch(e){} buildLangList(); applyLangToLobby(); };
    box.appendChild(b);
  });
}
document.getElementById('gearBtn').addEventListener('click', ()=>{
  buildLangList();
  document.getElementById('settingsOverlay').classList.add('show');
});
document.getElementById('closeSettings').addEventListener('click', ()=>{
  document.getElementById('settingsOverlay').classList.remove('show');
});

applyLangToLobby();
</script>
</body>
</html>`;

