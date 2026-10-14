# White Nile Chess — Android MVP

Android project wrapper for the White Nile Chess Academy UI.

Build:
1. Open this folder in Android Studio.
2. Sync Gradle.
3. Run on an Android 8+ device/emulator.
4. Build > Generate Signed App Bundle to create the Google Play AAB.

Important:
- This build is an Android MVP client around the designed UI.
- The real online service must be connected to `backend/API_SPEC.md`.
- Do not publish a production APK/AAB until backend authentication, legal server-side chess validation, database, WebSocket service, rating, tournament engine, fair-play review, privacy policy and Play Console requirements are completed.
- The provided personal administrative email is not embedded as a public contact.

## Platform hardening update
The current development package includes backend support for notifications, privacy controls, organizer/admin roles, official tournament locking and audited corrections, appeals, session/device security, maintenance mode, admin backups, audit logs, and unique WNC tournament codes. Team Arena and Team 4x4 are recognized tournament systems.

The backend syntax has been checked. End-to-end runtime testing requires installing the Node dependencies (`npm install`) in the backend environment.


## Release 3.7.1
Security hardening, short-lived WebSocket tickets, stricter validation, Daily Puzzle training, Academy Training Path, and dedicated Cultural/Educational + Dowaim Online Competitions branding.
