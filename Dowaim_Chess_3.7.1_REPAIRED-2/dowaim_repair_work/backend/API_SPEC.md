# White Nile Chess Academy API — repaired MVP

## Health
- `GET /health`

## Auth
- `POST /auth/register` — email, username, password, name
- `POST /auth/login`
- `GET /auth/me`

## Games
- `POST /games` — create rated/unrated game; time controls include 1+0 and 2+0
- `GET /games/:id`
- `POST /games/:id/join`
- `POST /games/:id/move`
- `POST /games/:id/draw-offer`
- `POST /games/:id/draw-accept`
- `POST /games/:id/resign`
- `GET /games/:id/pgn`
- WebSocket: `/ws?gameId=...`

## Special play
- `POST /blindfold/games` — board visible, pieces hidden in client
- `POST /simuls` — 2–10 parallel opponent games

## Players/social
- `GET /players/search?q=...`
- `GET /players/:id/profile`
- `POST /friends/:id/follow`
- `GET /friends`
- `POST /messages`
- `GET /messages`
- `POST /challenges`
- `POST /challenges/:id/accept`

## Tournaments
Systems: `swiss`, `round_robin`, `knockout`, `arena`, `teams`, `khalid`, `team_arena`, `team_4x4`.
- `POST /tournaments`
- `GET /tournaments`
- `GET /tournaments/:id`
- `POST /tournaments/:id/register`
- `POST /tournaments/:id/start`
- `POST /tournaments/:id/result`
- `GET /tournaments/:id/standings`

Khalid System is an additional independent tournament system. Confirmed cheating cancels the event and sets a full restart time 24 hours later.

## Fair play
- `POST /reports`
- `POST /fairplay/:reportId/confirm`

Confirmed reports create an email ban record and a correction workflow. Production deployment must protect confirmation endpoints with admin authorization.


## Team Arena
- `POST /tournaments/:id/team-register` — register a team (manager/captain permission required)
- `POST /tournaments/:id/team-arena/join` — add an individual team member to the event
- `POST /tournaments/:id/team-arena/games` — create a Team Arena game
- `GET /tournaments/:id/team-arena/standings` — live team standings
- `POST /tournaments/:id/team-arena/player-result` — intentionally disabled; scores come only from completed games

Team Arena has no fixed four-board roster and no artificial team-count cap. Any number of players from each registered team may participate. Players are blocked from playing members of their own team. Completed games automatically award 2/1/0 points and aggregate all player points into the team score.
