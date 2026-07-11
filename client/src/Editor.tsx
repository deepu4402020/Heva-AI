import { useEffect, useRef, useState } from 'react';
import Quill from 'quill';
import QuillCursors from 'quill-cursors';
import Delta from 'quill-delta';
import 'quill/dist/quill.snow.css';
import { v4 as uuidv4 } from 'uuid';
import { Document as CRDTDocument } from './crdt';

Quill.register('modules/cursors', QuillCursors);

function isEqual(obj1: any, obj2: any) {
  return JSON.stringify(obj1) === JSON.stringify(obj2);
}

export default function Editor({ roomId, userName }: { roomId: string, userName: string }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const crdtRef = useRef<CRDTDocument>(new CRDTDocument(uuidv4()));
  const offlineQueue = useRef<any[]>([]);
  const cursorsRef = useRef<any>(null);
  const isSyncingRef = useRef(false);

  const [presence, setPresence] = useState<any[]>([]);
  const [status, setStatus] = useState<string>('Connecting...');

  useEffect(() => {
    if (!editorRef.current) return;
    if (quillRef.current) return; // Prevent double init in strict mode
    
    const quill = new Quill(editorRef.current, {
      theme: 'snow',
      modules: {
        cursors: true,
        toolbar: [
          ['bold', 'italic'],
          [{ 'header': 1 }, { 'header': 2 }],
          [{ 'list': 'bullet' }],
          ['code']
        ]
      }
    });
    quillRef.current = quill;
    cursorsRef.current = quill.getModule('cursors');

    let ws: WebSocket;
    
    const connect = () => {
      setStatus('Connecting...');
      // Allow passing a different WS URL via environment if deployed
      const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('Online');
        ws.send(JSON.stringify({
          type: 'join',
          roomId,
          siteId: crdtRef.current.siteId,
          name: userName
        }));

        // Flush offline queue
        while (offlineQueue.current.length > 0) {
          ws.send(JSON.stringify(offlineQueue.current.shift()));
        }

        // Request peer sync for initial state
        ws.send(JSON.stringify({ type: 'sync-request' }));
      };

      ws.onclose = () => {
        setStatus('Offline (Changes saved locally)');
        // Auto-reconnect after 2 seconds
        setTimeout(connect, 2000);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
          // Re-affirm join with our siteId in case the server generated a new one
          ws.send(JSON.stringify({ type: 'join', roomId, siteId: crdtRef.current.siteId, name: userName }));
        } else if (msg.type === 'presence') {
          setPresence(msg.data);
          msg.data.forEach((p: any) => {
            if (p.siteId !== crdtRef.current.siteId && p.cursorPosition !== null && p.cursorPosition !== undefined) {
              try {
                cursorsRef.current.createCursor(p.siteId, p.name, 'blue');
                cursorsRef.current.moveCursor(p.siteId, { index: p.cursorPosition, length: 0 });
                cursorsRef.current.toggleFlag(p.siteId, true);
              } catch (e) {
                // Ignore cursor errors (e.g. index out of bounds while syncing)
              }
            }
          });
        } else if (msg.type === 'sync-request') {
          // Send our state to the peer
          ws.send(JSON.stringify({
            type: 'sync-response',
            state: crdtRef.current.serialize()
          }));
        } else if (msg.type === 'sync-response') {
          // Load peer state (merges into our own)
          const cursor = captureCursor();
          crdtRef.current.loadState(msg.state);
          rebuildEditorFromCRDT(cursor);
        } else if (msg.type === 'insert' || msg.type === 'delete' || msg.type === 'format') {
          const cursor = captureCursor();
          crdtRef.current.applyRemoteOp(msg);
          rebuildEditorFromCRDT(cursor);
        }
      };
    };

    connect();

    const sendOp = (op: any) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(op));
      } else {
        offlineQueue.current.push(op);
      }
    };

    quill.on('text-change', (delta, _oldDelta, source) => {
      if (source !== 'user' || isSyncingRef.current) return;
      
      let crdtIndex = 0;
      for (const op of delta.ops) {
        if (op.retain) {
          const retainCount = op.retain as number;
          if (op.attributes) {
            for (const key of Object.keys(op.attributes)) {
              const formatOp = crdtRef.current.localFormat(crdtIndex, crdtIndex + retainCount - 1, key, op.attributes[key]);
              if (formatOp) sendOp(formatOp);
            }
          }
          crdtIndex += retainCount;
        } else if (op.delete) {
          const deleteCount = op.delete as number;
          for (let i = 0; i < deleteCount; i++) {
            const delOp = crdtRef.current.localDelete(crdtIndex);
            if (delOp) sendOp(delOp);
          }
        } else if (op.insert) {
          if (typeof op.insert === 'string') {
            for (let i = 0; i < op.insert.length; i++) {
              const char = op.insert[i];
              const insOp = crdtRef.current.localInsert(crdtIndex, char);
              sendOp(insOp);
              
              if (op.attributes) {
                for (const key of Object.keys(op.attributes)) {
                  const formatOp = crdtRef.current.localFormat(crdtIndex, crdtIndex, key, op.attributes[key]);
                  if (formatOp) sendOp(formatOp);
                }
              }
              crdtIndex++;
            }
          } else {
            // e.g. images (not handled)
            crdtIndex++;
          }
        }
      }
    });

    quill.on('selection-change', (range) => {
      if (range) {
        sendOp({ type: 'cursor', cursorPosition: range.index });
      }
    });

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [roomId, userName]);

  function captureCursor() {
    const quill = quillRef.current;
    if (!quill) return null;
    const sel = quill.getSelection();
    if (!sel) return null;
    
    let cursorId: any = null;
    let cursorOffset = 0;
    const visible = crdtRef.current.getVisibleCharacters();
    if (sel.index < visible.length) {
      cursorId = visible[sel.index].id;
    } else if (visible.length > 0) {
      cursorId = visible[visible.length - 1].id;
      cursorOffset = 1;
    }
    return { cursorId, cursorOffset, length: sel.length };
  }

  function rebuildEditorFromCRDT(savedCursor?: any) {
    isSyncingRef.current = true;
    const quill = quillRef.current;
    if (!quill) return;

    // Build full Delta from CRDT
    const formatted = crdtRef.current.getFormattedText();
    const delta = new Delta();
    
    if (formatted.length > 0) {
      let currentStr = formatted[0].char;
      let currentFormats = formatted[0].formats;
      
      for (let i = 1; i < formatted.length; i++) {
        if (isEqual(currentFormats, formatted[i].formats)) {
          currentStr += formatted[i].char;
        } else {
          delta.insert(currentStr, Object.keys(currentFormats).length > 0 ? currentFormats : undefined);
          currentStr = formatted[i].char;
          currentFormats = formatted[i].formats;
        }
      }
      delta.insert(currentStr, Object.keys(currentFormats).length > 0 ? currentFormats : undefined);
    }
    
    // Add trailing newline if missing (Quill requires document to end with \n)
    if (formatted.length === 0 || formatted[formatted.length - 1].char !== '\n') {
      delta.insert('\n');
    }
    
    quill.setContents(delta, 'api');

    // Restore selection
    if (savedCursor && savedCursor.cursorId) {
      const visible = crdtRef.current.getVisibleCharacters();
      const idx = visible.findIndex(c => JSON.stringify(c.id) === JSON.stringify(savedCursor.cursorId));
      if (idx !== -1) {
        quill.setSelection(idx + savedCursor.cursorOffset, savedCursor.length || 0, 'api');
      }
    }
    isSyncingRef.current = false;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      <div style={{ width: '250px', borderRight: '1px solid #e0e0e0', padding: '20px', background: '#f9f9f9' }}>
        <h2>Presence</h2>
        <p style={{ color: status === 'Online' ? 'green' : 'red', fontWeight: 'bold' }}>{status}</p>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {presence.map((p, i) => (
            <li key={i} style={{ padding: '8px 0', borderBottom: '1px solid #eee', fontSize: '14px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: p.siteId === crdtRef.current.siteId ? 'green' : 'blue', marginRight: '8px' }}></span>
              {p.name} {p.siteId === crdtRef.current.siteId ? '(You)' : ''}
              {p.cursorPosition !== null && p.cursorPosition !== undefined && (
                <span style={{ display: 'block', color: '#888', marginLeft: '18px', marginTop: '4px', fontSize: '12px' }}>
                  Pos: {p.cursorPosition}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ flex: 1, padding: '40px', background: '#fff' }}>
        <h1 style={{ marginBottom: '20px' }}>Document: {roomId}</h1>
        <div ref={editorRef} style={{ height: '70vh' }} />
      </div>
    </div>
  );
}
