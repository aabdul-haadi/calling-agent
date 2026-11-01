import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AgentMode } from '@/agent3d/agent-state';
import { fetchAvatarBytes } from './preload';
import type { AvatarConfig } from './avatar-config';
import type { LipFrame } from './lip-sync';
import { VrmAnimator } from './vrm-animator';

export type AvatarLoadStatus = 'loading' | 'ready' | 'error';

export interface AvatarSceneProps {
  config: AvatarConfig;
  mode: AgentMode;
  /** Reads the audio actually being played. Absent when there is nothing analysable. */
  lipFrame?: () => LipFrame;
  reducedMotion: boolean;
  /** False when off-screen or the tab is hidden: the render loop stops. */
  active: boolean;
  onStatus: (status: AvatarLoadStatus, detail?: string) => void;
}

interface Live {
  mode: AgentMode;
  lipFrame?: () => LipFrame;
  reducedMotion: boolean;
}

function Character({
  config,
  live,
  onStatus,
}: {
  config: AvatarConfig;
  live: React.RefObject<Live>;
  onStatus: AvatarSceneProps['onStatus'];
}) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const vrmRef = useRef<VRM | undefined>(undefined);
  const animator = useRef<VrmAnimator | undefined>(undefined);
  const focus = useRef(new THREE.Vector3(0, 1.4, 0));

  // Load the model once per config; always release it (GPU buffers included) on the way out.
  useEffect(() => {
    let cancelled = false;
    let loaded: VRM | undefined;
    onStatus('loading');
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    // The bytes usually arrived already (see preload.ts); parsing is all that is left to do.
    fetchAvatarBytes(config.modelUrl)
      .then((bytes) => loader.parseAsync(bytes, ''))
      .then((gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) throw new Error('The file is not a VRM model.');
        if (cancelled) {
          VRMUtils.deepDispose(gltf.scene);
          return;
        }
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.traverse((o) => {
          o.frustumCulled = false;
          if (config.hideNodes?.includes(o.name)) o.visible = false;
        });
        scene.add(vrm.scene);
        vrm.scene.updateMatrixWorld(true);
        const head = vrm.humanoid.getNormalizedBoneNode('head');
        const p = new THREE.Vector3();
        (head ?? vrm.scene).getWorldPosition(p);
        focus.current.set(0, p.y - config.framing.focus, 0);
        if (vrm.lookAt) vrm.lookAt.target = camera; // natural eye contact with the viewer
        loaded = vrm;
        vrmRef.current = vrm;
        animator.current = new VrmAnimator(vrm, config);
        onStatus('ready');
      })
      .catch((err: unknown) => {
        if (!cancelled)
          onStatus('error', err instanceof Error ? err.message : 'The avatar could not be loaded.');
      });
    return () => {
      cancelled = true;
      animator.current?.close();
      animator.current = undefined;
      vrmRef.current = undefined;
      if (loaded) {
        scene.remove(loaded.scene);
        VRMUtils.deepDispose(loaded.scene);
      }
    };
  }, [config, scene, camera, onStatus]);

  // Frame the face and shoulders for the current viewport, wide or narrow.
  useEffect(() => {
    const { height } = config.framing;
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = size.width / Math.max(1, size.height);
    const byHeight = height / 2 / Math.tan(fov / 2);
    const byWidth = (height * 0.9) / aspect / 2 / Math.tan(fov / 2);
    camera.position.set(0, focus.current.y, Math.max(byHeight, byWidth));
    camera.lookAt(focus.current);
    camera.updateProjectionMatrix();
  }, [camera, size, config]);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    const a = animator.current;
    if (!vrm || !a) return;
    const l = live.current;
    // Keep the camera aimed at the face once the model has loaded and the focus is known.
    camera.lookAt(focus.current);
    a.update(delta, { mode: l.mode, frame: l.lipFrame?.(), reducedMotion: l.reducedMotion });
    vrm.update(Math.min(delta, 0.1));
    void state;
  });

  return null;
}

/** Studio-style lighting: soft fill, a warm key, and a tinted rim. No shadows, no postprocessing. */
function Lights({ config }: { config: AvatarConfig }) {
  return (
    <>
      <hemisphereLight args={['#ffffff', '#b8c4d8', 1.1]} />
      <directionalLight position={[0.8, 1.9, 2.4]} intensity={1.6} color={config.theme.key} />
      <directionalLight position={[-2.2, 1.6, -1.4]} intensity={1.1} color={config.theme.rim} />
    </>
  );
}

const MAX_CONTEXT_RETRIES = 3;

export default function AvatarScene({
  config,
  mode,
  lipFrame,
  reducedMotion,
  active,
  onStatus,
}: AvatarSceneProps) {
  const live = useRef<Live>({ mode, lipFrame, reducedMotion });
  useEffect(() => {
    live.current = { mode, lipFrame, reducedMotion };
  }, [mode, lipFrame, reducedMotion]);

  // A lost graphics context (a GPU reset, or React tearing the canvas down in development) is
  // recoverable: mount a fresh canvas, and only report failure if that keeps happening.
  const [generation, setGeneration] = useState(0);
  const losses = useRef(0);
  const onLost = useCallback(() => {
    losses.current += 1;
    if (losses.current > MAX_CONTEXT_RETRIES) onStatus('error', 'The graphics context was lost.');
    else setGeneration((g) => g + 1);
  }, [onStatus]);

  return (
    <Canvas
      key={generation}
      frameloop={active ? 'always' : 'never'}
      dpr={[1, 1.5]}
      camera={{ fov: 28, near: 0.05, far: 20, position: [0, 1.4, 1.6] }}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        const canvas = gl.domElement;
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          // Tearing a canvas down also loses its context on purpose: that is not a failure.
          if (canvas.isConnected) onLost();
        });
      }}
    >
      <Lights config={config} />
      <Character config={config} live={live} onStatus={onStatus} />
    </Canvas>
  );
}
