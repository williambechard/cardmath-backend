require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// CORS configuration - easily switch between development and production
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['*']; // Allow all origins in development

const corsOptions = {
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);

// Socket.IO with same CORS settings
const io = new Server(server, {
  cors: corsOptions
});

const PORT = process.env.PORT || 3000;

const RoomManager = require('./lib/roomManager');
const roomManager = new RoomManager();

// roomId -> { selections: { '1': card|null, '2': card|null }, currentProblem: null }
const roomStates = new Map();

// Track rematch requests: Map<roomId, Set<playerNumber>>
const rematchRequests = new Map();

// Timers for auto-advancing rounds: Map<roomId, Timeout>
const nextRoundTimers = new Map();

// Presence broadcast timers to debounce rapid presence events per-room
const presenceTimers = new Map();

function broadcastPresenceNow(roomId) {
  try {
    const room = roomManager.getRoom(roomId);
    if (!room) return;
    // Build an authoritative presence payload for the room
    const playersStatus = (room.playersStatus || []).map(p => ({ playerNumber: p.playerNumber, status: p.status }));
    const playersPresent = Array.from(room.players.values()).map(p => p.playerNumber);
    const payload = { roomId, playersStatus, playersPresent, ts: Date.now() };
    for (const [sId] of room.players.entries()) {
      io.to(sId).emit('presenceUpdate', payload);
    }
  } catch (err) {
    console.error('broadcastPresenceNow error', err);
  }
}

function schedulePresenceBroadcast(roomId, delay = 200) {
  try {
    // clear any existing timer
    const existing = presenceTimers.get(roomId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      presenceTimers.delete(roomId);
      broadcastPresenceNow(roomId);
    }, delay);
    presenceTimers.set(roomId, t);
  } catch (err) {
    console.error('schedulePresenceBroadcast error', err);
  }
}

function scheduleAutoNextRound(roomId, delay = 800) {
  if (nextRoundTimers.has(roomId)) return;
  console.log(`scheduleAutoNextRound: scheduling auto-next for room ${roomId} in ${delay}ms`);
  // Mark the room as transitioning so we ignore new selections until the
  // scheduled auto-next executes. This prevents clients from starting a
  // new selection round that races the server's auto-advance.
  try {
    const r = roomManager.getRoom(roomId);
    if (r) r.transitioning = true;
  } catch (e) {}

  const t = setTimeout(() => {
    try {
      const room = roomManager.getRoom(roomId);
      if (!room) return;
      const state = roomManager.nextRound(roomId);
      if (state) {
        const payload = { type: 'stateUpdate', roomId, data: state };
        // indicate that auto-next executed and clear the transitioning hint
        try { payload.transitioning = false; } catch (e) {}
        // auto-next execution: allow clients to advance now
        try { payload.data.advanceClients = true; } catch (e) {}
        try { payload.data.dealComplete = typeof payload.data.dealComplete === 'boolean' ? payload.data.dealComplete : true; } catch (e) {}
        console.log(`scheduleAutoNextRound: emitting auto nextRound stateUpdate for room ${roomId}`);
        for (const [sId] of room.players.entries()) {
          io.to(sId).emit('gameSync', payload);
          io.to(sId).emit('otherPlayerAction', payload);
        }
      }
    } catch (err) {
      console.error('auto nextRound error', err);
    } finally {
      // clear transitioning flag when the auto-next completed
      try { const r2 = roomManager.getRoom(roomId); if (r2) r2.transitioning = false; } catch (e) {}
      nextRoundTimers.delete(roomId);
    }
  }, delay);
  nextRoundTimers.set(roomId, t);
}

function clearAutoNextRound(roomId) {
  const t = nextRoundTimers.get(roomId);
  if (t) {
    console.log(`clearAutoNextRound: clearing auto-next timer for room ${roomId}`);
    clearTimeout(t);
    // also clear transitioning flag so the room can accept selections again
    try { const r = roomManager.getRoom(roomId); if (r) r.transitioning = false; } catch (e) {}
    nextRoundTimers.delete(roomId);
  }
}

function ensureRoomState(roomId) {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, { selections: { 1: null, 2: null }, currentProblem: null });
  }
  return roomStates.get(roomId);
}

// Helper: log a compact summary for stateUpdate payloads to keep logs readable.
function logStateUpdateSummary(prefix, payload) {
  try {
    const data = payload && payload.data;
    let dataCount = 0;
    if (data) {
      if (Array.isArray(data)) dataCount = data.length;
      else if (typeof data === 'object') dataCount = Object.keys(data).length;
      else dataCount = 1;
    }
    console.log(`${prefix} =`, { type: payload.type, roomId: payload.roomId, dataCount });
  } catch (err) {
    console.log(prefix + ' = (unable to summarize payload)');
  }
}

function clearRoomState(roomId) {
  roomStates.delete(roomId);
}

function generateWrongAnswer(correctAnswer) {
  const offset = Math.floor(Math.random() * 20) + 1;
  const wrongAnswer = correctAnswer + (Math.random() > 0.5 ? offset : -offset);
  return Math.max(1, wrongAnswer);
}

function buildAnswerOptions(correctAnswer) {
  const answerOptions = new Set();
  answerOptions.add(correctAnswer);
  while (answerOptions.size < 4) {
    answerOptions.add(generateWrongAnswer(correctAnswer));
  }
  return Array.from(answerOptions).sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('createRoom', (payload, callback) => {
    try {
      const { room, response } = roomManager.createRoom(socket.id);
      console.log(`createRoom: socket=${socket.id} created room ${response.roomId} playerId=${response.playerId}`);
      // Ack back to creator
      if (typeof callback === 'function') callback(response);
      // Also emit roomJoined for compatibility with client listeners
      socket.emit('roomJoined', response);
      console.log(`Room ${response.roomId} created by ${response.playerId}`);
    } catch (err) {
      console.error('createRoom error', err);
      if (typeof callback === 'function') callback({ error: 'Failed to create room' });
    }
  });

  socket.on('joinRoom', ({ roomId } = {}, callback) => {
    try {
      if (!roomId) {
        if (typeof callback === 'function') callback({ error: 'Missing roomId' });
        return;
      }
  const result = roomManager.joinRoom(roomId, socket.id);
  if (result && result.response) {
    console.log(`joinRoom: socket=${socket.id} attempt join ${roomId} -> ok`);
  } else {
    const reason = result && result.error ? result.error : 'unknown';
    console.log(`joinRoom: socket=${socket.id} attempt join ${roomId} -> error (${reason})`);
  }
      if (result.error) {
        if (typeof callback === 'function') callback({ error: result.error });
        return;
      }

      const { room, response } = result;
  console.log(`joinRoom: socket=${socket.id} joined room ${roomId} as player ${response.playerId}`);
      // If this room was previously empty and marked with lastEmptyAt, clear the marker now
      if (room.lastEmptyAt) delete room.lastEmptyAt;
      if (typeof callback === 'function') callback(response);
      socket.emit('roomJoined', response);

      // Notify other player that second player connected
      for (const [otherSocketId] of room.players.entries()) {
        if (otherSocketId !== socket.id) {
          io.to(otherSocketId).emit('otherPlayerConnected');
        }
      }
      // Schedule a debounced authoritative presenceUpdate broadcast for the room
      schedulePresenceBroadcast(roomId);
      // Note: do NOT auto-start when the second player joins. The room creator must explicitly
      // start the game (server will initialize authoritative state when the creator requests it).

      console.log(`Player ${response.playerId} joined room ${roomId}`);
    } catch (err) {
      console.error('joinRoom error', err);
      if (typeof callback === 'function') callback({ error: 'Failed to join room' });
    }
  });

  socket.on('gameSync', (message) => {
    try {
      if (!message || !message.roomId) return;
      // Log incoming gameSync for debugging
      console.log('gameSync recv:', JSON.stringify(message));

      const room = roomManager.getRoom(message.roomId);
      if (!room) return;

      // Orchestrate certain message types server-side
      if (message.type === 'cardSelected') {
        console.log(`gameSync: cardSelected from socket=${socket.id} room=${message.roomId} player=${message.playerNumber}`);
        // Let authoritative RoomManager handle selection and compute problem when both selected
        // Expect only cardId from clients to avoid object identity mismatches
        const cardId = message.data && message.data.cardId ? message.data.cardId : (message.data && message.data.card && message.data.card.id);
        const resultState = roomManager.playerSelectCard(message.roomId, message.playerNumber, { id: cardId });
        if (resultState) {
          // Only send stateUpdate with revealEquation, no auto-next/transitioning
          const payload = { type: 'stateUpdate', roomId: message.roomId, data: resultState };
          // Ensure explicit flags are present for clients to decide navigation
          try { payload.data.advanceClients = !!payload.data.advanceClients; } catch (e) {}
          try { payload.data.dealComplete = typeof payload.data.dealComplete === 'boolean' ? payload.data.dealComplete : false; } catch (e) {}
          try {
            logStateUpdateSummary('cardSelected: stateUpdate payload', payload);
          } catch (err) {
            console.log('cardSelected: stateUpdate payload (summarize failed)');
          }
          for (const [sId] of room.players.entries()) {
            io.to(sId).emit('gameSync', payload);
            io.to(sId).emit('otherPlayerAction', payload);
          }
        }
        return;
      }

      if (message.type === 'answerSubmitted') {
    console.log(`gameSync: answerSubmitted from socket=${socket.id} room=${message.roomId} player=${message.playerNumber}`);
        console.log(`answerSubmitted recv: room=${message.roomId} player=${message.playerNumber} answer=${message.data && message.data.answer}`);
        const res = roomManager.playerSubmitAnswer(message.roomId, message.playerNumber, message.data.answer);
        if (res) {
          // Broadcast updated state. Only schedule an auto-next if the problem was resolved
          if (res.state.problemSolved) {
            const autoDelay = 800;
            const payload = { type: 'stateUpdate', roomId: message.roomId, data: res.state, nextRoundInMs: autoDelay };
            // mark that server is transitioning to next round so clients can
            // disable UI interactions during the short window to avoid races
            payload.transitioning = true;
            // do not allow clients to auto-advance yet; server will flip advanceClients when auto-next runs
            try { payload.data.advanceClients = false; } catch (e) {}
            // include an absolute next-round timestamp so clients that fetch
            // state later (or missed this message) can schedule the same deadline
            try { payload.nextRoundAt = Date.now() + autoDelay; } catch (e) {}
            console.log(`answerSubmitted: problemSolved in room ${message.roomId}, scheduling auto-next ${autoDelay}ms, solvedBy=${res.state.solvedBy}`);
            try {
              logStateUpdateSummary('answerSubmitted: stateUpdate payload', payload);
            } catch (err) {
              console.log('answerSubmitted: stateUpdate payload (summarize failed)');
            }
            for (const [sId] of room.players.entries()) {
              io.to(sId).emit('gameSync', payload);
              io.to(sId).emit('otherPlayerAction', payload);
            }
            // Schedule server-side auto-advance shortly after answer is processed
            scheduleAutoNextRound(message.roomId, autoDelay);
          } else {
            const payload = { type: 'stateUpdate', roomId: message.roomId, data: res.state };
            try { payload.data.advanceClients = !!payload.data.advanceClients; } catch (e) {}
            try { payload.data.dealComplete = typeof payload.data.dealComplete === 'boolean' ? payload.data.dealComplete : false; } catch (e) {}
            console.log(`answerSubmitted: partial answer in room ${message.roomId}, other player may still answer`);
            try {
              logStateUpdateSummary('answerSubmitted: stateUpdate payload', payload);
            } catch (err) {
              console.log('answerSubmitted: stateUpdate payload (summarize failed)');
            }
            for (const [sId] of room.players.entries()) {
              io.to(sId).emit('gameSync', payload);
              io.to(sId).emit('otherPlayerAction', payload);
            }
          }
        }
        return;
      }

      if (message.type === 'nextRound') {
    console.log(`gameSync: nextRound from socket=${socket.id} room=${message.roomId}`);
        // If an auto-next timer exists, cancel it and run immediately
        clearAutoNextRound(message.roomId);
        const state = roomManager.nextRound(message.roomId);
        if (state) {
          const payload = { type: 'stateUpdate', roomId: message.roomId, data: state };
          // Manual nextRound invoked by a client: treat as an explicit advance
          try { payload.data.advanceClients = true; } catch (e) {}
          try { payload.data.dealComplete = typeof payload.data.dealComplete === 'boolean' ? payload.data.dealComplete : true; } catch (e) {}
          try {
            logStateUpdateSummary('nextRound: stateUpdate payload', payload);
          } catch (err) {
            console.log('nextRound: stateUpdate payload (summarize failed)');
          }
          for (const [sId] of room.players.entries()) {
            io.to(sId).emit('gameSync', payload);
            io.to(sId).emit('otherPlayerAction', payload);
          }
        }
        return;
      }

      if (message.type === 'resetGame') {
    console.log(`gameSync: resetGame from socket=${socket.id} room=${message.roomId}`);
        const state = roomManager.resetGameState(message.roomId);
        if (state) {
          const payload = { type: 'stateUpdate', roomId: message.roomId, data: state };
          try {
            logStateUpdateSummary('resetGame: stateUpdate payload', payload);
          } catch (err) {
            console.log('resetGame: stateUpdate payload (summarize failed)');
          }
          for (const [sId] of room.players.entries()) {
            io.to(sId).emit('gameSync', payload);
            io.to(sId).emit('otherPlayerAction', payload);
          }
          // Clear any pending rematch requests when game is reset
          rematchRequests.delete(message.roomId);
        }
        return;
      }

      // Default: relay to other players as before
      for (const [otherSocketId] of room.players.entries()) {
        if (otherSocketId !== socket.id) {
          io.to(otherSocketId).emit('gameSync', message);
          io.to(otherSocketId).emit('otherPlayerAction', message);
        }
      }
    } catch (err) {
      console.error('gameSync error', err);
    }
  });

  // Rematch request: player initiates or confirms rematch
  socket.on('requestRematch', ({ roomId, playerNumber } = {}, callback) => {
    try {
      if (!roomId || !playerNumber) {
        if (typeof callback === 'function') callback({ error: 'Missing roomId or playerNumber' });
        return;
      }
      const room = roomManager.getRoom(roomId);
      if (!room) {
        if (typeof callback === 'function') callback({ error: 'Room not found' });
        return;
      }

      // Initialize rematch request set for this room if needed
      if (!rematchRequests.has(roomId)) {
        rematchRequests.set(roomId, new Set());
      }
      const requests = rematchRequests.get(roomId);
      requests.add(playerNumber);

      console.log(`requestRematch: room=${roomId} player=${playerNumber} total=${requests.size}`);

      // Check if both players have requested rematch
      if (requests.size >= 2) {
        console.log(`requestRematch: both players confirmed for room=${roomId}, resetting game`);

        // Reset game state (reuse existing difficulty/initialCards)
        const difficulty = room.difficulty || 'easy';
        const initialCards = room.initialCards || 6;
        const state = roomManager.initGameState(roomId, { difficulty, initialCards });

        if (state) {
          // Ensure clients treat this like a fresh deal
          try { state.advanceClients = false; } catch (e) {}
          try { state.dealComplete = false; } catch (e) {}

          // Clear rematch requests
          rematchRequests.delete(roomId);

          // Broadcast state update and presence so clients route consistently
          const payload = { type: 'stateUpdate', roomId, data: state };
          for (const [sId] of room.players.entries()) {
            io.to(sId).emit('gameSync', payload);
            io.to(sId).emit('otherPlayerAction', payload);
            io.to(sId).emit('presenceUpdate', { roomId, playerSocket: sId, status: 'in-game' });
          }

          if (typeof callback === 'function') callback({ ok: true, bothConfirmed: true });
        } else {
          if (typeof callback === 'function') callback({ error: 'Failed to reset game' });
        }
      } else {
        // Notify other player about rematch request
        for (const [sId, player] of room.players.entries()) {
          if (player.playerNumber !== playerNumber) {
            io.to(sId).emit('rematchRequested', { roomId, requestedBy: playerNumber });
          }
        }
        if (typeof callback === 'function') callback({ ok: true, waiting: true });
      }
    } catch (err) {
      console.error('requestRematch error', err);
      if (typeof callback === 'function') callback({ error: 'Server error' });
    }
  });

  // Allow clients to set ephemeral presence (e.g., 'lobby' | 'in-game') without disconnecting
  socket.on('setPresence', ({ roomId, status } = {}, callback) => {
    try {
      if (!roomId || !status) {
        if (typeof callback === 'function') callback({ error: 'Missing roomId or status' });
        return;
      }

  // If a client explicitly sets presence to 'left', treat that as an intent to leave the room.
  console.log(`setPresence: socket=${socket.id} room=${roomId} status=${status}`);
      if (status === 'left') {
        const left = roomManager.leaveRoomBySocket(socket.id);
        if (left) {
          // If there are remaining players, notify them that this player left
          const room = roomManager.getRoom(left.roomId);
          if (room && room.players.size > 0) {
            for (const [otherSocketId] of room.players.entries()) {
              io.to(otherSocketId).emit('otherPlayerDisconnected');
            }
          }
          if (typeof callback === 'function') callback({ ok: true });
        } else {
          if (typeof callback === 'function') callback({ error: 'Not in a room' });
        }
        return;
      }

      const updated = roomManager.setPlayerStatus(roomId, socket.id, status);
      if (updated) {
        // request a debounced authoritative presence broadcast for the room
        schedulePresenceBroadcast(roomId);
        // If this client is indicating they want to enter the game, immediately send
        // the current authoritative game state (if any) back to the requesting socket
        // so they can rejoin without waiting for another trigger.
        if (status === 'in-game') {
          try {
            // Use authoritative game state from RoomManager instead of the
            // lightweight ensureRoomState map so clients receive canonical
            // flags (dealComplete / advanceClients) and consistent game data.
            const state = roomManager.getGameState(roomId);
            if (state) {
              const payload = { type: 'stateUpdate', roomId, data: state };
              try { payload.data.advanceClients = !!payload.data.advanceClients; } catch (e) {}
              try { payload.data.dealComplete = typeof payload.data.dealComplete === 'boolean' ? payload.data.dealComplete : false; } catch (e) {}
              io.to(socket.id).emit('gameSync', payload);
            }
          } catch (err) {
            console.error('setPresence in-game emit error', err);
          }
        }
        if (typeof callback === 'function') callback({ ok: true });
      } else {
        if (typeof callback === 'function') callback({ error: 'Failed to set presence' });
      }
    } catch (err) {
      console.error('setPresence error', err);
      if (typeof callback === 'function') callback({ error: 'Server error' });
    }
  });

  // Optional pre-configuration: client can set room options (difficulty, initialCards) before startGame
  socket.on('setRoomOptions', (payload = {}, callback) => {
    try {
      const { roomId } = payload;
      if (!roomId) {
        if (typeof callback === 'function') callback({ error: 'Missing roomId' });
        return;
      }
      const room = roomManager.getRoom(roomId);
      if (!room) {
        if (typeof callback === 'function') callback({ error: 'Room not found' });
        return;
      }
      const player = room.players.get(socket.id);
      if (!player) {
        if (typeof callback === 'function') callback({ error: 'Not in room' });
        return;
      }

      // Parse difficulty and initialCards from payload
      const difficulty = payload.difficulty || payload.options?.difficulty;
      const pickNumber = (...vals) => {
        for (const v of vals) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
        }
        return null;
      };
      const initialCards = pickNumber(
        payload.initialCards, payload.cardsPerPlayer, payload.cardCount,
        payload.initialHandSize, payload.startingHandSize, payload.startingCards, payload.initialDealCount,
        payload.options?.initialCards, payload.options?.cardsPerPlayer, payload.options?.cardCount,
        payload.options?.initialHandSize, payload.options?.startingHandSize, payload.options?.startingCards, payload.options?.initialDealCount
      );

      // Update room options
      if (difficulty) room.difficulty = difficulty;
      if (initialCards) room.initialCards = initialCards;
      room.options = { difficulty: room.difficulty, initialCards: room.initialCards };

      console.log(`setRoomOptions: room=${roomId} difficulty=${room.difficulty} initialCards=${room.initialCards}`);

      // Broadcast updated room metadata to lobby views (optional)
      schedulePresenceBroadcast(roomId, 100);

      if (typeof callback === 'function') callback({ ok: true });
    } catch (err) {
      console.error('setRoomOptions error', err);
      if (typeof callback === 'function') callback({ error: 'Server error' });
    }
  });

  // Creator explicit start: initialize authoritative game state and send initial state to players
  socket.on('startGame', (payload = {}, callback) => {
    try {
      const { roomId } = payload;
      if (!roomId) {
        if (typeof callback === 'function') callback({ error: 'Missing roomId' });
        return;
      }
      const room = roomManager.getRoom(roomId);
      if (!room) {
        if (typeof callback === 'function') callback({ error: 'Room not found' });
        return;
      }
      const player = room.players.get(socket.id);
      if (!player) {
        if (typeof callback === 'function') callback({ error: 'Not in room' });
        return;
      }
      // Only the room creator (playerNumber === 1) may start the game
      if (player.playerNumber !== 1) {
        if (typeof callback === 'function') callback({ error: 'Only the room creator can start the game' });
        return;
      }

      // Parse difficulty and initialCards from payload synonyms
      const difficulty = payload.difficulty || payload.options?.difficulty || room.difficulty || 'easy';
      const pickNumber = (...vals) => {
        for (const v of vals) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
        }
        return null;
      };
      const initialCards = pickNumber(
        payload.initialCards, payload.cardsPerPlayer, payload.cardCount,
        payload.initialHandSize, payload.startingHandSize, payload.startingCards, payload.initialDealCount,
        payload.options?.initialCards, payload.options?.cardsPerPlayer, payload.options?.cardCount,
        payload.options?.initialHandSize, payload.options?.startingHandSize, payload.options?.startingCards, payload.options?.initialDealCount
      ) || room.initialCards || null;

  console.log(`startGame: socket=${socket.id} requested start for room=${roomId} difficulty=${difficulty} initialCards=${initialCards}`);
  // Require two players to be present before starting the game.
      // This prevents a creator from accidentally starting a game alone
      // (which can be confusing when rooms are recreated quickly).
      if ((room.players && room.players.size) < 2) {
        if (typeof callback === 'function') callback({ error: 'Need two players to start' });
        return;
      }

      const state = roomManager.initGameState(roomId, { difficulty, initialCards });
  console.log(`startGame: initGameState result for room=${roomId} -> ${state ? 'ok' : 'failed'}`);
      if (state) {
        const payload = { type: 'stateUpdate', roomId, data: state };
        // At game start, cards are dealt immediately but clients should not auto-advance
        try { payload.data.advanceClients = false; } catch (e) {}
        try { payload.data.dealComplete = false; } catch (e) {}
        for (const [sId] of room.players.entries()) {
          io.to(sId).emit('gameSync', payload);
          io.to(sId).emit('otherPlayerAction', payload);
          // Also inform clients that presence changed to 'in-game' (clients may update UI)
          io.to(sId).emit('presenceUpdate', { roomId, playerSocket: sId, status: 'in-game' });
        }
        if (typeof callback === 'function') callback({ ok: true });
      } else {
        if (typeof callback === 'function') callback({ error: 'Failed to init game' });
      }
    } catch (err) {
      console.error('startGame error', err);
      if (typeof callback === 'function') callback({ error: 'Server error' });
    }
  });

  // Explicit leave without disconnecting the socket (mark left and notify others)
  socket.on('leaveRoom', ({ roomId } = {}, callback) => {
    try {
      // mark as left and remove from room
  const left = roomManager.leaveRoomBySocket(socket.id);
  console.log(`leaveRoom: socket=${socket.id} left -> ${left ? `room=${left.roomId} deleted=${left.deleted} remaining=${left.remaining}` : 'not-in-room'}`);
      if (left) {
        const room = roomManager.getRoom(left.roomId);
        if (room && room.players.size > 0) {
          for (const [otherSocketId] of room.players.entries()) {
            io.to(otherSocketId).emit('otherPlayerDisconnected');
          }
          // schedule presence broadcast for remaining players
          schedulePresenceBroadcast(left.roomId);
        }
        // Return detailed info so clients can decide where to navigate next
        if (typeof callback === 'function') callback({ ok: true, roomId: left.roomId, deleted: !!left.deleted, remaining: left.remaining });
      } else {
        if (typeof callback === 'function') callback({ error: 'Not in a room' });
      }
    } catch (err) {
      console.error('leaveRoom error', err);
      if (typeof callback === 'function') callback({ error: 'Server error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);

    const left = roomManager.leaveRoomBySocket(socket.id);
    if (left) {
      // If the RoomManager indicated the room was deleted (last player left),
      // it has already removed the room and its authoritative state. In that
      // case just clear timers and do not attempt to broadcast presence.
      if (left.deleted) {
        console.log(`Room ${left.roomId} deleted (last player disconnected)`);
        clearAutoNextRound(left.roomId);
      } else {
        // Notify remaining player(s) if any and schedule presence broadcast
        const room = roomManager.getRoom(left.roomId);
        if (room && room.players.size > 0) {
          for (const [otherSocketId] of room.players.entries()) {
            io.to(otherSocketId).emit('otherPlayerDisconnected');
          }
          clearAutoNextRound(left.roomId);
          schedulePresenceBroadcast(left.roomId);
        } else {
          // Defensive fallback: ensure timers cleared
          console.log(`Room ${left.roomId} not found after disconnect (fallback)`);
          clearAutoNextRound(left.roomId);
        }
      }
    }
  });
});

// Periodic garbage collection for idle rooms
const GC_INTERVAL_MS = 60 * 1000; // check every 60s
setInterval(() => {
  try {
    const removed = roomManager.garbageCollectRooms();
    if (removed && removed.length) {
      for (const rid of removed) {
        console.log(`GC: removed idle room ${rid}`);
        clearAutoNextRound(rid);
      }
    }
  } catch (err) {
    console.error('Room GC error', err);
  }
}, GC_INTERVAL_MS);

app.get('/', (req, res) => {
  res.json({ status: 'ok', rooms: roomManager.listRooms().length });
});

// Debug endpoint to list active rooms
app.get('/rooms', (req, res) => {
  res.json({ rooms: roomManager.listRooms() });
});

// Debug endpoint: return a single room's meta info (players, status)
app.get('/rooms/:id', (req, res) => {
  const roomId = req.params.id;
  const rooms = roomManager.listRooms();
  const found = rooms.find(r => r.roomId === roomId);
  if (!found) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  // Attach quick hints from authoritative game state so debug UIs can reflect server intent
  try {
    const state = roomManager.getGameState(roomId);
    if (state) {
      found.advanceClients = !!state.advanceClients;
      found.dealComplete = !!state.dealComplete;
    }
  } catch (e) {}
  res.json({ room: found });
});

// Debug: return authoritative state for a given room id
app.get('/rooms/:id/state', (req, res) => {
  const roomId = req.params.id;
  const state = roomManager.getGameState(roomId);
  if (!state) {
    res.status(404).json({ error: 'Room or state not found' });
    return;
  }
  console.log(`GET /rooms/${roomId}/state -> p1=${state.player1Hand.length} p2=${state.player2Hand.length}`);
  res.json({ state });
});

// Admin dashboard endpoint - returns detailed room statistics
app.get('/api/rooms', (req, res) => {
  const rooms = roomManager.listRooms();
  const now = Date.now();
  
  const roomsWithStats = rooms.map(room => {
    const roomData = roomManager.getRoom(room.roomId);
    const createdAt = roomData?.createdAt || now;
    const lastActivity = roomData?.lastActivity || createdAt;
    const age = now - createdAt;
    
    return {
      roomId: room.roomId,
      playerCount: room.playersPresent?.length || 0,
      players: room.playersPresent || [],
      createdAt,
      lastActivity,
      age
    };
  });

  // Calculate statistics
  const totalRooms = roomsWithStats.length;
  const totalPlayers = roomsWithStats.reduce((sum, room) => sum + room.playerCount, 0);
  const emptyRooms = roomsWithStats.filter(room => room.playerCount === 0).length;
  const oldRooms = roomsWithStats.filter(room => room.age >= 10 * 60 * 1000).length;

  res.json({
    totalRooms,
    totalPlayers,
    emptyRooms,
    oldRooms,
    rooms: roomsWithStats.sort((a, b) => b.createdAt - a.createdAt) // Sort by newest first
  });
});

// Serve the admin dashboard HTML
app.use('/admin', express.static('public'));

server.listen(PORT, () => {
  console.log(`CardMath backend listening on http://localhost:${PORT}`);
  console.log(`Admin dashboard available at http://localhost:${PORT}/admin/admin.html`);
});
