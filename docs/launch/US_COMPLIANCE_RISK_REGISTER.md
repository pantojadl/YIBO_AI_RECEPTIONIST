# US compliance risk register

This is an engineering risk list, not a legal opinion and not a compliance certificate. Counsel has to review it before a customer is signed. Sources were read on 2026-10-20.

Do not say "HIPAA compliant," "TCPA compliant," "SOC 2 certified," "FCC approved," or "legal in all 50 states."

## Product defaults that match the risk

- Inbound only. `YIBO_OUTBOUND_DIALING` other than off is a startup error.
- No recording pipeline. `YIBO_CALL_RECORDING` other than off is a startup error.
- First spoken turn is instructed to say the assistant is an automated AI, not a person.
- Healthcare is out of scope. The prompt tells the model not to collect health details or give medical advice.
- Emergency: the prompt tells the caller to contact local emergency services. YIBO does not place 911 calls and has no E911 registration.
- External phone transfer is off, because that leg can be a billable outbound call.

## Federal

| Topic | What was read | What it means for this pilot | Status |
|---|---|---|---|
| TCPA, AI voice | FCC consumer guide, updated 2025-03-05: https://www.fcc.gov/consumers/guides/political-campaign-robocalls-and-robotexts-rules — AI-generated voices are "artificial" under the TCPA. 47 USC 227. | That ruling is about calls the business initiates with an artificial or prerecorded voice. YIBO's pilot does not originate those calls. Inbound help is a different posture. It is not a free pass on every rule, and it is not a reason to add outbound later. | Outbound disabled. Counsel still reviews any callback or reminder. |
| TCPA text | FCC guide above also covers autodialed texts. | Do not add SMS. | Not implemented. |
| FTC Telemarketing Sales Rule | https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule | The TSR is mainly about telemarketing. Inbound customer calls are not automatically outside every FTC deception rule. Do not cold-call. Do not invent prices, testimonials, or certifications. | Outbound off. Sales copy is draft. |
| STIR/SHAKEN, caller ID | Carrier terms, not re-certified here. | The pilot number, if purchased, is presented by the carrier. Do not spoof. | Blocked until a carrier exists. |
| E911 | Twilio's price page lists emergency calling at $0.75/month per number and a $75 fee if 911 is dialed without a registered address. | YIBO must not be described as a 911 service. | Not configured. |

## Recording and state wiretap rules

Federal law does not erase stricter state consent rules. Several states are commonly described as requiring all-party consent to record a conversation (often including California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana, Nevada, New Hampshire, Oregon, Pennsylvania, and Washington). That list is a reminder, not a completed 50-state survey, and it was not re-verified statute by statute in this run.

Because the list can be wrong or incomplete, the safe default is: do not record, do not store call audio, and do not store a transcript. If the owner later wants recording, stop and get a state-by-state review plus an obvious notice. The software will refuse to boot if recording is switched on.

## Privacy

US state privacy laws (California and others) can apply based on the business, the volume, and the data. This pilot should collect name, callback number, and the appointment. It should not collect payment cards, government IDs, or health details. Retention and deletion for a real customer are operator steps in `PRIVACY_DATA_FLOW.md` and `OWNER_HANDOFF.md`. There is no published privacy policy. Draft language is in `OPERATOR_LEGAL_REVIEW.md` and is not approved.

## HIPAA

HHS, "Business Associates," content last reviewed 2026-07-30: https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html

A vendor that schedules for a covered entity and handles protected health information can be a business associate. The same page lists an AI chatbot on a provider portal that handles PHI as an example. OpenAI, the host, email, and a calendar can all sit in that chain.

YIBO does not claim to be HIPAA compliant. Do not onboard a clinic, dental office, or other covered entity. The development fixture is still named "Demo Clinic" with dental service labels. That is leftover test data, not an offer.

## Payments and sales

No payment processor is integrated. The demo does not take card numbers. Do not publish a final price. The cost model is a proposal.

## Accessibility

The demo page uses a visible simulation and buttons for common questions. A live pilot still needs a way to reach a person (`transfer_to_human` to an internal extension). Do not promise a full accessibility program that has not been tested.
