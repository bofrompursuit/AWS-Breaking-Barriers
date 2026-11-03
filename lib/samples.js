// Sample exchange records so the reviewer view is never empty on a fresh (ephemeral) deployment.
// Built by running the real tool flow, so every record passes the same scope, grounding and consent
// checks as a live conversation. Marked `sample: true` and shown with a "Sample" badge.
import { runTool, newSessionState } from './tools.js';

function converse(store, standards, producerId, steps) {
  const ctx = { store, standards, state: newSessionState(producerId) };
  const call = (name, input) => runTool(name, { reasoning: '', ...input }, ctx);
  return steps(call);
}

function completed(call, { tags, query, insight, example, pii, outOfScope, save }) {
  call('get_session_profile', { reasoning: 'Confirm location and entity type with the producer.' });
  if (outOfScope) call('log_out_of_scope', { category: outOfScope });
  if (pii) call('flag_pii', { reasoning: pii, kind: 'named_individual' });
  call('get_producer_history', { reasoning: 'Check what the organization already funded with Premium.' });
  const reg = call('get_regional_context', { reasoning: `Regional data for: ${tags.join(', ')}.`, tags });
  const peers = call('find_peer_examples', { reasoning: 'Comparable producers that funded projects on the same challenge.', tags });
  const cl = call('search_standards', { reasoning: 'Standard clauses related to the challenge and the peer example.', query, tags });
  const f = reg.facts.find((x) => x.tags?.includes(tags[0])) || reg.facts[0];
  const p = peers.examples[0];
  const clause = cl.clauses[0].clause_id;
  const g = call('prepare_guidance', {
    reasoning: 'Validate citations before presenting.',
    insights: [{ text: insight(f), source_ids: [f.source_id], clause_ids: [clause] }],
    examples: [{ text: example(p), project_id: p.project_id, clause_ids: [clause] }],
  });
  if (!g.ok) throw new Error(`sample guidance rejected: ${g.errors.join('; ')}`);
  return call('save_exchange_record', { reasoning: 'Producer confirmed the playback and agreed to storing a summary.', tags, ...save }).record_id;
}

export function seedSampleRecords(store, standards) {
  if (store.records().length) return 0;
  const ids = [];

  ids.push(converse(store, standards, 'P-HN-003', (call) => call('record_declined', { stage: 'declined_to_continue' }).record_id));

  ids.push(converse(store, standards, 'P-CI-005', (call) => completed(call, {
    tags: ['soil and land', 'climate and weather'], query: 'soil fertility erosion cover crops',
    outOfScope: 'certification_status',
    insight: (f) => `${f.dataset} : ${f.metric} = ${f.value} dans votre région, ce qui concorde avec la perte de fertilité que vous décrivez.`,
    example: (p) => `${p.peer_organization} (${p.country}, ${p.year}) a financé « ${p.title} » avec ${p.amount_usd.toLocaleString()} USD de Prime. ${p.outcome_note || ''}`.trim(),
    save: {
      language: 'fr', confirmed_entity_type: 'cooperative', confirmed_location: 'Nawa, Côte d\'Ivoire',
      challenge_summary: 'Les sols des parcelles de cacao s\'appauvrissent et les rendements baissent depuis trois saisons ; les jeunes arbres meurent pendant la saison sèche.',
      challenge_summary_en: 'Cocoa plot soils are getting poorer and yields have dropped for three seasons; young trees die in the dry season.',
      corrections: '', timing: 'three seasons', severity: 'yields down roughly a third on older plots', already_tried: 'some members applied compost; not enough for all plots',
      feedback_helpful: 'partly', feedback_comment: 'Would like examples from cocoa cooperatives in Côte d\'Ivoire specifically.',
    },
  })));

  ids.push(converse(store, standards, 'P-CO-001', (call) => completed(call, {
    tags: ['water', 'climate and weather'], query: 'water availability irregular rainfall irrigation',
    pii: 'The producer named the cooperative\'s technician as the person who measured the rainfall.',
    insight: (f) => `${f.dataset}: ${f.metric} = ${f.value} en su región, lo que coincide con la lluvia irregular que describe.`,
    example: (p) => `${p.peer_organization} (${p.country}, ${p.year}) usó US$${p.amount_usd.toLocaleString()} de la Prima para "${p.title}". ${p.outcome_note || ''}`.trim(),
    save: {
      language: 'es', confirmed_entity_type: 'cooperative', confirmed_location: 'Cauca, Colombia',
      challenge_summary: 'Desde hace dos cosechas la lluvia llega a destiempo; la floración se adelanta y se pierde parte del grano. Don Hernán, el técnico de la cooperativa, midió un 30% menos de lluvia en la época seca.',
      challenge_summary_en: 'For two harvests the rain has come at the wrong time; flowering comes early and part of the crop is lost. Don Hernán, the cooperative\'s technician, measured 30% less rain in the dry season.',
      corrections: 'We are a cooperative now, not an individual farm.', timing: 'two harvests', severity: 'about a fifth of the harvest lost last year', already_tried: 'shade trees on a few farms',
      feedback_helpful: 'yes', feedback_comment: '',
    },
  })));

  // Mark as samples; show the reviewed state on the French record (reviewer added a tag).
  for (const id of ids) {
    const item = { ...store.record(id), sample: true };
    store.db.prepare('UPDATE exchange_records SET item = ? WHERE record_id = ?').run(JSON.stringify(item), id);
  }
  const fr = store.record(ids[1]);
  store.reviewRecord(ids[1], { tags: [...fr.tags, 'biodiversity and conservation'], reviewer: 'IRL reviewer (sample)' });
  return ids.length;
}
