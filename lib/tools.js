// The agent's fixed toolset. Scope is enforced HERE, not in the prompt: every handler reads the
// producer from the server-side session, and no tool accepts a producer_id from the model.
import { TAGS } from './generate.js';

const reasoning = { type: 'string', description: 'One sentence: why you are calling this tool now. Logged for audit.' };
const tagList = { type: 'array', items: { type: 'string', enum: TAGS } };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_DEFS = [
  { name: 'get_session_profile', description: "Return the logged-in producer's registered profile (organization, country, region, crop, entity type). Use it to confirm location and entity type with the producer.", input_schema: obj({ reasoning }) },
  { name: 'get_producer_history', description: "Return THIS producer's own Community Development Fund (Premium) projects and survey results. Certification status is not available to this agent.", input_schema: obj({ reasoning }) },
  { name: 'get_regional_context', description: "Return open-data facts (rainfall, water stress, soil, forest, commodity price) for THIS producer's region and crop, filtered by challenge tags. Each fact has a source_id to cite.", input_schema: obj({ reasoning, tags: tagList }) },
  { name: 'find_peer_examples', description: 'Return Premium projects other producer organizations funded for similar challenges (same crop or country first). Organization-level, fictionalized names. Each has a project_id to cite.', input_schema: obj({ reasoning, tags: tagList }) },
  { name: 'search_standards', description: 'Search the certification standards text (APS/FPS) for clauses related to a challenge or a proposed insight/example. Returns clause_ids to cite.', input_schema: obj({ reasoning, query: { type: 'string' }, tags: tagList }) },
  { name: 'prepare_guidance', description: 'REQUIRED before you present guidance. Validates that every insight cites regional/history source_ids you retrieved and every example cites a peer project_id you retrieved, and that each links to retrieved standard clause_ids. Returns errors to fix, or ok.', input_schema: obj({
    reasoning,
    insights: { type: 'array', minItems: 1, items: obj({ text: { type: 'string' }, source_ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, clause_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }) },
    examples: { type: 'array', minItems: 1, items: obj({ text: { type: 'string' }, project_id: { type: 'string' }, clause_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }) },
  }) },
  { name: 'flag_pii', description: 'Raise a human-review flag when the producer names a specific individual or shares contact details. Never redact or alter their words.', input_schema: obj({ reasoning, kind: { type: 'string', enum: ['named_individual', 'contact_details', 'other'] } }) },
  { name: 'log_out_of_scope', description: 'Log that the producer asked for something this agent does not handle (e.g. certification status, worker-voice complaint). Only the category is logged; never the content.', input_schema: obj({ category: { type: 'string', enum: ['certification_status', 'worker_voice_complaint', 'audit_or_compliance', 'other'] } }) },
  { name: 'save_exchange_record', description: 'Write the conversation summary to the producer record. Call ONLY after the producer confirmed your playback, received guidance, and said YES to storing it.', input_schema: obj({
    reasoning,
    language: { type: 'string', description: 'ISO code of the conversation language, e.g. en, es, fr' },
    confirmed_entity_type: { type: 'string' },
    confirmed_location: { type: 'string' },
    challenge_summary: { type: 'string', description: "The producer-confirmed (corrected) understanding, close to the producer's own words, in the conversation language." },
    challenge_summary_en: { type: 'string', description: 'English translation of challenge_summary for reviewers (same text if already English).' },
    corrections: { type: 'string', description: 'What the producer corrected during playback, or "none".' },
    timing: { type: 'string' }, severity: { type: 'string' }, already_tried: { type: 'string' },
    tags: { ...tagList, minItems: 1 },
    feedback_helpful: { type: 'string', enum: ['yes', 'partly', 'no', 'not_answered'] },
    feedback_comment: { type: 'string' },
  }) },
  { name: 'record_declined', description: 'Record that the producer declined to continue or declined storage. Stores no conversation content. This is a successful outcome.', input_schema: obj({ stage: { type: 'string', enum: ['declined_to_continue', 'declined_storage'] }, feedback_helpful: { type: 'string', enum: ['yes', 'partly', 'no', 'not_answered'] } }) },
];

export function newSessionState(producerId) {
  return { producerId, retrieved: { sources: new Map(), projects: new Map(), clauses: new Map() }, profileShown: false, guidance: null, pii: [], reasoningLog: [], outOfScope: [], closed: null };
}

// ctx = { store, standards, state }. Returns a JSON-serializable result.
export function runTool(name, input, ctx) {
  const { store, standards, state } = ctx;
  const me = store.producer(state.producerId);
  if (!me) return { error: 'No producer bound to this session.' };
  if (state.closed && !['flag_pii', 'log_out_of_scope'].includes(name)) return { error: `Session already closed (${state.closed}). Nothing more is stored.` };
  if (name !== 'log_out_of_scope') state.reasoningLog.push({ at: new Date().toISOString(), tool: name, reasoning: input.reasoning || '' });

  switch (name) {
    case 'get_session_profile': {
      state.profileShown = true;
      const { producer_id, org_name, country, region, crop, entity_type, members } = me;
      return { producer_id, org_name, country, region, crop, entity_type_on_record: entity_type, members, note: 'Confirm location and entity type with the producer; they may correct it.' };
    }
    case 'get_producer_history': {
      const projects = store.projectsFor(me.producer_id);
      const surveys = store.surveysFor(me.producer_id);
      projects.forEach((p) => state.retrieved.sources.set(p.project_id, { kind: 'own_premium_project', title: p.title, year: p.year }));
      surveys.forEach((s) => state.retrieved.sources.set(s.survey_id, { kind: 'own_survey', year: s.year }));
      return { premium_projects: projects, surveys };
    }
    case 'get_regional_context': {
      const tags = new Set(input.tags || []);
      const facts = store.regionalFor(me.region_id).filter((f) => (!f.crop || f.crop === me.crop) && (!tags.size || f.tags.some((t) => tags.has(t))));
      facts.forEach((f) => state.retrieved.sources.set(f.source_id, { kind: 'regional_open_data', dataset: f.dataset, metric: f.metric, value: f.value }));
      return { region: `${me.region}, ${me.country}`, crop: me.crop, facts, caveat: 'Values are SYNTHETIC stand-ins for the named datasets in this sandbox. Say so when citing them.' };
    }
    case 'find_peer_examples': {
      const tags = new Set(input.tags || []);
      const byId = new Map(store.producers().map((p) => [p.producer_id, p]));
      const scored = store.projectsExcept(me.producer_id)
        .filter((p) => p.tags.some((t) => tags.has(t)))
        .map((p) => { const o = byId.get(p.producer_id); return { p, o, score: (o.crop === me.crop ? 2 : 0) + (o.country === me.country ? 1 : 0) }; })
        .sort((a, b) => b.score - a.score).slice(0, 4);
      // Only organization-level project fields leave this tool: no producer_id, surveys or certifications of peers.
      const examples = scored.map(({ p, o }) => ({ project_id: p.project_id, peer_organization: o.org_name, peer_entity_type: o.entity_type, country: o.country, crop: o.crop, year: p.year, title: p.title, description: p.description, amount_usd: p.amount_usd, status: p.status, outcome_note: p.outcome_note, tags: p.tags }));
      examples.forEach((e) => state.retrieved.projects.set(e.project_id, { peer_organization: e.peer_organization, title: e.title, country: e.country }));
      return { examples };
    }
    case 'search_standards': {
      const words = String(input.query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const tags = new Set(input.tags || []);
      const hits = standards.map((c) => ({ c, score: c.tags.filter((t) => tags.has(t)).length * 3 + words.filter((w) => c.text.toLowerCase().includes(w)).length }))
        .filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map((h) => h.c);
      hits.forEach((c) => state.retrieved.clauses.set(c.clause_id, { standard: c.standard, section: c.section }));
      return { clauses: hits };
    }
    case 'prepare_guidance': {
      const errors = [];
      const { sources, projects, clauses } = state.retrieved;
      (input.insights || []).forEach((g, i) => {
        if (!g.source_ids?.length) errors.push(`insight ${i + 1}: no source_ids`);
        g.source_ids?.forEach((s) => sources.has(s) || errors.push(`insight ${i + 1}: source_id ${s} was not retrieved in this session`));
        if (!g.clause_ids?.length) errors.push(`insight ${i + 1}: no clause_ids`);
        g.clause_ids?.forEach((c) => clauses.has(c) || errors.push(`insight ${i + 1}: clause ${c} was not retrieved via search_standards`));
      });
      (input.examples || []).forEach((e, i) => {
        if (!projects.has(e.project_id)) errors.push(`example ${i + 1}: project_id ${e.project_id} is not a retrieved peer example`);
        if (!e.clause_ids?.length) errors.push(`example ${i + 1}: no clause_ids`);
        e.clause_ids?.forEach((c) => clauses.has(c) || errors.push(`example ${i + 1}: clause ${c} was not retrieved via search_standards`));
      });
      if (!input.insights?.length) errors.push('at least one insight is required');
      if (!input.examples?.length) errors.push('at least one peer example is required');
      if (errors.length) return { ok: false, errors };
      const cite = (id) => ({ id, ...(sources.get(id) || projects.get(id)) });
      state.guidance = {
        insights: input.insights.map((g) => ({ text: g.text, citations: g.source_ids.map(cite), clauses: g.clause_ids.map((c) => ({ clause_id: c, ...clauses.get(c) })) })),
        examples: input.examples.map((e) => ({ text: e.text, citation: cite(e.project_id), clauses: e.clause_ids.map((c) => ({ clause_id: c, ...clauses.get(c) })) })),
      };
      return { ok: true, instruction: 'Present these insights and examples to the producer, each with its citation and related clause id(s). Frame them as information for their own decision, not instructions.' };
    }
    case 'flag_pii':
      state.pii.push({ kind: input.kind, by: 'agent', at: new Date().toISOString() });
      return { ok: true, note: 'Flagged for human review. Do not redact; continue normally.' };
    case 'log_out_of_scope':
      state.outOfScope.push({ category: input.category, at: new Date().toISOString() });
      state.reasoningLog.push({ at: new Date().toISOString(), tool: name, reasoning: `out-of-scope request: ${input.category}` });
      return { ok: true, instruction: 'Tell the producer plainly that this agent cannot help with that and why (it only discusses challenges and returns data and peer examples), suggest they contact their organization or FTUSA through the usual channel, then offer to return to describing a challenge. Do not include the request in any summary.' };
    case 'save_exchange_record': {
      const errs = [];
      if (!state.profileShown) errs.push('call get_session_profile and confirm location/entity type first');
      if (!state.guidance) errs.push('guidance has not passed prepare_guidance');
      if (errs.length) return { ok: false, errors: errs };
      const g = state.guidance;
      const rec = store.putRecord({
        producer_id: me.producer_id, outcome: 'completed', language: input.language,
        entity_type: input.confirmed_entity_type, entity_type_registered: me.entity_type, location: input.confirmed_location, crop: me.crop,
        challenge_summary: input.challenge_summary, challenge_summary_en: input.challenge_summary_en, corrections: input.corrections,
        timing: input.timing, severity: input.severity, already_tried: input.already_tried, tags: input.tags,
        guidance: g,
        citations: [...new Map([...g.insights.flatMap((i) => i.citations), ...g.examples.map((e) => e.citation)].map((c) => [c.id, c])).values()],
        standard_clauses: [...new Set([...g.insights, ...g.examples].flatMap((x) => x.clauses.map((c) => c.clause_id)))],
        feedback: { helpful: input.feedback_helpful, comment: input.feedback_comment || '' },
        pii_flag: { raised: state.pii.length > 0, reasons: state.pii },
        out_of_scope_requests: state.outOfScope.map((o) => o.category),
        reasoning_log: state.reasoningLog,
      });
      state.closed = 'saved';
      return { ok: true, record_id: rec.record_id };
    }
    case 'record_declined': {
      const rec = store.putRecord({ producer_id: me.producer_id, outcome: 'declined', decline_stage: input.stage, entity_type: me.entity_type, feedback: { helpful: input.feedback_helpful || 'not_answered' }, pii_flag: { raised: false, reasons: [] } });
      state.closed = 'declined';
      return { ok: true, record_id: rec.record_id, instruction: 'Thank the producer, confirm nothing from the conversation was stored, and close warmly.' };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// Server-side PII detection on producer messages: flags only, never alters the text.
const PII_PATTERNS = [
  ['contact_details', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['contact_details', /(?:\+?\d[\d\s().-]{7,}\d)/],
];
export function detectPii(text) {
  return PII_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}
