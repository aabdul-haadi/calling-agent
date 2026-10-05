# 2-minute demo script

Setup: `pnpm dev`, open <http://localhost:5173>. Have `docs/LEARNING.md` closed; this is about the product.

## 0:00 Rebooking (SkyLink Air)

1. Home: "One engine, one config folder per client." Click **Open agent** on SkyLink Air.
2. Click the starter **"My flight was cancelled"**. Point at the Live Trace: _Understood intent: rebooking_.
3. Type `SK1001, last name Rahman`. Trace fills in: _Checked identity_, _Checked the booking system (ms)_, _Searched for alternative flights, found 3_. State card: **Identity verified**, progress bar at "Offer alternatives".
4. Say `Yes, the first one`. Trace: _Rebooked the flight_. Click **Show details** on that line to show raw JSON, masked.

## 0:45 API failure handled

5. Open **Demo controls**, switch on **Booking API failing**, click **Reset conversation**, repeat steps 2-3.
6. Agent apologises in plain words and, after two failures in a row, hands off. Say: "Retries with backoff happened underneath; the model never saw a stack trace."

## 1:15 Handoff

7. Open **Handoff inbox**: the card shows masked customer, reason, 3-line summary, what the AI already tried, sentiment chip. Click **Accept**.
8. Mention the signed webhook (HMAC) and that duplicates are ignored.

## 1:35 Test dashboard

9. **Tests** tab, pick SkyLink Air, **Run tests**. Show the score (for example 18/20), open a failed scenario: transcript, expected behaviour, judge's written reason.

## 1:50 Reusability

10. **Home**, **View config** on NovaTel: persona card, journey diagram, rules checklist, tool chips. Close with: "NovaTel is a folder. The engine diff was empty."

## If voice is wanted (Chrome)

On SkyLink Air press the mic, say "My flight was cancelled", interrupt the agent mid-sentence to show barge-in, and point at the _Voice latency_ line in the trace.
