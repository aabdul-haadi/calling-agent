import type { AgentMode } from '@/agent3d/agent-state';
import type { VoiceState } from './state';

/**
 * Which look the 3D agent takes during a gateway voice call. Every input is an event the gateway
 * really sent or a real audio reading, so (unlike the browser-speech engine) tool activity and
 * thinking are live, not replayed after the fact.
 */
export function gatewayAgentMode(s: VoiceState): { mode: AgentMode; tool?: string } {
  switch (s.status) {
    case 'error':
      return { mode: 'error' };
    case 'handing_off':
      return { mode: 'handoff' };
    case 'executing_tool':
      return { mode: 'executing', tool: s.activeTool };
    case 'thinking':
      return { mode: 'thinking' };
    case 'speaking':
      return { mode: 'speaking' };
    case 'awaiting_confirmation':
      return { mode: 'awaiting' };
    case 'transcribing':
    case 'listening':
    case 'interrupted':
      return { mode: 'listening' };
    default:
      return { mode: 'idle' };
  }
}
