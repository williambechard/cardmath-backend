# CardMath Backend

Simple Node.js + Socket.IO backend for the CardMath Angular app. Provides basic room matchmaking for 2-player games and relays game sync messages between players.

Quick start

1. cd backend
2. npm install
3. npm start

The server listens on port 3000 by default. The Angular app expects the backend at `http://localhost:3000`.

Supported socket events

- `createRoom` (payload: {}, callback) -> ack response: `{ roomId, playerId, playerNumber, otherPlayerConnected }`
- `joinRoom` (payload: { roomId }, callback) -> ack response or `{ error }`
- `gameSync` (message) -> relays received message to the other player(s) in the same room via `gameSync` and `otherPlayerAction` events
- Server emits `roomJoined`, `otherPlayerConnected`, `otherPlayerDisconnected` to clients

Notes

- This is a minimal implementation intended for local/demo use on a trusted LAN. For production you should harden CORS, add validation, authentication and persistence.
