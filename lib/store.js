// Stand-in metadata store (SQLite). Mirrors the DynamoDB item shape (pk/sk + item JSON) for
// exchange records, with relational tables for the synthetic Premium / survey / certification
// data so the "joinable" requirement can be demonstrated with a real query.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generate, TAGS } from './generate.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function openStore(path = process.env.DB_PATH || join(DATA, 'exchange.db')) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS producers (producer_id TEXT PRIMARY KEY, item TEXT);
    CREATE TABLE IF NOT EXISTS premium_projects (project_id TEXT PRIMARY KEY, producer_id TEXT, item TEXT);
    CREATE TABLE IF NOT EXISTS surveys (survey_id TEXT PRIMARY KEY, producer_id TEXT, item TEXT);
    CREATE TABLE IF NOT EXISTS certifications (cert_id TEXT PRIMARY KEY, producer_id TEXT, item TEXT);
    CREATE TABLE IF NOT EXISTS regional_facts (source_id TEXT PRIMARY KEY, region_id TEXT, item TEXT);
    CREATE TABLE IF NOT EXISTS exchange_records (record_id TEXT PRIMARY KEY, pk TEXT, sk TEXT, producer_id TEXT,
      outcome TEXT, review_status TEXT, source TEXT, created_at TEXT, item TEXT);`);

  if (!db.prepare('SELECT 1 FROM producers LIMIT 1').get()) {
    const d = generate();
    const ins = (t, cols, rows) => { const s = db.prepare(`INSERT INTO ${t} VALUES (${cols.map(() => '?').join(',')}, ?)`); rows.forEach((r) => s.run(...cols.map((c) => r[c]), JSON.stringify(r))); };
    ins('producers', ['producer_id'], d.producers);
    ins('premium_projects', ['project_id', 'producer_id'], d.projects);
    ins('surveys', ['survey_id', 'producer_id'], d.surveys);
    ins('certifications', ['cert_id', 'producer_id'], d.certifications);
    ins('regional_facts', ['source_id', 'region_id'], d.regional);
  }
  const all = (sql, ...a) => db.prepare(sql).all(...a).map((r) => JSON.parse(r.item));
  const one = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? JSON.parse(r.item) : null; };

  return {
    db,
    producers: () => all('SELECT item FROM producers ORDER BY producer_id'),
    producer: (id) => one('SELECT item FROM producers WHERE producer_id = ?', id),
    projectsFor: (id) => all('SELECT item FROM premium_projects WHERE producer_id = ? ORDER BY project_id', id),
    projectsExcept: (id) => all('SELECT item FROM premium_projects WHERE producer_id <> ?', id),
    surveysFor: (id) => all('SELECT item FROM surveys WHERE producer_id = ?', id),
    regionalFor: (regionId) => all("SELECT item FROM regional_facts WHERE region_id IN (?, '*')", regionId),

    putRecord(rec) {
      const now = new Date().toISOString();
      const record_id = rec.record_id || randomUUID();
      const item = { pk: `PRODUCER#${rec.producer_id}`, sk: `EXCHANGE#${now}#${record_id}`, record_id, created_at: now, source: 'agent conversation', review_status: 'pending', ...rec };
      item.source = 'agent conversation'; // never overridable: keeps agent records distinct from compliance data
      db.prepare('INSERT INTO exchange_records VALUES (?,?,?,?,?,?,?,?,?)').run(record_id, item.pk, item.sk, item.producer_id, item.outcome, item.review_status, item.source, now, JSON.stringify(item));
      return item;
    },
    records: () => all('SELECT item FROM exchange_records ORDER BY created_at DESC'),
    record: (id) => one('SELECT item FROM exchange_records WHERE record_id = ?', id),
    reviewRecord(id, { tags, challenge_summary, reviewer }) {
      const item = this.record(id);
      if (!item) return null;
      item.reviewer_edits = { before: { tags: item.tags, challenge_summary: item.challenge_summary }, reviewer: reviewer || 'IRL reviewer', at: new Date().toISOString() };
      if (tags) item.tags = tags.filter((t) => TAGS.includes(t));
      if (challenge_summary) item.challenge_summary = challenge_summary;
      item.review_status = 'reviewed';
      db.prepare('UPDATE exchange_records SET review_status = ?, item = ? WHERE record_id = ?').run('reviewed', JSON.stringify(item), id);
      return item;
    },
    // The join FTUSA cares about: the producer-stated record next to the quantitative data.
    JOIN_SQL: `SELECT r.item AS record, p.item AS producer,
  (SELECT json_group_array(json(item)) FROM premium_projects WHERE producer_id = r.producer_id) AS premium_projects,
  (SELECT json_group_array(json(item)) FROM surveys WHERE producer_id = r.producer_id) AS surveys,
  (SELECT json_group_array(json(item)) FROM certifications WHERE producer_id = r.producer_id) AS certifications
FROM exchange_records r JOIN producers p ON p.producer_id = r.producer_id
WHERE r.record_id = ?`,
    joined(id) {
      const r = db.prepare(this.JOIN_SQL).get(id);
      if (!r) return null;
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, JSON.parse(v)]));
    },
  };
}

// Standards text: loads every CSV in data/standards (clause_id,standard,section,text,tags).
// FTUSA's APS/FPS Excel → export each sheet to CSV with these columns and drop it in that folder;
// the sample file is used only when it is the sole file present.
export function loadStandards(dir = join(DATA, 'standards')) {
  if (!existsSync(dir)) return [];
  let files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
  if (files.length > 1) files = files.filter((f) => !f.includes('.sample.'));
  return files.flatMap((f) => parseCsv(readFileSync(join(dir, f), 'utf8'))).map((r) => ({ ...r, tags: (r.tags || '').split('|').filter(Boolean) }));
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(Boolean)) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}
