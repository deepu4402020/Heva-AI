/**
 * WebSocket Relay Server
 * 
 * WHY NO DOCUMENT HISTORY HERE?
 * This server is intentionally designed as a dumb relay. It is never the source of truth 
 * for document content. Late joiners will get the current document state directly from an 
 * existing peer in the room via WebRTC or by relaying a state-request through this server, 
 * rather than the server attempting to re-assemble or store the CRDT ops itself.
 * This keeps the server thin, stateless, and incredibly easy to scale, leaving the heavy 
 * lifting to the client-side CRDT logic.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as crypto from 'crypto';

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const wss = new WebSocketServer({ port });

type Client = {
  ws: WebSocket;
  siteId: string;
  name: string;
  roomId: string | null;
  cursorPosition: any | null;
};

// Rooms map: roomId -> Set of Clients
const rooms = new Map<string, Set<Client>>();

function broadcastPresence(roomId: string) {
  const roomClients = rooms.get(roomId);
  if (!roomClients) return;
  
  const presenceData = Array.from(roomClients).map(c => ({
    siteId: c.siteId,
    name: c.name,
    cursorPosition: c.cursorPosition
  }));
  
  const message = JSON.stringify({ type: 'presence', data: presenceData });
  for (const client of roomClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  const client: Client = {
    ws,
    siteId: crypto.randomUUID(), // Assign siteId by default, can be overridden by client
    name: `User-${Math.floor(Math.random() * 1000)}`,
    roomId: null,
    cursorPosition: null
  };

  // Tell client their assigned ID
  ws.send(JSON.stringify({ type: 'welcome', siteId: client.siteId, name: client.name }));

  ws.on('message', (messageData) => {
    let msg: any;
    try {
      msg = JSON.parse(messageData.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'join') {
      const { roomId, siteId, name } = msg;
      
      // Override server-assigned values if provided
      if (siteId) client.siteId = siteId;
      if (name) client.name = name;
      
      // Leave current room if any
      if (client.roomId && rooms.has(client.roomId)) {
        rooms.get(client.roomId)!.delete(client);
        broadcastPresence(client.roomId);
      }
      
      client.roomId = roomId;
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId)!.add(client);
      
      broadcastPresence(roomId);
    } 
    else if (msg.type === 'cursor') {
      if (!client.roomId) return;
      client.cursorPosition = msg.cursorPosition;
      broadcastPresence(client.roomId);
    }
    else if (msg.type === 'insert' || msg.type === 'delete' || msg.type === 'format' || msg.type === 'sync-request' || msg.type === 'sync-response') {
      // Broadcast verbatim to everyone else in the room
      if (!client.roomId) return;
      
      const roomClients = rooms.get(client.roomId);
      if (roomClients) {
        // Just forward the message as-is (we don't append who sent it because op already contains siteId)
        for (const other of roomClients) {
          if (other !== client && other.ws.readyState === WebSocket.OPEN) {
            other.ws.send(messageData.toString()); 
          }
        }
      }
    }
  });

  ws.on('close', () => {
    if (client.roomId && rooms.has(client.roomId)) {
      rooms.get(client.roomId)!.delete(client);
      if (rooms.get(client.roomId)!.size === 0) {
        rooms.delete(client.roomId);
      } else {
        broadcastPresence(client.roomId);
      }
    }
  });
});

console.log(`WebSocket relay server listening on ws://localhost:${port}`);
