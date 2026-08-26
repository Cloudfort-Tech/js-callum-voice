// Copyright Cloudfort. All Rights Reserved.

/**
 * Connection state of the VoiceClient.
 */
export enum VoiceClientState {
  /** Not connected, not attempting to connect */
  Disconnected = 0,

  /** Establishing WebSocket connection */
  Connecting = 1,

  /** Connected to server, not yet in a room */
  Connected = 2,

  /** Joined a room and ready for audio */
  InRoom = 3,

  /** Attempting to reconnect after an unexpected disconnect */
  Reconnecting = 4,
}
