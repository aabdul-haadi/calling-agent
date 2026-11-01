import type { AgentMode } from '@/agent3d/agent-state';
import type { AvatarConfig } from './avatar-config';
import { limitMouth, MouthSmoother, VISEMES, type LipFrame } from './lip-sync';

/** The slice of a three-vrm `VRM` the animator touches, so it can be driven without WebGL. */
export interface VrmLike {
  expressionManager?: { setValue(name: string, weight: number): void } | null;
  humanoid?: {
    getNormalizedBoneNode(name: string): { rotation: { x: number; y: number; z: number } } | null;
  } | null;
}

export interface AnimatorInput {
  mode: AgentMode;
  /** Reading of the audio really being played, or undefined when there is no analysable audio. */
  frame?: LipFrame;
  reducedMotion: boolean;
}

/** Arms at rest instead of the T-pose the model is authored in. */
const REST_ARM = 1.2;

const smoothTo = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/**
 * Drives one VRM's face and posture. Frame-rate independent (everything is eased with the elapsed
 * time), and the mouth is driven only by a LipFrame from real playback: with none, or with a
 * frame that says nothing is audible, the mouth is closed.
 */
export class VrmAnimator {
  private readonly mouth = new MouthSmoother();
  private readonly expression: Record<string, number> = {};
  private time = 0;
  private blinkAt = 2;
  private blinkStart = -1;
  private lastEpoch = 0;
  private head = { yaw: 0, pitch: 0, roll: 0 };
  private breath = 0;
  /** Last mouth weight written, for tests and diagnostics. */
  lastMouth = 0;

  constructor(
    private readonly vrm: VrmLike,
    private readonly config: AvatarConfig,
    private readonly random: () => number = Math.random,
  ) {
    this.blinkAt = 1.5 + random() * 3;
  }

  update(dt: number, input: AnimatorInput): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.time += step;
    this.updateMouth(step, input);
    this.updateExpression(step, input);
    this.updateBlink();
    this.updatePosture(step, input);
  }

  private updateMouth(dt: number, { frame, mode }: AnimatorInput): void {
    const em = this.vrm.expressionManager;
    // A cut-off (new epoch) closes the mouth this instant instead of easing out.
    if (frame && frame.epoch !== this.lastEpoch) {
      this.lastEpoch = frame.epoch;
      this.mouth.reset();
    }
    const audible = !!frame?.active && mode !== 'error';
    const target = audible ? frame!.visemes : { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    const smoothed = this.mouth.step(target, dt);
    const scale = limitMouth(smoothed) * this.config.mouthScale;
    let total = 0;
    for (const v of VISEMES) {
      const weight = smoothed[v] * scale;
      total += weight;
      em?.setValue(this.config.visemeMap[v], weight);
    }
    this.lastMouth = total;
  }

  private updateExpression(dt: number, { mode }: AnimatorInput): void {
    const em = this.vrm.expressionManager;
    const wanted = this.config.expressions[mode] ?? {};
    const names = new Set([...Object.keys(this.expression), ...Object.keys(wanted)]);
    for (const name of names) {
      const next = smoothTo(this.expression[name] ?? 0, wanted[name] ?? 0, 4, dt);
      this.expression[name] = next < 0.002 ? 0 : next;
      em?.setValue(name, this.expression[name]!);
    }
  }

  private updateBlink(): void {
    const em = this.vrm.expressionManager;
    let weight = 0;
    if (this.blinkStart >= 0) {
      const t = (this.time - this.blinkStart) / 0.17; // close in ~70 ms, open in ~100 ms
      weight = t < 0.4 ? t / 0.4 : Math.max(0, 1 - (t - 0.4) / 0.6);
      if (t >= 1) {
        this.blinkStart = -1;
        // now and then a quick double blink, otherwise 2.5-6 s between blinks
        this.blinkAt = this.time + (this.random() < 0.12 ? 0.22 : 2.5 + this.random() * 3.5);
        weight = 0;
      }
    } else if (this.time >= this.blinkAt) {
      this.blinkStart = this.time;
    }
    em?.setValue(this.config.blinkExpression, weight);
  }

  private updatePosture(dt: number, { mode, reducedMotion }: AnimatorInput): void {
    const bones = this.vrm.humanoid;
    if (!bones) return;
    const calm = reducedMotion ? 0.15 : 1;
    const t = this.time;

    // Arms down from the authored T-pose (static: kept even with reduced motion).
    const left = bones.getNormalizedBoneNode('leftUpperArm');
    const right = bones.getNormalizedBoneNode('rightUpperArm');
    if (left) left.rotation.z = -REST_ARM;
    if (right) right.rotation.z = REST_ARM;
    const leftLower = bones.getNormalizedBoneNode('leftLowerArm');
    const rightLower = bones.getNormalizedBoneNode('rightLowerArm');
    if (leftLower) leftLower.rotation.z = -0.12;
    if (rightLower) rightLower.rotation.z = 0.12;

    // Breathing: a slow chest rise.
    const chest = bones.getNormalizedBoneNode('upperChest') ?? bones.getNormalizedBoneNode('chest');
    this.breath = Math.sin(t * 1.35) * 0.012 * calm;
    if (chest) chest.rotation.x = this.breath;

    // Head: a gentle drift made of slow sines, with a small lean in the attentive states.
    const listening = mode === 'listening' || mode === 'awaiting';
    const thinking = mode === 'thinking' || mode === 'searching' || mode === 'executing';
    const yaw = (Math.sin(t * 0.37) * 0.05 + Math.sin(t * 0.91 + 1.3) * 0.02) * calm;
    const pitch =
      (Math.sin(t * 0.52 + 0.6) * 0.025 + (listening ? 0.035 : 0) + (thinking ? -0.03 : 0)) * (reducedMotion ? 0.4 : 1);
    const roll = (Math.sin(t * 0.29 + 2) * 0.02 + (listening ? 0.03 : 0)) * calm;
    this.head.yaw = smoothTo(this.head.yaw, yaw, 3, dt);
    this.head.pitch = smoothTo(this.head.pitch, pitch, 3, dt);
    this.head.roll = smoothTo(this.head.roll, roll, 3, dt);
    const neck = bones.getNormalizedBoneNode('neck');
    const head = bones.getNormalizedBoneNode('head');
    if (neck) {
      neck.rotation.y = this.head.yaw * 0.4;
      neck.rotation.x = this.head.pitch * 0.4;
    }
    if (head) {
      head.rotation.y = this.head.yaw * 0.6;
      head.rotation.x = this.head.pitch * 0.6;
      head.rotation.z = this.head.roll;
    }
  }

  /** Close everything now (call before disposing). */
  close(): void {
    this.mouth.reset();
    const em = this.vrm.expressionManager;
    for (const v of VISEMES) em?.setValue(this.config.visemeMap[v], 0);
    em?.setValue(this.config.blinkExpression, 0);
    this.lastMouth = 0;
  }
}
