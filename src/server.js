const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3100;
const API_KEY = process.env.API_KEY || 'apex-agent-secret-change-me';

// DB setup
const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/apex.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    platform TEXT DEFAULT '',
    profile_url TEXT DEFAULT '',
    audience_size INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 0,
    outreach_type TEXT DEFAULT 'cold',
    source TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'discovered',
    outreach_sent_date TEXT DEFAULT '',
    response_date TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id TEXT,
    action TEXT,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(cors());
app.use(express.json());

// API key middleware
const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// --- PROSPECTS ---

app.get('/prospects', requireApiKey, (req, res) => {
  const rows = db.prepare('SELECT * FROM prospects ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...r, iap_score: r.total_score || 0 })));
});

app.post('/prospects', requireApiKey, (req, res) => {
  const { name, email, platform, profile_url, audience_size, iap_score, outreach_type, source, notes, status } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = require('crypto').randomUUID();
  db.prepare(`INSERT INTO prospects (id, name, email, platform, profile_url, audience_size, total_score, outreach_type, source, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, email||'', platform||'', profile_url||'', audience_size||0, iap_score||0, outreach_type||'cold', source||'', notes||'', status||'discovered');
  db.prepare(`INSERT INTO activity_log (prospect_id, action, detail) VALUES (?, 'created', ?)`)
    .run(id, `Added ${name}`);
  res.json({ id, success: true });
});

app.patch('/prospects/:id', requireApiKey, (req, res) => {
  const fieldMap = { status: 'status', notes: 'notes', outreach_sent: 'outreach_sent_date', response_date: 'response_date', iap_score: 'total_score', outreach_type: 'outreach_type', name: 'name', email: 'email', platform: 'platform', profile_url: 'profile_url', audience_size: 'audience_size', source: 'source' };
  const updates = Object.entries(req.body).filter(([k]) => fieldMap[k]).map(([k, v]) => [fieldMap[k], v]);
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
  updates.push(['updated_at', new Date().toISOString()]);
  db.prepare(`UPDATE prospects SET ${updates.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...updates.map(([, v]) => v), req.params.id);
  db.prepare(`INSERT INTO activity_log (prospect_id, action, detail) VALUES (?, 'updated', ?)`)
    .run(req.params.id, `Updated: ${Object.keys(req.body).join(', ')}`);
  const row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(req.params.id);
  res.json({ ...row, iap_score: row.total_score || 0 });
});

app.delete('/prospects/:id', requireApiKey, (req, res) => {
  db.prepare('DELETE FROM prospects WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- ACTIVITY LOG ---
app.get('/prospects/:id/activity', requireApiKey, (req, res) => {
  const rows = db.prepare('SELECT * FROM activity_log WHERE prospect_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json(rows);
});

// --- STATS ---
app.get('/stats', requireApiKey, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM prospects').get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM prospects GROUP BY status').all();
  const byPlatform = db.prepare('SELECT platform, COUNT(*) as c FROM prospects GROUP BY platform').all();
  const outreachSent = db.prepare("SELECT COUNT(*) as c FROM prospects WHERE outreach_sent_date != ''").get().c;
  const responded = db.prepare("SELECT COUNT(*) as c FROM prospects WHERE response_date != ''").get().c;
  res.json({ total, byStatus, byPlatform, outreachSent, responded });
});

// --- HEALTH ---
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Apex CRM running on port ${PORT}`));
