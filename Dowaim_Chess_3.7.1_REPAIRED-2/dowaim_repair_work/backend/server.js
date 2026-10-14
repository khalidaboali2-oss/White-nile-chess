const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const app = express();
const IS_PROD=process.env.NODE_ENV==='production';
if(IS_PROD && !process.env.ALLOWED_ORIGINS) throw new Error('ALLOWED_ORIGINS_required_in_production');
if(IS_PROD && !process.env.REDIS_URL) throw new Error('REDIS_URL_required_in_production');
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || true : false);
const ALLOWED_ORIGINS=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors(ALLOWED_ORIGINS.length?{origin:ALLOWED_ORIGINS,methods:['GET','POST','PUT','DELETE'],allowedHeaders:['Content-Type','Authorization']}:{origin:false}));
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('X-DNS-Prefetch-Control','off');
  res.setHeader('X-Permitted-Cross-Domain-Policies','none');
  if(IS_PROD) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json({limit:'256kb',strict:true}));
app.use(express.urlencoded({extended:false,limit:'32kb'}));
// Do not acknowledge a request that changed stored state until its PostgreSQL snapshot completes.
app.use((req,res,next)=>{
  if(!pgPool) return next();
  const queueAtStart=persistenceQueue;
  const originalJson=res.json.bind(res), originalSend=res.send.bind(res);
  let insideOriginalResponder=false;
  const durableRespond=(kind,body)=>{
    const original=kind==='json'?originalJson:originalSend;
    if(insideOriginalResponder || persistenceQueue===queueAtStart) return original(body);
    return persistenceQueue.then(()=>{
      insideOriginalResponder=true;
      try{
        if(persistenceError){if(!res.headersSent)res.status(503);return originalJson({error:'persistence_unavailable'});}
        return original(body);
      }finally{insideOriginalResponder=false;}
    }).catch(()=>{insideOriginalResponder=true;try{if(!res.headersSent)res.status(503);return originalJson({error:'persistence_unavailable'});}finally{insideOriginalResponder=false;}});
  };
  res.json=body=>durableRespond('json',body);
  res.send=body=>durableRespond('send',body);
  next();
});

// Serve the browser client from the same Web Service in production/deployment.
// This keeps the web UI and API on one origin, so users can open the platform
// directly from the public service URL without manually entering an API URL.
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

// Redis-backed rate limiting in production; memory fallback for local development.
const rateBuckets=new Map();
const redis=process.env.REDIS_URL?new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:2,enableOfflineQueue:false}):null;
if(redis) redis.on('error',()=>{});
const { Pool } = require('pg');
const pgPool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...(process.env.PGSSL === 'require' ? { ssl: { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } } : {})
}) : null;
let persistenceError = null;
let persistenceQueue = Promise.resolve();
function rateLimit(max,windowMs){return async (req,res,next)=>{const account=req.user||'anon';const key=`rl:${req.ip}:${account}:${req.path}`;if(redis){try{const n=await redis.incr(key);if(n===1)await redis.pexpire(key,windowMs);if(n>max)return res.status(429).json({error:'rate_limited'});return next();}catch(e){if(IS_PROD)return res.status(503).json({error:'rate_limiter_unavailable'});}}const t=Date.now();let b=rateBuckets.get(key);if(!b||t-b.start>=windowMs)b={start:t,count:0};b.count++;rateBuckets.set(key,b);if(b.count>max)return res.status(429).json({error:'rate_limited'});next();};}
setInterval(()=>{const cutoff=Date.now()-300000;for(const [k,b] of rateBuckets)if(b.start<cutoff)rateBuckets.delete(k);},60000);


const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,'data');
fs.mkdirSync(DATA_DIR,{recursive:true});
const DB_FILE = path.join(DATA_DIR,'store.json');
const now=()=>new Date().toISOString();
const id=p=>`${p}_${crypto.randomBytes(8).toString('hex')}`;
const hash=(v,salt=crypto.randomBytes(16).toString('hex'))=>({salt,hash:crypto.scryptSync(v,salt,64).toString('hex')});
const verify=(v,h)=>{try{const a=Buffer.from(h.hash,'hex'),b=crypto.scryptSync(String(v),h.salt,64);return a.length===b.length&&crypto.timingSafeEqual(a,b)}catch{return false}};
let db={users:[],games:[],tournaments:[],messages:[],reports:[],challenges:[],friendships:[],ratings:[],bans:[],events:[],notifications:[],audit:[],privacy:[],appeals:[],teams:[],teamInvites:[],sessions:[],puzzleStats:[],maintenance:false};
try{if(fs.existsSync(DB_FILE))db=JSON.parse(fs.readFileSync(DB_FILE,'utf8'));}catch(e){}
function save(){
  const serialized=JSON.stringify(db);
  const tmp=DB_FILE+'.tmp';
  fs.writeFileSync(tmp,serialized);
  fs.renameSync(tmp,DB_FILE);
  if(pgPool){
    persistenceQueue=persistenceQueue.then(()=>pgPool.query(
      'INSERT INTO app_state (id,payload,updated_at) VALUES (1,$1::jsonb,now()) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now()',
      [serialized]
    )).then(()=>{persistenceError=null;}).catch(err=>{persistenceError=String(err.message||err);console.error('PostgreSQL persistence failed:',persistenceError);});
  }
}
async function initializeStorage(){
  if(!pgPool){if(IS_PROD)throw new Error('DATABASE_URL_required_in_production');return;}
  await pgPool.query(`CREATE TABLE IF NOT EXISTS app_state (id SMALLINT PRIMARY KEY CHECK (id=1), payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const result=await pgPool.query('SELECT payload FROM app_state WHERE id=1');
  if(result.rows.length){
    const payload=result.rows[0].payload;
    if(!payload || typeof payload!=='object' || Array.isArray(payload)) throw new Error('invalid_postgres_app_state');
    db={...db,...payload};
    for(const key of ['users','games','tournaments','messages','reports','challenges','friendships','ratings','bans','events','notifications','audit','privacy','appeals','teams','teamInvites','sessions','puzzleStats']) if(!Array.isArray(db[key])) db[key]=[];
    if(typeof db.maintenance!=='boolean')db.maintenance=false;
    const tmp=DB_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db,null,2));fs.renameSync(tmp,DB_FILE);
  } else {
    await pgPool.query('INSERT INTO app_state (id,payload,updated_at) VALUES (1,$1::jsonb,now()) ON CONFLICT (id) DO NOTHING',[JSON.stringify(db)]);
  }
  await pgPool.query('SELECT 1');
}
function audit(action,actorId,targetId,details={}){db.audit.push({id:id('audit'),action,actorId:actorId||null,targetId:targetId||null,details,createdAt:now()});}
function notify(userId,type,title,body,meta={}){db.notifications.push({id:id('notif'),userId,type,title,body,meta,read:false,createdAt:now()});}
function requireOrganizer(req,res,next){const u=db.users.find(x=>x.id===req.user);if(!u||!['organizer','admin'].includes(u.role))return res.status(403).json({error:'organizer_required'});req.organizer=u;next();}
function requireAdmin(req,res,next){const u=db.users.find(x=>x.id===req.user);if(!u||u.role!=='admin')return res.status(403).json({error:'admin_required'});req.admin=u;next();}
app.use((req,res,next)=>{if(db.maintenance && req.path!=='/health')return res.status(503).json({error:'maintenance'});next();});
const sessions=new Map(); const sockets=new Map(); const games=new Map();
const SESSION_MS=30*24*60*60*1000;
function tokenHash(t){return crypto.createHash('sha256').update(String(t)).digest('hex')}
async function issueSession(user,req){const token=crypto.randomBytes(32).toString('base64url');const h=tokenHash(token);const device={id:id('device'),userAgent:String(req.headers['user-agent']||'unknown').slice(0,300),createdAt:now(),expiresAt:new Date(Date.now()+SESSION_MS).toISOString(),tokenHash:h};user.devices=user.devices||[];user.devices.push(device);db.sessions.push({hash:h,userId:user.id,expiresAt:device.expiresAt});sessions.set(h,user.id);if(redis)await redis.set(`sess:${h}`,user.id,'PX',SESSION_MS);return token}
async function revokeToken(token){const h=tokenHash(token);sessions.delete(h);if(redis)redis.del(`sess:${h}`).catch(()=>{});db.sessions=db.sessions.filter(x=>x.hash!==h);for(const u of db.users){if(u.devices)u.devices=u.devices.filter(d=>d.tokenHash!==h)}}
function revokeTokenHash(h){sessions.delete(h);if(redis)redis.del(`sess:${h}`).catch(()=>{});db.sessions=db.sessions.filter(x=>x.hash!==h);for(const u of db.users)if(u.devices)u.devices=u.devices.filter(d=>d.tokenHash!==h)}
async function revokeUserSessions(uid){for(const x of db.sessions.filter(x=>x.userId===uid)){sessions.delete(x.hash);if(redis)redis.del(`sess:${x.hash}`).catch(()=>{});}db.sessions=db.sessions.filter(x=>x.userId!==uid);const u=db.users.find(x=>x.id===uid);if(u)u.devices=[];}
async function restoreSessions(){db.sessions=(db.sessions||[]).filter(x=>Date.parse(x.expiresAt)>Date.now());for(const x of db.sessions){sessions.set(x.hash,x.userId);if(redis)await redis.set(`sess:${x.hash}`,x.userId,'PX',Math.max(1000,Date.parse(x.expiresAt)-Date.now()));}}
setInterval(()=>{const t=Date.now();for(const x of [...sessions.keys()]){const d=db.sessions.find(s=>s.hash===x);if(!d||Date.parse(d.expiresAt)<=t){sessions.delete(x);for(const u of db.users)if(u.devices)u.devices=u.devices.filter(v=>v.tokenHash!==x)}}},60000);
function persistGame(g){ const x={id:g.id,type:g.type,variant:g.type,mode:g.mode,timeControl:g.timeControl,status:g.status,initialFen:g.initialFen||g.chess.fen(),players:g.players,moves:g.moves,createdAt:g.createdAt,endedAt:g.endedAt,reason:g.reason,clocks:g.clocks,lastTick:g.lastTick,drawOffer:g.drawOffer,winner:g.winner,teamArenaContext:g.teamArenaContext||null,teamArenaResultRecorded:!!g.teamArenaResultRecorded,tournamentId:g.tournamentId||null,simulHost:g.simulHost||null,challengeId:g.challengeId||null}; const i=db.games.findIndex(v=>v.id===g.id); if(i<0)db.games.push(x);else db.games[i]=x; save(); }
async function restoreGames(){
  for(const x of db.games.filter(v=>v.status==='playing'||v.status==='waiting')){
    try{
      const c=new Chess(x.initialFen||undefined);
      for(const san of x.moves||[]) c.move(san);
      // Server downtime must not consume either player's clock.
      const restored={...x,chess:c,lastTick:x.status==='playing'?Date.now():null,teamArenaContext:x.teamArenaContext||null,teamArenaResultRecorded:!!x.teamArenaResultRecorded,tournamentId:x.tournamentId||null};
      games.set(x.id,restored);
      if(restored.status==='playing')persistGame(restored);
    }catch(e){console.error('Could not restore game',x.id,String(e.message||e));}
  }
  await restoreSessions();
}

const SYSTEMS=['swiss','round_robin','knockout','arena','teams','khalid'];
const RATING_TYPES=['bullet','blitz','rapid','classical','chess960'];
const TIMES={'1+0':60,'2+0':120,'3+0':180,'3+2':180,'5+0':300,'10+0':600,'15+10':900,'20+0':1200,'30+0':1800};

app.get('/health',(q,r)=>r.json({ok:true,service:'white-nile-chess',version:'3.7.1',platform:'Dowaim Chess',academy:'White Nile Chess Academy',owner:'Khalid Ahmed Mostafa Yousif',storage:pgPool?'postgres-jsonb-state':'json-local',postgresConfigured:!!pgPool,persistenceError:!!persistenceError,redis:!!redis,production:IS_PROD,online:db.users.filter(u=>u.online).length,games:db.games.length}));
app.get('/ready',async(q,r)=>{let dbOk=!IS_PROD,redisOk=true;if(pgPool){try{await pgPool.query('SELECT 1');await persistenceQueue;dbOk=!persistenceError;}catch(e){dbOk=false;}}if(redis){try{await redis.ping()}catch(e){redisOk=false}}const ok=dbOk&&redisOk&&!persistenceError;r.status(ok?200:503).json({ok,postgresConfigured:!!pgPool,postgresReachable:dbOk,redis:redisOk,persistenceHealthy:!persistenceError});});
async function auth(req,res,next){try{const token=(req.headers.authorization||'').replace(/^Bearer /,'').trim();const h=tokenHash(token);const session=db.sessions.find(x=>x.hash===h);let u=session&&sessions.get(h);if(redis&&token){u=await redis.get(`sess:${h}`);if(u&&!session){return res.status(401).json({error:'session_desync'});}}if(!token||!session||!u||Date.parse(session.expiresAt)<=Date.now()){return res.status(401).json({error:'unauthorized'});}const user=db.users.find(x=>x.id===u);if(!user||user.banned){revokeToken(token);return res.status(401).json({error:'unauthorized'});}req.user=u;req.sessionHash=h;next();}catch(e){return res.status(503).json({error:'auth_unavailable'});}}
function publicUser(u){return {id:u.id,username:u.username,name:u.name,createdAt:u.createdAt};}
function banned(email){return db.bans.some(b=>b.email===email.toLowerCase());}
const DUMMY_PASSWORD_HASH=hash('DowaimChessDummyPasswordOnlyForTiming');
function safePasswordVerify(password,stored){return stored?verify(String(password||''),stored):verify(String(password||''),DUMMY_PASSWORD_HASH);}


app.post('/auth/register',rateLimit(10,15*60*1000),async (req,res)=>{const {email,password,username,name}=req.body||{}; if(!email||!password||!username)return res.status(400).json({error:'email_password_username_required'}); const e=String(email).trim().toLowerCase(); if(String(password).length<8)return res.status(400).json({error:'password_min_8'}); if(String(username).length<3||String(username).length>32||!/^[A-Za-z0-9_\-]+$/.test(String(username)))return res.status(400).json({error:'invalid_username'}); if(banned(e))return res.status(403).json({error:'email_banned'}); if(db.users.some(u=>u.email===e||u.username.toLowerCase()===username.toLowerCase()))return res.status(409).json({error:'already_exists'}); const role=(process.env.ORGANIZER_KEY && req.body.organizerKey===process.env.ORGANIZER_KEY)?'organizer':'player';const u={id:id('user'),email:e,username,name:name||username,pass:hash(password),role,createdAt:now(),devices:[]}; db.users.push(u); save(); const token=await issueSession(u,req); audit('register',u.id,u.id,{email:e,role}); save(); res.status(201).json({token,user:publicUser(u)});});
app.post('/auth/login',rateLimit(20,15*60*1000),async (req,res)=>{const {email,password}=req.body||{};const u=db.users.find(x=>x.email===String(email||'').trim().toLowerCase());if(!safePasswordVerify(password,u?.pass)||!u||u.banned||banned(u.email))return res.status(401).json({error:'invalid_credentials'});const token=await issueSession(u,req);audit('login',u.id,u.id);save();res.json({token,user:publicUser(u)});});
app.get('/auth/me',auth,(req,res)=>res.json({user:publicUser(db.users.find(u=>u.id===req.user))}));
app.post('/auth/logout',auth,async (req,res)=>{await revokeToken((req.headers.authorization||'').replace(/^Bearer /,'').trim());audit('logout',req.user,req.user);save();res.json({ok:true});});
app.post('/auth/logout-all',auth,async (req,res)=>{await revokeUserSessions(req.user);audit('logout_all',req.user,req.user);save();res.json({ok:true});});

function canViewGame(g,userId){
  if(!g) return false;
  if(g.players.some(p=>p.id===userId)) return true;
  return g.status==='finished' || g.mode==='unrated';
}
function requireGamePlayer(g,userId){ return !!g && g.players.some(p=>p.id===userId); }
function gamePublic(g,viewerId=null){
  const blind=g.type==='blindfold';
  const canSeePrivate=g.players.some(p=>p.id===viewerId);
  return {id:g.id,type:g.type,variant:g.type,mode:g.mode,timeControl:g.timeControl,status:g.status,initialFen:g.initialFen||g.chess.fen(),
    players:g.players.map(p=>({id:p.id,name:p.name,color:p.color})),
    fen:blind?null:g.chess.fen(),
    moves:blind?[]:g.moves,
    createdAt:g.createdAt,endedAt:g.endedAt,reason:g.reason,lastTick:g.lastTick,winner:g.winner,
    pgn:blind?'':g.chess.pgn(),whiteTime:g.clocks.white,blackTime:g.clocks.black,
    hidePieces:blind,hideMoveHistory:blind};
}
function chess960Fen(){const a=Array(8).fill(null),back=['r','n','b','q','k','b','n','r'];let light=[0,2,4,6], bi1=light[Math.floor(Math.random()*light.length)];a[bi1]='b';let dark=[1,3,5,7],bi2=dark[Math.floor(Math.random()*dark.length)];a[bi2]='b';let free=a.map((v,i)=>v?null:i).filter(x=>x!==null);let qi=free.splice(Math.floor(Math.random()*free.length),1)[0];a[qi]='q';let ni=free.splice(Math.floor(Math.random()*free.length),1)[0];a[ni]='n';let ni2=free.splice(Math.floor(Math.random()*free.length),1)[0];a[ni2]='n';free.sort((x,y)=>x-y);a[free[0]]='r';a[free[1]]='k';a[free[2]]='r';const w=a.join(''),b=w.toUpperCase();return w+'/pppppppp/8/8/8/8/PPPPPPPP/'+b+' w KQkq - 0 1';}
function setupGame(body,creator){const tc=body.timeControl||'10+0'; if(!TIMES[tc])throw Error('invalid_time'); const variant=body.type||'standard';const chess=new Chess();if(variant==='chess960')chess.load(chess960Fen()); const g={id:id('game'),type:variant,initialFen:chess.fen(),mode:body.mode==='unrated'?'unrated':'rated',timeControl:tc,status:'waiting',players:[{id:creator.id,name:creator.name,color:'white'}],chess,moves:[],createdAt:now(),clocks:{white:TIMES[tc],black:TIMES[tc]},lastTick:null,drawOffer:null,winner:null,ratedResultRecorded:false,teamArenaContext:body.teamArenaContext||null,teamArenaResultRecorded:false};games.set(g.id,g);persistGame(g);return g;}
function recordGameResult(g){if(g.ratedResultRecorded||g.mode!=='rated'||g.players.length<2)return;const w=g.players.find(p=>p.color==='white'),b=g.players.find(p=>p.color==='black');if(!w||!b)return;const type=g.type==='chess960'?'chess960':(g.timeControl.startsWith('1+')||g.timeControl.startsWith('2+')?'bullet':g.timeControl.startsWith('3+')||g.timeControl.startsWith('5+')?'blitz':g.timeControl.startsWith('10+')||g.timeControl.startsWith('15+')||g.timeControl.startsWith('20+')?'rapid':'classical');const rw=rating(w.id,type),rb=rating(b.id,type);let sw=0.5,sb=0.5;if(g.winner===w.id){sw=1;sb=0}else if(g.winner===b.id){sw=0;sb=1}const ew=1/(1+Math.pow(10,(rb.rating-rw.rating)/400));const eb=1/(1+Math.pow(10,(rw.rating-rb.rating)/400));rw.rating=Math.round(rw.rating+32*(sw-ew));rb.rating=Math.round(rb.rating+32*(sb-eb));rw.games++;rb.games++;if(sw===1){rw.wins++;rb.losses++}else if(sb===1){rb.wins++;rw.losses++}else{rw.draws++;rb.draws++}g.ratedResultRecorded=true;db.events.push({type:'game',gameId:g.id,white:w.id,black:b.id,winner:g.winner||null,reason:g.reason,createdAt:now()});save();}
function recordTeamArenaGameResult(g){
  if(g.teamArenaResultRecorded||!g.teamArenaContext||g.status!=='finished')return;
  const c=g.teamArenaContext, t=db.tournaments.find(x=>x.id===c.tournamentId);
  if(!t||t.system!=='team_arena'||t.status!=='running')return;
  const ids=new Set((t.teams||[]).map(x=>x.teamId));
  if(!ids.has(c.whiteTeamId)||!ids.has(c.blackTeamId))return;
  const a=t.teams.find(x=>x.teamId===c.whiteTeamId), b=t.teams.find(x=>x.teamId===c.blackTeamId);
  if(!a||!b||!a.members.some(m=>m.userId===c.whiteId)||!b.members.some(m=>m.userId===c.blackId))return;
  const ensure=(entry,userId)=>{entry.playerScores=entry.playerScores||{};return entry.playerScores[userId]||(entry.playerScores[userId]={userId,name:db.users.find(u=>u.id===userId)?.name||userId,points:0,wins:0,draws:0,losses:0,games:0});};
  const wa=ensure(a,c.whiteId), bb=ensure(b,c.blackId); wa.games++;bb.games++;
  if(g.winner===c.whiteId){wa.points+=2;wa.wins++;bb.losses++;}else if(g.winner===c.blackId){bb.points+=2;bb.wins++;wa.losses++;}else{wa.points+=1;bb.points+=1;wa.draws++;bb.draws++;}
  for(const e of [a,b]){e.score=Object.values(e.playerScores||{}).reduce((sum,x)=>sum+(Number(x.points)||0),0);e.wins=Object.values(e.playerScores||{}).reduce((sum,x)=>sum+(x.wins||0),0);e.draws=Object.values(e.playerScores||{}).reduce((sum,x)=>sum+(x.draws||0),0);e.losses=Object.values(e.playerScores||{}).reduce((sum,x)=>sum+(x.losses||0),0);}
  t.results=t.results||[];t.results.push({type:'team_arena_game',gameId:g.id,whiteId:c.whiteId,blackId:c.blackId,whiteTeamId:c.whiteTeamId,blackTeamId:c.blackTeamId,winner:g.winner||null,reason:g.reason,createdAt:now()});
  g.teamArenaResultRecorded=true; audit('team_arena_game_result','system',t.id,{gameId:g.id,whiteTeamId:c.whiteTeamId,blackTeamId:c.blackTeamId}); save();
}
function finishGame(g,reason,winner=null){if(g.status==='finished')return;g.status='finished';g.reason=reason;g.winner=winner;g.endedAt=now();recordGameResult(g);recordTeamArenaGameResult(g);persistGame(g);broadcast(g.id,{type:'game_end',game:gamePublic(g)});}
app.post('/tournaments/:id/team-arena/games',auth,rateLimit(20,60000),(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t||t.system!=='team_arena')return res.status(404).json({error:'team_arena_not_found'});if(t.status!=='running')return res.status(409).json({error:'tournament_not_running'});const team=teamById(req.body.teamId);if(!team||!isTeamMember(team,req.user))return res.status(403).json({error:'team_member_required'});const entry=t.teams.find(x=>x.teamId===team.id);if(!entry)return res.status(409).json({error:'team_not_registered'});if(!entry.members.some(m=>m.userId===req.user))return res.status(403).json({error:'player_not_registered_for_team'});const opponentTeamId=req.body.opponentTeamId||null;if(opponentTeamId&&opponentTeamId===team.id)return res.status(400).json({error:'same_team_opponent'});const g=setupGame({type:req.body.type||'standard',mode:req.body.mode,timeControl:req.body.timeControl||'10+0',teamArenaContext:{tournamentId:t.id,whiteId:req.user,whiteTeamId:team.id,blackId:null,blackTeamId:opponentTeamId}},db.users.find(u=>u.id===req.user));g.tournamentId=t.id;g.teamArena=true;persistGame(g);save();res.status(201).json(gamePublic(g));});
app.post('/games',auth,rateLimit(30,60000),(req,res)=>{try{const g=setupGame(req.body,db.users.find(u=>u.id===req.user));res.status(201).json(gamePublic(g));}catch(e){res.status(400).json({error:e.message});}});
app.get('/games/:id',auth,(req,res)=>{const g=games.get(req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(!canViewGame(g,req.user))return res.status(403).json({error:'game_private'});res.json(gamePublic(g));});
app.post('/games/:id/join',auth,rateLimit(30,60000),(req,res)=>{const g=games.get(req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(g.players.length>=2)return res.status(409).json({error:'full'});const u=db.users.find(x=>x.id===req.user);if(!u)return res.status(401).json({error:'unauthorized'});
  if(g.teamArenaContext){const t=db.tournaments.find(x=>x.id===g.teamArenaContext.tournamentId);const candidates=(t?.teams||[]).filter(e=>e.members.some(m=>m.userId===u.id)&&e.teamId!==g.teamArenaContext.whiteTeamId);const requested=req.body.teamId?candidates.find(e=>e.teamId===req.body.teamId):candidates[0];if(!t||t.system!=='team_arena'||t.status!=='running'||!requested)return res.status(403).json({error:'team_arena_membership_required'});g.teamArenaContext.blackId=u.id;g.teamArenaContext.blackTeamId=requested.teamId;}
  g.players.push({id:u.id,name:u.name,color:'black'});g.status='playing';g.lastTick=Date.now();persistGame(g);broadcast(g.id,{type:'state',game:gamePublic(g)});res.json(gamePublic(g));});
function tick(g){if(g.status!=='playing'||!g.lastTick)return true;const dt=Math.max(0,(Date.now()-g.lastTick)/1000);const side=g.chess.turn()==='w'?'white':'black';g.clocks[side]-=dt;g.lastTick=Date.now();if(g.clocks[side]<=0){g.clocks[side]=0;finishGame(g,'timeout',side==='white'?g.players.find(p=>p.color==='black')?.id:g.players.find(p=>p.color==='white')?.id);return false;}return true;}
app.post('/games/:id/move',auth,rateLimit(120,60000),(req,res)=>{const g=games.get(req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(g.status!=='playing')return res.status(409).json({error:'not_playing'});const p=g.players.find(x=>x.id===req.user);if(!p||p.color!==(g.chess.turn()==='w'?'white':'black'))return res.status(403).json({error:'not_your_turn'});if(!tick(g))return res.status(409).json({error:'timeout'});try{const m=g.chess.move({from:req.body.from,to:req.body.to,promotion:req.body.promotion||'q'});g.moves.push(m.san);const inc=Number((g.timeControl.split('+')[1]||0));g.clocks[p.color]+=inc;g.lastTick=Date.now();if(g.chess.isGameOver()){const reason=g.chess.isCheckmate()?'checkmate':g.chess.isStalemate()?'stalemate':g.chess.isThreefoldRepetition()?'threefold':g.chess.isDraw()?'draw':'game_over';const winner=reason==='checkmate'?p.id:null;finishGame(g,reason,winner);}persistGame(g);broadcast(g.id,{type:'move',move:m,game:gamePublic(g)});res.json({ok:true,game:gamePublic(g)});}catch(e){res.status(400).json({error:'illegal_move'});}});
app.post('/games/:id/draw-offer',auth,rateLimit(10,60000),(req,res)=>{const g=games.get(req.params.id);if(!g||g.status!=='playing')return res.status(409).json({error:'not_playing'});if(!requireGamePlayer(g,req.user))return res.status(403).json({error:'not_player'});g.drawOffer=req.user;persistGame(g);broadcast(g.id,{type:'draw_offer',from:req.user});res.json({ok:true});});
app.post('/games/:id/draw-accept',auth,rateLimit(10,60000),(req,res)=>{const g=games.get(req.params.id);if(!g||!g.drawOffer)return res.status(409).json({error:'no_offer'});if(!requireGamePlayer(g,req.user)||g.drawOffer===req.user)return res.status(403).json({error:'not_opponent'});finishGame(g,'agreement',null);res.json({ok:true,game:gamePublic(g)});});
app.post('/games/:id/resign',auth,rateLimit(10,60000),(req,res)=>{const g=games.get(req.params.id);if(!g||g.status!=='playing')return res.status(409).json({error:'not_playing'});if(!requireGamePlayer(g,req.user))return res.status(403).json({error:'not_player'});finishGame(g,'resignation',g.players.find(p=>p.id!==req.user)?.id||null);res.json({ok:true,game:gamePublic(g)});});
app.get('/games/:id/pgn',auth,(req,res)=>{const g=games.get(req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(!canViewGame(g,req.user))return res.status(403).json({error:'game_private'});res.type('text/plain').send(g.chess.pgn());});
app.get('/games/:id/review',auth,(req,res)=>{const g=games.get(req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(!canViewGame(g,req.user))return res.status(403).json({error:'game_private'});const c=new Chess(g.initialFen||undefined);const material={p:1,n:3,b:3,r:5,q:9,k:0};const score=()=>{let n=0;for(const row of c.board())for(const x of row)if(x)n+=(x.color==='w'?1:-1)*(material[x.type]||0);return n};const moves=[];let prev=score();for(let i=0;i<(g.moves||[]).length;i++){const san=g.moves[i];let m;try{m=c.move(san,{sloppy:true})}catch(_){break}const after=score();const delta=after-prev;const mover=m.color==='w'?'white':'black';const captured=!!m.captured;const check=c.isCheck();let tag='normal';if(captured)tag='capture';if(check)tag='check';if(Math.abs(delta)>=3 && ((mover==='white'&&delta<0)||(mover==='black'&&delta>0)))tag='material_warning';moves.push({ply:i+1,san,mover,tag,captured,check,materialDelta:delta});prev=after;}const warnings=moves.filter(x=>x.tag==='material_warning').slice(0,20);res.json({type:'basic_review',engine:false,note:'هذه مراجعة أساسية مبنية على النقلات والاختلال المادي وليست بديلاً عن محرك شطرنج.',moves,warnings,summary:{plies:moves.length,captures:moves.filter(x=>x.captured).length,checks:moves.filter(x=>x.check).length,warnings:warnings.length,result:g.reason||'unknown'}});});

// Simultaneous play: one host against 2..10 opponents, each opponent has a parallel board.
app.post('/simuls',auth,(req,res)=>{const n=Math.min(10,Math.max(2,Number(req.body.opponents||2)));const host=db.users.find(u=>u.id===req.user);const ids=[];for(let i=0;i<n;i++){const g=setupGame({type:'simul',mode:req.body.mode,timeControl:req.body.timeControl||'5+0'},host);g.simulHost=host.id;ids.push(g.id);}res.status(201).json({type:'simul',opponents:n,gameIds:ids});});

app.post('/blindfold/games',auth,(req,res)=>{const g=setupGame({type:'blindfold',mode:req.body.mode,timeControl:req.body.timeControl||'5+0'},db.users.find(u=>u.id===req.user));res.status(201).json({...gamePublic(g),hidePieces:true});});

function rating(userId,type){let r=db.ratings.find(x=>x.userId===userId&&x.type===type);if(!r){r={userId,type,rating:1200,games:0,wins:0,losses:0,draws:0};db.ratings.push(r);}return r;}
app.get('/players/:id/profile',(req,res)=>{const u=db.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'not_found'});const ev=db.events.filter(e=>e.type==='game'&&(e.white===u.id||e.black===u.id)).slice(-100);const summary=ev.reduce((a,e)=>{a.games++;if(!e.winner)a.draws++;else if(e.winner===u.id)a.wins++;else a.losses++;return a},{games:0,wins:0,draws:0,losses:0});res.json({user:publicUser(u),ratings:RATING_TYPES.map(t=>rating(u.id,t)),games:ev,summary});});
app.get('/players/search',auth,(req,res)=>{const q=String(req.query.q||'').toLowerCase();res.json(db.users.filter(u=>u.username.toLowerCase().includes(q)||u.name.toLowerCase().includes(q)).slice(0,50).map(publicUser));});
app.post('/friends/:id/follow',auth,(req,res)=>{if(req.params.id===req.user)return res.status(400).json({error:'self'});if(!db.friendships.some(f=>f.a===req.user&&f.b===req.params.id))db.friendships.push({a:req.user,b:req.params.id,createdAt:now()});save();res.json({ok:true});});
app.get('/friends',auth,(req,res)=>res.json(db.friendships.filter(f=>f.a===req.user).map(f=>publicUser(db.users.find(u=>u.id===f.b))).filter(Boolean)));
app.post('/messages',auth,(req,res)=>{const m={id:id('msg'),from:req.user,to:req.body.to,text:String(req.body.text||'').slice(0,2000),createdAt:now()};db.messages.push(m);save();res.status(201).json(m);});
app.get('/messages',auth,(req,res)=>res.json(db.messages.filter(m=>m.from===req.user||m.to===req.user).slice(-200)));
app.post('/challenges',auth,rateLimit(30,60000),(req,res)=>{const to=db.users.find(u=>u.id===req.body.to);if(!to||to.id===req.user)return res.status(400).json({error:'invalid_target'});const tc=req.body.timeControl||'10+0';if(!TIMES[tc])return res.status(400).json({error:'invalid_time'});const variant=req.body.variant||'standard';if(!['standard','chess960','blindfold','simul'].includes(variant))return res.status(400).json({error:'invalid_variant'});const c={id:id('challenge'),from:req.user,to:to.id,timeControl:tc,variant,via:'direct',status:'pending',createdAt:now()};db.challenges.push(c);save();res.status(201).json(c);});
app.post('/challenges/link',auth,rateLimit(20,60000),(req,res)=>{const tc=String(req.body.timeControl||'10+0');const variant=String(req.body.variant||'standard');if(!TIMES[tc])return res.status(400).json({error:'invalid_time'});if(!['standard','chess960','blindfold'].includes(variant))return res.status(400).json({error:'invalid_variant'});const c={id:id('challenge'),token:crypto.randomBytes(24).toString('base64url'),from:req.user,to:null,timeControl:tc,variant,via:'link',status:'pending',createdAt:now()};db.challenges.push(c);save();res.status(201).json({id:c.id,token:c.token});});
app.post('/challenges/link/:token/accept',auth,(req,res)=>{const c=db.challenges.find(x=>x.token===req.params.token&&x.via==='link'&&x.status==='pending');if(!c)return res.status(404).json({error:'link_invalid'});if(c.from===req.user)return res.status(400).json({error:'cannot_accept_own_challenge'});const host=db.users.find(u=>u.id===c.from),joiner=db.users.find(u=>u.id===req.user);const g=setupGame({mode:'rated',timeControl:c.timeControl,type:c.variant},host);g.challengeId=c.id;g.players.push({id:joiner.id,name:joiner.name,color:'black'});g.status='playing';g.lastTick=Date.now();c.status='accepted';c.to=req.user;persistGame(g);save();res.json(gamePublic(g));});
app.post('/challenges/:id/accept',auth,(req,res)=>{const c=db.challenges.find(x=>x.id===req.params.id&&x.to===req.user);if(!c)return res.status(404).json({error:'not_found'});c.status='accepted';const host=db.users.find(u=>u.id===c.from);const g=setupGame({mode:'rated',timeControl:c.timeControl,type:c.variant},host);g.challengeId=c.id;g.players.push({id:req.user,name:db.users.find(u=>u.id===req.user).name,color:'black'});g.status='playing';save();res.json(gamePublic(g));});

function khalidPairPlayers(players){
  const active=players.filter(p=>!p.eliminated);
  const pairs=[];
  for(let i=0;i+1<active.length;i+=2)pairs.push({id:id('match'),whiteId:active[i].id,blackId:active[i+1].id,status:'pending',winnerId:null,loserId:null});
  if(active.length%2===1){const bye=active[active.length-1];pairs.push({id:id('match'),whiteId:bye.id,blackId:null,status:'bye',winnerId:bye.id,loserId:null});}
  return pairs;
}
function khalidEnsureRound(t){
  if(t.system!=='khalid')return;
  t.khalid=t.khalid||{rounds:[],currentRound:0,totalMatches:Math.max(0,t.players.length-1)};
  const r=t.khalid.rounds[t.khalid.currentRound-1];
  if(!r)return;
  if(r.matches.every(m=>m.status==='completed'||m.status==='bye')){
    const active=t.players.filter(p=>!p.eliminated);
    if(active.length===1){t.status='finished';t.winnerId=active[0].id;t.finalized=true;t.official=true;return;}
    if(active.length>1){const matches=khalidPairPlayers(t.players);t.khalid.currentRound+=1;t.khalid.rounds.push({number:t.khalid.currentRound,matches});}
  }
}
function teamById(id){return db.teams.find(t=>t.id===id)}
function isTeamMember(t,uid){return t.members.some(m=>m.userId===uid)}
const TEAM_ROLES={captain:{manageMembers:true,manageRoster:true,manageSettings:true,sendMessages:true,createTournaments:true},vice_captain:{manageMembers:true,manageRoster:true,manageSettings:false,sendMessages:true,createTournaments:true},manager:{manageMembers:false,manageRoster:true,manageSettings:false,sendMessages:true,createTournaments:false},player:{manageMembers:false,manageRoster:false,manageSettings:false,sendMessages:false,createTournaments:false},substitute:{manageMembers:false,manageRoster:false,manageSettings:false,sendMessages:false,createTournaments:false}};
const TEAM_BACKGROUNDS=['classic','nile','night','wood','blue','green','gold','marble'];
function teamMember(t,uid){return t?.members?.find(m=>m.userId===uid)}
function teamPermission(t,uid,p){const m=teamMember(t,uid);return !!(m&&TEAM_ROLES[m.role]?.[p])}
function teamPublic(t){return {id:t.id,name:t.name,description:t.description||'',slogan:t.slogan||'',background:t.background||'classic',emblem:t.emblem||'♜',ownerId:t.ownerId,createdAt:t.createdAt,memberCount:t.members.length,members:t.members.map(m=>({userId:m.userId,username:m.username,name:m.name,role:m.role,board:m.board,substitute:!!m.substitute}))}}
app.post('/teams',auth,rateLimit(10,60000),(req,res)=>{const u=db.users.find(x=>x.id===req.user);const name=String(req.body.name||'').trim();if(name.length<2||name.length>60)return res.status(400).json({error:'invalid_team_name'});if(db.teams.some(t=>t.name.toLowerCase()===name.toLowerCase()))return res.status(409).json({error:'team_exists'});const t={id:id('team'),name,description:String(req.body.description||'').slice(0,500),slogan:String(req.body.slogan||'').slice(0,160),background:TEAM_BACKGROUNDS.includes(req.body.background)?req.body.background:'classic',emblem:String(req.body.emblem||'♜').slice(0,4),ownerId:u.id,createdAt:now(),members:[{userId:u.id,username:u.username,name:u.name,role:'captain',board:1,substitute:false}]};db.teams.push(t);audit('team_create',u.id,t.id,{name});notify(u.id,'team_created','تم إنشاء الفريق','أصبحت كابتن الفريق '+t.name,{teamId:t.id});save();res.status(201).json(teamPublic(t));});
app.get('/teams',auth,(req,res)=>res.json(db.teams.filter(t=>isTeamMember(t,req.user)).map(teamPublic)));
app.get('/teams/:id',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!isTeamMember(t,req.user)&&db.users.find(u=>u.id===req.user)?.role!=='admin')return res.status(403).json({error:'team_private'});res.json(teamPublic(t));});
app.get('/teams/:id/permissions',auth,(req,res)=>{const t=teamById(req.params.id);if(!t||!isTeamMember(t,req.user))return res.status(404).json({error:'not_found'});const m=teamMember(t,req.user);res.json({role:m.role,permissions:TEAM_ROLES[m.role]||{}});});
app.post('/teams/:id/transfer-captain',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(t.ownerId!==req.user)return res.status(403).json({error:'captain_required'});const m=teamMember(t,req.body.userId);if(!m)return res.status(404).json({error:'member_not_found'});const old=teamMember(t,req.user);old.role='vice_captain';m.role='captain';t.ownerId=m.userId;audit('team_transfer_captain',req.user,t.id,{newCaptain:m.userId});notify(m.userId,'team_captain','أصبحت كابتن الفريق','تم نقل قيادة فريق '+t.name+' إليك',{teamId:t.id});save();res.json(teamPublic(t));});
app.delete('/teams/:id',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(t.ownerId!==req.user&&db.users.find(u=>u.id===req.user)?.role!=='admin')return res.status(403).json({error:'captain_required'});if(db.tournaments.some(x=>x.ownerTeamId===t.id&&x.status==='running'))return res.status(409).json({error:'team_has_running_tournament'});db.teams=db.teams.filter(x=>x.id!==t.id);db.teamInvites=db.teamInvites.filter(x=>x.teamId!==t.id);db.messages=db.messages.filter(x=>x.teamId!==t.id);audit('team_delete',req.user,t.id);save();res.json({ok:true});});
app.put('/teams/:id/settings',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'manageSettings')&&db.users.find(u=>u.id===req.user)?.role!=='admin')return res.status(403).json({error:'team_settings_forbidden'});if(req.body.name!==undefined){const n=String(req.body.name).trim();if(n.length<2||n.length>60)return res.status(400).json({error:'invalid_team_name'});if(db.teams.some(x=>x.id!==t.id&&x.name.toLowerCase()===n.toLowerCase()))return res.status(409).json({error:'team_exists'});t.name=n}if(req.body.description!==undefined)t.description=String(req.body.description).slice(0,500);if(req.body.slogan!==undefined)t.slogan=String(req.body.slogan).slice(0,160);if(req.body.emblem!==undefined)t.emblem=String(req.body.emblem).slice(0,4);if(req.body.background!==undefined){if(!TEAM_BACKGROUNDS.includes(req.body.background))return res.status(400).json({error:'invalid_background'});t.background=req.body.background}audit('team_settings_update',req.user,t.id,{background:t.background});save();res.json(teamPublic(t));});
app.post('/teams/:id/invite',auth,rateLimit(30,60000),(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'manageMembers'))return res.status(403).json({error:'captain_required'});const to=db.users.find(u=>u.id===req.body.userId);if(!to)return res.status(404).json({error:'user_not_found'});if(isTeamMember(t,to.id))return res.status(409).json({error:'already_member'});if(t.members.length>=20)return res.status(409).json({error:'team_full'});if(db.teamInvites.some(i=>i.teamId===t.id&&i.to===to.id&&i.status==='pending'))return res.status(409).json({error:'invite_exists'});const inv={id:id('teaminvite'),teamId:t.id,to:to.id,from:req.user,status:'pending',createdAt:now()};db.teamInvites.push(inv);notify(to.id,'team_invite','دعوة للانضمام إلى فريق','تمت دعوتك إلى فريق '+t.name,{teamId:t.id,inviteId:inv.id});save();res.status(201).json(inv);});
app.get('/teams/invites',auth,(req,res)=>res.json(db.teamInvites.filter(i=>i.to===req.user&&i.status==='pending').map(i=>({...i,team:teamPublic(teamById(i.teamId))}))));
app.post('/teams/invites/:id/accept',auth,(req,res)=>{const inv=db.teamInvites.find(i=>i.id===req.params.id&&i.to===req.user&&i.status==='pending');if(!inv)return res.status(404).json({error:'invite_not_found'});const t=teamById(inv.teamId);if(!t)return res.status(404).json({error:'team_not_found'});if(t.members.length>=20)return res.status(409).json({error:'team_full'});if(isTeamMember(t,req.user))return res.status(409).json({error:'already_member'});const u=db.users.find(x=>x.id===req.user);t.members.push({userId:req.user,username:u.username,name:u.name,role:'player',board:null,substitute:true});inv.status='accepted';audit('team_join',req.user,t.id);notify(t.ownerId,'team_member_joined','عضو جديد','انضم '+u.name+' إلى فريقك',{teamId:t.id,userId:req.user});save();res.json(teamPublic(t));});
app.post('/teams/invites/:id/reject',auth,(req,res)=>{const inv=db.teamInvites.find(i=>i.id===req.params.id&&i.to===req.user&&i.status==='pending');if(!inv)return res.status(404).json({error:'invite_not_found'});inv.status='rejected';save();res.json({ok:true});});
app.delete('/teams/:id/members/:userId',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'manageMembers')&&db.users.find(u=>u.id===req.user)?.role!=='admin')return res.status(403).json({error:'captain_required'});if(req.params.userId===t.ownerId)return res.status(400).json({error:'cannot_remove_captain'});t.members=t.members.filter(m=>m.userId!==req.params.userId);save();res.json(teamPublic(t));});
app.put('/teams/:id/members/:userId/role',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'manageMembers'))return res.status(403).json({error:'captain_required'});const m=teamMember(t,req.params.userId);if(!m)return res.status(404).json({error:'member_not_found'});const role=String(req.body.role||'player');if(!TEAM_ROLES[role]||role==='captain'||m.userId===t.ownerId)return res.status(400).json({error:'invalid_role'});m.role=role;notify(m.userId,'team_role','صلاحية الفريق','تم تغيير دورك في فريق '+t.name,{teamId:t.id,role});audit('team_role_change',req.user,t.id,{userId:m.userId,role});save();res.json(teamPublic(t));});
app.put('/teams/:id/boards',auth,(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'manageRoster'))return res.status(403).json({error:'roster_forbidden'});const used=new Set();for(const m of t.members){const b=Number(req.body.boards?.[m.userId]||0);m.board=(b>=1&&b<=4&&!used.has(b))?b:null;if(m.board)used.add(m.board);m.substitute=!m.board}if(used.size<4)return res.status(400).json({error:'four_boards_required'});audit('team_roster_update',req.user,t.id);save();res.json(teamPublic(t));});
app.post('/teams/:id/messages',auth,rateLimit(30,60000),(req,res)=>{const t=teamById(req.params.id);if(!t||!isTeamMember(t,req.user))return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'sendMessages'))return res.status(403).json({error:'message_forbidden'});const text=String(req.body.text||'').trim().slice(0,2000);if(!text)return res.status(400).json({error:'empty_message'});const m={id:id('teammsg'),teamId:t.id,from:req.user,text,createdAt:now()};db.messages.push(m);for(const member of t.members)if(member.userId!==req.user)notify(member.userId,'team_message','رسالة من '+t.name,text,{teamId:t.id,messageId:m.id});audit('team_message',req.user,t.id);save();res.status(201).json(m);});
app.get('/teams/:id/messages',auth,(req,res)=>{const t=teamById(req.params.id);if(!t||!isTeamMember(t,req.user))return res.status(404).json({error:'not_found'});res.json(db.messages.filter(m=>m.teamId===t.id).slice(-200));});
app.post('/teams/:id/tournaments',auth,rateLimit(10,60000),(req,res)=>{const t=teamById(req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(!teamPermission(t,req.user,'createTournaments'))return res.status(403).json({error:'tournament_create_forbidden'});const system=String(req.body.system||'team_arena').toLowerCase();if(!['team_arena','team_4x4','teams'].includes(system))return res.status(400).json({error:'team_system_only'});if(system!=='team_arena'&&!teamValidateRoster(t))return res.status(400).json({error:'roster_must_have_four_boards'});const seq=db.tournaments.length+1;const tour={id:id('tournament'),code:`TEAM-${new Date().getUTCFullYear()}-${String(seq).padStart(4,'0')}`,name:String(req.body.name||t.name+' Tournament').slice(0,120),system,rated:false,rounds:Math.max(1,Math.min(100,Number(req.body.rounds||5))),status:'registration',players:[],teams:[],results:[],createdAt:now(),restartAt:null,ownerId:req.user,ownerTeamId:t.id,ownerType:'team',official:false,finalized:false,teamArenaMinutes:Math.max(1,Math.min(60,Number(req.body.arenaMinutes||10)))};db.tournaments.push(tour);audit('team_tournament_create',req.user,t.id,{tournamentId:tour.id,system});for(const m of t.members)notify(m.userId,'team_tournament','بطولة جديدة من '+t.name,tour.name,{tournamentId:tour.id,teamId:t.id});save();res.status(201).json(tour);});
function teamRegistration(tour,team){if(tour.teams.some(x=>x.teamId===team.id))return false;if(tour.system!=='team_arena'&&team.members.filter(m=>m.board).length!==4)return false;tour.teams.push({teamId:team.id,name:team.name,members:team.members.map(m=>({...m})),score:0,wins:0,draws:0,losses:0,playerScores:{}});return true;}
function teamArenaJoin(tour,team,user){if(tour.system!=='team_arena')return false;const entry=tour.teams.find(x=>x.teamId===team.id);if(!entry)return false;entry.playerScores=entry.playerScores||{};if(!entry.playerScores[user.id])entry.playerScores[user.id]={userId:user.id,name:user.name,points:0,wins:0,draws:0,losses:0,games:0};return true;}
function teamArenaAddResult(tour,teamId,userId,result){const entry=(tour.teams||[]).find(x=>x.teamId===teamId);if(!entry)throw Error('team_not_registered');entry.playerScores=entry.playerScores||{};const u=db.users.find(x=>x.id===userId);if(!u||!entry.members.some(m=>m.userId===userId))throw Error('team_member_required');const p=entry.playerScores[userId]||(entry.playerScores[userId]={userId,name:u.name,points:0,wins:0,draws:0,losses:0,games:0});p.games++;if(result==='win'){p.points+=2;p.wins++;}else if(result==='draw'){p.points+=1;p.draws++;}else if(result==='loss'){p.losses++;}else throw Error('invalid_result');entry.score=Object.values(entry.playerScores).reduce((a,x)=>a+(x.points||0),0);entry.wins=Object.values(entry.playerScores).reduce((a,x)=>a+(x.wins||0),0);entry.draws=Object.values(entry.playerScores).reduce((a,x)=>a+(x.draws||0),0);entry.losses=Object.values(entry.playerScores).reduce((a,x)=>a+(x.losses||0),0);}
function teamValidateRoster(team){const boards=team.members.filter(m=>m.board).map(m=>m.board);return new Set(boards).size===4&&boards.length===4}
function buildTeamRounds(t){const ids=(t.teams||[]).map(x=>x.teamId);if(ids.length<2)throw Error('not_enough_teams');if(t.system==='team_arena'){t.teamRounds=[];t.currentTeamRound=0;t.arena={openEntry:true,unlimitedPlayers:true,scoring:'all_player_points',standings:(t.teams||[]).map(x=>({teamId:x.teamId,name:x.name,score:0}))};return;}let arr=ids.slice();if(arr.length%2)arr.push(null);const n=arr.length,roundCount=t.system==='team_arena'?Math.min(Math.max(1,Number(t.rounds||5)),n-1):n-1,rounds=[];for(let r=0;r<roundCount;r++){const matches=[];for(let i=0;i<n/2;i++){const a=arr[i],b=arr[n-1-i];if(a&&b)matches.push({id:id('tmatch'),teamA:a,teamB:b,status:'pending',boardResults:[],winnerTeamId:null,round:r+1});else if(a||b)matches.push({id:id('tmatch'),teamA:a||b,teamB:null,status:'bye',boardResults:[],winnerTeamId:a||b,round:r+1});}rounds.push({number:r+1,matches});arr=[arr[0],arr[n-1],...arr.slice(1,n-1)];}t.teamRounds=rounds;t.currentTeamRound=1;t.arena=t.system==='team_arena'?{maxTeams:60,minutes:Number(t.teamArenaMinutes||10),rounds:roundCount}:null;}
app.post('/tournaments/:id/team-register',auth,(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);const team=teamById(req.body.teamId);if(!t||!team)return res.status(404).json({error:'not_found'});if(t.status!=='registration')return res.status(409).json({error:'registration_closed'});if(!teamPermission(team,req.user,'createTournaments'))return res.status(403).json({error:'team_tournament_permission_required'});if(!['teams','team_arena','team_4x4'].includes(t.system))return res.status(400).json({error:'not_team_tournament'});if(t.system!=='team_arena'&&!teamValidateRoster(team))return res.status(400).json({error:'roster_must_have_four_boards'});if((t.teams||[]).some(x=>x.members.some(m=>m.userId===req.user)))return res.status(409).json({error:'player_already_in_event_team'});if(!teamRegistration(t,team))return res.status(409).json({error:'already_registered'});save();res.json(t);});
app.post('/tournaments/:id/team-arena/join',auth,rateLimit(20,60000),(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t||t.system!=='team_arena')return res.status(404).json({error:'team_arena_not_found'});if(t.status!=='registration'&&t.status!=='running')return res.status(409).json({error:'registration_closed'});const team=teamById(req.body.teamId);if(!team||!isTeamMember(team,req.user))return res.status(403).json({error:'team_member_required'});if(!t.teams.some(x=>x.teamId===team.id))return res.status(409).json({error:'team_not_registered'});if(!teamArenaJoin(t,team,db.users.find(x=>x.id===req.user)))return res.status(409).json({error:'cannot_join'});save();res.json(t);});
app.post('/tournaments/:id/team-arena/player-result',auth,(req,res)=>res.status(410).json({error:'manual_scoring_disabled',message:'نتائج أرينا الفرق تُحتسب تلقائيًا من المباريات المنتهية.'}));
app.post('/tournaments/:id/team-result',auth,(req,res)=>{const actor=db.users.find(u=>u.id===req.user);const pre=db.tournaments.find(x=>x.id===req.params.id);if(!pre)return res.status(404).json({error:'not_found'});const ot=pre.ownerTeamId?teamById(pre.ownerTeamId):null;if(!['organizer','admin'].includes(actor?.role)&&!(ot&&teamPermission(ot,req.user,'createTournaments')))return res.status(403).json({error:'team_tournament_manager_required'});req.organizer=actor||{};const t=db.tournaments.find(x=>x.id===req.params.id);if(!t||!['teams','team_arena','team_4x4'].includes(t.system))return res.status(404).json({error:'not_team_tournament'});if(t.ownerId!==req.user&&req.organizer.role!=='admin')return res.status(403).json({error:'not_owner'});const round=(t.teamRounds||[]).find(r=>r.matches.some(m=>m.id===req.body.matchId));if(!round||round.number!==(t.currentTeamRound||1))return res.status(409).json({error:'round_not_current'});const m=round?.matches.find(x=>x.id===req.body.matchId);if(!m||m.status!=='pending')return res.status(409).json({error:'match_not_pending'});
if(!m.teamB)return res.status(400).json({error:'bye_match'});const a=t.teams.find(x=>x.teamId===m.teamA),b=t.teams.find(x=>x.teamId===m.teamB);if(!a||!b)return res.status(409).json({error:'teams_not_found'});const br=Array.isArray(req.body.boardResults)?req.body.boardResults:[];if(br.length!==4)return res.status(400).json({error:'four_board_results_required'});let ap=0,bp=0;for(const r of br){if(!['A','B','D'].includes(r.result))return res.status(400).json({error:'invalid_board_result'});if(r.result==='A')ap++;else if(r.result==='B')bp++;else {ap+=.5;bp+=.5;}}m.boardResults=br;m.boardPoints={teamA:ap,teamB:bp};m.status='completed';m.winnerTeamId=ap>bp?a.teamId:bp>ap?b.teamId:null;for(const x of [a,b]){const own=x.teamId===a.teamId?ap:bp;const matchPts=m.winnerTeamId===null?1:(m.winnerTeamId===x.teamId?2:0);x.boardPoints=(x.boardPoints||0)+own;x.score=(x.score||0)+matchPts;x.wins+=(m.winnerTeamId===x.teamId?1:0);x.losses+=(m.winnerTeamId&&m.winnerTeamId!==x.teamId?1:0);x.draws+=(!m.winnerTeamId?1:0);}if(round.matches.every(x=>x.status==='completed'||x.status==='bye')){if(t.currentTeamRound<(t.teamRounds||[]).length)t.currentTeamRound++;else{t.status='finished';t.finalized=true;t.official=true;}}save();res.json(t);});
app.get('/tournaments/:id/team-rounds',auth,(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});const teams=[...(t.teams||[])].sort((a,b)=>(b.score||0)-(a.score||0)||(b.wins||0)-(a.wins||0));res.json({rounds:t.teamRounds||[],teams});});
app.get('/tournaments/:id/team-arena/standings',(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t||t.system!=='team_arena')return res.status(404).json({error:'team_arena_not_found'});const teams=(t.teams||[]).map(e=>({...e,score:Number(e.score||0),playerScores:Object.values(e.playerScores||{}).sort((a,b)=>(b.points||0)-(a.points||0))})).sort((a,b)=>b.score-a.score||b.wins-a.wins||b.draws-a.draws);res.json({tournamentId:t.id,status:t.status,teams});});
app.post('/tournaments',auth,requireOrganizer,(req,res)=>{
  const system=String(req.body.system||'swiss').toLowerCase();
  const allowed=[...SYSTEMS,'team_arena','team_4x4'];
  if(!allowed.includes(system))return res.status(400).json({error:'invalid_system',systems:allowed});
  const seq=db.tournaments.length+1;
  const code=`WNC-${new Date().getUTCFullYear()}-${String(seq).padStart(4,'0')}`;
  const t={id:id('tournament'),code,name:String(req.body.name||'White Nile Online').slice(0,120),system,rated:!!req.body.rated,rounds:system==='khalid'?null:Math.max(1,Math.min(100,Number(req.body.rounds||7))),status:'registration',players:[],teams:[],results:[],createdAt:now(),restartAt:null,ownerId:req.user,official:false,finalized:false};
  db.tournaments.push(t);audit('tournament_create',req.user,t.id,{code,system});save();res.status(201).json(t);
});
app.get('/tournaments',(req,res)=>res.json(db.tournaments));
app.get('/tournaments/:id',(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});res.json(t);});
app.post('/tournaments/:id/register',auth,(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(t.status!=='registration'||t.finalized)return res.status(409).json({error:'registration_closed'});const u=db.users.find(x=>x.id===req.user);if(!u)return res.status(401).json({error:'unauthorized'});if(!t.players.some(x=>x.id===req.user))t.players.push({id:u.id,name:u.name,rating:Number(req.body.rating||1200),score:0,eliminated:false,eliminationOrder:null});save();res.json(t);});
app.post('/tournaments/:id/start',auth,(req,res)=>{
  const actor=db.users.find(u=>u.id===req.user);const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});const ownerTeam=t.ownerTeamId?teamById(t.ownerTeamId):null;const canStart=actor&&['organizer','admin'].includes(actor.role)&&t.ownerId===req.user || (ownerTeam&&teamPermission(ownerTeam,req.user,'createTournaments'));if(!canStart)return res.status(403).json({error:'not_owner'});if(t.status!=='registration')return res.status(409).json({error:'already_started'});
  const isTeamEvent=['teams','team_arena','team_4x4'].includes(t.system);
  if(!isTeamEvent&&t.players.length<2)return res.status(400).json({error:'not_enough_players'});
  if(isTeamEvent&&t.system!=='team_arena'&&t.teams.length<2)return res.status(400).json({error:'not_enough_teams'});if(t.system==='team_arena'&&t.teams.length<2)return res.status(400).json({error:'not_enough_teams'});
  t.status='running';t.startedAt=now();
  if(isTeamEvent){if(t.system==='team_4x4'&&t.teams.some(x=>!teamValidateRoster(teamById(x.teamId))))return res.status(400).json({error:'invalid_team_roster'});buildTeamRounds(t);if(t.system!=='team_arena')t.currentTeamRound=1;}
  if(t.system==='khalid'){
    t.players.forEach(p=>{p.eliminated=false;p.eliminationOrder=null;p.score=0;p.cheat=false;});
    t.khalid={rounds:[{number:1,matches:khalidPairPlayers(t.players)}],currentRound:1,totalMatches:t.players.length-1};
    // A bye advances automatically and is not a game/match.
    t.khalid.rounds[0].matches.filter(m=>m.status==='bye').forEach(m=>{const p=t.players.find(x=>x.id===m.winnerId);if(p)p.byeCount=(p.byeCount||0)+1;});
  }
  save();res.json(t);
});
app.get('/tournaments/:id/current-round',(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(t.system!=='khalid')return res.status(400).json({error:'not_khalid'});res.json(t.khalid||{rounds:[]});});
app.post('/tournaments/:id/result',auth,requireOrganizer,(req,res)=>{
  const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(t.ownerId!==req.user&&req.organizer.role!=='admin')return res.status(403).json({error:'not_owner'});if(t.finalized)return res.status(409).json({error:'official_result_locked'});
  const {winnerId,loserId,cheated,matchId}=req.body||{};const w=t.players.find(p=>p.id===winnerId),l=t.players.find(p=>p.id===loserId);
  if(t.system==='khalid'){
    if(t.status!=='running')return res.status(409).json({error:'tournament_not_running'});
    const round=t.khalid?.rounds?.[t.khalid.currentRound-1];if(!round)return res.status(409).json({error:'no_current_round'});
    const m=round.matches.find(x=>x.id===matchId)||round.matches.find(x=>x.status==='pending'&&((x.whiteId===winnerId&&x.blackId===loserId)||(x.whiteId===loserId&&x.blackId===winnerId)));
    if(!m)return res.status(409).json({error:'match_not_pending'});if(m.status!=='pending')return res.status(409).json({error:'match_already_completed'});
    if(!w||!l||m.whiteId===null||!([m.whiteId,m.blackId].includes(winnerId)&&[m.whiteId,m.blackId].includes(loserId)))return res.status(400).json({error:'invalid_match_players'});
    m.status='completed';m.winnerId=winnerId;m.loserId=loserId;m.cheated=!!cheated;
    if(cheated){l.eliminated=true;l.cheat=true;t.status='cancelled';t.restartAt=new Date(Date.now()+86400000).toISOString();t.restartReason='confirmed_cheating';t.results.push({matchId:m.id,winnerId,loserId,cheated:true,correctedWinnerId:loserId,createdAt:now()});}
    else {l.eliminated=true;l.eliminationOrder=t.players.filter(p=>p.eliminationOrder).length+1;w.score=(w.score||0)+1;t.results.push({matchId:m.id,winnerId,loserId,cheated:false,round:round.number,createdAt:now()});khalidEnsureRound(t);}
    save();return res.json(t);
  }
  if(!w||!l)return res.status(400).json({error:'players_not_found'});
  if(cheated){l.eliminated=true;l.cheat=true;if(t.system==='khalid'){t.status='cancelled';t.restartAt=new Date(Date.now()+86400000).toISOString();t.restartReason='confirmed_cheating';}t.results.push({winnerId,loserId,cheated:true,correctedWinnerId:loserId,createdAt:now()});}
  else{w.score=(w.score||0)+1;t.results.push({winnerId,loserId,cheated:false,createdAt:now()});}
  save();res.json(t);
});
function arenaStandings(t){const ps=t.players.map(p=>({...p,wins:p.wins||0,draws:p.draws||0,losses:p.losses||0,points:p.score||0}));const pct=p=>{const played=p.wins+p.draws+p.losses;return played?((p.wins*2+p.draws)/(played*2)):0;};return ps.sort((a,b)=>b.points-a.points||b.wins-a.wins||((b.headToHead||0)-(a.headToHead||0))||pct(b)-pct(a)||((a.fastestWinSeconds??1e12)-(b.fastestWinSeconds??1e12)));}
app.get('/tournaments/:id/standings',(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});let ps=[...t.players];if(t.system==='khalid')ps.sort((a,b)=>{if(a.eliminated!==b.eliminated)return a.eliminated?1:-1;if(a.eliminationOrder&&b.eliminationOrder)return b.eliminationOrder-a.eliminationOrder;return b.score-a.score||b.rating-a.rating;});else if(t.system==='arena')ps=arenaStandings(t);else ps.sort((a,b)=>b.score-a.score||b.rating-a.rating);res.json({tournament:t,standings:ps});});

app.get('/notifications',auth,(req,res)=>res.json(db.notifications.filter(n=>n.userId===req.user).slice(-100)));
app.post('/notifications/:id/read',auth,(req,res)=>{const n=db.notifications.find(x=>x.id===req.params.id&&x.userId===req.user);if(!n)return res.status(404).json({error:'not_found'});n.read=true;save();res.json(n);});
app.get('/privacy',auth,(req,res)=>{let p=db.privacy.find(x=>x.userId===req.user);if(!p){p={userId:req.user,messages:'friends',challenges:'everyone',games:'friends',profile:'everyone'};db.privacy.push(p);save();}res.json(p);});
app.put('/privacy',auth,(req,res)=>{let p=db.privacy.find(x=>x.userId===req.user);if(!p){p={userId:req.user};db.privacy.push(p);}for(const k of ['messages','challenges','games','profile'])if(req.body[k])p[k]=req.body[k];audit('privacy_update',req.user,req.user,p);save();res.json(p);});
app.get('/sessions',auth,(req,res)=>{const u=db.users.find(x=>x.id===req.user);const current=req.sessionHash;res.json((u.devices||[]).map(d=>({id:d.id,userAgent:d.userAgent,createdAt:d.createdAt,expiresAt:d.expiresAt,current:d.tokenHash===current})));});
app.delete('/sessions/:id',auth,(req,res)=>{const u=db.users.find(x=>x.id===req.user);const d=(u.devices||[]).find(x=>x.id===req.params.id);if(!d)return res.status(404).json({error:'not_found'});revokeTokenHash(d.tokenHash);u.devices=u.devices.filter(x=>x.id!==d.id);audit('session_revoke',req.user,req.user,{deviceId:d.id});save();res.json({ok:true});});
app.post('/sessions/revoke-all',auth,(req,res)=>{const u=db.users.find(x=>x.id===req.user);for(const d of (u.devices||[]))revokeTokenHash(d.tokenHash);u.devices=[];audit('sessions_revoke_all',req.user,req.user);save();res.json({ok:true});});
app.post('/tournaments/:id/finalize',auth,(req,res)=>{const actor=db.users.find(u=>u.id===req.user);const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});const ot=t.ownerTeamId?teamById(t.ownerTeamId):null;const canFinalize=actor&&['organizer','admin'].includes(actor.role)&&t.ownerId===req.user || (ot&&teamPermission(ot,req.user,'createTournaments'));if(!canFinalize)return res.status(403).json({error:'not_owner'});t.finalized=true;t.official=true;t.status='finished';audit('tournament_finalize',req.user,t.id);save();res.json(t);});
app.post('/tournaments/:id/correct-result',auth,requireOrganizer,(req,res)=>{const t=db.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'not_found'});if(t.finalized && req.organizer.role!=='admin')return res.status(409).json({error:'official_result_locked'});t.corrections=t.corrections||[];t.corrections.push({by:req.user,reason:String(req.body.reason||'').slice(0,500),payload:req.body.result||{},createdAt:now()});audit('tournament_result_correction',req.user,t.id,{reason:req.body.reason||''});save();res.json(t);});
app.get('/audit/:targetId',auth,requireOrganizer,(req,res)=>res.json(db.audit.filter(a=>a.targetId===req.params.targetId)));
app.post('/appeals',auth,(req,res)=>{const a={id:id('appeal'),reportId:req.body.reportId,from:req.user,reason:String(req.body.reason||'').slice(0,2000),status:'review',createdAt:now()};db.appeals.push(a);audit('appeal_create',req.user,a.id);save();res.status(201).json(a);});
app.post('/maintenance',auth,rateLimit(5,60000),requireAdmin,(req,res)=>{db.maintenance=!!req.body.enabled;audit('maintenance',req.user,null,{enabled:db.maintenance});save();res.json({maintenance:db.maintenance});});
app.get('/backup',auth,requireAdmin,(req,res)=>{audit('backup_export',req.user,null);save();
 const safe=JSON.parse(JSON.stringify(db)); safe.users=safe.users.map(u=>{const x={...u};delete x.pass;delete x.devices;return x;}); safe.sessions='excluded'; safe.generatedAt=now();
 res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition','attachment; filename=white-nile-backup-safe.json');res.send(JSON.stringify(safe,null,2));
});
app.post('/reports',auth,(req,res)=>{const r={id:id('report'),gameId:req.body.gameId,reporterId:req.user,reportedId:req.body.reportedId,type:req.body.type||'fair_play',details:req.body.details||'',status:'review',createdAt:now()};db.reports.push(r);save();res.status(201).json(r);});
app.post('/fairplay/:reportId/confirm',auth,requireOrganizer,(req,res)=>{const r=db.reports.find(x=>x.id===req.params.reportId);if(!r)return res.status(404).json({error:'not_found'});r.status='confirmed';const u=db.users.find(x=>x.id===r.reportedId);if(u){if(!db.bans.some(b=>b.email===u.email))db.bans.push({email:u.email,reason:'confirmed_cheating',createdAt:now()}); for(const d of (u.devices||[]))revokeTokenHash(d.tokenHash); u.devices=[]; u.banned=true;notify(r.reporterId,'fair_play','تم تأكيد البلاغ','تمت مراجعة البلاغ واتخاذ الإجراء المناسب.',{reportId:r.id});audit('fairplay_confirm',req.user,r.reportedId,{reportId:r.id});}const game=games.get(r.gameId)||db.games.find(e=>e.id===r.gameId);if(game){game.corrected=true;const opponent=game.players?.find(p=>p.id!==r.reportedId);game.winner=opponent?.id||null;if(game.status!=='finished'){game.status='finished';game.endedAt=now();game.reason='confirmed_cheating';}persistGame(game);}save();res.json({ok:true,report:r});});


// Daily training puzzles: lightweight, deterministic and stored server-side.
const DAILY_PUZZLES=[
 {id:'mate-01',title:'كش مات في نقلة واحدة',level:1,theme:'Mate in 1',fen:'7k/5Q2/7K/8/8/8/8/8 w - - 0 1',from:'f7',to:'f8',solution:'Qf8#',explanation:'الوزير إلى f8 يحاصر الملك h8، والملك الأبيض يحمي h7.'},
 {id:'mate-02',title:'مات في الزاوية',level:1,theme:'Mate in 1',fen:'7k/4Q3/6K1/8/8/8/8/8 w - - 0 1',from:'e7',to:'g7',solution:'Qg7#',explanation:'الوزير إلى g7 يعطي كش مات؛ الملك الأبيض يحمي الوزير ويغطي h7.'},
 {id:'mate-03',title:'شبكة الملك',level:1,theme:'Mate in 1',fen:'7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',from:'f7',to:'g7',solution:'Qg7#',explanation:'الوزير على g7 يضع الملك g8 في كش مات، والملك الأبيض يحمي g7.'},
 {id:'mate-04',title:'الوزير والملك',level:1,theme:'Mate in 1',fen:'7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',from:'f7',to:'f8',solution:'Qf8#',explanation:'الوزير يغلق خط الهروب، والملك الأبيض يغطي g7 وh7.'},
 {id:'mate-05',title:'مات على الحافة',level:1,theme:'Mate in 1',fen:'7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',from:'f7',to:'g7',solution:'Qg7#',explanation:'الوزير إلى g7 يعطي كش مات ويحصل على حماية الملك الأبيض.'},
 {id:'mate-06',title:'أوقف الهروب',level:1,theme:'Mate in 1',fen:'7k/5Q2/7K/8/8/8/8/8 w - - 0 1',from:'f7',to:'f8',solution:'Qf8#',explanation:'الوزير إلى f8 يغلق مربعات الهروب، والملك الأبيض يغطي h7 وg7.'},
 {id:'mate-07',title:'الخاتمة البسيطة',level:1,theme:'Mate in 1',fen:'k7/4Q3/2K5/8/8/8/8/8 w - - 0 1',from:'e7',to:'b7',solution:'Qb7#',explanation:'الوزير إلى b7 يعطي كش مات؛ الملك الأبيض يحمي b7 والوزير يغطي مربعات الهروب.'}
];
function dailyPuzzle(){const day=Math.floor(Date.now()/86400000);return DAILY_PUZZLES[day%DAILY_PUZZLES.length];}
function puzzlePublic(p){return {id:p.id,title:p.title,level:p.level,theme:p.theme,fen:p.fen};}
app.get('/training/daily-puzzle',(req,res)=>res.json({date:new Date().toISOString().slice(0,10),puzzle:puzzlePublic(dailyPuzzle()),total:DAILY_PUZZLES.length}));
app.get('/training/puzzles',(req,res)=>res.json({puzzles:DAILY_PUZZLES.map(puzzlePublic)}));
app.post('/training/puzzles/:id/solve',auth,rateLimit(60,60000),(req,res)=>{
  const p=DAILY_PUZZLES.find(x=>x.id===req.params.id);
  if(!p)return res.status(404).json({error:'puzzle_not_found'});
  const from=String(req.body?.from||'').toLowerCase(),to=String(req.body?.to||'').toLowerCase();
  let correct=false;
  try{
    const chess=new Chess(p.fen);
    const move=chess.move({from,to,promotion:String(req.body?.promotion||'q').toLowerCase()});
    correct=!!move && move.san===p.solution && (p.theme!=='Mate in 1'||chess.isCheckmate());
  }catch(_){correct=false;}
  db.puzzleStats=db.puzzleStats||[];
  let st=db.puzzleStats.find(x=>x.userId===req.user&&x.puzzleId===p.id);
  if(!st){st={userId:req.user,puzzleId:p.id,attempts:0,solved:false,createdAt:now()};db.puzzleStats.push(st);}
  st.attempts++;
  if(correct&&!st.solved){st.solved=true;st.solvedAt=now();}
  st.lastAttemptAt=now();
  audit('puzzle_attempt',req.user,p.id,{correct});save();
  res.json({correct,solution:correct?p.solution:null,explanation:correct?p.explanation:'حاول مرة أخرى: ابحث عن كش مات أو أفضل نقلة قبل كشف الحل.',attempts:st.attempts});
});
app.get('/training/my-stats',auth,(req,res)=>{
  const rows=(db.puzzleStats||[]).filter(x=>x.userId===req.user);
  const solvedDates=new Set(rows.filter(x=>x.solved&&x.solvedAt).map(x=>new Date(x.solvedAt).toISOString().slice(0,10)));
  let streak=0;const day=new Date();day.setUTCHours(0,0,0,0);
  // A streak may include today or yesterday, then counts consecutive UTC days.
  if(!solvedDates.has(day.toISOString().slice(0,10)))day.setUTCDate(day.getUTCDate()-1);
  while(solvedDates.has(day.toISOString().slice(0,10))){streak++;day.setUTCDate(day.getUTCDate()-1);}
  res.json({solved:rows.filter(x=>x.solved).length,attempts:rows.reduce((n,x)=>n+x.attempts,0),streak});
});

app.get('/version',(req,res)=>res.json({version:'3.7.1',platform:'Dowaim Chess',academy:'White Nile Chess Academy',owner:'Khalid Ahmed Mostafa Yousif',release:'security-hardened'}));
const wsTickets=new Map();
app.post('/ws-ticket',auth,rateLimit(20,60000),async(req,res)=>{const gameId=String(req.body?.gameId||'');const g=games.get(gameId);if(!g)return res.status(404).json({error:'not_found'});if(!canViewGame(g,req.user))return res.status(403).json({error:'game_private'});const ticket=crypto.randomBytes(24).toString('base64url');const ttl=60000;wsTickets.set(ticket,{userId:req.user,gameId,expiresAt:Date.now()+ttl});if(redis)await redis.set(`wst:${ticket}`,JSON.stringify({userId:req.user,gameId}), 'PX',ttl);res.json({ticket,expiresIn:ttl});});
setInterval(()=>{const t=Date.now();for(const [k,v] of wsTickets)if(v.expiresAt<=t)wsTickets.delete(k)},30000);
const server=http.createServer(app);const wss=new WebSocketServer({server,path:'/ws'});
const wsCounts=new Map();
wss.on('connection',async(ws,req)=>{const url=new URL(req.url,'http://localhost');const gameId=url.searchParams.get('gameId');const ticket=url.searchParams.get('ticket');const ip=req.socket.remoteAddress||'unknown';let userId=null;let rec=ticket&&wsTickets.get(ticket);if(rec&&rec.expiresAt>Date.now()&&rec.gameId===gameId){userId=rec.userId;wsTickets.delete(ticket)}else if(redis&&ticket){try{const raw=await redis.get(`wst:${ticket}`);if(raw){const x=JSON.parse(raw);if(x.gameId===gameId)userId=x.userId;await redis.del(`wst:${ticket}`)}}catch(_){}}if(!userId||!gameId||!games.has(gameId))return ws.close(1008,'unauthorized');const count=wsCounts.get(ip)||0;if(count>=20)return ws.close(1013,'too_many_connections');wsCounts.set(ip,count+1);const g=games.get(gameId);if(!canViewGame(g,userId))return ws.close(1008,'forbidden');if(!sockets.has(gameId))sockets.set(gameId,new Set());sockets.get(gameId).add(ws);ws.send(JSON.stringify({type:'state',game:gamePublic(games.get(gameId))}));ws.on('close',()=>{sockets.get(gameId)?.delete(ws);const n=(wsCounts.get(ip)||1)-1;if(n<=0)wsCounts.delete(ip);else wsCounts.set(ip,n)});});
function broadcast(gameId,payload){for(const ws of sockets.get(gameId)||[])if(ws.readyState===1)ws.send(JSON.stringify(payload));}
setInterval(()=>{for(const g of games.values())if(g.status==='playing'){tick(g);if(g.status==='finished')broadcast(g.id,{type:'game_end',game:gamePublic(g)});}},1000);
initializeStorage().then(()=>restoreGames()).then(()=>{const port=process.env.PORT||8080;server.listen(port,'0.0.0.0',()=>console.log(`White Nile Chess 3.7.1 server listening on ${port}`));}).catch(err=>{console.error('Startup failed',err);process.exit(1);});
