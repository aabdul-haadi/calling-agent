import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentOrb } from '@/agent3d/agent-orb';

vi.mock('@/agent3d/development-avatar-scene', () => ({
  default: () => <div data-testid="development-avatar-scene" />,
}));

describe('development avatar UI', () => {
  it('labels the procedural model and keeps the agent status accessible', async () => {
    render(
      <AgentOrb
        mode="speaking"
        agentName="Nia"
        accent="violet"
        level={0.4}
        developmentAvatar
      />,
    );

    expect(await screen.findByTestId('development-avatar-scene')).toBeInTheDocument();
    expect(screen.getByText('Temporary development avatar')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Nia is speaking');
  });
});
