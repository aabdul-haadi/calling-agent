import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MODE_META, type AgentMode } from './agent-state';

/**
 * The 3D agent: a faceted core, three orbital rings and a particle shell. It is a pure view:
 * it only receives a mode, a 0-1 level and an accent, and keeps per-frame values in refs so
 * nothing re-renders while it animates.
 */
/** Small deterministic PRNG so the particle layout is pure (same count, same shell every render). */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AgentSceneProps {
  mode: AgentMode;
  /** Real microphone level (0-1) while listening; otherwise 0. */
  level: number;
  accent: 'sky' | 'violet';
  particles: number;
  /** Render one still frame instead of animating. */
  still: boolean;
  /** False when off-screen or the tab is hidden: the render loop stops. */
  active: boolean;
}

interface Live {
  mode: AgentMode;
  level: number;
  accent: 'sky' | 'violet';
  modeSince: number;
}

const ringTilts: [number, number, number][] = [
  [Math.PI / 2.3, 0, 0],
  [Math.PI / 3, 0.9, 0],
  [Math.PI / 1.8, -0.7, 0.4],
];

function Orbit({
  live,
  particles,
  still,
}: {
  live: React.RefObject<Live>;
  particles: number;
  still: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const points = useRef<THREE.Points>(null);
  const runner = useRef<THREE.Mesh>(null);
  const satellite = useRef<THREE.Mesh>(null);
  const ripple = useRef<THREE.Mesh>(null);
  const color = useRef(new THREE.Color(0.43, 0.88, 1));
  const spin = useRef(1);
  const drift = useRef(1);
  const glow = useRef(0.7);

  const positions = useMemo(() => {
    const rand = seeded(1337);
    const arr = new Float32Array(particles * 3);
    for (let i = 0; i < particles; i++) {
      // Spread on a thick shell around the core (deterministic enough, not security relevant).
      const r = 1.7 + rand() * 1.3;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [particles]);

  const target = useMemo(() => new THREE.Color(), []);

  useFrame(({ clock }, delta) => {
    const l = live.current;
    const meta = MODE_META[l.mode];
    const t = clock.elapsedTime;
    const dt = still ? 0 : Math.min(delta, 0.05);
    const ease = 1 - Math.exp(-dt * 5);

    // Idle / listening / speaking follow the tenant accent; other modes carry their own colour.
    const base =
      l.accent === 'violet' && ['idle', 'listening', 'speaking'].includes(l.mode)
        ? ([0.7, 0.58, 1] as const)
        : meta.color;
    target.setRGB(base[0], base[1], base[2]);
    color.current.lerp(target, still ? 1 : ease);
    spin.current += (meta.spin - spin.current) * ease;
    drift.current += (meta.drift - drift.current) * ease;
    glow.current += (meta.glow - glow.current) * ease;

    // Core: breathes at rest; follows the mic when listening; pulses on a local rhythm when
    // speaking (browser speech audio cannot be analysed, so this is a pulse, not a waveform).
    let pulse = 1 + Math.sin(t * 1.4) * 0.025;
    if (l.mode === 'listening') pulse = 1 + l.level * 0.35;
    else if (l.mode === 'speaking') pulse = 1 + (Math.sin(t * 9) * 0.5 + 0.5) * 0.12;
    else if (l.mode === 'thinking') pulse = 1 + Math.sin(t * 5) * 0.04;
    else if (l.mode === 'error') pulse = 1 + (Math.sin(t * 17) > 0.7 ? 0.05 : 0);
    else if (l.mode === 'awaiting') pulse = 1 + Math.sin(t * 1.1) * 0.05;

    if (core.current) {
      core.current.scale.setScalar(pulse);
      core.current.rotation.y += dt * 0.25 * spin.current;
      core.current.rotation.x += dt * 0.12 * spin.current;
      const m = core.current.material as THREE.MeshStandardMaterial;
      m.color.copy(color.current).multiplyScalar(0.3);
      m.emissive.copy(color.current);
      m.emissiveIntensity = 0.3 + glow.current * 0.35;
    }
    if (shell.current) {
      shell.current.scale.setScalar(pulse * 1.18);
      shell.current.rotation.y -= dt * 0.18 * spin.current;
      (shell.current.material as THREE.MeshBasicMaterial).color.copy(color.current);
    }
    rings.current.forEach((ring, i) => {
      if (!ring) return;
      ring.rotation.z += dt * (0.25 + i * 0.12) * spin.current * (i % 2 === 0 ? 1 : -1);
      ring.rotation.x += dt * 0.05 * spin.current;
      (ring.material as THREE.MeshBasicMaterial).color.copy(color.current);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + glow.current * 0.3;
    });
    if (points.current) {
      points.current.rotation.y += dt * 0.05 * drift.current;
      points.current.rotation.x += dt * 0.02 * drift.current;
      (points.current.material as THREE.PointsMaterial).color.copy(color.current);
    }
    if (group.current && l.mode === 'error') {
      group.current.position.x = still ? 0 : Math.sin(t * 40) * 0.015;
    } else if (group.current) {
      group.current.position.x = 0;
    }

    // Tool execution: a bright node races around the first ring.
    if (runner.current) {
      const on = l.mode === 'executing' || l.mode === 'thinking';
      runner.current.visible = on;
      if (on) {
        const a = t * (l.mode === 'executing' ? 4.2 : 2.2);
        runner.current.position.set(Math.cos(a) * 1.45, 0, Math.sin(a) * 1.45);
      }
    }
    // Handoff: a second node (the human) holds a steady orbit.
    if (satellite.current) {
      satellite.current.visible = l.mode === 'handoff';
      const a = t * 0.7;
      satellite.current.position.set(Math.cos(a) * 1.9, Math.sin(a * 0.8) * 0.5, Math.sin(a) * 1.9);
    }
    // Success: a single expanding ring, then rest.
    if (ripple.current) {
      const age = (performance.now() - l.modeSince) / 1000;
      const on = l.mode === 'success' && age < 1.6;
      ripple.current.visible = on;
      if (on) {
        ripple.current.scale.setScalar(1 + age * 1.6);
        (ripple.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 - age * 0.5);
      }
    }
  });

  return (
    <group ref={group}>
      <mesh ref={core}>
        <icosahedronGeometry args={[0.85, 2]} />
        <meshStandardMaterial
          roughness={0.35}
          metalness={0.2}
          flatShading
          transparent
          opacity={0.92}
        />
      </mesh>
      <mesh ref={shell}>
        <icosahedronGeometry args={[0.85, 2]} />
        <meshBasicMaterial wireframe transparent opacity={0.28} />
      </mesh>
      {ringTilts.map((rot, i) => (
        <mesh
          key={i}
          rotation={rot}
          ref={(m) => {
            rings.current[i] = m;
          }}
        >
          <torusGeometry args={[1.45 + i * 0.28, 0.0125, 8, 120]} />
          <meshBasicMaterial transparent opacity={0.5} />
        </mesh>
      ))}
      <points ref={points}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.028}
          sizeAttenuation
          transparent
          opacity={0.85}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <mesh ref={runner} visible={false}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <mesh ref={satellite} visible={false}>
        <sphereGeometry args={[0.16, 16, 16]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.9} />
      </mesh>
      <mesh ref={ripple} visible={false} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.4, 1.43, 64]} />
        <meshBasicMaterial color="#8dffb4" transparent opacity={0.8} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** In reduced-motion mode the loop is on demand: redraw once whenever the mode changes. */
function Redraw({ mode, accent }: { mode: AgentMode; accent: string }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidate();
  }, [mode, accent, invalidate]);
  return null;
}

export default function AgentScene({
  mode,
  level,
  accent,
  particles,
  still,
  active,
}: AgentSceneProps) {
  const live = useRef<Live>({ mode, level, accent, modeSince: 0 });
  useEffect(() => {
    if (live.current.mode !== mode) live.current.modeSince = performance.now();
    live.current.mode = mode;
    live.current.level = level;
    live.current.accent = accent;
  }, [mode, level, accent]);

  return (
    <Canvas
      flat
      aria-hidden="true"
      dpr={[1, 1.6]}
      frameloop={still ? 'demand' : active ? 'always' : 'never'}
      camera={{ position: [0, 0, 5.2], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
    >
      <ambientLight intensity={0.35} />
      <pointLight position={[3, 3, 4]} intensity={7} color="#bfe9ff" />
      <pointLight position={[-4, -2, -2]} intensity={4} color="#9b8cff" />
      <Orbit live={live} particles={particles} still={still} />
      {still && <Redraw mode={mode} accent={accent} />}
    </Canvas>
  );
}
