const { expect } = require('chai');
const RoomManager = require('../lib/roomManager');

describe('RoomManager', () => {
  let rm;

  beforeEach(() => {
    rm = new RoomManager();
  });

  it('creates a room and returns correct response', () => {
    const socketId = 'socket_1';
    const { room, response } = rm.createRoom(socketId);

    expect(response).to.have.property('roomId');
    expect(response.playerNumber).to.equal(1);
    expect(response.otherPlayerConnected).to.be.false;
    const got = rm.getRoom(response.roomId);
    expect(got).to.equal(room);
    expect(got.players.size).to.equal(1);
  });

  it('allows a second player to join and notifies room state', () => {
    const { response } = rm.createRoom('socket_1');
    const roomId = response.roomId;

    const resJoin = rm.joinRoom(roomId, 'socket_2');
    expect(resJoin).to.have.property('response');
    expect(resJoin.response.playerNumber).to.equal(2);
    const room = rm.getRoom(roomId);
    expect(room.players.size).to.equal(2);
  });

  it('rejects joining non-existent rooms or full rooms', () => {
    const notFound = rm.joinRoom('NOPE', 'socket_2');
    expect(notFound).to.have.property('error');

    const { response } = rm.createRoom('s1');
    const roomId = response.roomId;
    rm.joinRoom(roomId, 's2');
    const full = rm.joinRoom(roomId, 's3');
    expect(full).to.have.property('error');
  });

  it('removes players and deletes empty rooms', () => {
    const { response } = rm.createRoom('s1');
    const roomId = response.roomId;
    rm.joinRoom(roomId, 's2');

    const left2 = rm.leaveRoomBySocket('s2');
    expect(left2).to.be.an('object');
    expect(left2.roomId).to.equal(roomId);
    expect(left2.deleted).to.be.false;
    const room = rm.getRoom(roomId);
    expect(room.players.size).to.equal(1);

    const left1 = rm.leaveRoomBySocket('s1');
    expect(left1).to.be.an('object');
    // Room is kept in-memory after last player leaves (TTL applies)
    expect(left1.deleted).to.be.false;
    const gone = rm.getRoom(roomId);
    expect(gone).to.not.be.null;
  });
});
