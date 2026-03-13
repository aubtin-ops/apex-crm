const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3100;
const API_KEY = process.env.API_KEY || 'apex-agent-secret-change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/apex.db');

let db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], nextId:1 };

function loadData() {
  try {
    if (fs.existsSync(DB_PATH + '.json')) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH + '.json', 'utf8'));
      db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], nextId:1, ...raw };
      console.log(`Loaded: ${db.prospects.length} prospects, ${db.deals.length} deals, ${db.inboxEmails.length} emails`);
    }
  } catch(e) { console.log('Fresh start:', e.message); }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive:true });
    fs.writeFileSync(DB_PATH + '.json', JSON.stringify(db, null, 2));
  } catch(e) { console.error('Save error:', e.message); }
}

loadData();
app.use(cors());
app.use(express.json({ limit:'4mb' }));

const auth = (req,res,next) => {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error:'Unauthorized' });
  next();
};

function logActivity(prospect_id, action, detail) {
  db.activityLog.push({ id: db.nextId++, prospect_id, action, detail, created_at: new Date().toISOString() });
}

// ─── PROSPECTS ────────────────────────────────────────────────
app.get('/prospects', auth, (req,res) => {
  res.json([...db.prospects].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)));
});

app.post('/prospects', auth, (req,res) => {
  const { name, email, phone, platform, profile_url, handle, audience_size, iap_score, fit_score, outreach_type, source, notes, status, content_focus, priority, type } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const p = { id, name, email:email||'', phone:phone||'', platform:platform||'', handle:handle||'', profile_url:profile_url||'', audience_size:parseInt(audience_size)||0, total_score:parseInt(iap_score||fit_score)||0, outreach_type:outreach_type||'cold', source:source||'', notes:notes||'', status:status||'prospect', content_focus:content_focus||'', priority:parseInt(priority)||3, type:type||'affiliate', outreach_sent_date:'', response_date:'', created_at:now, updated_at:now };
  db.prospects.push(p);
  logActivity(id, 'created', `Added ${name}`);
  save();
  res.json({ id, success:true });
});

app.patch('/prospects/:id', auth, (req,res) => {
  const idx = db.prospects.findIndex(p => p.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  const allowed = ['status','notes','outreach_type','platform','profile_url','handle','audience_size','source','name','email','phone','content_focus','priority','type'];
  const map = { iap_score:'total_score', outreach_sent:'outreach_sent_date', fit_score:'total_score', response_date:'response_date' };
  const updates = {};
  Object.entries(req.body).forEach(([k,v]) => { if(allowed.includes(k)) updates[k]=v; else if(map[k]) updates[map[k]]=v; });
  if (!Object.keys(updates).length) return res.status(400).json({ error:'No valid fields' });
  updates.updated_at = new Date().toISOString();
  db.prospects[idx] = { ...db.prospects[idx], ...updates };
  logActivity(req.params.id, 'updated', `Updated: ${Object.keys(req.body).join(', ')}`);
  save();
  res.json(db.prospects[idx]);
});

app.delete('/prospects/:id', auth, (req,res) => {
  db.prospects = db.prospects.filter(p => p.id!==req.params.id);
  save();
  res.json({ success:true });
});

app.get('/prospects/:id/activity', auth, (req,res) => {
  res.json(db.activityLog.filter(l => l.prospect_id===req.params.id).slice(-50).reverse());
});

app.post('/prospects/bulk', auth, (req,res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error:'records array required' });
  const now = new Date().toISOString();
  let added = 0;
  records.forEach(r => {
    if (!r.name && !r.handle) return;
    if (r.handle && db.prospects.find(p => p.handle?.toLowerCase()===r.handle.toLowerCase())) return;
    const id = crypto.randomUUID();
    db.prospects.push({ id, name:r.name||r.handle||'', email:r.email||'', phone:r.phone||'', platform:r.platform||'', handle:r.handle||'', profile_url:r.profile_url||'', audience_size:parseInt(r.audience_size||r.followers)||0, total_score:parseInt(r.fit_score||r.iap_score||r.score)||0, outreach_type:'cold', source:r.source||'csv-import', notes:r.notes||'', status:r.status||'prospect', content_focus:r.content_focus||r.niche||'', priority:parseInt(r.priority)||3, type:r.type||'affiliate', outreach_sent_date:'', response_date:'', created_at:now, updated_at:now });
    added++;
  });
  save();
  res.json({ added, total:db.prospects.length });
});

// ─── DEALS ───────────────────────────────────────────────────
app.get('/deals', auth, (req,res) => res.json([...db.deals].sort((a,b) => new Date(b.created_at)-new Date(a.created_at))));

app.post('/deals', auth, (req,res) => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const val = parseFloat(req.body.value)||0, pct = parseFloat(req.body.commission_pct)||10;
  db.deals.push({ id, prospect_id:req.body.prospect_id||'', prospect_name:req.body.prospect_name||'', value:val, stage:req.body.stage||'proposal', commission_pct:pct, commission_value:val*pct/100, notes:req.body.notes||'', close_date:req.body.close_date||'', created_at:now, updated_at:now });
  save();
  res.json({ id, success:true });
});

app.patch('/deals/:id', auth, (req,res) => {
  const idx = db.deals.findIndex(d => d.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  const updates = { ...req.body, updated_at:new Date().toISOString() };
  if (updates.value!==undefined || updates.commission_pct!==undefined) {
    const v = parseFloat(updates.value ?? db.deals[idx].value)||0;
    const p = parseFloat(updates.commission_pct ?? db.deals[idx].commission_pct)||0;
    updates.commission_value = v*p/100;
  }
  db.deals[idx] = { ...db.deals[idx], ...updates };
  save();
  res.json(db.deals[idx]);
});

app.delete('/deals/:id', auth, (req,res) => {
  db.deals = db.deals.filter(d => d.id!==req.params.id);
  save();
  res.json({ success:true });
});

// ─── INBOX ───────────────────────────────────────────────────
app.get('/inbox/emails', auth, (req,res) => res.json([...db.inboxEmails].sort((a,b) => new Date(b.date||b.created_at)-new Date(a.date||a.created_at)).slice(0,200)));

app.post('/inbox/emails', auth, (req,res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error:'emails array required' });
  const newEmails = emails.filter(e => !db.inboxEmails.find(ex => ex.id===e.id));
  db.inboxEmails = [...newEmails, ...db.inboxEmails].slice(0, 500);
  save();
  res.json({ added:newEmails.length, total:db.inboxEmails.length });
});

// ─── AI ANALYZE ──────────────────────────────────────────────
app.post('/analyze', auth, async (req,res) => {
  const { prompt, apiKey, context } = req.body;
  if (!apiKey) return res.status(400).json({ error:'apiKey required' });
  const stats = {
    total: db.prospects.length,
    byStage: db.prospects.reduce((acc,p) => { acc[p.status]=(acc[p.status]||0)+1; return acc; }, {}),
    recentProspects: db.prospects.slice(0,10).map(p=>({name:p.name,status:p.status,platform:p.platform,handle:p.handle})),
    deals: db.deals.length,
    totalDealValue: db.deals.reduce((s,d)=>s+(d.value||0),0),
    recentEmails: db.inboxEmails.slice(0,5).map(e=>({from:e.from_name||e.from,subject:e.subject,snippet:e.snippet})),
  };
  const systemPrompt = `You are APEX, an AI business operator analyzing an affiliate partner CRM. Be direct, concise, and actionable. No fluff.`;
  const userMsg = `CRM Data:\n${JSON.stringify(stats,null,2)}\n\n${context||''}\n\nQuestion: ${prompt||'What needs my attention right now? What are the top 3 actions I should take?'}`;
  try {
    const body = JSON.stringify({ model:'claude-3-5-sonnet-20241022', max_tokens:800, system:systemPrompt, messages:[{role:'user',content:userMsg}] });
    const result = await new Promise((resolve,reject) => {
      const reqO = https.request({ hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{'content-type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','content-length':Buffer.byteLength(body)} }, (r) => {
        let data=''; r.on('data',c=>data+=c); r.on('end',()=>{ try{resolve(JSON.parse(data));}catch{reject(new Error('Parse error'));} });
      });
      reqO.on('error',reject);
      reqO.write(body); reqO.end();
    });
    if (result.error) return res.status(400).json({ error:result.error.message });
    res.json({ analysis:result.content?.[0]?.text||'No response' });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── REID ────────────────────────────────────────────────────
app.get('/reid/messages', auth, (req,res) => res.json([...db.reidMessages].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,100)));

app.post('/reid/messages', auth, (req,res) => {
  const id = crypto.randomUUID();
  db.reidMessages.unshift({ id, message:req.body.message, type:req.body.type||'instruction', status:'pending', created_at:new Date().toISOString() });
  save();
  res.json({ id, success:true });
});

app.patch('/reid/messages/:id', auth, (req,res) => {
  const msg = db.reidMessages.find(m=>m.id===req.params.id);
  if (!msg) return res.status(404).json({ error:'Not found' });
  Object.assign(msg, req.body, { updated_at:new Date().toISOString() });
  save();
  res.json(msg);
});

// ─── PLAYBOOK ────────────────────────────────────────────────
app.get('/playbook', auth, (req,res) => res.json(db.playbook));
app.post('/playbook', auth, (req,res) => {
  const id=crypto.randomUUID(), now=new Date().toISOString();
  db.playbook.push({ id, title:req.body.title, content:req.body.content||'', category:req.body.category||'general', created_at:now });
  save(); res.json({ id, success:true });
});
app.patch('/playbook/:id', auth, (req,res) => {
  const idx=db.playbook.findIndex(p=>p.id===req.params.id);
  if(idx===-1)return res.status(404).json({error:'Not found'});
  db.playbook[idx]={...db.playbook[idx],...req.body,updated_at:new Date().toISOString()};
  save(); res.json(db.playbook[idx]);
});
app.delete('/playbook/:id', auth, (req,res)=>{ db.playbook=db.playbook.filter(p=>p.id!==req.params.id); save(); res.json({success:true}); });

// ─── STATS ───────────────────────────────────────────────────
app.get('/stats', auth, (req,res) => {
  const byStatus={}, byPlatform={}, byType={};
  db.prospects.forEach(p => {
    byStatus[p.status]=(byStatus[p.status]||0)+1;
    byPlatform[p.platform||'Unknown']=(byPlatform[p.platform||'Unknown']||0)+1;
    byType[p.type||'affiliate']=(byType[p.type||'affiliate']||0)+1;
  });
  res.json({
    total:db.prospects.length,
    byStatus:Object.entries(byStatus).map(([status,c])=>({status,c})),
    byPlatform:Object.entries(byPlatform).map(([platform,c])=>({platform,c})),
    byType:Object.entries(byType).map(([type,c])=>({type,c})),
    outreachSent:db.prospects.filter(p=>['outreach_sent','lead','qualified','call_booked','follow_up','closed_won'].includes(p.status)).length,
    responded:db.prospects.filter(p=>['lead','qualified','call_booked','follow_up','closed_won'].includes(p.status)).length,
    qualified:db.prospects.filter(p=>['qualified','call_booked','follow_up','closed_won'].includes(p.status)).length,
    callBooked:db.prospects.filter(p=>['call_booked','closed_won'].includes(p.status)).length,
    wonDeals:db.prospects.filter(p=>p.status==='closed_won').length,
    deals:db.deals.length,
    totalDealValue:db.deals.reduce((s,d)=>s+(d.value||0),0),
    totalCommission:db.deals.reduce((s,d)=>s+(d.commission_value||0),0),
    wonDealCount:db.deals.filter(d=>d.stage==='closed_won').length,
  });
});

// ─── STATIC / HEALTH ─────────────────────────────────────────
app.get('/health', (req,res) => res.json({ ok:true, prospects:db.prospects.length, deals:db.deals.length, ts:new Date().toISOString() }));

const publicDir = path.join(__dirname,'../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req,res) => { if(!req.path.startsWith('/api')) res.sendFile(path.join(publicDir,'index.html')); });
}

app.listen(PORT, () => console.log(`Apex CRM on :${PORT} | DB: ${DB_PATH}.json`));
