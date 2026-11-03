// Drives a scripted scenario against a running server: node scripts/scenario.js <name>
// The agent's questions vary run to run; the scripted producer turns are written to answer generically.
const SCENARIOS = {
  'drought-es': { producerId: 'P-CO-001', lang: 'es', turns: [
    'La lluvia ha sido muy irregular durante dos temporadas y la última cosecha bajó bastante.',
    'Empezó a principios de 2025. Perdimos como un 30% de la cosecha. Hemos intentado regar a mano, pero no alcanza el agua.',
    'Estamos en Cauca, pero no somos una finca individual, somos una cooperativa de unas 90 familias.',
    'Sí, eso es correcto.',
    'Sí, fue útil. Y sí, puede guardar el resumen.',
  ] },
  'decline-en': { producerId: 'P-HN-003', lang: 'en', turns: [
    'Prices have dropped a lot and members are worried.',
    "Actually, I'd rather not continue and I don't want this stored.",
  ] },
  'out-of-scope-pii-en': { producerId: 'P-CI-005', lang: 'en', turns: [
    'Can you tell me if our certification audit passed?',
    'OK. Then: our soil is getting worse. Our agronomist Kouassi Yao (+225 07 12 34 56) says yields fell for three years.',
  ] },
};
const base = process.env.BASE || 'http://localhost:3000';
const name = process.argv[2] || 'drought-es';
const sc = SCENARIOS[name];
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const { sessionId, greeting, error } = await post('/api/session', sc);
if (error) { console.log('ERROR', error); process.exit(1); }
console.log(`\n=== ${name} (${sc.producerId}) ===\nAGENT: ${greeting}`);
for (const t of sc.turns) {
  console.log(`\nPRODUCER: ${t}`);
  const r = await post('/api/chat', { sessionId, message: t });
  if (r.error) { console.log('ERROR', r.error); process.exit(1); }
  console.log(`  [tools: ${r.toolEvents.map((e) => e.tool + (e.ok ? '' : '✗')).join(', ') || '—'}]\nAGENT: ${r.reply}`);
  if (r.state.closed) { console.log(`\n>> closed: ${r.state.closed}; pii: ${JSON.stringify(r.state.pii.map((p) => p.kind))}`); break; }
}
