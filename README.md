# Fair Trade USA · Producer Exchange Agent (hackathon MVP)

**Live demo:** https://ftusa-producer-exchange.vercel.app · reviewer view: https://ftusa-producer-exchange.vercel.app/review
*(Vercel demo: records and sessions are kept in temporary per-instance storage and may reset. Use a local run for the full reviewer walkthrough.)*

A multilingual conversational agent: a producer describes a challenge, confirms the agent's playback, and gets back (a) what the data shows for their crop and region and (b) what comparable producers funded, with every claim cited and tied to a certification standard clause. With consent, the conversation is written back as a tagged record (`source = "agent conversation"`, `review_status = pending`) that can be joined to the producer's Premium, survey and certification data.

**Synthetic data only.** All producers, organizations and projects are fictional. Regional figures are synthetic stand-ins shaped like CHIRPS, Aqueduct, SoilGrids, JRC TMF and the World Bank Pink Sheet. Standards text is an illustrative placeholder until FTUSA's APS/FPS files are dropped in (see below).

## Run

```bash
npm install
# AWS credentials + AWS_REGION in .env (see .env.example). Claude runs on Amazon Bedrock only.
npm start            # http://127.0.0.1:3000  (producer chat)  ·  /review  (IRL reviewer view)
npm test             # scope / grounding / decline / PII tests, no LLM needed
node scripts/scenario.js drought-es | decline-en | out-of-scope-pii-en   # scripted live scenarios (server must be running)
npm run seed         # writes the synthetic dataset to data/synthetic/*.json
```

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`). Delete `data/exchange.db` to reset.

## Access and spend guards

- **Bedrock only.** All model calls go through Amazon Bedrock (`anthropic.claude-opus-5-5` by default), as FTUSA's technical document requires. `ANTHROPIC_API_KEY` is ignored.
- **Passwords.** `DEMO_PASSWORD` gates the chat; `REVIEW_PASSWORD` gates `/review` and the record APIs (and also opens the chat). Browsers prompt via HTTP Basic auth. Both are optional locally; a hosted deployment returns 503 until they are set.
- **Limits.** Chat turns are rate-limited per IP (`CHAT_RATE_LIMIT`, default 60 per 10 minutes), conversations are capped (`MAX_TURNS_PER_SESSION`, default 30), and in-memory sessions are bounded (`MAX_SESSIONS`).
- **Known limitation.** Sessions and the database are in memory / per instance, so on Vercel a conversation can end with "no longer available" if a request lands on another instance. Durable sessions (AgentCore Runtime or DynamoDB) are the real fix.
- Locally the server listens on `127.0.0.1` only (`HOST` to change).

## Demo script

1. **Journey 1 (Spanish):** pick `P-CO-001` (Cauca coffee, *registered as an individual farm*), Español. Describe irregular rain, answer the follow-ups, correct the entity type to "cooperativa", confirm the playback, say yes to helpful + storing. The side panel shows each tool call and its logged reasoning.
2. **Journey 3:** open `/review`. The record shows the producer's words, tags, the guidance with citations and clauses, the PII flag, the reasoning log, and the SQL join to Premium / survey / certification rows. Edit the tags, then approve.
3. **Journey 2:** any producer, then "I'd rather not continue". This stores a `declined` record with no content.
4. **Journey 4 + PII:** `P-CI-005`. Ask "did our audit pass?" and the agent declines and explains why. Then mention a person's name and phone number, which raises the flag without redacting anything.

## Swapping in FTUSA's standards

Export each APS/FPS sheet to CSV with the columns `clause_id,standard,section,text,tags` (tags are `|`-separated, from the 11-tag set) and put the files in `data/standards/`. Once a real file is present, the sample file is ignored.

See [docs/HANDOFF.md](docs/HANDOFF.md) for the record schema, tool contracts, and the stand-in → AWS target mapping.
