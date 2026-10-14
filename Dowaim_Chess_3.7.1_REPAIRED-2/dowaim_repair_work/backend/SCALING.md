# White Nile Chess — Scalable Architecture

## Target
Designed to scale horizontally for thousands of concurrent connected players.

Example target:
10,000 connected players / ~5,000 simultaneous games, subject to load testing and server sizing.

## Components
1. Nginx/load balancer — distributes HTTP and WebSocket traffic.
2. Multiple API/game instances — stateless application nodes.
3. Redis — shared fast state, presence, pub/sub and WebSocket fan-out.
4. PostgreSQL — durable accounts, games, results, ratings and tournaments.
5. Separate workers — tournament pairing, rating updates, notifications and fair-play jobs.

## Critical rule
A move is validated on the server. The Android client is never authoritative.

## WebSocket scaling
Production WebSocket nodes must use Redis pub/sub or an equivalent broker so a game connected to different nodes remains synchronized.

## Database
Use indexes on player_id, game_id, tournament_id, created_at and rating pool.
Use transactions for game results and rating changes.

## Security
- TLS/WSS
- JWT/session authentication
- per-IP and per-account rate limits
- WebSocket connection limits
- request size limits
- audit logs
- secrets outside source control

## Load testing
Before public launch, test at progressively higher concurrency:
500 → 1,000 → 2,500 → 5,000 → 10,000 connections.
Measure p95/p99 move latency, reconnect rate, CPU, memory, Redis latency and DB connections.
