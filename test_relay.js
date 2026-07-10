const WebSocket = require('ws');

const ws1 = new WebSocket('ws://localhost:8080');
const ws2 = new WebSocket('ws://localhost:8080');

let welcomeCount = 0;

ws1.on('message', data => {
  const msg = JSON.parse(data.toString());
  console.log('[Client 1 Received]', msg);
  
  if (msg.type === 'welcome') {
    ws1.send(JSON.stringify({ type: 'join', roomId: 'doc1', name: 'Alice' }));
    welcomeCount++;
    checkReady();
  }
});

ws2.on('message', data => {
  const msg = JSON.parse(data.toString());
  console.log('[Client 2 Received]', msg);
  
  if (msg.type === 'welcome') {
    ws2.send(JSON.stringify({ type: 'join', roomId: 'doc1', name: 'Bob' }));
    welcomeCount++;
    checkReady();
  }
});

function checkReady() {
  if (welcomeCount === 2) {
    setTimeout(() => {
      // Both joined. Let's send an op from Alice
      console.log('\n--- Alice sends an op ---');
      ws1.send(JSON.stringify({ type: 'op', char: { value: 'A' } }));
      
      setTimeout(() => {
        // Bob moves cursor
        console.log('\n--- Bob moves cursor ---');
        ws2.send(JSON.stringify({ type: 'cursor', cursorPosition: 5 }));
        
        setTimeout(() => {
          console.log('\n--- Test finished ---');
          ws1.close();
          ws2.close();
          process.exit(0);
        }, 500);
      }, 500);
    }, 500);
  }
}
