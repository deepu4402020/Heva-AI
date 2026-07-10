import { useState } from 'react'
import Editor from './Editor'
import './index.css'

function App() {
  const [joined, setJoined] = useState(false)
  const [userName, setUserName] = useState('User-' + Math.floor(Math.random() * 1000))
  const [roomId, setRoomId] = useState('demo-doc')

  if (!joined) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', flexDirection: 'column', gap: '10px', fontFamily: 'sans-serif' }}>
        <h1>Collaborative Editor</h1>
        <input 
          value={userName} 
          onChange={e => setUserName(e.target.value)} 
          placeholder="Your Name" 
          style={{ padding: '8px', fontSize: '16px' }} 
        />
        <input 
          value={roomId} 
          onChange={e => setRoomId(e.target.value)} 
          placeholder="Room ID" 
          style={{ padding: '8px', fontSize: '16px' }} 
        />
        <button onClick={() => setJoined(true)} style={{ padding: '10px 20px', fontSize: '16px', cursor: 'pointer' }}>
          Join Document
        </button>
      </div>
    )
  }

  return <Editor roomId={roomId} userName={userName} />
}

export default App
