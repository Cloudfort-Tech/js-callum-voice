// Copyright Cloudfort. All Rights Reserved.

/**
 * Configuration for connecting to the voice chat service.
 */
export interface VoiceConfig {
  /** Server address (e.g. "callem.cloudfort.ir"). Do NOT include scheme or port. */
  server: string;

  /** API key obtained from account registration (vc_live_...) */
  apiKey: string;

  /** Unique identifier for this peer / user */
  peerId: string;

  /** Use WSS (TLS) instead of WS. Auto-detected when undefined. */
  useTls?: boolean;

  /** Audio sample rate in Hz (default 48000) */
  sampleRate: number;

  /** Automatically reconnect on unexpected disconnect (default true) */
  autoReconnect: boolean;

  /** Maximum reconnection attempts before giving up (default 5) */
  maxReconnectAttempts: number;

  /** Delay between reconnection attempts in milliseconds (default 2000) */
  reconnectDelayMs: number;

  /** Enable browser echo cancellation (default true) */
  echoCancellation: boolean;

  /** Enable browser noise suppression (default true) */
  noiseSuppression: boolean;

  /** Enable browser automatic gain control (default true) */
  autoGainControl: boolean;
}

/**
 * Create a VoiceConfig with sensible defaults.
 */
export function createVoiceConfig(overrides: Partial<VoiceConfig>): VoiceConfig {
  return {
    server: '',
    apiKey: '',
    peerId: '',
    sampleRate: 48000,
    autoReconnect: true,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 2000,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...overrides,
  };
}
