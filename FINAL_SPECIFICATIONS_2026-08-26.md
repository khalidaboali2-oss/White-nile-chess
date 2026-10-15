# White Nile Chess Academy — Final Development Specifications

Owner: Khalid Ahmed Mostafa Yousif
Academy: White Nile Chess Academy

## Tournament systems
1. Swiss
2. Round Robin
3. Knockout
4. Arena
5. Teams
6. Khalid System
7. Team Arena — open-number team Arena
8. Team 4x4 — four boards with two substitutes

## Khalid System
- A player is eliminated after the first loss.
- The player whose match ends first receives the later finishing place, then the next eliminated player, until the winner is reached.
- Absence/withdrawal during the active competition: zero points for the player, removal from the current competition, and the opponent receives the win.
- If cheating is confirmed in a Khalid System event, the entire event is replayed after 24 hours.

## Team Arena
- Open number of teams (no artificial team-count cap).
- Arena format; any number of players from each participating team may play.
- A player may not play an opponent from their own team.
- Team score is calculated automatically from actual completed game results: win = 2 points, draw = 1 point, loss = 0.
- All participating player points are summed into the team score; manual player-result scoring is disabled.

## Team 4x4
- Four starters on fixed boards: 1, 2, 3, 4.
- Two registered substitutes; maximum six players per team.
- Substitutes do not play round 1.
- A substitute may replace a starter on any board before a round; no substitution during a round.
- The original starter may return to their board in a later round.
- A player cannot be registered for more than one team in the same event.
- Round 1 supports up to 60 teams.
- Player result points: win = 2, draw = 1, loss = 0. These are tournament result points and are separate from rating.
- No agreed draws in Team 4x4 events.
- Team draw examples: 2 wins vs 2 wins, or win+draw vs win+draw.
- An absent player scores zero on their board.
- Team result is the aggregate of its board results.
- Tiebreak order: team points -> board points -> head-to-head -> event-specific tiebreak.
- Confirmed cheating: player is permanently banned after review/appeal; the team loses the match in which cheating was confirmed.

## Cheating / fair play
- Only points from matches in which cheating is confirmed are removed; valid points remain.
- The affected opponent receives the applicable corrected result.
- Permanent bans require review and an opportunity to appeal.

## Other play modes
- Chess960.
- Bullet: 1+0 and 2+0.
- Blindfold: player does not see pieces or move list.
- Simultaneous play: 2–10 opponents; each player sees only their own board.
- A spectator/watch option is available for other registered online players.

## Match UI
- “White Nile Chess Academy” above the board without covering squares.
- Opponent name above the board.
- Player name below the board.
- Share match link.
- Share PGN.
- Full-screen and normal-screen modes.
- Multiple board/-piece color themes.
- English chess-letter option with clear uppercase symbols in a contrasting color.
- Post-game accuracy display.
- In tournaments, a luminous return-to-tournament arrow after each game.

## Player/social features
- Full player profile with name, friends, ratings by Bullet/Blitz/Rapid/Classical/Chess960, all games, messages, following, and player search.
- Direct challenge and challenge-by-link.
- Watch an online friend’s game.

## Draw rules
- Agreed draw is available where the event rules allow it.
- Threefold repetition, stalemate, and other mandatory draw conditions follow the applicable chess rules.
- Team 4x4 specifically prohibits agreed draws.

## Ownership
Copyright/ownership attribution: Khalid Ahmed Mostafa Yousif / White Nile Chess Academy.


## Arena — قاعدة كسر التعادل المعتمدة
عند تساوي لاعبين في النقاط في بطولة Arena يكون الترتيب بالترتيب التالي:
1. عدد الانتصارات.
2. المواجهة المباشرة، إذا وُجدت.
3. نسبة النقاط المحققة إلى عدد المباريات.
4. الفوز في أقل وقت.
5. إذا تعذر الحسم، يبقى اللاعبان متساويين في المركز.
- لا يُستخدم Rating لكسر التعادل في Arena.


## General platform hardening — 2026-08-26
- Notifications: in-app notification inbox with read/unread state.
- Privacy: player controls for messages, challenges, games and profile visibility.
- Organizer roles: player/organizer/admin separation; tournament creation/finalization requires organizer/admin.
- Official results: finalized tournaments are locked; corrections require authorized organizer/admin action and a reason.
- Audit log: important tournament, privacy, session, fair-play and maintenance actions are recorded.
- Player search and statistics: search by username/name; ratings are tracked separately for Bullet, Blitz, Rapid, Classical and Chess960.
- Reports and appeals: fair-play reports have review status and players can submit an appeal before final enforcement.
- Account security: device/session listing, single-session revocation and revoke-all support.
- Backup: admin-only JSON backup endpoint for the platform data store.
- Maintenance mode: admin-controlled temporary maintenance state while preserving data.
- Tournament IDs: every tournament receives a unique human-readable code such as `WNC-2026-0001`.
- Official result changes are audited and require a reason.
- Team systems: `team_arena` and `team_4x4` are first-class tournament system identifiers.
