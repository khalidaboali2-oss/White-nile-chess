# Dowaim Chess 3.7.0 — Final Hardening & Training Pass

## Implemented in this release
- Security headers and production HSTS/CSP.
- Stricter request body limits.
- Constant-time password verification path for unknown accounts.
- Additional rate limits on sensitive game/account/training operations.
- Short-lived, single-use WebSocket tickets; long-lived bearer tokens are no longer placed in the WebSocket URL by the official web client.
- Server validation for challenge-link time controls and variants.
- Daily Puzzle API with curated training positions and recorded attempts.
- Academy Training Path: Fundamentals → Tactics → Strategy → Calculation → Advanced → Higher-level preparation.
- Dedicated Cultural & Educational Program badge.
- Dedicated Dowaim Chess Online Competitions badge with no reference to any external chess platform.
- Mobile navigation retained and synchronized across browser and Android assets.
- Existing Team Arena, 4×4, Khalid System, ratings, fair play, sessions, game review and tournament permissions preserved.
- Version updated to 3.7.0.

## Branding decision
Institution: White Nile Chess Academy.
Platform: Dowaim Chess / شطرنج الدويم.
Online department: Dowaim Chess — Online Competitions.
Cultural department: Cultural & Educational Program.

## Important QA limitation
Static/source validation passes. A real public deployment, Android APK build, and live two-account match still require external environment testing.
