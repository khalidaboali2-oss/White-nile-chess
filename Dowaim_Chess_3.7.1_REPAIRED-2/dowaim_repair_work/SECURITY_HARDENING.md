# Security hardening — 2026-08-26

This revision hardens the primary `backend/server.js`:
- Authenticated access for private games and PGN.
- Game-player authorization for moves, resignations, and draw acceptance.
- Authenticated WebSocket with token and game visibility checks.
- Tournament registration uses the authenticated account, not a client-supplied playerId.
- Tournament start/results require organizer authorization and ownership.
- Confirmed fair-play bans invalidate active sessions and mark the account banned.
- Fair-play confirmation now updates the actual game store instead of the unrelated events list.
- Backups exclude password hashes and device/session tokens.
- Configurable CORS via `ALLOWED_ORIGINS`.
- Minimum password length and username validation.

Important:
`backend/server-scaled.js` remains a scaling prototype and does NOT implement the full authentication/game rules of `server.js`. It must not be exposed publicly as a production endpoint until it is integrated with the same authentication and authorization layer.

Recommended production architecture:
PostgreSQL for authoritative data, Redis for ephemeral state/pubsub, TLS, rate limiting, secret management, and automated security tests.
