// roomManager.js
// All room state lives here in-process memory only.
// No database. Server restart = all rooms gone.

const { v4: uuidv4 } = require('uuid');

const MAX_VIEWERS_PER_ROOM = 50;
const ROOM_INACTIVE_MS = 2 * 60 * 60 * 1000; // 2 hours

const rooms = new Map(); // roomId -> Room

function generateRoomId() {
  // 4+4 alphanumeric, e.g. "A3BX-9KZM"
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = (n) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(4)}-${seg(4)}`;
}

function createRoom(publisherSocketId) {
  let roomId;
  do {
    roomId = generateRoomId();
  } while (rooms.has(roomId));

  const room = {
    roomId,
    publisher: publisherSocketId,
    viewers: new Set(),
    createdAt: Date.now(),
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function addViewer(roomId, viewerSocketId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: 'room-not-found' };
  if (room.viewers.size >= MAX_VIEWERS_PER_ROOM) return { ok: false, error: 'room-full' };
  room.viewers.add(viewerSocketId);
  return { ok: true };
}

function removeViewer(roomId, viewerSocketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.viewers.delete(viewerSocketId);
}

function removeRoom(roomId) {
  rooms.delete(roomId);
}

function getRoomForSocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.publisher === socketId) return { room, role: 'publisher' };
    if (room.viewers.has(socketId)) return { room, role: 'viewer' };
  }
  return null;
}

function viewerCount(roomId) {
  const room = rooms.get(roomId);
  return room ? room.viewers.size : 0;
}

// Cleanup stale rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.createdAt > ROOM_INACTIVE_MS) {
      rooms.delete(roomId);
      console.log(`[roomManager] Cleaned up stale room ${roomId}`);
    }
  }
}, 30 * 60 * 1000);

module.exports = {
  createRoom,
  getRoom,
  addViewer,
  removeViewer,
  removeRoom,
  getRoomForSocket,
  viewerCount,
};
