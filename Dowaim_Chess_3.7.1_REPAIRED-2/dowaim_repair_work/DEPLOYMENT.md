# White Nile Chess — scalable deployment package

This package now contains the horizontal-scaling architecture:
Nginx -> multiple API/WebSocket nodes -> Redis -> PostgreSQL.

The included docker-compose.scale.yml is a development/staging topology.
For production, deploy the same roles on managed/container infrastructure with:
- TLS certificate
- managed PostgreSQL
- managed Redis
- autoscaling application nodes
- monitoring and alerts
- backups
- secret manager

Do not expose PostgreSQL/Redis directly to the public internet.
Do not use the example passwords in production.

The next operational step is deployment to a real cloud/server environment and load testing.
