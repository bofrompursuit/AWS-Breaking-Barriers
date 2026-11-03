# Handoff package

## Architecture (single agent, enforced scope)

```
web chat ──► POST /api/chat ──► agent loop (Claude, manual tool-use loop, lib/agent.js)
                                   │  tools (lib/tools.js) read producer_id from the SERVER session only
                                   ▼
                       metadata store (lib/store.js) ◄── /review (IRL reviewer)
```

- **Scope is enforced in the tools, not the prompt.** No tool schema has a `producer_id` field; handlers use `state.producerId`, which is bound when the session is created. `find_peer_examples` only returns organization-level project fields (no peer producer_id, surveys or certification). Certification status has no tool at all.
- **Grounding is enforced in a tool.** `prepare_guidance` rejects any insight or example that cites a `source_id`, `project_id` or `clause_id` not retrieved in this session. The model is told never to present guidance that hasn't passed, and `save_exchange_record` refuses to run without it.
- **Consent:** `record_declined` writes `{outcome: "declined", decline_stage, feedback}` with no narrative and closes the session, so later tool calls fail.
- **PII:** a server regex (phone/email) plus model-raised `flag_pii` (named individuals). Flags go to `pii_flag`; text is never altered.
- **Out of scope:** `log_out_of_scope` logs only the category, and the content never reaches the record.

## Exchange record schema (DynamoDB-shaped item)

| field | notes |
|---|---|
| `pk` / `sk` | `PRODUCER#<producer_id>` / `EXCHANGE#<iso ts>#<record_id>` |
| `record_id`, `producer_id`, `created_at` | |
| `source` | always `"agent conversation"` (hard-set by the store) |
| `outcome` | `completed` \| `declined` (+ `decline_stage`) |
| `review_status` | `pending` → `reviewed` (+ `reviewer_edits.before`) |
| `language`, `entity_type`, `entity_type_registered`, `location`, `crop` | confirmed values; registered value kept when corrected |
| `challenge_summary`, `challenge_summary_en`, `corrections`, `timing`, `severity`, `already_tried` | producer-confirmed playback |
| `tags` | subset of the 11 challenge tags |
| `guidance.insights[]` | `{text, citations[{id, dataset, metric, value}], clauses[{clause_id, standard, section}]}` |
| `guidance.examples[]` | `{text, citation{id, peer_organization, title, country}, clauses[]}` |
| `citations[]`, `standard_clauses[]` | de-duplicated rollups for querying |
| `feedback` | `{helpful: yes\|partly\|no\|not_answered, comment}` |
| `pii_flag` | `{raised, reasons[{kind, by: agent\|server_pattern, at}]}` |
| `out_of_scope_requests[]` | categories only |
| `reasoning_log[]` | `{at, tool, reasoning}` for every tool call (the triage audit trail) |

The join query is `JOIN_SQL` in `lib/store.js`. It returns the record alongside that producer's `premium_projects`, `surveys` and `certifications`.

## Tool interface contracts

| tool | input (all include `reasoning` except the last two) | returns |
|---|---|---|
| `get_session_profile` | — | registered org, country, region, crop, `entity_type_on_record` |
| `get_producer_history` | — | own `premium_projects[]`, `surveys[]` |
| `get_regional_context` | `tags[]` | `facts[{source_id, dataset, metric, value, tags}]` for own region + own crop price |
| `find_peer_examples` | `tags[]` | up to 4 `examples[{project_id, peer_organization, country, crop, year, title, description, amount_usd, status, outcome_note}]` |
| `search_standards` | `query`, `tags[]` | top 5 `clauses[{clause_id, standard, section, text, tags}]` |
| `prepare_guidance` | `insights[{text, source_ids[], clause_ids[]}]`, `examples[{text, project_id, clause_ids[]}]` | `{ok}` or `{ok:false, errors[]}` |
| `flag_pii` | `kind` | `{ok}` |
| `save_exchange_record` | confirmed profile, summary (+EN), corrections, timing, severity, tried, `tags[]`, feedback | `{ok, record_id}` or errors |
| `log_out_of_scope` | `category` | instruction to decline |
| `record_declined` | `stage`, `feedback_helpful?` | `{ok, record_id}` |

## Stand-in → target mapping

| sandbox stand-in | AWS target |
|---|---|
| `lib/server.js` (node:http) | API Gateway (HTTP API) + Lambda (Node 22). The `/api/chat` handler is unchanged. |
| in-memory session map | DynamoDB `sessions` table with TTL (state + messages) |
| Model client | Already Claude on Amazon Bedrock (`AnthropicBedrockMantle`, model `anthropic.claude-opus-5-5`); move to a Strands `BedrockModel` |
| SQLite `exchange_records` (pk/sk + item) | DynamoDB table with the same pk/sk, then a stream → Redshift for the join |
| SQLite synthetic Premium / survey / cert tables | Atlas / Redshift tables (join on `producer_id`) |
| `data/standards/*.csv` | S3 + (optionally) a Bedrock Knowledge Base; the `search_standards` contract stays the same |
| synthetic regional fact table | pre-extracted CHIRPS / Aqueduct / SoilGrids / JRC TMF / WB tables in S3 or Athena, keyed by `region_id` |
| static `public/*.html` | S3 + CloudFront (review view behind Cognito) |

## Known limits / next steps

- Tag agreement against the 80% target is not measured yet. Build a small labeled set during the workshop and compare it to `tags` on saved records.
- FPIC consent is simplified to a yes/no.
- Peer matching is a tag + crop/country heuristic. Swap in embeddings when real project text arrives.
- Sessions live in memory, so a restart drops conversations in progress (saved records persist).
