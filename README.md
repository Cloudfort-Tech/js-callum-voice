# Callum Voice Web

Real-time voice chat SDK for web browsers. Connects to the Callum voice service over WebSocket, captures microphone audio via **AudioWorklet**, and plays back remote peer audio with proper device routing.

## Features

- **AudioWorklet** mic capture and playback mixing (no separate worker files needed)
- **Automatic reconnection** with room/mic state restoration
- **Peer speaking detection** via RMS analysis
- **Resampling** support for mismatched sample rates
- **TypeScript** with full type definitions
- **Zero dependencies** — uses only browser Web APIs

## Install

```bash
npm install callum-voice-web
```

## Quick Start

```typescript
import { VoiceClient, createVoiceConfig } from 'callum-voice-web';

const client = new VoiceClient(createVoiceConfig({
  server: 'callem.cloudfort.ir',
  apiKey: 'vc_live_YOUR_API_KEY',
  peerId: 'user_123',
}));

client.setListener({
  onConnected: () => {
    console.log('Connected!');
    client.joinRoom('general');
  },
  onPeerJoined: (peerId) => console.log(`${peerId} joined`),
  onPeerSpeaking: (peerId) => console.log(`${peerId} is speaking`),
  onPeerStopped: (peerId) => console.log(`${peerId} stopped speaking`),
  onPeerLeft: (peerId) => console.log(`${peerId} left`),
  onError: (err) => console.error('Error:', err),
});

await client.connect();
```

## API

### `createVoiceConfig(overrides)`

Create a config with sensible defaults:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `server` | `string` | `''` | Server address (e.g. `callem.cloudfort.ir`) |
| `apiKey` | `string` | `''` | API key from account registration |
| `peerId` | `string` | `''` | Unique peer identifier |
| `useTls` | `boolean` | `undefined` | Force WSS/WS. Auto-detected when undefined |
| `sampleRate` | `number` | `48000` | Audio sample rate in Hz |
| `autoReconnect` | `boolean` | `true` | Auto reconnect on disconnect |
| `maxReconnectAttempts` | `number` | `5` | Max reconnection attempts |
| `reconnectDelayMs` | `number` | `2000` | Delay between reconnect attempts |
| `echoCancellation` | `boolean` | `true` | Browser echo cancellation |
| `noiseSuppression` | `boolean` | `true` | Browser noise suppression |
| `autoGainControl` | `boolean` | `true` | Browser auto gain control |

### `VoiceClient`

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `VoiceClientState` | Current connection state |
| `isConnected` | `boolean` | Whether connected to server |
| `isInRoom` | `boolean` | Whether joined a room |
| `isMicEnabled` | `boolean` | Whether microphone is active |
| `currentRoomId` | `string \| null` | Current room ID |
| `peerIds` | `string[]` | List of peer IDs in the room |
| `audio` | `AudioContext \| null` | AudioContext (available after `joinRoom`) |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Connect to the voice server |
| `disconnect()` | `void` | Disconnect from the server |
| `joinRoom(roomId)` | `Promise<void>` | Join a voice room |
| `leaveRoom()` | `Promise<void>` | Leave the current room |
| `enableMic()` | `Promise<void>` | Enable microphone |
| `disableMic()` | `void` | Disable microphone |
| `toggleMic()` | `Promise<boolean>` | Toggle microphone, returns new state |
| `isPeerSpeaking(peerId)` | `boolean` | Check if a peer is speaking |
| `getPeerSpeakingInfo(peerId)` | `{ speaking, rms }` | Get peer speaking state with RMS level |
| `setListener(listener)` | `void` | Set the event listener |
| `dispose()` | `void` | Dispose and release all resources |

#### Events (VoiceEventListener)

| Event | Parameters | Description |
|-------|------------|-------------|
| `onConnected` | — | Connection established |
| `onDisconnected` | — | Connection lost |
| `onReconnecting` | `attempt: number` | Reconnection attempt in progress |
| `onAuthFailed` | `reason: string` | Authentication failed |
| `onRoomJoined` | `roomId: string` | Joined a room |
| `onRoomLeft` | `roomId: string` | Left a room |
| `onPeerJoined` | `peerId: string` | New peer joined |
| `onPeerLeft` | `peerId: string` | Peer left |
| `onPeerSpeaking` | `peerId: string` | Peer started speaking |
| `onPeerStopped` | `peerId: string` | Peer stopped speaking |
| `onMicEnabled` | — | Microphone enabled |
| `onMicDisabled` | — | Microphone disabled |
| `onError` | `error: Error` | Error occurred |
| `onStateChanged` | `state: VoiceClientState` | Connection state changed |

### `VoiceClientState` Enum

```typescript
enum VoiceClientState {
  Disconnected = 0,
  Connecting = 1,
  Connected = 2,
  InRoom = 3,
  Reconnecting = 4,
}
```

## Speaker Routing

Use the `audio` property to route output to a specific device:

```typescript
await client.joinRoom('general');

// Route to a specific speaker
const devices = await navigator.mediaDevices.enumerateDevices();
const speaker = devices.find(d => d.kind === 'audiooutput');
if (speaker) {
  await client.audio.setSinkId(speaker.deviceId);
}
```

## Protocol

- **WebSocket**: Binary PCM audio at 16-bit signed integer, mono, 48000 Hz
- **Packet format**: `[1B RoomLen][RoomID][1B PeerLen][PeerID][PCM Audio]`
- **Speaking detection**: RMS threshold 0.012, checked every 80ms
- **Auth failure**: WebSocket close codes 1008 / 4001

## Build

```bash
npm install
npm run build
```

## License

MIT
