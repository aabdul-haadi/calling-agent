import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/App';
import { api } from '@/services/api';
import type { LocalEvent } from '@/voice/state';
import type { ServerEvent } from '@/voice/protocol';
import { clientDetail, clients, overview } from './fixtures';

type Emit = (e: ServerEvent | LocalEvent) => void;

const hoisted = vi.hoisted(() => ({
  last: undefined as undefined | { emit: Emit; stop: () => void; interrupt: () => void },
  startError: undefined as Error | undefined,
}));

vi.mock('@/voice/client', () => {
  class MicrophoneError extends Error {}
  class VoiceClient {
    opts: { onEvent: Emit };
    isMuted = false;
    constructor(opts: { onEvent: Emit }) {
      this.opts = opts;
      hoisted.last = {
        emit: opts.onEvent,
        stop: () => this.stop(),
        interrupt: () => this.interrupt(),
      };
    }
    async start() {
      if (hoisted.startError) throw hoisted.startError;
    }
    stop = vi.fn(() => this.opts.onEvent({ type: 'local.closed' }));
    interrupt = vi.fn();
    setMuted(m: boolean) {
      this.isMuted = m;
    }
    micLevel() {
      return 0.3;
    }
    outputLevel() {
      return 0.2;
    }
  }
  return { VoiceClient, MicrophoneError, voiceEngineSupported: () => true };
});

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api');
  return {
    ...actual,
    api: {
      health: vi.fn(),
      clients: vi.fn(),
      client: vi.fn(),
      overview: vi.fn(),
      voiceStatus: vi.fn(),
      voiceSession: vi.fn(),
      chat: vi.fn(),
      conversation: vi.fn(),
      resetConversation: vi.fn(),
      setSimulator: vi.fn(),
      voiceLatency: vi.fn(),
    },
  };
});
const mocked = vi.mocked(api);

let seq = 0;
const server = (e: Record<string, unknown>) =>
  ({ session: 's1', seq: ++seq, t: 0, ...e }) as unknown as ServerEvent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  hoisted.last = undefined;
  hoisted.startError = undefined;
  mocked.health.mockResolvedValue({ status: 'ok', db: 'up' });
  mocked.clients.mockResolvedValue(clients);
  mocked.client.mockResolvedValue(clientDetail);
  mocked.overview.mockResolvedValue(overview);
  mocked.voiceStatus.mockResolvedValue({
    configured: true,
    available: true,
    url: 'ws://localhost:8765/ws',
    asr: 'sherpa-onnx/zipformer-large',
    tts: 'sherpa-onnx/piper-amy-low',
  });
  mocked.voiceSession.mockResolvedValue({
    url: 'ws://localhost:8765/ws',
    token: 'signed.token',
    expiresAt: '2026-11-10T10:01:00.000Z',
    protocol: 1,
  });
});

const renderLab = () =>
  render(
    <MemoryRouter initialEntries={['/voice']}>
      <AppRoutes />
    </MemoryRouter>,
  );

const emit = (e: ServerEvent | LocalEvent) => act(() => hoisted.last!.emit(e));

async function serious(container: HTMLElement) {
  const r = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

describe('Voice Lab with the local engine', () => {
  it('uses the local engine when it is running and says what it is made of', async () => {
    renderLab();
    expect(await screen.findByRole('button', { name: 'Start voice session' })).toBeInTheDocument();
    expect(await screen.findByText(/sherpa-onnx\/zipformer-large/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Local engine' })).toBeChecked();
  });

  it('falls back to browser speech, with the reason, when the gateway is not running', async () => {
    mocked.voiceStatus.mockResolvedValue({ configured: true, available: false, url: '' });
    const user = userEvent.setup();
    renderLab();
    expect(await screen.findByText(/Local engine not running/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Browser speech' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Local engine' })); // cannot be chosen
    expect(screen.getByRole('radio', { name: 'Browser speech' })).toBeChecked();
  });

  it('explains how to turn the local engine on when it is not configured', async () => {
    mocked.voiceStatus.mockResolvedValue({ configured: false, available: false, url: '' });
    renderLab();
    expect(await screen.findByText(/VOICE_GATEWAY_SECRET/)).toBeInTheDocument();
  });

  it('runs a whole call from real gateway events', async () => {
    const user = userEvent.setup();
    const { container } = renderLab();
    await user.click(await screen.findByRole('button', { name: 'Start voice session' }));
    await waitFor(() => expect(mocked.voiceSession).toHaveBeenCalledWith('skylink-air', undefined));
    await waitFor(() => expect(hoisted.last).toBeDefined());

    await emit(
      server({
        type: 'session.started',
        protocol: 1,
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        conversationId: null,
      }),
    );
    expect(await screen.findByText('Listening')).toBeInTheDocument();

    await emit(server({ type: 'speech.started', turn: 1 }));
    await emit(server({ type: 'transcript.partial', turn: 1, text: 'my flight was' }));
    expect(screen.getByText(/“my flight was”/)).toBeInTheDocument();

    await emit(
      server({
        type: 'transcript.final',
        turn: 1,
        text: 'My flight was cancelled',
        confidence: 0.9,
        lowConfidence: false,
      }),
    );
    const transcript = screen.getByRole('list', { name: 'Voice transcript' });
    expect(within(transcript).getByText(/My flight was cancelled/)).toBeInTheDocument();
    expect(screen.getByText('Thinking…')).toBeInTheDocument();

    // live tool activity, not replayed after the fact
    await emit(server({ type: 'tool.started', turn: 1, tool: 'search_alternatives' }));
    expect(screen.getByText('Checking a system…')).toBeInTheDocument();
    expect(screen.getAllByText('search_alternatives').length).toBeGreaterThan(0);
    await emit(
      server({ type: 'tool.completed', turn: 1, tool: 'search_alternatives', status: 'ok' }),
    );

    await emit(server({ type: 'agent.text.delta', turn: 1, text: 'I found two flights. ' }));
    await emit(server({ type: 'agent.speaking', turn: 1, sampleRate: 16000 }));
    expect(screen.getByText(/Speaking/)).toBeInTheDocument();
    expect(within(transcript).getByText(/I found two flights/)).toBeInTheDocument();

    expect(await serious(container)).toEqual([]);

    await emit(
      server({
        type: 'approval.required',
        turn: 1,
        summary: 'Move booking SK1001 to flight SK110',
        expiresAt: '2026-11-10T10:10:00Z',
      }),
    );
    await emit({ type: 'local.playback_ended' });
    expect(
      await screen.findByText(/Waiting for your approval: Move booking SK1001/),
    ).toBeInTheDocument();
    expect(screen.getByText('Waiting for your yes or no')).toBeInTheDocument();
  });

  it('shows an interruption at once', async () => {
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByRole('button', { name: 'Start voice session' }));
    await waitFor(() => expect(hoisted.last).toBeDefined());
    await emit(
      server({
        type: 'session.started',
        protocol: 1,
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        conversationId: null,
      }),
    );
    await emit(server({ type: 'agent.speaking', turn: 1, sampleRate: 16000 }));
    await emit(
      server({ type: 'agent.interrupted', turn: 1, reason: 'barge_in', droppedChunks: 3 }),
    );
    expect(await screen.findByText('Interrupted')).toBeInTheDocument();
  });

  it('the Stop button interrupts only when there is something to stop', async () => {
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByRole('button', { name: 'Start voice session' }));
    await waitFor(() => expect(hoisted.last).toBeDefined());
    await emit(
      server({
        type: 'session.started',
        protocol: 1,
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        conversationId: null,
      }),
    );
    const stop = screen.getByRole('button', { name: /Stop/ });
    expect(stop).toBeDisabled();
    await emit(server({ type: 'agent.speaking', turn: 1, sampleRate: 16000 }));
    expect(stop).toBeEnabled();
    await user.click(stop);
    expect(hoisted.last).toBeDefined();
  });

  it('a refused microphone becomes a clear message and a way to try again', async () => {
    hoisted.startError = new Error(
      'Microphone access was blocked. Allow it in the address bar, then press Start again.',
    );
    const user = userEvent.setup();
    const { container } = renderLab();
    await user.click(await screen.findByRole('button', { name: 'Start voice session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was blocked');
    expect(screen.getByRole('button', { name: 'Reconnect voice session' })).toBeInTheDocument();
    expect(await serious(container)).toEqual([]);
  });

  it('a fatal session error ends the call and offers reconnect', async () => {
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByRole('button', { name: 'Start voice session' }));
    await waitFor(() => expect(hoisted.last).toBeDefined());
    await emit(
      server({
        type: 'session.started',
        protocol: 1,
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        conversationId: null,
      }),
    );
    await emit(
      server({ type: 'session.error', code: 'timeout', message: 'no audio received', fatal: true }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('no audio received');
    expect(screen.getByRole('button', { name: 'Reconnect voice session' })).toBeInTheDocument();
  });

  it('flags a transcript the recognizer was unsure about', async () => {
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByRole('button', { name: 'Start voice session' }));
    await waitFor(() => expect(hoisted.last).toBeDefined());
    await emit(
      server({
        type: 'transcript.final',
        turn: 1,
        text: 'yes',
        confidence: 0.3,
        lowConfidence: true,
      }),
    );
    expect(await screen.findByText('not sure I heard that')).toBeInTheDocument();
  });
});
