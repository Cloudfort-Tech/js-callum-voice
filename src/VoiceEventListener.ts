// Copyright Cloudfort. All Rights Reserved.

import { VoiceClientState } from './VoiceClientState';

/**
 * Callback interface for receiving voice client events.
 *
 * Implement only the methods you need — all methods have no-op defaults.
 *
 * @example
 * ```ts
 * const listener: VoiceEventListener = {
 *   onConnected: () => console.log('Connected!'),
 *   onPeerSpeaking: (id) => console.log(`${id} is speaking`),
 * };
 * ```
 */
export interface VoiceEventListener {
  /** Connection established */
  onConnected?(): void;

  /** Connection lost */
  onDisconnected?(): void;

  /** Reconnection attempt in progress */
  onReconnecting?(attempt: number): void;

  /** Authentication failed (close code 1008 / 4001) */
  onAuthFailed?(reason: string): void;

  /** Joined a room */
  onRoomJoined?(roomId: string): void;

  /** Left a room */
  onRoomLeft?(roomId: string): void;

  /** New peer joined the room */
  onPeerJoined?(peerId: string): void;

  /** Peer left the room */
  onPeerLeft?(peerId: string): void;

  /** Peer started speaking */
  onPeerSpeaking?(peerId: string): void;

  /** Peer stopped speaking */
  onPeerStopped?(peerId: string): void;

  /** Microphone enabled */
  onMicEnabled?(): void;

  /** Microphone disabled */
  onMicDisabled?(): void;

  /** Error occurred */
  onError?(error: Error): void;

  /** Connection state changed */
  onStateChanged?(newState: VoiceClientState): void;
}
