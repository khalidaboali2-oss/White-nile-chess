// Horizontal scaling remains intentionally disabled: 3.7.1 persists a single whole-state JSONB snapshot.
// Concurrent API replicas could overwrite each other; use one API replica until a normalized transactional repository and distributed game state are implemented.
require('./server.js');
