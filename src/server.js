const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3100;
const API_KEY = process.env.API_KEY || 'apex-agent-secret-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/apex.db');

// In-memory store (persists for process lifetime; Railway volumes for persistence)
let prospects = [];
let activityLog = [];
let nextActivityId = 1;

// Try to load from disk if file exists
function loadData() {
  try {
    if (fs.existsSync(DB_PATH + '.json')) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH + '.json', 'utf8'));
      prospects = raw.prospects || [];
      activityLog = raw.activityLog || [];
      nextActivityId = raw.nextActivityId || 1;
      console.log(`Loaded ${prospects.length} prospects from disk`);
    }
  } catch (e) { console.log('Starting fresh (no data file)'); }
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH + '.json', JSON.stringify({ prospects, activityLog, nextActivityId }, null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

loadData();

app.use(cors());
app.use(express.json());

const requireApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// --- PROSPECTS ---

app.get('/prospects', requireApiKey, (req, res) => {
  const sorted = [...prospects].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(sorted.map(r => ({ ...r, iap_score: r.total_score || 0 })));
});

app.post('/prospects', requireApiKey, (req, res) => {
  const { name, email, platform, profile_url, handle, audience_size, iap_score, outreach_type, source, notes, status, content_focus, fit_score, priority } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = require('crypto').randomUUID();
  const now = new Date().toISOString();
  const prospect = {
    id, name,
    email: email || '',
    platform: platform || '',
    handle: handle || '',
    profile_url: profile_url || '',
    audience_size: audience_size || 0,
    total_score: iap_score || fit_score || 0,
    outreach_type: outreach_type || 'cold',
    source: source || '',
    notes: notes || '',
    status: status || 'discovered',
    content_focus: content_focus || '',
    priority: priority || 3,
    outreach_sent_date: '',
    response_date: '',
    created_at: now,
    updated_at: now
  };
  prospects.push(prospect);
  activityLog.push({ id: nextActivityId++, prospect_id: id, action: 'created', detail: `Added ${name}`, created_at: now });
  saveData();
  res.json({ id, success: true });
});

app.patch('/prospects/:id', requireApiKey, (req, res) => {
  const idx = prospects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const allowedFields = ['status', 'notes', 'outreach_type', 'platform', 'profile_url', 'handle', 'audience_size', 'source', 'name', 'email', 'content_focus', 'priority'];
  const fieldMap = { iap_score: 'total_score', outreach_sent: 'outreach_sent_date', fit_score: 'total_score' };
  const updates = {};
  Object.entries(req.body).forEach(([k, v]) => {
    if (allowedFields.includes(k)) updates[k] = v;
    else if (fieldMap[k]) updates[fieldMap[k]] = v;
  });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
  updates.updated_at = new Date().toISOString();
  prospects[idx] = { ...prospects[idx], ...updates };
  activityLog.push({ id: nextActivityId++, prospect_id: req.params.id, action: 'updated', detail: `Updated: ${Object.keys(req.body).join(', ')}`, created_at: new Date().toISOString() });
  saveData();
  res.json({ ...prospects[idx], iap_score: prospects[idx].total_score || 0 });
});

app.delete('/prospects/:id', requireApiKey, (req, res) => {
  prospects = prospects.filter(p => p.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

app.get('/prospects/:id/activity', requireApiKey, (req, res) => {
  res.json(activityLog.filter(l => l.prospect_id === req.params.id).slice(-50).reverse());
});

// --- STATS ---
app.get('/stats', requireApiKey, (req, res) => {
  const byStatus = {};
  const byPlatform = {};
  prospects.forEach(p => {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    byPlatform[p.platform || 'unknown'] = (byPlatform[p.platform || 'unknown'] || 0) + 1;
  });
  res.json({
    total: prospects.length,
    byStatus: Object.entries(byStatus).map(([status, c]) => ({ status, c })),
    byPlatform: Object.entries(byPlatform).map(([platform, c]) => ({ platform, c })),
    outreachSent: prospects.filter(p => p.outreach_sent_date).length,
    responded: prospects.filter(p => p.response_date).length
  });
});

// --- BULK IMPORT ---
app.post('/prospects/bulk', requireApiKey, (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records array required' });
  const now = new Date().toISOString();
  let added = 0;
  records.forEach(r => {
    if (!r.name && !r.handle) return;
    const existingHandle = r.handle && prospects.find(p => p.handle?.toLowerCase() === r.handle.toLowerCase());
    if (existingHandle) return;
    const id = require('crypto').randomUUID();
    prospects.push({
      id, name: r.name || r.handle || '',
      email: r.email || '', platform: r.platform || '', handle: r.handle || '',
      profile_url: r.profile_url || '', audience_size: r.audience_size || 0,
      total_score: r.fit_score || r.iap_score || 0, outreach_type: 'cold',
      source: r.source || '', notes: r.notes || '', status: r.status || 'discovered',
      content_focus: r.content_focus || '', priority: r.priority || 3,
      outreach_sent_date: '', response_date: '', created_at: now, updated_at: now
    });
    added++;
  });
  saveData();
  res.json({ added, total: prospects.length });
});

app.get('/health', (req, res) => res.json({ ok: true, prospects: prospects.length, ts: new Date().toISOString() }));

// Serve frontend
const publicDir = path.join(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

app.listen(PORT, () => console.log(`Apex CRM running on port ${PORT}`));
