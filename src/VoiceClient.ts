// Copyright Cloudfort. All Rights Reserved.

import { VoiceClientState } from './VoiceClientState';
import { VoiceConfig } from './VoiceConfig';
import { VoiceEventListener } from './VoiceEventListener';
import {
  CAPTURE_PROCESSOR_SOURCE,
  PLAYBACK_PROCESSOR_SOURCE,
  createWorkletBlobUrl,
} from './worklets';

// ── Constants ────────────────────────────────────────────────────────
const SPEAKING_CHECK_INTERVAL_MS = 80;
const SPEAKING_RMS_THRESHOLD = 0.012;
const PEER_RING_CAPACITY = 96000; // ~2s at 48 kHz

// ── Peer State ───────────────────────────────────────────────────────

interface PeerState {
  peerId: string;
  isSpeaking: boolean;
  rmsLevel: number;
  lastSamples: Float32Array | null;
}

function createPeerState(peerId: string): PeerState {
  return {
    peerId,
    isSpeaking: false,
    rmsLevel: 0,
    lastSamples: null,
  };
}

// ── VoiceClient ──────────────────────────────────────────────────────

/**
 * Browser voice-chat client using Web Audio API and AudioWorklet.
 *
 * Connects to the Go voice service over WebSocket, captures microphone audio
 * via AudioWorklet, and plays back remote peer audio with proper device routing.
 *
 * @example
 * ```ts
 * import { VoiceClient, createVoiceConfig } from 'callum-voice-web';
 *
 * const client = new VoiceClient(createVoiceConfig({
 *   server: 'callem.cloudfort.ir',
 *   apiKey: 'vc_live_...',
 *   peerId: 'user_123',
 * }));
 *
 * client.setListener({
 *   onConnected: () => console.log('Connected!'),
 *   onPeerSpeaking: (id) => console.log(`${id} is speaking`),
 * });
 *
 * await client.connect();
 * await client.joinRoom('game_room_1');
 * await client.enableMic();
 * ```
 */
export class VoiceClient {
  private readonly config: VoiceConfig;
  private listener: VoiceEventListener | null = null;

  // WebSocket
  private ws: WebSocket | null = null;
  private _state: VoiceClientState = VoiceClientState.Disconnected;
  private currentRoom: string | null = null;
  private micEnabled = false;
  private reconnectAttempts = 0;
  private prevRoom: string | null = null;
  private prevMicEnabled = false;

  // Audio
  private audioContext: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private captureGain: GainNode | null = null;
  private playbackNode: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private serverSampleRate = 48000;

  // Worklet blob URLs (cached)
  private captureBlobUrl: string | null = null;
  private playbackBlobUrl: string | null = null;

  // Peers & speaking
  private peers: Map<string, PeerState> = new Map();
  private speakingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VoiceConfig) {
    this.config = config;
    this.serverSampleRate = config.sampleRate;
  }

  // ── Public Properties ────────────────────────────────────────────

  /** Current connection state */
  get state(): VoiceClientState {
    return this._state;
  }

  /** Whether connected to server */
  get isConnected(): boolean {
    return this._state >= VoiceClientState.Connected;
  }

  /** Whether joined a room */
  get isInRoom(): boolean {
    return this._state === VoiceClientState.InRoom;
  }

  /** Whether microphone is active */
  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  /** Current room ID (null if not in room) */
  get currentRoomId(): string | null {
    return this.currentRoom;
  }

  /** List of peer IDs in the current room */
  get peerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  /**
   * AudioContext used for playback and mic capture.
   * Available after joinRoom(). Useful for setSinkId() speaker routing.
   */
  get audio(): AudioContext | null {
    return this.audioContext;
  }

  // ── Listener ─────────────────────────────────────────────────────

  /** Set the event listener */
  setListener(listener: VoiceEventListener | null): void {
    this.listener = listener;
  }

  // ── Connection ───────────────────────────────────────────────────

  /** Connect to the voice server */
  async connect(): Promise<void> {
    if (this._state >= VoiceClientState.Connected) return;

    this.setState(VoiceClientState.Connecting);

    const scheme = this.resolveScheme();
    const url =
      `${scheme}://${this.config.server}/ws` +
      `?room=__lobby__` +
      `&peer=${encodeURIComponent(this.config.peerId)}` +
      `&api_key=${encodeURIComponent(this.config.apiKey)}`;

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.handleWebSocketConnected();
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          if (event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(new Uint8Array(event.data));
          }
        };

        this.ws.onclose = (event: CloseEvent) => {
          this.handleClose(event.code, event.reason);
          this.handleDisconnect();
        };

        this.ws.onerror = () => {
          this.raiseError(new Error('WebSocket error'));
          if (this._state < VoiceClientState.Connected) {
            reject(new Error('WebSocket connection failed'));
          }
        };
      } catch (e) {
        this.raiseError(e instanceof Error ? e : new Error(String(e)));
        this.setState(VoiceClientState.Disconnected);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Disconnect from the server */
  disconnect(): void {
    this.config.autoReconnect = false;
    this.cleanup();
    this.setState(VoiceClientState.Disconnected);
    this.listener?.onDisconnected?.();
  }

  // ── Room Management ──────────────────────────────────────────────

  /** Join a voice room */
  async joinRoom(roomId: string): Promise<void> {
    if (this._state < VoiceClientState.Connected) {
      this.raiseError(new Error('Not connected'));
      return;
    }

    if (this.currentRoom !== null) {
      await this.leaveRoom();
    }

    // Create AudioContext
    try {
      this.audioContext = new AudioContext({ sampleRate: this.config.sampleRate });
    } catch {
      this.audioContext = new AudioContext();
    }
    this.serverSampleRate = this.audioContext.sampleRate;

    // Setup playback worklet
    await this.setupPlaybackChain();

    // Tell server we joined
    this.sendText(
      JSON.stringify({
        type: 'join',
        room: roomId,
        peer: this.config.peerId,
        sampleRate: this.serverSampleRate,
      }),
    );

    this.currentRoom = roomId;
    this.setState(VoiceClientState.InRoom);

    // Start speaking detection
    this.startSpeakingDetection();

    this.listener?.onRoomJoined?.(roomId);
  }

  /** Leave the current room */
  async leaveRoom(): Promise<void> {
    if (this.currentRoom === null) return;

    this.stopMic();
    this.stopSpeakingDetection();

    // Notify peers leaving
    const peerIds = Array.from(this.peers.keys());
    this.peers.clear();
    for (const peerId of peerIds) {
      this.listener?.onPeerLeft?.(peerId);
    }

    // Cleanup playback worklet
    if (this.playbackNode) {
      try {
        this.playbackNode.port.postMessage({ type: 'clear' });
        this.playbackNode.disconnect();
      } catch {
        // ignore
      }
      this.playbackNode = null;
    }

    // Close audio context
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }

    const room = this.currentRoom;
    this.currentRoom = null;
    this.setState(VoiceClientState.Connected);
    this.listener?.onRoomLeft?.(room);
  }

  // ── Microphone Control ───────────────────────────────────────────

  /** Enable microphone (must be in a room) */
  async enableMic(): Promise<void> {
    if (this.micEnabled) return;
    if (this._state !== VoiceClientState.InRoom) {
      this.raiseError(new Error('Must be in a room to enable mic'));
      return;
    }

    try {
      if (this.audioContext!.state === 'suspended') {
        await this.audioContext!.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.config.echoCancellation,
          noiseSuppression: this.config.noiseSuppression,
          autoGainControl: this.config.autoGainControl,
          sampleRate: this.config.sampleRate,
          channelCount: 1,
        },
      });

      this.micStream = stream;
      const source = this.audioContext!.createMediaStreamSource(stream);

      // Load capture worklet (create blob URL once, reuse)
      if (!this.captureBlobUrl) {
        this.captureBlobUrl = createWorkletBlobUrl(CAPTURE_PROCESSOR_SOURCE);
      }
      await this.audioContext!.audioWorklet.addModule(this.captureBlobUrl);

      this.captureNode = new AudioWorkletNode(this.audioContext!, 'callum-capture-processor');
      this.captureNode.port.onmessage = (e: MessageEvent) => {
        if (!this.micEnabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const pcm = this.floatToPcm16(e.data as Float32Array);
        this.ws.send(pcm);
      };

      source.connect(this.captureNode);
      // Silent gain to keep audio graph alive
      this.captureGain = this.audioContext!.createGain();
      this.captureGain.gain.value = 0;
      this.captureNode.connect(this.captureGain);
      this.captureGain.connect(this.audioContext!.destination);

      this.micEnabled = true;
      this.listener?.onMicEnabled?.();
    } catch (err) {
      this.raiseError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Disable microphone */
  disableMic(): void {
    if (!this.micEnabled) return;
    this.stopMic();
    this.listener?.onMicDisabled?.();
  }

  /** Toggle microphone, returns new state */
  async toggleMic(): Promise<boolean> {
    if (this.micEnabled) {
      this.disableMic();
      return false;
    }
    await this.enableMic();
    return true;
  }

  // ── Speaking Detection ───────────────────────────────────────────

  /** Check if a specific peer is speaking */
  isPeerSpeaking(peerId: string): boolean {
    return this.peers.get(peerId)?.isSpeaking ?? false;
  }

  /** Get peer speaking state with RMS level */
  getPeerSpeakingInfo(peerId: string): { speaking: boolean; rms: number } {
    const peer = this.peers.get(peerId);
    if (!peer) return { speaking: false, rms: 0 };
    return { speaking: peer.isSpeaking, rms: peer.rmsLevel };
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  /** Dispose and release all resources */
  dispose(): void {
    this.config.autoReconnect = false;
    this.cleanup();

    // Revoke blob URLs
    if (this.captureBlobUrl) {
      URL.revokeObjectURL(this.captureBlobUrl);
      this.captureBlobUrl = null;
    }
    if (this.playbackBlobUrl) {
      URL.revokeObjectURL(this.playbackBlobUrl);
      this.playbackBlobUrl = null;
    }
  }

  // ── Private: WebSocket Event Handlers ────────────────────────────

  private handleWebSocketConnected(): void {
    this.setState(VoiceClientState.Connected);
    this.reconnectAttempts = 0;
    this.listener?.onConnected?.();

    // Re-join room if we were in one before disconnect
    if (this.prevRoom !== null) {
      const restoreMic = this.prevMicEnabled;
      const room = this.prevRoom;
      this.prevRoom = null;
      this.prevMicEnabled = false;

      this.joinRoom(room)
        .then(() => {
          if (restoreMic) {
            this.enableMic();
          }
        })
        .catch((e) => {
          this.raiseError(e instanceof Error ? e : new Error(String(e)));
        });
    }
  }

  // ── Private: Binary Packet Parsing ───────────────────────────────
  // Format: [1B RoomLen][RoomID][1B PeerLen][PeerID][PCM Audio Data]

  private handleBinaryMessage(data: Uint8Array): void {
    if (data.length < 4) return;

    const roomLen = data[0];
    if (data.length < 2 + roomLen) return;

    const peerLen = data[1 + roomLen];
    if (data.length < 2 + roomLen + peerLen) return;

    const peerIdBytes = data.slice(2 + roomLen, 2 + roomLen + peerLen);
    const peerId = new TextDecoder().decode(peerIdBytes);

    if (peerId === this.config.peerId) return; // ignore own echo

    const audioOffset = 2 + roomLen + peerLen;
    const audioLen = data.length - audioOffset;
    if (audioLen === 0) return;

    // Convert PCM bytes → Float32
    const samples = this.pcm16ToFloat(data.slice(audioOffset));
    this.handlePeerAudio(peerId, samples);
  }

  private handlePeerAudio(peerId: string, samples: Float32Array): void {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = createPeerState(peerId);
      this.peers.set(peerId, peer);
      this.listener?.onPeerJoined?.(peerId);
    }

    // Resample if needed
    let resampled = samples;
    if (this.serverSampleRate !== this.audioContext?.sampleRate) {
      resampled = this.resample(
        samples,
        this.serverSampleRate,
        this.audioContext!.sampleRate,
      );
    }

    // Store for speaking detection
    peer.lastSamples = resampled;

    // Forward to playback worklet
    if (this.playbackNode) {
      this.playbackNode.port.postMessage({ type: 'audio', peerId, samples: resampled });
    }
  }

  // ── Private: Audio Chain Setup ───────────────────────────────────

  private async setupPlaybackChain(): Promise<void> {
    if (this.playbackNode) return;

    // Create playback blob URL once
    if (!this.playbackBlobUrl) {
      this.playbackBlobUrl = createWorkletBlobUrl(PLAYBACK_PROCESSOR_SOURCE);
    }

    try {
      await this.audioContext!.audioWorklet.addModule(this.playbackBlobUrl);
      this.playbackNode = new AudioWorkletNode(
        this.audioContext!,
        'callum-playback-processor',
      );
      this.playbackNode.connect(this.audioContext!.destination);
    } catch (e) {
      this.raiseError(
        new Error(`Failed to setup playback worklet: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  // ── Private: Audio Conversion ────────────────────────────────────

  /** Convert Float32 [-1..1] to 16-bit PCM ArrayBuffer */
  private floatToPcm16(floats: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(floats.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  /** Convert 16-bit PCM Uint8Array to Float32 [-1..1] */
  private pcm16ToFloat(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes.byteLength / 2;
    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      output[i] = view.getInt16(i * 2, true) / 32768.0;
    }
    return output;
  }

  /** Linear interpolation resampler */
  private resample(source: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return source;
    const ratio = fromRate / toRate;
    const outputLength = Math.round(source.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, source.length - 1);
      const frac = srcIndex - low;
      output[i] = source[low] * (1 - frac) + source[high] * frac;
    }
    return output;
  }

  // ── Private: Speaking Detection ──────────────────────────────────

  private startSpeakingDetection(): void {
    if (this.speakingTimer) return;

    this.speakingTimer = setInterval(() => {
      for (const [peerId, peer] of this.peers) {
        const samples = peer.lastSamples;
        let rms = 0;
        if (samples && samples.length > 0) {
          let sum = 0;
          for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
          }
          rms = Math.sqrt(sum / samples.length);
        }

        const wasSpeaking = peer.isSpeaking;
        const isSpeaking = rms > SPEAKING_RMS_THRESHOLD;

        if (isSpeaking !== wasSpeaking) {
          peer.isSpeaking = isSpeaking;
          if (isSpeaking) {
            this.listener?.onPeerSpeaking?.(peerId);
          } else {
            this.listener?.onPeerStopped?.(peerId);
          }
        }

        peer.rmsLevel = rms;
      }
    }, SPEAKING_CHECK_INTERVAL_MS);
  }

  private stopSpeakingDetection(): void {
    if (this.speakingTimer !== null) {
      clearInterval(this.speakingTimer);
      this.speakingTimer = null;
    }
  }

  // ── Private: Close / Disconnect / Reconnect ──────────────────────

  private handleClose(code: number, reason: string): void {
    // Close codes 1008 / 4001 indicate auth failure
    if (code === 1008 || code === 4001) {
      this.listener?.onAuthFailed?.(reason || 'Authentication failed');
      this.config.autoReconnect = false;
    }
  }

  private handleDisconnect(): void {
    const wasConnected = this._state >= VoiceClientState.Connected;

    // Save state for reconnect restoration
    this.prevRoom = this.currentRoom;
    this.prevMicEnabled = this.micEnabled;

    this.cleanup();

    if (!wasConnected) return;

    this.setState(VoiceClientState.Disconnected);
    this.listener?.onDisconnected?.();

    if (
      this.config.autoReconnect &&
      this.reconnectAttempts < this.config.maxReconnectAttempts
    ) {
      this.reconnectAttempts++;
      this.setState(VoiceClientState.Reconnecting);
      this.listener?.onReconnecting?.(this.reconnectAttempts);

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {
          // error already reported via listener
        });
      }, this.config.reconnectDelayMs);
    }
  }

  // ── Private: Send Helpers ────────────────────────────────────────

  private sendText(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(text);
    }
  }

  // ── Private: Cleanup ─────────────────────────────────────────────

  private cleanup(): void {
    this.stopMic();
    this.stopSpeakingDetection();

    // Clear playback worklet
    if (this.playbackNode) {
      try {
        this.playbackNode.port.postMessage({ type: 'clear' });
        this.playbackNode.disconnect();
      } catch {
        // ignore
      }
      this.playbackNode = null;
    }

    // Clear peers
    const peerIds = Array.from(this.peers.keys());
    this.peers.clear();
    for (const peerId of peerIds) {
      this.listener?.onPeerLeft?.(peerId);
    }

    // Close audio context
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }

    // Close WebSocket
    if (this.ws) {
      try {
        this.ws.close(1000, 'bye');
      } catch {
        // ignore
      }
      this.ws = null;
    }

    // Clear reconnect timer
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.currentRoom = null;
  }

  private stopMic(): void {
    if (!this.micEnabled) return;

    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
    }
    if (this.captureNode) {
      try {
        this.captureNode.port.onmessage = null;
        this.captureNode.disconnect();
      } catch {
        // ignore
      }
    }
    if (this.captureGain) {
      try {
        this.captureGain.disconnect();
      } catch {
        // ignore
      }
    }

    this.micStream = null;
    this.captureNode = null;
    this.captureGain = null;
    this.micEnabled = false;
  }

  // ── Private: Helpers ─────────────────────────────────────────────

  private resolveScheme(): string {
    if (this.config.useTls === true) return 'wss';
    if (this.config.useTls === false) return 'ws';
    // Auto-detect from current page
    if (typeof location !== 'undefined' && location.protocol === 'https:') return 'wss';
    return 'ws';
  }

  private setState(newState: VoiceClientState): void {
    if (this._state === newState) return;
    this._state = newState;
    this.listener?.onStateChanged?.(newState);
  }

  private raiseError(error: Error): void {
    this.listener?.onError?.(error);
  }
}
