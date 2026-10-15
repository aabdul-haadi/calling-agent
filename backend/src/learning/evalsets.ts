// Hand-written, stable evaluation material for each tenant. It is kept apart from anything learned
// from live conversations: `seed` utterances may be used to start the local intent model, `heldOut`
// ones are never trained on and decide whether a release may go live. Voice utterances are written
// the way speech recognition returns them (no punctuation, fillers); chat ones the way people type.

export interface IntentCase {
  say: string;
  channel: 'voice' | 'chat';
  intent: string;
}

export interface RetrievalCase {
  q: string;
  /** The document that must come back, or null when the documents do not cover the question. */
  source: string | null;
  channel: 'voice' | 'chat';
}

export interface TenantEvalSet {
  seed: IntentCase[];
  heldOut: IntentCase[];
  retrieval: RetrievalCase[];
}

const v = (say: string, intent: string): IntentCase => ({ say, channel: 'voice', intent });
const c = (say: string, intent: string): IntentCase => ({ say, channel: 'chat', intent });

export const EVAL_SETS: Record<string, TenantEvalSet> = {
  'skylink-air': {
    seed: [
      v('my flight got cancelled and i need another one', 'flight_cancelled'),
      c('My flight was cancelled by the airline', 'flight_cancelled'),
      v('they cancelled my flight this morning', 'flight_cancelled'),
      c('SkyLink cancelled my flight, what now?', 'flight_cancelled'),
      v('i would like to move to a later flight', 'rebooking'),
      c('Can I rebook onto the evening flight?', 'rebooking'),
      v('can you put me on a different flight', 'rebooking'),
      c('I want to change to another departure time', 'rebooking'),
      v('how many bags can i check in', 'baggage_policy'),
      c('What is the baggage allowance for economy?', 'baggage_policy'),
      v('how heavy can my suitcase be', 'baggage_policy'),
      c('How much does an extra bag cost?', 'baggage_policy'),
      v('can i get my money back', 'refund_policy'),
      c('What is your refund policy?', 'refund_policy'),
      v('i want a refund for the cancelled ticket', 'refund_policy'),
      c('How long do refunds take?', 'refund_policy'),
      v('how much is the change fee', 'change_fee_policy'),
      c('Is there a fee to change my booking?', 'change_fee_policy'),
      v('what do i pay to switch my flight', 'change_fee_policy'),
      c('Do I have to pay to move my date?', 'change_fee_policy'),
      v('my bag never arrived', 'lost_baggage_claim'),
      c('The airline lost my luggage', 'lost_baggage_claim'),
      v('i want to file a claim for my lost suitcase', 'lost_baggage_claim'),
      c('My checked bag is missing', 'lost_baggage_claim'),
      v('i want to make a complaint about your staff', 'complaint'),
      c('I would like to file a complaint', 'complaint'),
      v('hello', 'greeting'),
      c('Hi there', 'greeting'),
      v('good morning', 'greeting'),
      c('Hey', 'greeting'),
      v('my flight has been called off', 'flight_cancelled'),
      c('Flight SK100 is cancelled, help', 'flight_cancelled'),
      v('i need to travel on a different day', 'rebooking'),
      c('Please move my booking to Friday', 'rebooking'),
      v('what is the allowance for my hand luggage', 'baggage_policy'),
      c('How many suitcases am I allowed?', 'baggage_policy'),
      v('what is the maximum weight for a bag', 'baggage_policy'),
      v('what does it cost to change a ticket', 'change_fee_policy'),
      c('What is the cost of changing flights?', 'change_fee_policy'),
      v('i would like to complain', 'complaint'),
      c('I want to complain about the service', 'complaint'),
      v('tell me something funny', 'out_of_scope'),
      c('Tell me about the stock market', 'out_of_scope'),
      v('can you book me a hotel in paris', 'out_of_scope'),
      c('What is the weather in London today?', 'out_of_scope'),
      v('i need medical advice for flying', 'out_of_scope'),
      c('Can you recommend a restaurant?', 'out_of_scope'),
    ],
    heldOut: [
      v('the airline called off my flight', 'flight_cancelled'),
      c('My 7am flight is no longer running', 'flight_cancelled'),
      v('i would like a different flight please', 'rebooking'),
      c('Could you switch me to tomorrow morning?', 'rebooking'),
      v('what is the limit for hand luggage', 'baggage_policy'),
      c('Can I bring two suitcases?', 'baggage_policy'),
      v('will i get reimbursed', 'refund_policy'),
      c('I need my money returned for the ticket', 'refund_policy'),
      v('what is the cost of changing my ticket', 'change_fee_policy'),
      c('How much is it to alter my booking?', 'change_fee_policy'),
      v('they lost my luggage', 'lost_baggage_claim'),
      c('My suitcase was damaged and I want to claim', 'lost_baggage_claim'),
      c('I have a complaint about how I was treated', 'complaint'),
      v('i want to complain', 'complaint'),
      c('Good evening!', 'greeting'),
      v('howdy', 'greeting'),
      c('Can you book me a rental car?', 'out_of_scope'),
      v('tell me a joke', 'out_of_scope'),
    ],
    retrieval: [
      { q: 'how many bags can i check in economy', source: 'checked-baggage', channel: 'voice' },
      { q: 'What is the weight limit for a carry-on bag?', source: 'carry-on-baggage', channel: 'chat' },
      { q: 'when does online check in close', source: 'check-in-and-boarding', channel: 'voice' },
      { q: 'What happens if you cancel my flight?', source: 'cancellations-by-airline', channel: 'chat' },
      { q: 'how long do i have to ask for a refund on a cancelled flight', source: 'cancellations-by-airline', channel: 'voice' },
      { q: 'How much does a second suitcase cost?', source: 'checked-baggage', channel: 'chat' },
      { q: 'what are the fare classes', source: 'fare-classes', channel: 'voice' },
      { q: 'Is seat selection free?', source: 'fare-classes', channel: 'chat' },
      { q: 'what if my bag is delayed', source: 'delayed-and-lost-baggage', channel: 'voice' },
      { q: 'Which liquids can go in my cabin bag?', source: 'carry-on-baggage', channel: 'chat' },
      { q: 'does the airline have a pet policy for cats on board', source: 'special-baggage-pets-sports', channel: 'voice' },
      { q: 'is there free wifi on board', source: null, channel: 'voice' },
      { q: 'What is the price of a first class lounge day pass at JFK?', source: null, channel: 'chat' },
      { q: 'can i bring a hunting rifle in my hand luggage', source: null, channel: 'voice' },
      { q: 'What is your parental leave policy for employees?', source: null, channel: 'chat' },
      { q: 'what is the capital of australia', source: null, channel: 'voice' },
    ],
  },
  novatel: {
    seed: [
      v('why is my bill so high this month', 'bill_question'),
      c('Why is my bill higher than usual?', 'bill_question'),
      v('i do not understand this charge on my bill', 'bill_question'),
      c('What is this extra fee on my invoice?', 'bill_question'),
      v('is there an outage in my area', 'outage_check'),
      c('My internet is down, is there an outage?', 'outage_check'),
      v('my phone has no signal at home', 'outage_check'),
      c('Is the network down right now?', 'outage_check'),
      v('i want to cancel my plan', 'cancellation_request'),
      c('I would like to cancel my contract', 'cancellation_request'),
      v('how do i close my account', 'cancellation_request'),
      c('Please cancel my subscription', 'cancellation_request'),
      v('when is my payment due', 'billing_policy'),
      c('What happens if I pay my bill late?', 'billing_policy'),
      v('is there a late fee', 'billing_policy'),
      c('How do roaming charges work?', 'billing_policy'),
      v('will i get a credit for the outage', 'billing_policy'),
      c('When does my billing cycle start?', 'billing_policy'),
      v('i want to make a complaint', 'complaint'),
      c('I need to file a complaint about customer service', 'complaint'),
      v('hello', 'greeting'),
      c('Hi', 'greeting'),
      v('good afternoon', 'greeting'),
      c('Hello there', 'greeting'),
      v('can you explain the charges on my bill', 'bill_question'),
      c('Please explain my latest bill', 'bill_question'),
      v('i would like to complain', 'complaint'),
      c('I want to complain about your support', 'complaint'),
      c('Hey', 'greeting'),
      v('hey there', 'greeting'),
      v('tell me a story', 'out_of_scope'),
      v('can you tell me a recipe for pasta', 'out_of_scope'),
      c('Who won the football game?', 'out_of_scope'),
      v('fix my broken phone screen', 'out_of_scope'),
      c('Can you repair my laptop?', 'out_of_scope'),
    ],
    heldOut: [
      v('why did my bill go up', 'bill_question'),
      c('Can you explain the charges on my latest bill?', 'bill_question'),
      v('is the network down where i live', 'outage_check'),
      c('No service on my phone since this morning', 'outage_check'),
      v('i want to end my contract', 'cancellation_request'),
      c('How can I terminate my plan?', 'cancellation_request'),
      v('what is the due date for my bill', 'billing_policy'),
      c('Are there charges when I travel abroad?', 'billing_policy'),
      c('I have a complaint about my service', 'complaint'),
      v('i want to complain', 'complaint'),
      c('Greetings!', 'greeting'),
      v('hi there', 'greeting'),
      c('Can you fix my television?', 'out_of_scope'),
      v('tell me about the weather', 'out_of_scope'),
    ],
    retrieval: [
      { q: 'when is my bill due', source: 'billing-cycle-and-due-dates', channel: 'voice' },
      { q: 'What is the late payment fee?', source: 'late-payment-and-fees', channel: 'chat' },
      { q: 'how do roaming charges work abroad', source: 'roaming-charges', channel: 'voice' },
      { q: 'Do I get a credit when there is an outage?', source: 'outage-credits', channel: 'chat' },
      { q: 'what happens if i cancel my contract early', source: 'cancellation-and-contracts', channel: 'voice' },
      { q: 'Can I cancel at any time?', source: 'cancellation-and-contracts', channel: 'chat' },
      { q: 'when does my billing cycle begin', source: 'billing-cycle-and-due-dates', channel: 'voice' },
      { q: 'What fee do I pay if my payment is late?', source: 'late-payment-and-fees', channel: 'chat' },
      { q: 'do you sell smart watches', source: null, channel: 'voice' },
      { q: 'What are your store opening hours on Sunday?', source: null, channel: 'chat' },
      { q: 'how do i reset my router password', source: null, channel: 'voice' },
      { q: 'What is the airline baggage allowance?', source: null, channel: 'chat' },
    ],
  },
};

/** Behaviour every tenant must keep, checked on the real classification rules (no model involved). */
export interface SharedCase {
  say: string;
  /** What the rules must conclude. */
  expect: { presenceCheck?: boolean; negatesHuman?: boolean };
}
export const SHARED_RULE_CASES: SharedCase[] = [
  { say: 'Hello, are you listening to me?', expect: { presenceCheck: true } },
  { say: 'Can you hear me?', expect: { presenceCheck: true } },
  { say: 'Are you still there?', expect: { presenceCheck: true } },
  { say: 'Rahman, SK1001.', expect: { presenceCheck: false } },
  { say: 'I want to change my flight', expect: { presenceCheck: false } },
  { say: "I don't want to transfer to a human", expect: { negatesHuman: true } },
  { say: "I don't want to talk to an agent, just help me", expect: { negatesHuman: true } },
  { say: 'I want to talk to a human', expect: { negatesHuman: false } },
  { say: "I don't care, get me a person", expect: { negatesHuman: false } },
];
