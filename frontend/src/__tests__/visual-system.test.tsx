import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from '@/components/layout/nav-items';
import { EmptyState } from '@/components/ui/state-views';
import { AgentIdentityCard } from '@/components/visual/agent-identity-card';
import { VISUAL_ASSETS, visualUrl, type VisualKey } from '@/components/visual/assets';
import { DashboardMetricCard } from '@/components/visual/dashboard-metric-card';
import { QuickActionCard } from '@/components/visual/quick-action-card';
import { VisualAsset } from '@/components/visual/visual-asset';
import { clients } from './fixtures';

const publicDir = resolve(__dirname, '../../public');
const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('visual asset files', () => {
  const keys = Object.keys(VISUAL_ASSETS) as VisualKey[];

  it('every asset the app can ask for exists at both sizes as a real WebP', () => {
    for (const key of keys) {
      for (const width of [96, 256] as const) {
        const file = resolve(publicDir, visualUrl(key, width).replace(/^\//, ''));
        expect(existsSync(file), `${key} ${width}`).toBe(true);
        const head = readFileSync(file).subarray(0, 12).toString('latin1');
        expect(head.startsWith('RIFF') && head.endsWith('WEBP'), `${key} ${width}`).toBe(true);
      }
    }
  });

  it('stays light: no single icon is over 40 KB and the whole set is under 1 MB', () => {
    let total = 0;
    for (const key of keys) {
      for (const width of [96, 256] as const) {
        const size = readFileSync(resolve(publicDir, visualUrl(key, width).replace(/^\//, ''))).length;
        expect(size).toBeLessThan(40 * 1024);
        total += size;
      }
    }
    expect(total).toBeLessThan(1024 * 1024);
  });

  it('ships the licence of the pictures next to them', () => {
    const text = readFileSync(resolve(publicDir, 'visuals/LICENSES.md'), 'utf8');
    expect(text).toContain('CC0');
    expect(text).toContain('3dicons');
  });

  it('every navigation item has a valid picture', () => {
    for (const item of NAV_ITEMS) expect(Object.keys(VISUAL_ASSETS), item.id).toContain(item.asset);
  });
});

describe('VisualAsset', () => {
  it('is decorative by default (empty alt) and named when given a label', () => {
    const { container, rerender } = render(<VisualAsset asset="voice" />);
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
    rerender(<VisualAsset asset="voice" label="Microphone" />);
    expect(screen.getByRole('img', { name: 'Microphone' })).toBeInTheDocument();
  });

  it('is lazy unless it is above the fold, and has a fixed size so the page does not jump', () => {
    const { container, rerender } = render(<VisualAsset asset="analytics" size={56} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('width', '56');
    expect(img).toHaveAttribute('height', '56');
    expect(img.getAttribute('srcset')).toContain('96w');
    expect(img.getAttribute('srcset')).toContain('256w');
    rerender(<VisualAsset asset="analytics" size={56} priority />);
    expect(container.querySelector('img')).toHaveAttribute('loading', 'eager');
  });

  it('uses the small file for small icons and the large one for big ones', () => {
    const { container, rerender } = render(<VisualAsset asset="analytics" size={24} />);
    expect(container.querySelector('img')!.getAttribute('src')).toContain('-96.webp');
    rerender(<VisualAsset asset="analytics" size={88} />);
    expect(container.querySelector('img')!.getAttribute('src')).toContain('-256.webp');
  });

  it('leaves an empty space instead of a broken-image mark when the file fails to load', () => {
    const { container } = render(<VisualAsset asset="analytics" size={32} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('DashboardMetricCard', () => {
  it('shows the real number, its hint, and a plain "needs attention" note when asked', () => {
    inRouter(
      <DashboardMetricCard
        asset="handoffs"
        label="Waiting for a person"
        value={28}
        tone="warn"
        attention="Customers waiting"
        hint="5 accepted"
        to="/handoffs"
      />,
    );
    expect(screen.getByText('28')).toBeInTheDocument();
    expect(screen.getByText('Customers waiting')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/handoffs');
  });

  it('says "Not recorded" instead of inventing a figure', () => {
    inRouter(<DashboardMetricCard asset="analytics" label="Model cost" value={null} />);
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('warms up what the next page needs when the pointer arrives', () => {
    const onPreload = vi.fn();
    inRouter(
      <DashboardMetricCard asset="voice" label="Voice" value={1} to="/voice" onPreload={onPreload} />,
    );
    fireEvent.pointerEnter(screen.getByRole('link'));
    expect(onPreload).toHaveBeenCalledOnce();
  });
});

describe('QuickActionCard', () => {
  it('links to its page and preloads on hover, focus and touch', () => {
    const onPreload = vi.fn();
    inRouter(
      <QuickActionCard
        asset="voice"
        title="Start a voice session"
        description="Talk to the agent out loud"
        to="/voice"
        onPreload={onPreload}
      />,
    );
    const link = screen.getByRole('link', { name: /Start a voice session/ });
    expect(link).toHaveAttribute('href', '/voice');
    fireEvent.pointerEnter(link);
    fireEvent.focus(link);
    fireEvent.touchStart(link);
    expect(onPreload).toHaveBeenCalledTimes(3);
  });
});

describe('AgentIdentityCard', () => {
  const ava = clients[0]!;
  const nia = { ...clients[1]!, channels: ['chat', 'voice'] as ('chat' | 'voice')[] };

  it('shows the agent, the company, the portrait and the real voice-engine status', () => {
    inRouter(<AgentIdentityCard client={ava} selected voiceReady onSelect={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Ava' })).toBeInTheDocument();
    expect(screen.getByText('SkyLink Air')).toBeInTheDocument();
    expect(screen.getByText('Selected')).toBeInTheDocument();
    expect(screen.getByText('Voice engine ready')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Ava, the SkyLink Air agent/ })).toHaveAttribute(
      'src',
      '/visuals/agents/ava.webp',
    );
  });

  it('says the engine is not running when it is not, and says nothing while it is still unknown', () => {
    const { rerender } = inRouter(
      <AgentIdentityCard client={ava} selected={false} voiceReady={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByText('Voice engine not running')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <AgentIdentityCard client={ava} selected={false} onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Voice engine/)).not.toBeInTheDocument();
  });

  it('credits the model that requires it (Nia) and not the one that does not (Ava)', () => {
    inRouter(
      <>
        <AgentIdentityCard client={ava} selected={false} onSelect={vi.fn()} />
        <AgentIdentityCard client={nia} selected={false} onSelect={vi.fn()} />
      </>,
    );
    expect(screen.getAllByText(/Seed-san by VirtualCast/)).toHaveLength(1);
  });

  it('a chat-only agent offers no voice link', () => {
    inRouter(<AgentIdentityCard client={clients[1]!} selected={false} onSelect={vi.fn()} />);
    expect(screen.queryByRole('link', { name: /Talk to/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open workspace' })).toHaveAttribute('href', '/agent/novatel');
  });

  it('selecting a link makes that company the active one and preloads its character', () => {
    const onSelect = vi.fn();
    const onPreload = vi.fn();
    inRouter(
      <AgentIdentityCard client={nia} selected={false} onSelect={onSelect} onPreload={onPreload} />,
    );
    const talk = screen.getByRole('link', { name: 'Talk to Nia' });
    fireEvent.pointerEnter(talk);
    expect(onPreload).toHaveBeenCalledWith('novatel');
    fireEvent.click(talk);
    expect(onSelect).toHaveBeenCalledWith('novatel');
  });
});

describe('EmptyState', () => {
  it('shows its picture as decoration, with the title and hint as the real content', () => {
    const { container } = render(
      <EmptyState asset="allClear" title="Nobody is waiting" hint="Customers who need a person appear here." />,
    );
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('thumb-up');
    expect(img).toHaveAttribute('alt', '');
    expect(screen.getByText('Nobody is waiting')).toBeInTheDocument();
  });

  it('falls back to a plain folder when no picture is chosen', () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector('img')!.getAttribute('src')).toContain('folder');
  });
});
