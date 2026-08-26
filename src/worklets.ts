// Copyright Cloudfort. All Rights Reserved.

/**
 * AudioWorklet processor source code, inlined as strings.
 * At runtime we create Blob URLs so consumers don't need to host separate files.
 */

// ── Capture processor ────────────────────────────────────────────────
// Runs on the audio rendering thread; posts Float32 samples
// back to the main thread via port.postMessage.
export const CAPTURE_PROCESSOR_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0][0];
        if (input && input.length > 0) {
            this.port.postMessage(new Float32Array(input));
        }
        return true;
    }
}
registerProcessor('callum-capture-processor', CaptureProcessor);
`;

// ── Playback processor ───────────────────────────────────────────────
// Mixes peer voice audio on the audio rendering thread for proper
// device routing (earphones, Bluetooth, speakers, etc.).
export const PLAYBACK_PROCESSOR_SOURCE = `
class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queues = new Map();

        this.port.onmessage = (e) => {
            const { type, peerId, samples } = e.data;

            if (type === 'audio') {
                let q = this.queues.get(peerId);
                if (!q) {
                    q = { buf: new Float32Array(96000), write: 0, read: 0, len: 0, cap: 96000 };
                    this.queues.set(peerId, q);
                }
                if (q.len + samples.length > q.cap) {
                    const drop = q.len + samples.length - q.cap;
                    q.read += drop;
                    q.len -= drop;
                }
                for (let i = 0; i < samples.length; i++) {
                    q.buf[q.write++ % q.cap] = samples[i];
                }
                q.len += samples.length;

            } else if (type === 'remove') {
                this.queues.delete(peerId);

            } else if (type === 'clear') {
                this.queues.clear();
            }
        };
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        if (!out) return true;

        out.fill(0);
        for (const [, q] of this.queues) {
            const n = Math.min(q.len, out.length);
            for (let i = 0; i < n; i++) {
                out[i] += q.buf[q.read++ % q.cap];
            }
            q.len -= n;
        }
        return true;
    }
}
registerProcessor('callum-playback-processor', PlaybackProcessor);
`;

/**
 * Create a Blob URL from processor source code.
 * The URL can be passed to `audioContext.audioWorklet.addModule()`.
 */
export function createWorkletBlobUrl(source: string): string {
  const blob = new Blob([source], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
