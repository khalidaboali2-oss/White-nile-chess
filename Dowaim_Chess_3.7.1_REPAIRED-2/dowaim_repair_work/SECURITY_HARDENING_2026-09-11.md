# Dowaim Chess — Security & Quality Hardening — 2026-09-11

## Implemented
- Production security headers including HSTS, CSP, frame protection, referrer policy and cross-origin restrictions.
- Strict JSON/urlencoded body limits.
- Constant-time password verification path with a dummy hash for unknown accounts.
- Rate limits on registration, login, challenges, game creation/join/moves, draw actions and puzzle attempts.
- WebSocket authentication changed to short-lived, single-use tickets instead of putting the long-lived bearer session token in the WebSocket URL.
- Server-side validation for challenge-link time controls and variants.
- Existing server-side authorization, fair-play bans, session revocation, atomic JSON persistence and tournament permissions preserved.
- No manual Team Arena scoring.

## Production notes
- Keep `REDIS_URL`, `DATABASE_URL`, `ALLOWED_ORIGINS`, `TRUST_PROXY` and secrets in the deployment secret/environment manager.
- Update `ALLOWED_ORIGINS` when a custom domain is added.
- In 3.7.1, PostgreSQL stores the authoritative application-state snapshot when DATABASE_URL is configured; local JSON is retained as a development mirror. This is not yet a normalized transactional repository and does not support safe horizontal scaling.
- Do not expose `backend/server-scaled.js` directly until it receives the same security and business-rule layer.

## Validation
- Node syntax check: PASS.
- Frontend JavaScript parse: PASS.
- Structural preflight: updated to include the new security and training controls.
- Actual public Render deployment and two-account live WebSocket match still require external testing.
