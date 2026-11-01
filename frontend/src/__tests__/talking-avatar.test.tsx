import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOrb } from '@/agent3d/agent-orb';
import { resetWebglProbe, TalkingAvatar } from '@/avatar/talking-avatar';
import type { AvatarSceneProps } from '@/avatar/avatar-scene';
import type { LipFrame } from '@/avatar/lip-sync';

/** What the mocked 3D scene does when it mounts: report ready, or fail, like the real one. */
const scene = vi.hoisted(() => ({
  outcome: 'ready' as 'ready' | 'error' | 'throw' | 'hang',
  props: [] as unknown[],
}));

vi.mock('@/avatar/avatar-scene', async () => {
  const React = await import('react');
  return {
    default: function MockScene(p: AvatarSceneProps) {
      scene.props.push(p);
      if (scene.outcome === 'throw') throw new Error('shader failed');
      const { onStatus } = p;
      React.useEffect(() => {
        if (scene.outcome === 'ready') onStatus('ready');
        if (scene.outcome === 'error') onStatus('error', 'model file is not a VRM');
      }, [onStatus]);
      return <div data-testid="scene" data-client={p.config.clientId} data-active={String(p.active)} />;
    },
  };
});

const fallback = <div data-testid="fallback">orb</div>;
const lastProps = () => scene.props.at(-1) as AvatarSceneProps;

function stubWebgl(available: boolean) {
  resetWebglProbe();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
    available ? {} : null) as never);
}

describe('TalkingAvatar', () => {
  beforeEach(() => {
    scene.outcome = 'ready';
    scene.props.length = 0;
    stubWebgl(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetWebglProbe();
  });

  it('renders the 3D scene with the tenant character once the chunk has loaded', async () => {
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    expect(await screen.findByTestId('scene')).toHaveAttribute('data-client', 'skylink-air');
    expect(lastProps().config.name).toBe('Ava');
  });

  it('shows a loading state, then clears it when the model is ready', async () => {
    scene.outcome = 'hang';
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    expect(await screen.findByText(/Loading Ava/)).toBeInTheDocument();
    act(() => lastProps().onStatus('ready'));
    await waitFor(() => expect(screen.queryByText(/Loading Ava/)).not.toBeInTheDocument());
  });

  it('shows the character portrait at once and fades it out when the live model is ready', async () => {
    scene.outcome = 'hang';
    const { container } = render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    const portrait = container.querySelector('img[src="/visuals/agents/ava.webp"]')!;
    expect(portrait).toHaveAttribute('aria-hidden', 'true');
    expect(portrait).toHaveClass('opacity-100');
    await screen.findByTestId('scene');
    act(() => lastProps().onStatus('ready'));
    await waitFor(() => expect(portrait).toHaveClass('opacity-0'));
  });

  it('falls back to the plain avatar and says so when the model fails to load', async () => {
    scene.outcome = 'error';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    expect(await screen.findByTestId('fallback')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Voice still works/);
    expect(screen.queryByTestId('scene')).not.toBeInTheDocument();
  });

  it('falls back (and does not crash the page) when the scene throws while rendering', async () => {
    scene.outcome = 'throw';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    expect(await screen.findByTestId('fallback')).toBeInTheDocument();
  });

  it('falls back without ever loading the 3D scene when WebGL is unavailable', async () => {
    stubWebgl(false);
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/3D is not available/);
    expect(scene.props).toHaveLength(0);
  });

  it('shows only the fallback for a tenant that has no character', () => {
    render(<TalkingAvatar clientId="unknown" mode="idle" fallback={fallback} />);
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(scene.props).toHaveLength(0);
  });

  it('switches character when the tenant changes, and a failure for one does not stick to the next', async () => {
    scene.outcome = 'error';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rerender } = render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    expect(await screen.findByRole('note')).toBeInTheDocument();
    scene.outcome = 'ready';
    rerender(<TalkingAvatar clientId="novatel" mode="idle" fallback={fallback} />);
    const el = await screen.findByTestId('scene');
    expect(el).toHaveAttribute('data-client', 'novatel');
    expect(lastProps().config.name).toBe('Nia');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows the licence credit the model requires (Nia) and none for Ava', async () => {
    const { rerender } = render(<TalkingAvatar clientId="novatel" mode="idle" fallback={fallback} />);
    expect(await screen.findByText(/Seed-san by VirtualCast/)).toBeInTheDocument();
    rerender(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    await screen.findByTestId('scene');
    expect(screen.queryByText(/VirtualCast/)).not.toBeInTheDocument();
  });

  it('hands the scene the live mode and the audio reader, and nothing else drives the mouth', async () => {
    const lipFrame = vi.fn<() => LipFrame>();
    const { rerender } = render(
      <TalkingAvatar clientId="skylink-air" mode="listening" lipFrame={lipFrame} fallback={fallback} />,
    );
    await screen.findByTestId('scene');
    expect(lastProps().mode).toBe('listening');
    expect(lastProps().lipFrame).toBe(lipFrame);
    rerender(<TalkingAvatar clientId="skylink-air" mode="speaking" lipFrame={lipFrame} fallback={fallback} />);
    expect(lastProps().mode).toBe('speaking');
    // the component itself never polls the audio: only the scene's frame loop does
    expect(lipFrame).not.toHaveBeenCalled();
  });

  it('gives the scene no audio reader when there is nothing to analyse (browser speech)', async () => {
    render(<TalkingAvatar clientId="skylink-air" mode="speaking" fallback={fallback} />);
    await screen.findByTestId('scene');
    expect(lastProps().lipFrame).toBeUndefined();
  });

  it('passes the reduced-motion preference through', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    await screen.findByTestId('scene');
    expect(lastProps().reducedMotion).toBe(true);
  });

  it('stops the render loop while scrolled out of view or in a background tab, and resumes', async () => {
    let notify: (visible: boolean) => void = () => undefined;
    class FakeObserver {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        notify = (visible) => cb([{ isIntersecting: visible }]);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    const el = await screen.findByTestId('scene');
    expect(el).toHaveAttribute('data-active', 'true');
    act(() => notify(false));
    expect(screen.getByTestId('scene')).toHaveAttribute('data-active', 'false');
    act(() => notify(true));
    expect(screen.getByTestId('scene')).toHaveAttribute('data-active', 'true');

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByTestId('scene')).toHaveAttribute('data-active', 'false');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByTestId('scene')).toHaveAttribute('data-active', 'true');
  });

  it('disconnects its observers when it unmounts', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const { unmount } = render(<TalkingAvatar clientId="skylink-air" mode="idle" fallback={fallback} />);
    await screen.findByTestId('scene');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('AgentOrb with a talking avatar', () => {
  beforeEach(() => {
    scene.outcome = 'ready';
    scene.props.length = 0;
    stubWebgl(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetWebglProbe();
  });

  it('keeps the accessible status caption next to the character, and survives 3D failing', async () => {
    scene.outcome = 'error';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <AgentOrb mode="speaking" agentName="Ava" talkingAvatar={{ clientId: 'skylink-air' }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Ava is speaking');
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Ava is speaking');
  });
});
