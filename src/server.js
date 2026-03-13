const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3100;
const API_KEY = process.env.API_KEY || 'apex-agent-secret-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/apex.db');

let prospects = [];
let deals = [];
let inboxEmails = [];
let reidMessages = [];
let activityLog = [];
let playbook = [];
let nextId = 1;

function loadData() {
  try {
    if (fs.existsSync(DB_PATH + '.json')) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH + '.json', 'utf8'));
      prospects = raw.prospects || [];
      deals = raw.deals || [];
      inboxEmails = raw.inboxEmails || [];
      reidMessages = raw.reidMessages || [];
      activityLog = raw.activityLog || [];
      playbook = raw.playbook || [];
      nextId = raw.nextId || 1;
      console.log(`Loaded ${prospects.length} prospects, ${deals.length} deals, ${inboxEmails.length} emails`);
    }
  } catch (e) { console.log('Starting fresh'); }
}

function saveData() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH + '.json', JSON.stringify({ prospects, deals, inboxEmails, reidMessages, activityLog, playbook, nextId }, null, 2));
  } catch (e) { console.error('Save error:', e.message); }
}

loadData();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const auth = (req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ─── PROSPECTS ───────────────────────────────────────────────
app.get('/prospects', auth, (req, res) => {
  res.json([...prospects].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)).map(r => ({...r, iap_score: r.total_score||0})));
});

app.post('/prospects', auth, (req, res) => {
  const { name, email, platform, profile_url, handle, audience_size, iap_score, outreach_type, source, notes, status, content_focus, fit_score, priority } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const p = { id, name, email:email||'', platform:platform||'', handle:handle||'', profile_url:profile_url||'', audience_size:audience_size||0, total_score:iap_score||fit_score||0, outreach_type:outreach_type||'cold', source:source||'', notes:notes||'', status:status||'discovered', content_focus:content_focus||'', priority:priority||3, outreach_sent_date:'', response_date:'', created_at:now, updated_at:now };
  prospects.push(p);
  activityLog.push({ id: nextId++, prospect_id: id, action: 'created', detail: `Added ${name}`, created_at: now });
  saveData();
  res.json({ id, success: true });
});

app.patch('/prospects/:id', auth, (req, res) => {
  const idx = prospects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const allowed = ['status','notes','outreach_type','platform','profile_url','handle','audience_size','source','name','email','content_focus','priority'];
  const map = { iap_score:'total_score', outreach_sent:'outreach_sent_date', fit_score:'total_score' };
  const updates = {};
  Object.entries(req.body).forEach(([k,v]) => { if (allowed.includes(k)) updates[k]=v; else if (map[k]) updates[map[k]]=v; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
  updates.updated_at = new Date().toISOString();
  prospects[idx] = { ...prospects[idx], ...updates };
  activityLog.push({ id: nextId++, prospect_id: req.params.id, action: 'updated', detail: `Updated: ${Object.keys(req.body).join(', ')}`, created_at: new Date().toISOString() });
  saveData();
  res.json({ ...prospects[idx], iap_score: prospects[idx].total_score||0 });
});

app.delete('/prospects/:id', auth, (req, res) => {
  prospects = prospects.filter(p => p.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

app.get('/prospects/:id/activity', auth, (req, res) => {
  res.json(activityLog.filter(l => l.prospect_id === req.params.id).slice(-50).reverse());
});

app.post('/prospects/bulk', auth, (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records array required' });
  const now = new Date().toISOString();
  let added = 0;
  records.forEach(r => {
    if (!r.name && !r.handle) return;
    if (r.handle && prospects.find(p => p.handle?.toLowerCase() === r.handle.toLowerCase())) return;
    const id = crypto.randomUUID();
    prospects.push({ id, name:r.name||r.handle||'', email:r.email||'', platform:r.platform||'', handle:r.handle||'', profile_url:r.profile_url||'', audience_size:r.audience_size||0, total_score:r.fit_score||r.iap_score||0, outreach_type:'cold', source:r.source||'', notes:r.notes||'', status:r.status||'discovered', content_focus:r.content_focus||'', priority:r.priority||3, outreach_sent_date:'', response_date:'', created_at:now, updated_at:now });
    added++;
  });
  saveData();
  res.json({ added, total: prospects.length });
});

// ─── DEALS ───────────────────────────────────────────────────
app.get('/deals', auth, (req, res) => {
  res.json([...deals].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)));
});

app.post('/deals', auth, (req, res) => {
  const { prospect_id, prospect_name, value, stage, commission_pct, notes, close_date } = req.body;
  if (!prospect_name) return res.status(400).json({ error: 'prospect_name required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const deal = { id, prospect_id:prospect_id||'', prospect_name, value:parseFloat(value)||0, stage:stage||'proposal', commission_pct:parseFloat(commission_pct)||10, commission_value:((parseFloat(value)||0)*(parseFloat(commission_pct)||10)/100), notes:notes||'', close_date:close_date||'', created_at:now, updated_at:now };
  deals.push(deal);
  saveData();
  res.json({ id, success: true });
});

app.patch('/deals/:id', auth, (req, res) => {
  const idx = deals.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const allowed = ['stage','notes','value','commission_pct','close_date','prospect_name'];
  const updates = {};
  Object.entries(req.body).forEach(([k,v]) => { if (allowed.includes(k)) updates[k]=v; });
  updates.updated_at = new Date().toISOString();
  if (updates.value || updates.commission_pct) {
    const val = updates.value ?? deals[idx].value;
    const pct = updates.commission_pct ?? deals[idx].commission_pct;
    updates.commission_value = (parseFloat(val)||0)*(parseFloat(pct)||0)/100;
  }
  deals[idx] = { ...deals[idx], ...updates };
  saveData();
  res.json(deals[idx]);
});

app.delete('/deals/:id', auth, (req, res) => {
  deals = deals.filter(d => d.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

// ─── INBOX / GMAIL SYNC ──────────────────────────────────────
app.get('/inbox/emails', auth, (req, res) => {
  res.json([...inboxEmails].sort((a,b) => new Date(b.date)-new Date(a.date)).slice(0, 100));
});

app.post('/inbox/emails', auth, (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });
  const newEmails = emails.filter(e => !inboxEmails.find(ex => ex.id === e.id));
  inboxEmails = [...newEmails, ...inboxEmails].slice(0, 500);
  saveData();
  res.json({ added: newEmails.length, total: inboxEmails.length });
});

// ─── ASK REID ────────────────────────────────────────────────
app.get('/reid/messages', auth, (req, res) => {
  res.json([...reidMessages].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)).slice(0,50));
});

app.post('/reid/messages', auth, (req, res) => {
  const { message, type } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  reidMessages.unshift({ id, message, type:type||'instruction', status:'pending', created_at:now });
  saveData();
  res.json({ id, success: true });
});

app.patch('/reid/messages/:id', auth, (req, res) => {
  const msg = reidMessages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  Object.assign(msg, req.body, { updated_at: new Date().toISOString() });
  saveData();
  res.json(msg);
});

// ─── PLAYBOOK ────────────────────────────────────────────────
app.get('/playbook', auth, (req, res) => res.json(playbook));

app.post('/playbook', auth, (req, res) => {
  const { title, content, category } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  playbook.push({ id, title, content:content||'', category:category||'general', created_at:now, updated_at:now });
  saveData();
  res.json({ id, success: true });
});

app.patch('/playbook/:id', auth, (req, res) => {
  const idx = playbook.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  playbook[idx] = { ...playbook[idx], ...req.body, updated_at: new Date().toISOString() };
  saveData();
  res.json(playbook[idx]);
});

app.delete('/playbook/:id', auth, (req, res) => {
  playbook = playbook.filter(p => p.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

// ─── STATS ───────────────────────────────────────────────────
app.get('/stats', auth, (req, res) => {
  const byStatus = {}, byPlatform = {};
  prospects.forEach(p => {
    byStatus[p.status] = (byStatus[p.status]||0)+1;
    byPlatform[p.platform||'Unknown'] = (byPlatform[p.platform||'Unknown']||0)+1;
  });
  const totalDealValue = deals.reduce((sum,d) => sum+(d.value||0), 0);
  const totalCommission = deals.reduce((sum,d) => sum+(d.commission_value||0), 0);
  res.json({
    total: prospects.length,
    byStatus: Object.entries(byStatus).map(([status,c])=>({status,c})),
    byPlatform: Object.entries(byPlatform).map(([platform,c])=>({platform,c})),
    outreachSent: prospects.filter(p=>p.outreach_sent_date).length,
    responded: prospects.filter(p=>p.response_date).length,
    deals: deals.length,
    totalDealValue,
    totalCommission,
    wonDeals: deals.filter(d=>d.stage==='closed_won').length,
  });
});

// ─── HEALTH / FRONTEND ──────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok:true, prospects:prospects.length, deals:deals.length, emails:inboxEmails.length, ts:new Date().toISOString() }));

const publicDir = path.join(__dirname, '../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

app.listen(PORT, () => console.log(`Apex CRM on port ${PORT}`));
