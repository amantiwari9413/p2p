// signaling.js
// Handles all WebSocket signaling messages.
// Only relays SDP/ICE between Publisher and Viewers. Zero media/content stored.

const {
  createRoom,
  getRoom,
  addViewer,
  removeViewer,
  removeRoom,
  getRoomForSocket,
  viewerCount,
} = require('./roomManager');

const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KB per signaling message

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(wss, socketIds, obj, excludeId = null) {
  wss.clients.forEach((client) => {
    if (client._socketId && socketIds.has(client._socketId) && client._socketId !== excludeId) {
      send(client, obj);
    }
  });
}

function getSocket(wss, socketId) {
  for (const client of wss.clients) {
    if (client._socketId === socketId) return client;
  }
  return null;
}

function handleMessage(wss, ws, raw) {
  // Size guard
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
    send(ws, { type: 'error', message: 'Message too large' });
    return;
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  const { type } = msg;

  switch (type) {
    case 'create-room': {
      const room = createRoom(ws._socketId);
      ws._roomId = room.roomId;
      ws._role = 'publisher';
      send(ws, {
        type: 'room-created',
        roomId: room.roomId,
      });
      console.log(`[signaling] Room created: ${room.roomId} by ${ws._socketId}`);
      break;
    }

    case 'join-room': {
      const { roomId } = msg;
      const room = getRoom(roomId);

      if (!room) {
        send(ws, { type: 'error', code: 'room-not-found', message: 'Room does not exist' });
        return;
      }

      const result = addViewer(roomId, ws._socketId);
      if (!result.ok) {
        send(ws, { type: 'error', code: result.error, message: result.error === 'room-full' ? 'Room is full' : 'Room not found' });
        return;
      }

      ws._roomId = roomId;
      ws._role = 'viewer';

      send(ws, {
        type: 'room-joined',
        roomId,
        viewerCount: viewerCount(roomId),
      });

      // Tell publisher that a new viewer joined
      const publisherWs = getSocket(wss, room.publisher);
      if (publisherWs) {
        send(publisherWs, {
          type: 'viewer-joined',
          viewerId: ws._socketId,
          viewerCount: viewerCount(roomId),
        });
      }

      console.log(`[signaling] Viewer ${ws._socketId} joined room ${roomId}`);
      break;
    }

    // Publisher sends offer to a specific viewer
    case 'offer': {
      const { targetId, sdp } = msg;
      const targetWs = getSocket(wss, targetId);
      if (targetWs) {
        send(targetWs, {
          type: 'offer',
          sdp,
          fromId: ws._socketId,
        });
      }
      break;
    }

    // Viewer sends answer back to publisher
    case 'answer': {
      const { targetId, sdp } = msg;
      const targetWs = getSocket(wss, targetId);
      if (targetWs) {
        send(targetWs, {
          type: 'answer',
          sdp,
          fromId: ws._socketId,
        });
      }
      break;
    }

    // ICE candidate relay (both directions)
    case 'ice-candidate': {
      const { targetId, candidate } = msg;
      const targetWs = getSocket(wss, targetId);
      if (targetWs) {
        send(targetWs, {
          type: 'ice-candidate',
          candidate,
          fromId: ws._socketId,
        });
      }
      break;
    }

    case 'leave': {
      handleDisconnect(wss, ws);
      break;
    }

    default:
      send(ws, { type: 'error', message: `Unknown message type: ${type}` });
  }
}

function handleDisconnect(wss, ws) {
  const { _socketId, _roomId, _role } = ws;
  if (!_roomId) return;

  const room = getRoom(_roomId);
  if (!room) return;

  if (_role === 'publisher') {
    // Notify all viewers
    const viewerSet = new Set(room.viewers);
    broadcast(wss, viewerSet, {
      type: 'room-closed',
      message: 'Publisher has left the room',
    });
    removeRoom(_roomId);
    console.log(`[signaling] Room ${_roomId} closed (publisher left)`);
  } else if (_role === 'viewer') {
    removeViewer(_roomId, _socketId);
    const publisherWs = getSocket(wss, room.publisher);
    if (publisherWs) {
      send(publisherWs, {
        type: 'viewer-left',
        viewerId: _socketId,
        viewerCount: viewerCount(_roomId),
      });
    }
    console.log(`[signaling] Viewer ${_socketId} left room ${_roomId}`);
  }

  ws._roomId = null;
  ws._role = null;
}

module.exports = { handleMessage, handleDisconnect };
