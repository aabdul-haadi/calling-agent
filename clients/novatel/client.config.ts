import type { ClientConfig } from '@adk/shared';

// Fictional telecom operator. Same engine as SkyLink Air: only this folder is new.
export const novatel: ClientConfig = {
  id: 'novatel',
  displayName: 'NovaTel',
  initials: 'NT',
  accent: 'violet',
  tagline:
    'Understand your bill, check outages in your area, or talk to a person about cancelling.',
  channels: ['chat'],
  persona: {
    name: 'Nia',
    tone: 'friendly, clear, patient with technical questions',
    voiceStyle: 'Use short sentences and avoid jargon',
  },
  scope: ['bill explanations', 'outage and coverage checks', 'billing and cancellation policy'],
  outOfScope: ['legal disputes', 'device repairs', 'payment plan negotiation'],
  intents: [
    'bill_question',
    'outage_check',
    'cancellation_request',
    'billing_policy',
    'complaint',
    'greeting',
    'out_of_scope',
  ],
  starterPrompts: [
    'Why is my bill higher this month?',
    'Is there an outage in Northgate?',
    'I want to cancel my plan',
    'When is my bill due?',
  ],
  journeys: [
    {
      id: 'bill-help',
      label: 'Explain a bill',
      steps: [
        { id: 'identify_intent', label: 'Understand the question' },
        { id: 'verify', label: 'Verify identity' },
        { id: 'look_up', label: 'Look up account' },
        { id: 'explain', label: 'Explain the charges', afterTurn: 'close' },
        { id: 'close', label: 'Wrap up' },
      ],
    },
  ],
  rules: [
    {
      id: 'requires-verification',
      kind: 'requiresVerification',
      description:
        'Bill details can only be shown after the customer is verified (account number + last name). Outage status is public.',
      tools: ['get_bill'],
    },
  ],
  tools: ['verify_customer', 'get_bill', 'check_outage', 'transfer_to_human'],
  escalation: {
    onUserRequest: true,
    maxFailedTurns: 2,
    sentimentThreshold: 'frustrated',
    // Cancellation requests are retention-sensitive, so they always go to a person.
    alwaysEscalateIntents: ['cancellation_request', 'complaint'],
  },
  knowledgeDir: './knowledge',
  scenariosDir: './scenarios',
};
