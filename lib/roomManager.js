// Simple in-memory RoomManager to keep room logic testable
class RoomManager {
  constructor() {
    // Map<roomId, { roomId, players: Map<socketId, { playerId, playerNumber, socketId }> }>
    this.rooms = new Map();
    // per-room authoritative game state
    // Map<roomId, gameState>
    this.gameStates = new Map();
    // default TTL for empty rooms (ms). Rooms with no players are kept for this duration before GC.
    this.roomTTLMs = 10 * 60 * 1000; // 10 minutes
  }

  // Simple friendly name generator using easy adjectives and nouns
  generateRoomName() {
    // richer kid-friendly themed pools and optional multi-word names
    const adjectives = [
      'happy','tiny','quick','brave','silly','bright','bouncy','jolly','clever','merry','gentle','neon','sparkly','lucky','mighty'
    ];
    const animals = [
      'bunny','fox','panda','otter','koala','puppy','kitten','owl','dolphin','penguin'
    ];
    const nature = [
      'star','pond','cloud','meadow','river','mountain','valley','garden','grove','tree'
    ];
    const space = [
      'rocket','comet','orbit','cosmo','galaxy','meteor','asteroid','nebula','luna','sol'
    ];
    const fruits = [
      'apple','berry','peach','mango','melon','kiwi','pear','plum','grape','cherry'
    ];

    const pools = [animals, nature, space, fruits];

    // Try a few unique combinations, sometimes emit multi-word names
    for (let i = 0; i < 12; i++) {
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const pool = pools[Math.floor(Math.random() * pools.length)];
      const n1 = pool[Math.floor(Math.random() * pool.length)];

      // 30% chance to make a two-noun name (e.g., 'star-rocket' or 'merry-bunny')
      const makeMulti = Math.random() < 0.3;
      let name = '';
      if (makeMulti) {
        const pool2 = pools[Math.floor(Math.random() * pools.length)];
        const n2 = pool2[Math.floor(Math.random() * pool2.length)];
        // format: 'adj noun-phrase' (space + hyphenated nouns)
        name = `${adj} ${n1}-${n2}`;
      } else {
        // format: 'adj-noun' (short and kid-friendly)
        name = `${adj}-${n1}`;
      }

      // ensure uniqueness among current rooms
      let collision = false;
      for (const [, r] of this.rooms.entries()) {
        if (r.name === name) { collision = true; break; }
      }
      if (!collision) return name;
    }

    // fallback with random suffix
    return `fun-${Math.random().toString(36).substring(2,5)}`;
  }

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  generatePlayerId() {
    return 'player_' + Math.random().toString(36).substring(2, 10);
  }

  createRoom(socketId) {
    const roomId = this.generateRoomId();
    const playerId = this.generatePlayerId();

    const roomName = this.generateRoomName();
    const now = Date.now();
    const room = { 
      roomId, 
      name: roomName, 
      players: new Map(),
      createdAt: now,
      lastActivity: now
    };
  const player = { playerId, playerNumber: 1, socketId, status: 'lobby' };
    room.players.set(socketId, player);
    this.rooms.set(roomId, room);

    return {
      room,
      response: {
        roomId,
        roomName,
        playerId,
        playerNumber: 1,
        otherPlayerConnected: false,
      },
    };
  }

  joinRoom(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'Room not found' };

    if (room.players.size >= 2) return { error: 'Room is full' };

    const playerId = this.generatePlayerId();
  const player = { playerId, playerNumber: 2, socketId, status: 'lobby' };
    room.players.set(socketId, player);
    room.lastActivity = Date.now(); // Update activity timestamp

    const response = {
      roomId,
      roomName: room.name,
      playerId,
      playerNumber: 2,
      otherPlayerConnected: true,
    };

    return { room, response };
  }

  // Initialize game state for a room (deal cards) when both players are present
  initGameState(roomId, options = {}) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Parse difficulty and initialCards from options (with fallbacks)
    const difficulty = options.difficulty || room.difficulty || 'easy';
    const difficultyDefaults = { test: 1, easy: 6, medium: 18, hard: 24 };
    const initialCards = options.initialCards || room.initialCards || difficultyDefaults[difficulty] || 6;

    // Persist difficulty and initialCards on room object for REST endpoints
    room.difficulty = difficulty;
    room.initialCards = initialCards;
    room.options = { difficulty, initialCards };

    // build deck 2..12 for 4 suits
    const suits = ['hearts','diamonds','clubs','spades'];
    const allCards = [];
    let id = 0;
    for (const suit of suits) {
      for (let value = 2; value <= 12; value++) {
        allCards.push({ id: `${suit}-${value}-${id}`, value, suit });
        id++;
      }
    }

    // shuffle
    for (let i = allCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
    }

    // Deal exactly initialCards to each player
    const player1Hand = allCards.splice(0, initialCards);
    const player2Hand = allCards.splice(0, initialCards);

    const state = {
      difficulty,
      initialCards,
      player1Hand,
      player2Hand,
      player1SelectedCard: null,
      player2SelectedCard: null,
      // store the exact submitted answer values per-player (null when none).
      // This allows clients to deterministically render which answer a player chose
      // without relying on timing heuristics.
      submittedAnswers: { 1: null, 2: null },
      player1Answered: false,
      player2Answered: false,
      player1Score: 0,
      player2Score: 0,
      currentProblem: null,
      answerOptions: [],
      correctAnswer: 0,
      gameOver: false,
      winner: null,
      problemSolved: false,
      solvedBy: null,
      roundInProgress: false,
      playersConnected: room.players.size,
      // Explicitly start with the equation hidden until both cards are selected
      // and a problem is generated. This prevents stale reveal flags from a
      // previous round/rematch from leaking into a fresh game.
      revealEquation: false,
      // authoritative history of rounds (server-side). Each entry: { a, b, correctAnswer, solvedBy, timestamp }
      history: [],
      // Control flags for client behavior
      // Clients should default to showing the dealing animation when they
      // first receive dealt cards from the server. Set `dealComplete` to
      // false here so clients know the deal is not finished until their
      // local animation clears it.
      dealComplete: false,
      advanceClients: false,
    };

    // mark players as "in-game"
    for (const [, p] of room.players.entries()) {
      p.status = 'in-game';
    }

    this.gameStates.set(roomId, state);
    console.log(`initGameState for room ${roomId}: p1=${state.player1Hand.length} p2=${state.player2Hand.length}`);
    return state;
  }

  getGameState(roomId) {
    return this.gameStates.get(roomId) || null;
  }

  // Player selects a card by id (authoritative)
  playerSelectCard(roomId, playerNumber, card) {
    const state = this.gameStates.get(roomId);
    if (!state) return null;
    const room = this.rooms.get(roomId);
    // keep authoritative playersConnected flag up-to-date so clients can
    // reliably determine whether both players are present (used by /equation)
    try { state.playersConnected = room ? room.players.size : 0; } catch (e) {}
    // If the room is currently transitioning to the next round (auto-next
    // scheduled) ignore new selections to avoid racing the nextRound transition.
    if (room && room.transitioning) {
      // return current state unchanged to callers so they can re-render
      // authoritative state but avoid starting a new round prematurely.
      return state;
    }

    // Use authoritative card objects from the server-side hand arrays.
    // Do not blindly accept client-provided card objects which may differ in identity/order.
    if (playerNumber === 1) {
      const found = state.player1Hand.find(c => c.id === card.id);
      state.player1SelectedCard = found || null;
    } else {
      const found = state.player2Hand.find(c => c.id === card.id);
      state.player2SelectedCard = found || null;
    }

    // If both selected, compute problem server-side
    if (state.player1SelectedCard && state.player2SelectedCard) {
      const a = state.player1SelectedCard.value;
      const b = state.player2SelectedCard.value;
      const correctAnswer = a * b;
      const answerOptions = (() => {
        const opts = new Set();
        opts.add(correctAnswer);
        while (opts.size < 4) {
          const offset = Math.floor(Math.random() * 20) + 1;
          const wrong = correctAnswer + (Math.random() > 0.5 ? offset : -offset);
          opts.add(Math.max(1, wrong));
        }
        return Array.from(opts).sort(() => Math.random() - 0.5);
      })();

      state.currentProblem = { a, b };
      state.correctAnswer = correctAnswer;
      state.answerOptions = answerOptions;
      state.roundInProgress = true;
      state.problemSolved = false;
      state.solvedBy = null;
      // reset answered flags when a new problem starts
      state.player1Answered = false;
      state.player2Answered = false;
      // clear any previously submitted answers when a fresh problem begins
      state.submittedAnswers = { 1: null, 2: null };
      // Set revealEquation flag so frontend unmasks equation/answers
      state.revealEquation = true;
    } else {
      // Mask equation/answers until both players have selected
      state.revealEquation = false;
    }

    return state;
  }

  // Player submits an answer; server validates and updates scores
  playerSubmitAnswer(roomId, playerNumber, answer) {
    const state = this.gameStates.get(roomId);
    if (!state) return null;
    const room = this.rooms.get(roomId);
    // keep playersConnected current for authoritative replies
    try { state.playersConnected = room ? room.players.size : 0; } catch (e) {}
    if (!state.roundInProgress || state.problemSolved) return state;

    const isCorrect = answer === state.correctAnswer;

    // mark that this player has answered (do not expose their chosen answer to the other player)
    if (playerNumber === 1) state.player1Answered = true;
    else state.player2Answered = true;
    // record the exact submitted answer value for deterministic client rendering
    try {
      if (!state.submittedAnswers) state.submittedAnswers = { 1: null, 2: null };
      state.submittedAnswers[playerNumber] = answer;
    } catch (err) {
      // non-fatal; do not block normal flow if submittedAnswers structure is unexpected
    }

    if (isCorrect) {
      // correct: award point, mark solved
      if (playerNumber === 1) state.player1Score += 1;
      else state.player2Score += 1;
      state.problemSolved = true;
      state.solvedBy = playerNumber;
      // record history entry
      try {
        state.history.push({
          a: state.currentProblem && state.currentProblem.a,
          b: state.currentProblem && state.currentProblem.b,
          correctAnswer: state.correctAnswer,
          solvedBy: playerNumber,
          timestamp: Date.now(),
        });
      } catch (err) {
        // ignore history push errors
      }
      return { state, isCorrect };
    }

    // wrong answer: if the other player already answered and also wrong, conclude the problem (no points)
    const otherAnswered = playerNumber === 1 ? state.player2Answered : state.player1Answered;
    if (otherAnswered) {
      // both have answered (and since we are here, both wrong) -> reveal correct answer but no score
      state.problemSolved = true;
      state.solvedBy = null;
      // record history entry for both-wrong
      try {
        state.history.push({
          a: state.currentProblem && state.currentProblem.a,
          b: state.currentProblem && state.currentProblem.b,
          correctAnswer: state.correctAnswer,
          solvedBy: null,
          timestamp: Date.now(),
        });
      } catch (err) {}
      return { state, isCorrect };
    }

    // Otherwise, only mark that this player has answered; wait for the other player to answer.
    return { state, isCorrect };
  }

  // Advance to next round: remove selected cards, reset selections/problems
  nextRound(roomId) {
    const state = this.gameStates.get(roomId);
    if (!state) return null;

    if (state.player1SelectedCard) {
      state.player1Hand = state.player1Hand.filter(c => c.id !== state.player1SelectedCard.id);
    }
    if (state.player2SelectedCard) {
      state.player2Hand = state.player2Hand.filter(c => c.id !== state.player2SelectedCard.id);
    }

    const gameOver = state.player1Hand.length === 0 || state.player2Hand.length === 0;
    state.gameOver = gameOver;
    if (gameOver) {
      if (state.player1Score > state.player2Score) state.winner = 'player1';
      else if (state.player2Score > state.player1Score) state.winner = 'player2';
      else state.winner = null;
    }

    state.player1SelectedCard = null;
    state.player2SelectedCard = null;
  state.player1Answered = false;
  state.player2Answered = false;
    // clear submitted answers between rounds
    state.submittedAnswers = { 1: null, 2: null };
    state.currentProblem = null;
    state.answerOptions = [];
    state.correctAnswer = 0;
    state.problemSolved = false;
    state.solvedBy = null;
    state.roundInProgress = false;
  // After advancing the round there is no active equation to show
  // until both players select new cards and the server generates a
  // new problem. Ensure revealEquation is reset to false so clients
  // don't linger on /equation due to a stale reveal flag.
  try { state.revealEquation = false; } catch (e) {}

    // Ensure UI control flags are explicit on each authoritative nextRound
    // Clients should treat `dealComplete` as whether a local deal animation
    // is finished. After advancing a round (cards removed), there is no
    // active dealing animation to perform — mark dealComplete true so
    // clients stop any dealing overlays unless they start a fresh deal.
    try { state.dealComplete = true; } catch (e) {}
    // When nextRound runs on the server it means the server has advanced
    // authoritative state and clients may safely advance their local views.
    try { state.advanceClients = true; } catch (e) {}
    try {
      const room = this.rooms.get(roomId);
      state.playersConnected = room ? room.players.size : 0;
    } catch (e) {}

    console.log(`nextRound for room ${roomId}: p1=${state.player1Hand.length} p2=${state.player2Hand.length} gameOver=${state.gameOver}`);
    return state;
  }

  resetGameState(roomId) {
    // Reset authoritative state and ensure control flags are explicit
    this.gameStates.delete(roomId);
    const s = this.initGameState(roomId);
    try {
      if (s) {
        s.dealComplete = false; // fresh deal in progress (clients should animate)
        s.advanceClients = false; // do not auto-advance clients on reset
      }
    } catch (e) {}
    return s;
  }

  leaveRoomBySocket(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.players.has(socketId)) {
        // mark the leaving player's status as 'left' if possible then remove
        const player = room.players.get(socketId);
        if (player) player.status = 'left';
        room.players.delete(socketId);
        const remaining = room.players.size;
        if (remaining === 0) {
          // No players remain — immediately remove the room so it doesn't linger.
          // Also remove any authoritative game state for this room.
          try {
            this.rooms.delete(roomId);
          } catch (e) { /* ignore deletion errors */ }
          try { this.gameStates.delete(roomId); } catch (e) { /* ignore */ }
          return { roomId, deleted: true, remaining };
        }
        // When there are remaining players, ensure lastEmptyAt is cleared
        if (room.lastEmptyAt) delete room.lastEmptyAt;
        return { roomId, deleted: false, remaining };
      }
    }
    return null;
  }

  // Allow updating a player's status inside a room (e.g., 'lobby' | 'in-game' | 'left')
  setPlayerStatus(roomId, socketId, status) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const p = room.players.get(socketId);
    if (!p) return false;
    p.status = status;
    return true;
  }

  findRoomBySocket(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.players.has(socketId)) {
        return { roomId, room, player: room.players.get(socketId) };
      }
    }
    return null;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  listRooms() {
    const out = [];
    for (const [roomId, room] of this.rooms.entries()) {
      // collect which player numbers are present
      const present = [];
      const statuses = [];
      for (const [, p] of room.players.entries()) {
        if (p && p.playerNumber) present.push(p.playerNumber);
        statuses.push({ playerNumber: p.playerNumber, status: p.status || 'lobby' });
      }
      out.push({
        roomId,
        name: room.name || null,
        players: room.players.size,
        playersPresent: present,
        playersStatus: statuses,
        lastEmptyAt: room.lastEmptyAt || null,
        difficulty: room.difficulty || 'easy',
        initialCards: room.initialCards || null,
        options: room.options || { difficulty: room.difficulty || 'easy', initialCards: room.initialCards || null }
      });
    }
    return out;
  }

  // Garbage-collect rooms that have been empty longer than roomTTLMs
  garbageCollectRooms() {
    const now = Date.now();
    const removed = [];
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.players.size === 0 && room.lastEmptyAt) {
        if (now - room.lastEmptyAt > this.roomTTLMs) {
          this.rooms.delete(roomId);
          this.gameStates.delete(roomId);
          removed.push(roomId);
        }
      }
    }
    return removed;
  }
}

module.exports = RoomManager;
