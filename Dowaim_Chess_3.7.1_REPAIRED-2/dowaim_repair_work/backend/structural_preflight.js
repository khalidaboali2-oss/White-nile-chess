const fs=require('fs');
const path=require('path');
const root=__dirname;
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const checks=[
 ['Redis dependency',!!pkg.dependencies.ioredis],
 ['Postgres dependency',!!pkg.dependencies.pg],
 ['Production requires Redis',server.includes("REDIS_URL_required_in_production")],
 ['Production requires allowed origins',server.includes("ALLOWED_ORIGINS_required_in_production")],
 ['Redis session storage',server.includes('sess:${h}')],
 ['Redis rate limiting',server.includes('redis.incr(key)')],
 ['WS connection limit',server.includes('too_many_connections')],
 ['Password timing-safe verify',server.includes('timingSafeEqual')],
 ['Team 4-board validation',server.includes('four_board_results_required')],
 ['Team roster validation',server.includes('roster_must_have_four_boards')],
 ['Khalid engine',server.includes('khalidEnsureRound')],
 ['Chess960 generation',server.includes('function chess960Fen')],
 ['Rating result recording',server.includes('recordGameResult')],
 ['Atomic JSON save',server.includes("fs.renameSync(tmp,DB_FILE)")],
 ['Team role permissions',server.includes('TEAM_ROLES') && server.includes('teamPermission')],
 ['Team captain/settings management',server.includes('/teams/:id/transfer-captain') && server.includes('/teams/:id/settings')],
 ['Team messaging and tournament creation',server.includes('/teams/:id/messages') && server.includes('/teams/:id/tournaments')],
 ['Team background whitelist',server.includes('TEAM_BACKGROUNDS') && server.includes('invalid_background')],
 ['Team Arena multi-round engine',server.includes("t.system==='team_arena'?") && server.includes('roundCount')],
 ['Team-owned tournament permissions',server.includes('ownerTeamId') && server.includes('team_tournament_permission_required')]
];
let bad=0; for(const [n,v] of checks){console.log((v?'PASS ':'FAIL ')+n);if(!v)bad++;}
if(bad)process.exit(1); console.log('STRUCTURAL PREFLIGHT PASS');
