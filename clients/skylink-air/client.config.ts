import type { ClientConfig } from '@adk/shared';

// Fictional airline. Journeys/rules/escalation are DATA; the engine enforces them in code.
export const skylinkAir: ClientConfig = {
  id: 'skylink-air',
  displayName: 'SkyLink Air',
  initials: 'SK',
  accent: 'sky',
  tagline: 'Rebook cancelled flights, check baggage and change-fee policy, or hand off to a human.',
  channels: ['chat', 'voice'],
  persona: {
    name: 'Ava',
    tone: 'warm, concise, calm under pressure',
    voiceStyle: 'Use short sentences, read numbers naturally, and confirm key details back',
  },
  scope: ['flight cancellations', 'rebooking', 'baggage and change-fee policy', 'refund policy'],
  outOfScope: ['medical advice', 'legal claims', 'loyalty points disputes'],
  intents: [
    'rebooking',
    'flight_cancelled',
    'baggage_policy',
    'refund_policy',
    'change_fee_policy',
    'lost_baggage_claim',
    'complaint',
    'greeting',
    'out_of_scope',
  ],
  starterPrompts: [
    'My flight was cancelled',
    'How many bags can I check?',
    'Can I get a refund?',
    'I want to talk to a person',
  ],
  journeys: [
    {
      id: 'rebooking',
      label: 'Rebook a flight',
      steps: [
        { id: 'identify_intent', label: 'Understand the problem' },
        { id: 'verify', label: 'Verify identity' },
        { id: 'look_up', label: 'Look up booking' },
        { id: 'offer', label: 'Offer alternatives', afterUserReply: 'confirm' },
        { id: 'confirm', label: 'Confirm choice' },
        { id: 'act', label: 'Rebook', afterTurn: 'close' },
        { id: 'close', label: 'Wrap up' },
      ],
    },
  ],
  rules: [
    {
      id: 'requires-verification',
      kind: 'requiresVerification',
      description:
        'Booking details can only be read or changed after the passenger is verified (booking reference + last name).',
      tools: ['get_booking', 'search_alternatives', 'change_flight'],
    },
    {
      id: 'max-free-changes',
      kind: 'maxCallsPerConversation',
      description: 'Only one flight change can be made per conversation.',
      tool: 'change_flight',
      limit: 1,
    },
  ],
  tools: [
    'verify_customer',
    'get_booking',
    'search_alternatives',
    'change_flight',
    'transfer_to_human',
  ],
  escalation: {
    onUserRequest: true,
    maxFailedTurns: 2,
    sentimentThreshold: 'frustrated',
    alwaysEscalateIntents: ['lost_baggage_claim', 'complaint'],
  },
  knowledgeDir: './knowledge',
  scenariosDir: './scenarios',
};
