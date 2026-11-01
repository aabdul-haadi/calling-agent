import type { AgentMode } from '@/agent3d/agent-state';
import type { Viseme } from './lip-sync';

/** One tenant's character. The shared engine reads only this, so nothing in it is Ava-specific. */
export interface AvatarConfig {
  clientId: string;
  name: string;
  /** VRM 1.0 model, served from /public. */
  modelUrl: string;
  /** A still of this character: shown at once while the model loads, and on identity cards. */
  portraitUrl: string;
  /** Mesh/node names to hide (props that do not belong in a support portrait). */
  hideNodes?: string[];
  /** Maps the five mouth shapes to this model's expression names (VRM presets by default). */
  visemeMap: Record<Viseme, string>;
  blinkExpression: string;
  /** Expression weights per agent mode, eased in and out. Keys are expression names. */
  expressions: Partial<Record<AgentMode, Record<string, number>>>;
  /** Fraction of the mouth weight the model tolerates before the face distorts (1 = full). */
  mouthScale: number;
  /** Visible height in metres around the face and shoulders, and the point it is centred on. */
  framing: { height: number; focus: number };
  /** Page theme around the character. */
  theme: { background: string; rim: string; key: string };
  /** Shown under the portrait when the licence asks for credit. */
  credit?: { text: string; url: string };
}

const VRM_VISEMES: Record<Viseme, string> = { aa: 'aa', ih: 'ih', ou: 'ou', ee: 'ee', oh: 'oh' };

const POSE_EXPRESSIONS: AvatarConfig['expressions'] = {
  idle: { relaxed: 0.2 },
  listening: { relaxed: 0.1, happy: 0.1 },
  thinking: {},
  searching: {},
  executing: {},
  awaiting: { surprised: 0.05 },
  speaking: { happy: 0.14 },
  success: { happy: 0.45 },
  error: {},
  handoff: {},
};

/**
 * Models: both are VRM 1.0 samples whose embedded licence allows commercial use, redistribution
 * and modification (see public/avatars/LICENSES.md). They are stylised stand-ins; a custom VRM
 * exported from VRoid Studio drops in by replacing the file or changing `modelUrl`.
 */
export const AVATARS: Record<string, AvatarConfig> = {
  'skylink-air': {
    clientId: 'skylink-air',
    name: 'Ava',
    modelUrl: '/avatars/ava.vrm',
    portraitUrl: '/visuals/agents/ava.webp',
    visemeMap: VRM_VISEMES,
    blinkExpression: 'blink',
    expressions: POSE_EXPRESSIONS,
    mouthScale: 0.85,
    framing: { height: 0.7, focus: 0.1 },
    theme: {
      background: 'linear-gradient(180deg, #dbe7f7 0%, #b9cce8 100%)',
      rim: '#7fa8ff',
      key: '#fff6ea',
    },
  },
  novatel: {
    clientId: 'novatel',
    name: 'Nia',
    modelUrl: '/avatars/nia.vrm',
    portraitUrl: '/visuals/agents/nia.webp',
    hideNodes: ['robo_arm'],
    visemeMap: VRM_VISEMES,
    blinkExpression: 'blink',
    expressions: POSE_EXPRESSIONS,
    mouthScale: 0.85,
    framing: { height: 0.72, focus: 0.06 },
    theme: {
      background: 'linear-gradient(180deg, #e3dcf3 0%, #c5d8dd 100%)',
      rim: '#6ad6c8',
      key: '#fff3f0',
    },
    credit: {
      text: 'Seed-san by VirtualCast, Inc. (VRM Public License 1.0)',
      url: 'https://vrm.dev/licenses/1.0/',
    },
  },
};

/** The character for a tenant, or undefined (the caller then shows the plain status orb). */
export function avatarFor(clientId: string): AvatarConfig | undefined {
  return AVATARS[clientId];
}
