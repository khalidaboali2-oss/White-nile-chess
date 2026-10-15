# Dowaim Chess 3.7.1 — Repair Notes

This is a repair copy of the supplied archive. The original archive was not modified and no repository changes were made.

## Applied changes
- Removed recursive training navigation; opening the training section no longer recursively fetches the daily puzzle. The home training card now opens the training section.
- Removed puzzle coordinates, expected move, solution, and explanation from public puzzle payloads. The server checks submitted moves using chess.js and reveals the solution only after a correct answer.
- Added solved timestamps and a consecutive-day training streak calculation.
- Added PostgreSQL `app_state` persistence using the existing `pg` dependency. Production startup now fails if PostgreSQL is unavailable; `/ready` checks actual PostgreSQL/Redis reachability and persistence status. JSON file storage remains as a local mirror/development fallback.
- Rehydrated active games with a fresh clock tick so server downtime is not charged to players; restoration failures are logged instead of silently swallowed.
- Aligned backend/package/Android version metadata to 3.7.1 and incremented Android versionCode to 35.
- Synchronized web UI and Android HTML assets.

## Verification status
- JavaScript syntax and static checks must be rerun after these changes.
- Full end-to-end testing requires dependency installation and a reachable PostgreSQL/Redis service. Those services are not available in this offline repair environment, so no live game, account, tournament, team-arena, or Android build is claimed as tested.
- The seven bundled mate-in-one puzzles still require chess-engine validation as a set; the solve route now refuses a puzzle answer unless chess.js confirms the configured SAN and checkmate. Any malformed puzzle should be corrected before release.
