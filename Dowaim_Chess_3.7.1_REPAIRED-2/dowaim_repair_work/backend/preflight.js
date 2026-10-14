#!/usr/bin/env node
// White Nile Chess Academy - automated preflight checks
const fs=require('fs'), path=require('path'), cp=require('child_process');
const root=path.resolve(__dirname,'..');
const required=[
 'app/build.gradle','app/src/main/AndroidManifest.xml',
 'app/src/main/java/com/whitenilechess/MainActivity.kt',
 'backend/server.js','backend/package.json','FINAL_SPECIFICATIONS_2026-08-26.md'
];
let ok=true;
for(const f of required){if(fs.existsSync(path.join(root,f))) console.log('PASS file',f); else {console.log('FAIL file',f);ok=false;}}
try{cp.execFileSync(process.execPath,['--check',path.join(root,'backend/server.js')],{stdio:'inherit'});console.log('PASS Node syntax');}
catch(e){console.log('FAIL Node syntax');ok=false;}
const srv=fs.readFileSync(path.join(root,'backend/server.js'),'utf8');
for(const x of [
 "rateLimit(10,15*60*1000)","rateLimit(20,15*60*1000)",
 "hideMoveHistory","function arenaStandings","/version",
 "confirmed_cheating","white-nile-backup-safe.json","team_arena","all_player_points","unlimitedPlayers","same_team_opponent","manual_scoring_disabled","Content-Security-Policy","Strict-Transport-Security","DUMMY_PASSWORD_HASH","/ws-ticket","DAILY_PUZZLES","/training/daily-puzzle", "initializeStorage()", "persistence_unavailable", "chess.isCheckmate()", "version:'3.7.1'"
]){if(srv.includes(x)) console.log('PASS security/feature',x); else {console.log('FAIL security/feature',x);ok=false;}}
const html=fs.readFileSync(path.join(root,'backend/public/index.html'),'utf8');
const puzzlePublic=srv.match(/function puzzlePublic\(p\)\{([^}]+)\}/);
if(puzzlePublic && !/solution|explanation|from:|to:/.test(puzzlePublic[1])) console.log('PASS puzzle answer not exposed publicly'); else {console.log('FAIL puzzle answer not exposed publicly');ok=false;}
if(!/async function loadDailyPuzzle\(\)\{try\{go\('training'\)/.test(html)) console.log('PASS training navigation recursion removed'); else {console.log('FAIL training navigation recursion removed');ok=false;}
if(fs.readFileSync(path.join(root,'backend/public/index.html'),'utf8')===fs.readFileSync(path.join(root,'app/src/main/assets/index.html'),'utf8')) console.log('PASS web/Android HTML assets synchronized'); else {console.log('FAIL web/Android HTML assets synchronized');ok=false;}
console.log(ok?'PRECHECK PASS':'PRECHECK FAIL');
process.exit(ok?0:1);
