// Posts raw mono PCM frames with the absolute context frame index of the first sample, so the
// main thread can map every sample to the session clock without relying on message timing.
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(4096); this.filled = 0; this.startFrame = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      if (this.filled === 0) this.startFrame = currentFrame;
      this.buffer.set(channel, this.filled); this.filled += channel.length;
      if (this.filled + 128 > this.buffer.length) {
        const out = this.buffer.slice(0, this.filled);
        this.port.postMessage({ samples: out, startFrame: this.startFrame }, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
