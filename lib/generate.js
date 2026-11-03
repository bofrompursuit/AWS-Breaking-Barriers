// Synthetic data generator. Deterministic (seeded) so every run produces the same demo dataset.
// Everything here is FICTIONAL. Regional figures are synthetic stand-ins shaped like the named
// open datasets; they must be replaced with real pre-extracted values before any real use.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const TAGS = [
  'climate and weather', 'water', 'soil and land', 'market and price', 'labor and migration',
  'financial and access to capital', 'education', 'health', 'infrastructure',
  'biodiversity and conservation', 'social and community',
];

let seed = 20270401;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => Math.round(lo + rnd() * (hi - lo));

// region_id, country, region, crop, registered entity type, fictional org name, members, regional profile
const PRODUCERS = [
  ['CO-CAU', 'Colombia', 'Cauca', 'coffee', 'individual farm', 'Finca Alto Mirador', 1, { rain: -22, stress: 'medium-high', stress2030: 'high', soc: 38, forest: 1.1 }],
  ['PE-JUN', 'Peru', 'Junín (Satipo)', 'coffee', 'cooperative', 'Cooperativa Río Ene', 410, { rain: -9, stress: 'low-medium', stress2030: 'medium-high', soc: 44, forest: 2.4 }],
  ['HN-COP', 'Honduras', 'Copán', 'coffee', 'cooperative', 'Cooperativa Cumbre Azul', 260, { rain: -17, stress: 'medium-high', stress2030: 'high', soc: 31, forest: 1.6 }],
  ['MX-CHI', 'Mexico', 'Chiapas', 'coffee', 'cooperative', 'Unión Sierra Madre', 980, { rain: -12, stress: 'medium-high', stress2030: 'high', soc: 35, forest: 1.9 }],
  ['CI-NAW', "Côte d'Ivoire", 'Nawa (Soubré)', 'cocoa', 'cooperative', 'Coopérative Espoir de Soubré', 1150, { rain: -14, stress: 'low-medium', stress2030: 'medium-high', soc: 18, forest: 3.8 }],
  ['CI-GOH', "Côte d'Ivoire", 'Gôh (Gagnoa)', 'cocoa', 'cooperative', 'Coopérative Lumière de Gagnoa', 720, { rain: -19, stress: 'medium-high', stress2030: 'high', soc: 16, forest: 3.1 }],
  ['CO-MAG', 'Colombia', 'Magdalena', 'banana', 'hired-labor farm', 'Plantación La Esperanza', 140, { rain: -26, stress: 'high', stress2030: 'extremely high', soc: 12, forest: 0.6 }],
  ['PE-PIU', 'Peru', 'Piura', 'banana', 'small producer association', 'Asociación Valle del Chira', 330, { rain: -31, stress: 'extremely high', stress2030: 'extremely high', soc: 9, forest: 0.3 }],
];

const PROJECT_TEMPLATES = {
  water: [['Rainwater catchment tanks', 'Installed household and nursery rainwater catchment tanks to bridge dry-season gaps.'], ['Drip irrigation pilot', 'Co-financed drip irrigation lines on member plots with the most severe water deficits.']],
  'climate and weather': [['Shade-tree planting', 'Planted native shade trees across member plots to lower canopy temperature and soil moisture loss.'], ['Climate-resilient variety renovation', 'Replaced aging plants with drought- and disease-tolerant varieties through a shared nursery.']],
  'soil and land': [['Community compost plant', 'Built a compost facility turning pulp and husk residues into organic fertilizer for members.'], ['Erosion-control terraces', 'Funded live barriers and terracing on steep plots to reduce topsoil loss.']],
  'market and price': [['Quality lab and cupping room', 'Equipped a quality lab so the organization can grade lots and negotiate on quality premiums.'], ['Price-risk reserve fund', 'Created a reserve that tops up member payments when market prices fall below cost of production.']],
  'labor and migration': [['Harvest worker housing upgrade', 'Upgraded seasonal worker housing with sanitation and safe water.'], ['Youth farm-succession program', 'Paid stipends for young members to train in farm management instead of migrating.']],
  'financial and access to capital': [['Revolving credit fund', 'Seeded a member revolving loan fund for inputs and emergencies at below-market rates.']],
  education: [['Scholarship program', "Funded secondary-school scholarships for members' children."]],
  health: [['Community health post', 'Co-funded a health post and visiting nurse for member communities.']],
  infrastructure: [['Access road repair', 'Repaired the main access road so harvests reach the collection center during rains.'], ['Solar drying beds', 'Built covered solar drying beds to protect quality during unpredictable rains.']],
  'biodiversity and conservation': [['Riparian buffer reforestation', 'Reforested stream buffers to protect water sources and wildlife corridors.']],
  'social and community': [['Community center', 'Built a meeting space used for assemblies, training, and women’s committee activities.']],
};

export function generate() {
  seed = 20270401;
  const producers = [], projects = [], surveys = [], certifications = [], regional = [];
  PRODUCERS.forEach(([rid, country, region, crop, entity, org, members, rp], i) => {
    const id = `P-${rid.slice(0, 2)}-${String(i + 1).padStart(3, '0')}`;
    producers.push({ producer_id: id, org_name: org, country, region, region_id: rid, crop, entity_type: entity, members, language: country === "Côte d'Ivoire" ? 'fr' : 'es', synthetic: true });

    const tagPool = rp.rain < -15 ? ['water', 'climate and weather', 'soil and land', 'infrastructure'] : ['market and price', 'soil and land', 'education', 'climate and weather'];
    const used = new Set();
    for (let k = 0; k < 3; k++) {
      let tag = k < 2 ? tagPool[k + (i % 2)] : pick(['education', 'health', 'labor and migration', 'financial and access to capital', 'biodiversity and conservation', 'social and community']);
      const [title, desc] = PROJECT_TEMPLATES[tag].find((t) => !used.has(t[0])) || PROJECT_TEMPLATES[tag][0];
      used.add(title);
      const year = 2022 + k;
      projects.push({ project_id: `PRJ-${id.slice(2)}-${k + 1}`, producer_id: id, year, title, description: desc, tags: [tag], amount_usd: between(4, 60) * 1000, status: year < 2024 ? 'completed' : 'in progress', outcome_note: year < 2024 ? pick(['Members report fewer lost harvest days.', 'Adopted by roughly two-thirds of members.', 'Maintenance costs higher than planned.', 'Yields on participating plots recovered within two seasons.']) : 'Ongoing.', synthetic: true });
    }
    surveys.push({ survey_id: `SRV-${id.slice(2)}`, producer_id: id, year: 2025, respondents: Math.max(1, Math.round(members * 0.3)), top_reported_challenges: [...tagPool.slice(0, 2), pick(TAGS)], avg_income_change_pct: between(-18, 6), share_reporting_lower_yield_pct: between(20, 70), synthetic: true });
    certifications.push({ cert_id: `CERT-${id.slice(2)}`, producer_id: id, standard: 'APS', standard_version: '2.0', status: pick(['certified', 'certified', 'certified with conditions']), last_audit: `2025-${String(between(1, 12)).padStart(2, '0')}-15`, synthetic: true });
    regional.push(
      { source_id: `RF-${rid}-CHIRPS`, region_id: rid, dataset: 'CHIRPS v2.0 rainfall (SYNTHETIC STAND-IN)', metric: 'rainfall vs 10-year average, last two seasons', value: `${rp.rain}%`, tags: ['climate and weather', 'water'] },
      { source_id: `RF-${rid}-AQUEDUCT`, region_id: rid, dataset: 'WRI Aqueduct 4.0 (SYNTHETIC STAND-IN)', metric: 'baseline water stress → 2030 business-as-usual projection', value: `${rp.stress} → ${rp.stress2030}`, tags: ['water', 'climate and weather'] },
      { source_id: `RF-${rid}-SOILGRIDS`, region_id: rid, dataset: 'ISRIC SoilGrids 2.0 (SYNTHETIC STAND-IN)', metric: 'topsoil organic carbon (0–30 cm)', value: `${rp.soc} g/kg`, tags: ['soil and land'] },
      { source_id: `RF-${rid}-JRCTMF`, region_id: rid, dataset: 'JRC Tropical Moist Forest (SYNTHETIC STAND-IN)', metric: 'forest cover lost 2015–2024', value: `${rp.forest}%`, tags: ['biodiversity and conservation', 'soil and land'] },
    );
  });
  for (const [crop, chg, note] of [['coffee', -14, 'arabica'], ['cocoa', -21, 'after the 2024 peak'], ['banana', 3, 'flat in real terms']]) {
    regional.push({ source_id: `RF-WB-${crop.toUpperCase()}`, region_id: '*', crop, dataset: 'World Bank Pink Sheet (SYNTHETIC STAND-IN)', metric: `${crop} benchmark price, 12-month change (${note})`, value: `${chg}%`, tags: ['market and price'] });
  }
  return { producers, projects, surveys, certifications, regional };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'synthetic');
  mkdirSync(out, { recursive: true });
  for (const [k, v] of Object.entries(generate())) writeFileSync(join(out, `${k}.json`), JSON.stringify(v, null, 2));
  console.log(`Wrote synthetic dataset to ${out}`);
}
