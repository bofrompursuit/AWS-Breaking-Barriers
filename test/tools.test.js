import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, loadStandards } from '../lib/store.js';
import { runTool, newSessionState, detectPii, TOOL_DEFS } from '../lib/tools.js';

const store = openStore(':memory:');
const standards = loadStandards();
const ctxFor = (pid) => ({ store, standards, state: newSessionState(pid) });
const ME = 'P-CO-001', OTHER = 'P-PE-002';
const otherIds = () => new Set([OTHER, ...store.projectsFor(OTHER).map((p) => p.project_id), ...store.surveysFor(OTHER).map((s) => s.survey_id)]);

test('no tool schema accepts a producer_id', () => {
  for (const t of TOOL_DEFS) assert.ok(!JSON.stringify(t.input_schema).includes('producer_id'), t.name);
});

test('NEGATIVE: history ignores injected producer_id and never returns another producer', () => {
  const out = runTool('get_producer_history', { reasoning: 'x', producer_id: OTHER }, ctxFor(ME));
  assert.ok(out.premium_projects.length > 0);
  for (const p of [...out.premium_projects, ...out.surveys]) assert.equal(p.producer_id, ME);
});

test('NEGATIVE: peer examples exclude own projects and carry no peer producer_id, surveys or certification', () => {
  const out = runTool('find_peer_examples', { reasoning: 'x', tags: ['water', 'climate and weather', 'market and price'] }, ctxFor(ME));
  assert.ok(out.examples.length > 0);
  const own = new Set(store.projectsFor(ME).map((p) => p.project_id));
  const s = JSON.stringify(out);
  for (const e of out.examples) assert.ok(!own.has(e.project_id));
  for (const banned of ['producer_id', 'survey', 'cert_id', 'last_audit', 'respondents']) assert.ok(!s.includes(banned), banned);
});

test('NEGATIVE: regional context only returns own region (plus global commodity rows for own crop)', () => {
  const me = store.producer(ME);
  const out = runTool('get_regional_context', { reasoning: 'x', tags: [], region_id: 'PE-JUN' }, ctxFor(ME));
  for (const f of out.facts) assert.ok(f.region_id === me.region_id || (f.region_id === '*' && f.crop === me.crop), f.source_id);
});

test('NEGATIVE: profile and every tool output for ME contains no identifiers of another producer', () => {
  const ctx = ctxFor(ME), ids = otherIds();
  const outs = ['get_session_profile', 'get_producer_history', 'get_regional_context'].map((n) => JSON.stringify(runTool(n, { reasoning: 'x', tags: [] }, ctx)));
  for (const o of outs) for (const id of ids) assert.ok(!o.includes(`"${id}"`), id);
});

test('grounding: prepare_guidance rejects uncited or un-retrieved sources and clauses', () => {
  const ctx = ctxFor(ME);
  const bad = runTool('prepare_guidance', { reasoning: 'x', insights: [{ text: 'made up', source_ids: ['RF-FAKE'], clause_ids: ['APS-DEMO-4.1'] }], examples: [{ text: 'x', project_id: 'PRJ-PE-002-1', clause_ids: ['NOPE'] }] }, ctx);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 3);
});

test('grounding: full happy path saves a record with guidance content, source marking and pending review', () => {
  const ctx = ctxFor(ME);
  runTool('get_session_profile', { reasoning: 'confirm' }, ctx);
  const reg = runTool('get_regional_context', { reasoning: 'x', tags: ['water'] }, ctx);
  const peers = runTool('find_peer_examples', { reasoning: 'x', tags: ['water'] }, ctx);
  const cl = runTool('search_standards', { reasoning: 'x', query: 'water availability', tags: ['water'] }, ctx);
  const clause = cl.clauses[0].clause_id;
  const ok = runTool('prepare_guidance', { reasoning: 'x', insights: [{ text: 'Rainfall is down.', source_ids: [reg.facts[0].source_id], clause_ids: [clause] }], examples: [{ text: 'Peer built tanks.', project_id: peers.examples[0].project_id, clause_ids: [clause] }] }, ctx);
  assert.equal(ok.ok, true);
  const saved = runTool('save_exchange_record', { reasoning: 'consented', language: 'en', confirmed_entity_type: 'cooperative', confirmed_location: 'Cauca, Colombia', challenge_summary: 'Rain unreliable two seasons', challenge_summary_en: 'Rain unreliable two seasons', corrections: 'cooperative, not individual farm', timing: '2 seasons', severity: 'harvest down', already_tried: 'nothing', tags: ['water', 'climate and weather'], feedback_helpful: 'yes', feedback_comment: '' }, ctx);
  const rec = store.joined(saved.record_id);
  assert.equal(rec.record.source, 'agent conversation');
  assert.equal(rec.record.review_status, 'pending');
  assert.equal(rec.record.entity_type, 'cooperative');
  assert.equal(rec.record.entity_type_registered, 'individual farm');
  assert.ok(rec.record.guidance.insights[0].text && rec.record.guidance.examples[0].citation.peer_organization);
  assert.ok(rec.record.standard_clauses.includes(clause));
  assert.ok(rec.premium_projects.length && rec.surveys.length && rec.certifications.length, 'joins to quantitative data');
  assert.ok(rec.premium_projects.every((p) => p.producer_id === ME));
});

test('save is refused before guidance passes', () => {
  const ctx = ctxFor(ME);
  const r = runTool('save_exchange_record', { reasoning: 'x', tags: ['water'] }, ctx);
  assert.equal(r.ok, false);
});

test('decline records an outcome with no narrative content and closes the session', () => {
  const ctx = ctxFor(ME);
  const r = runTool('record_declined', { stage: 'declined_to_continue' }, ctx);
  const rec = store.record(r.record_id);
  assert.equal(rec.outcome, 'declined');
  assert.equal(rec.source, 'agent conversation');
  for (const k of ['challenge_summary', 'guidance', 'reasoning_log', 'tags']) assert.ok(!(k in rec), k);
  assert.ok(runTool('get_producer_history', { reasoning: 'x' }, ctx).error, 'nothing retrievable after decline');
});

test('out-of-scope logs only the category', () => {
  const ctx = ctxFor(ME);
  runTool('log_out_of_scope', { category: 'certification_status', reasoning: 'they asked whether their audit passed' }, ctx);
  assert.ok(!JSON.stringify(ctx.state).includes('audit passed'));
});

test('PII detector flags contact details without altering text', () => {
  assert.deepEqual(detectPii('call me on +57 312 555 0199'), ['contact_details']);
  assert.ok(detectPii('write to ana@example.org').includes('contact_details'));
  assert.deepEqual(detectPii('rain was down 20% in 2025'), []);
});

test('sample records are built through the real tool flow and labeled', async () => {
  const { seedSampleRecords } = await import('../lib/samples.js');
  const s = openStore(':memory:');
  assert.equal(seedSampleRecords(s, standards), 3);
  const recs = s.records();
  assert.ok(recs.every((r) => r.sample && r.source === 'agent conversation'));
  assert.equal(recs.filter((r) => r.outcome === 'declined').length, 1);
  assert.ok(recs.some((r) => r.pii_flag.raised) && recs.some((r) => r.review_status === 'reviewed'));
  assert.equal(seedSampleRecords(s, standards), 0, 'does not reseed a non-empty store');
});
