import { analyseSpeech, NO_VISEMES, type LipFrame } from '@/avatar/lip-sync';
import { TurnGate, type OutputFrame } from './protocol';

export interface PlaybackHandlers {
  /** The first audio of a reply is actually starting to play. */
  onStarted: (turn: number) => void;
  /** The whole reply has finished playing (not called for an interrupted reply). */
  onEnded: (turn: number) => void;
}

interface Scheduled {
  source: AudioBufferSourceNode;
  turn: number;
}

/**
 * Plays the agent's speech as it arrives and can silence it at once.
 *
 * Frames are scheduled back to back on the audio clock. `interrupt()` makes the output silent
 * immediately, stops everything already queued, and from then on refuses any frame of that turn
 * or an older one (the TurnGate), so audio still in flight can never be heard.
 */
export class Playback {
  private readonly gate = new TurnGate();
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly scheduled = new Set<Scheduled>();
  private readonly samples: Float32Array<ArrayBuffer>;
  /** Second, branch-only reading of the same output for the avatar's mouth (nothing is re-played). */
  private readonly lipAnalyser: AnalyserNode;
  private lipTime?: Float32Array<ArrayBuffer>;
  private lipFreq?: Float32Array<ArrayBuffer>;
  private lipGateOpen = false;
  private epoch = 0;
  private nextTime = 0;
  private startedTurn = 0;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  /** Frames dropped because their turn was interrupted: evidence that the gate works. */
  staleDropped = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly handlers: PlaybackHandlers,
  ) {
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.lipAnalyser = ctx.createAnalyser();
    this.lipAnalyser.fftSize = 1024;
    this.lipAnalyser.smoothingTimeConstant = 0.2;
    this.gain.connect(this.lipAnalyser); // a read-only branch: it is not connected to the speakers
  }

  enqueue(frame: OutputFrame): void {
    if (!this.gate.allows(frame.turn)) {
      this.staleDropped += 1;
      return;
    }
    if (frame.samples.length === 0) {
      // end-of-reply marker: tell the page when the audio already queued has finished
      if (frame.last) this.scheduleEnd(frame.turn);
      return;
    }
    const buffer = this.ctx.createBuffer(1, frame.samples.length, frame.sampleRate);
    buffer.copyToChannel(frame.samples as Float32Array<ArrayBuffer>, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.ctx.currentTime;
    // A small lead keeps the first chunk from being late; later chunks follow each other exactly.
    this.nextTime = Math.max(this.nextTime, now + 0.04);
    const entry: Scheduled = { source, turn: frame.turn };
    this.scheduled.add(entry);
    source.onended = () => this.scheduled.delete(entry);
    if (this.gain.gain.value === 0) this.gain.gain.setValueAtTime(1, now);
    source.start(this.nextTime);
    if (this.startedTurn !== frame.turn) {
      this.startedTurn = frame.turn;
      clearTimeout(this.startTimer);
      this.startTimer = setTimeout(
        () => this.gate.allows(frame.turn) && this.handlers.onStarted(frame.turn),
        Math.max(0, (this.nextTime - now) * 1000),
      );
    }
    this.nextTime += buffer.duration;
    if (frame.last) this.scheduleEnd(frame.turn);
  }

  private scheduleEnd(turn: number): void {
    clearTimeout(this.endTimer);
    const wait = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000) + 60;
    this.endTimer = setTimeout(() => {
      if (this.gate.allows(turn)) this.handlers.onEnded(turn);
    }, wait);
  }

  /**
   * Silence the agent now. Returns how long that took in milliseconds (reported to the server,
   * which records it as the playback-stop latency).
   */
  interrupt(turn: number): number {
    const t0 = performance.now();
    this.gate.interrupt(turn);
    this.epoch += 1;
    this.lipGateOpen = false;
    clearTimeout(this.endTimer);
    clearTimeout(this.startTimer);
    const now = this.ctx.currentTime;
    // Mute first (instant), then stop and drop what was queued.
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    for (const s of this.scheduled) {
      try {
        s.source.stop();
      } catch {
        // already stopped
      }
      s.source.disconnect();
    }
    this.scheduled.clear();
    this.nextTime = 0;
    return performance.now() - t0;
  }

  /** Real output level (0-1) from the audio actually being played. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
  }

  /**
   * What the avatar's mouth should do right now, read from the audio actually being played. Only
   * analyses while a scheduled chunk exists and the output is not muted, so it costs nothing in
   * silence. After `interrupt()` the output is muted and nothing is scheduled, so this reports a
   * closed mouth at once, whatever the next frame tries to do.
   */
  lipFrame(): LipFrame {
    const heard = this.scheduled.size > 0 && this.gain.gain.value > 0;
    if (!heard) {
      this.lipGateOpen = false;
      return { active: false, epoch: this.epoch, level: 0, visemes: NO_VISEMES };
    }
    this.lipTime ??= new Float32Array(this.lipAnalyser.fftSize);
    this.lipFreq ??= new Float32Array(this.lipAnalyser.frequencyBinCount);
    this.lipAnalyser.getFloatTimeDomainData(this.lipTime);
    this.lipAnalyser.getFloatFrequencyData(this.lipFreq);
    const heardNow = analyseSpeech(this.lipTime, this.lipFreq, this.ctx.sampleRate, this.lipGateOpen);
    this.lipGateOpen = heardNow.gateOpen;
    return { active: true, epoch: this.epoch, level: heardNow.level, visemes: heardNow.visemes };
  }

  get playing(): boolean {
    return this.scheduled.size > 0;
  }

  dispose(): void {
    clearTimeout(this.endTimer);
    clearTimeout(this.startTimer);
    for (const s of this.scheduled) {
      try {
        s.source.stop();
      } catch {
        // ignore
      }
    }
    this.scheduled.clear();
    this.epoch += 1;
    this.gain.disconnect();
    this.analyser.disconnect();
    this.lipAnalyser.disconnect();
  }
}
