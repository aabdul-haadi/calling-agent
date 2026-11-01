import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AgentMode } from './agent-state';
import { blinkAmount, mouthOpenness } from './avatar-motion';

const SKIN = '#d9a785';
const HAIR = '#342c35';
const SHIRT = '#426b9b';

function Face({ mode, level }: { mode: AgentMode; level: number }) {
  const head = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const eyes = useRef<(THREE.Mesh | null)[]>([]);
  const lids = useRef<(THREE.Mesh | null)[]>([]);
  const live = useRef({ mode, level });

  useEffect(() => {
    live.current = { mode, level };
  }, [mode, level]);

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const amount = blinkAmount(t);
    const { mode: currentMode, level: currentLevel } = live.current;
    if (head.current) {
      head.current.rotation.y += ((currentMode === 'listening' ? 0.06 : 0) - head.current.rotation.y) * Math.min(1, delta * 4);
      head.current.position.y = Math.sin(t * 1.3) * 0.018;
    }
    for (const eye of eyes.current) {
      if (eye) eye.scale.y = Math.max(0.035, 1 - amount * 0.96);
    }
    for (const lid of lids.current) {
      if (lid) lid.scale.y = 0.025 + amount * 0.12;
    }
    if (mouth.current) {
      const target = mouthOpenness(currentMode, currentLevel, t);
      mouth.current.scale.y += (0.025 + target * 0.16 - mouth.current.scale.y) * Math.min(1, delta * 18);
    }
  });

  return (
    <group ref={head} position={[0, 0.04, 0]}>
      <mesh position={[0, -0.72, -0.05]} scale={[0.92, 0.64, 0.52]}>
        <sphereGeometry args={[1, 32, 24]} />
        <meshStandardMaterial color={SHIRT} roughness={0.78} />
      </mesh>
      <mesh position={[0, -0.12, 0]}>
        <cylinderGeometry args={[0.23, 0.27, 0.48, 24]} />
        <meshStandardMaterial color={SKIN} roughness={0.86} />
      </mesh>
      <mesh position={[0, 0.52, 0]} scale={[0.57, 0.72, 0.47]}>
        <sphereGeometry args={[1, 40, 32]} />
        <meshStandardMaterial color={SKIN} roughness={0.82} />
      </mesh>
      <mesh position={[0, 1.02, -0.015]} scale={[0.59, 0.3, 0.49]}>
        <sphereGeometry args={[1, 32, 20]} />
        <meshStandardMaterial color={HAIR} roughness={0.92} />
      </mesh>
      {[-1, 1].map((side, i) => (
        <group key={side} position={[side * 0.22, 0.6, 0.405]}>
          <mesh
            ref={(node) => {
              eyes.current[i] = node;
            }}
            scale={[0.105, 0.07, 0.045]}
          >
            <sphereGeometry args={[1, 20, 16]} />
            <meshStandardMaterial color="#fffaf4" roughness={0.35} />
          </mesh>
          <mesh position={[0, -0.004, 0.036]} scale={[0.033, 0.042, 0.022]}>
            <sphereGeometry args={[1, 16, 12]} />
            <meshStandardMaterial color="#302a32" roughness={0.35} />
          </mesh>
          <mesh
            ref={(node) => {
              lids.current[i] = node;
            }}
            position={[0, 0.012, 0.012]}
            scale={[0.12, 0.025, 0.03]}
          >
            <sphereGeometry args={[1, 20, 12]} />
            <meshStandardMaterial color={SKIN} roughness={0.82} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.37, 0.444]} scale={[0.09, 0.13, 0.1]}>
        <sphereGeometry args={[1, 20, 16]} />
        <meshStandardMaterial color="#c98f70" roughness={0.82} />
      </mesh>
      <mesh ref={mouth} position={[0, 0.16, 0.431]} scale={[0.16, 0.025, 0.035]}>
        <sphereGeometry args={[1, 24, 16]} />
        <meshStandardMaterial color="#633b3d" roughness={0.8} />
      </mesh>
    </group>
  );
}

export interface DevelopmentAvatarSceneProps {
  mode: AgentMode;
  /** Real audio playback level where the voice client exposes it; zero uses speech activity animation. */
  level: number;
  accent: 'sky' | 'violet';
}

export default function DevelopmentAvatarScene({ mode, level, accent }: DevelopmentAvatarSceneProps) {
  const tint = accent === 'violet' ? '#9a7cff' : '#77d7ff';
  return (
    <Canvas
      aria-hidden="true"
      dpr={[1, 1.5]}
      camera={{ position: [0, 0.2, 4], fov: 36 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
    >
      <ambientLight intensity={1.35} />
      <directionalLight position={[2, 3, 4]} intensity={2} color="#fff4e8" />
      <pointLight position={[-2, 0.5, 2]} intensity={8} color={tint} />
      <Face mode={mode} level={level} />
    </Canvas>
  );
}
