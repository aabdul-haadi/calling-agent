/* Microphone capture for the voice gateway. Runs on the audio thread.
 *
 * Takes whatever rate the browser captures at (usually 44.1 or 48 kHz), averages down to 16 kHz
 * (a box filter, enough for speech) and posts 20 ms frames of 16-bit PCM to the page. It also posts
 * the real microphone level, so the interface can show it. While muted it sends silent frames: the
 * session stays alive, but nothing the user says leaves the page.
 */
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.phase = 0;
    this.acc = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
    this.sumSquares = 0;
    this.framesSinceLevel = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (typeof e.data.muted === 'boolean') this.muted = e.data.muted;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.count += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const sample = this.muted ? 0 : this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        const clamped = Math.max(-1, Math.min(1, sample));
        this.frame[this.filled++] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        this.sumSquares += clamped * clamped;
        if (this.filled === FRAME_SAMPLES) this.flush();
      }
    }
    return true;
  }

  flush() {
    const out = this.frame.slice();
    this.port.postMessage({ type: 'frame', pcm: out.buffer }, [out.buffer]);
    this.filled = 0;
    this.framesSinceLevel += 1;
    if (this.framesSinceLevel >= 3) {
      this.port.postMessage({
        type: 'level',
        rms: Math.sqrt(this.sumSquares / (FRAME_SAMPLES * 3)),
      });
      this.sumSquares = 0;
      this.framesSinceLevel = 0;
    }
  }
}

registerProcessor('voice-capture', VoiceCapture);
