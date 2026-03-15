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
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';

let db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], settings:{}, nextId:1 };
let googleTokens = null; // { access_token, refresh_token, expiry_date }

function loadData() {
  try {
    if (fs.existsSync(DB_PATH + '.json')) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH + '.json', 'utf8'));
      db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], settings:{}, nextId:1, ...raw };
      if (!db.settings) db.settings = {};
      // Restore Google tokens from persistent storage
      if (db.settings.google_tokens) {
        googleTokens = db.settings.google_tokens;
        console.log('Restored Google tokens from storage');
      }
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

// ─── PROSPECTS ────────────────────────────────────────────────────────────────
app.get('/prospects', auth, (req,res) => {
  res.json([...db.prospects].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)));
});

app.post('/prospects', auth, (req,res) => {
  const { name, email, phone, platform, profile_url, handle, audience_size, iap_score, fit_score, outreach_type, source, notes, status, content_focus, priority, type, deal_value, commission_pct, lead_type } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const p = { id, name, email:email||'', phone:phone||'', platform:platform||'', handle:handle||'', profile_url:profile_url||'', audience_size:parseInt(audience_size)||0, total_score:parseInt(iap_score||fit_score)||0, outreach_type:outreach_type||'cold', source:source||'', notes:notes||'', status:status||'prospect', content_focus:content_focus||'', priority:parseInt(priority)||3, type:type||'affiliate', deal_value:parseFloat(deal_value)||0, commission_pct:parseFloat(commission_pct)||10, lead_type:lead_type||'Potential Affiliate Partner', outreach_sent_date:'', response_date:'', created_at:now, updated_at:now };
  db.prospects.push(p);
  logActivity(id, 'created', `Added ${name}`);
  save();
  res.json({ id, success:true });
});

app.patch('/prospects/:id', auth, (req,res) => {
  const idx = db.prospects.findIndex(p => p.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  const allowed = ['status','notes','outreach_type','platform','profile_url','handle','audience_size','source','name','email','phone','content_focus','priority','type','deal_value','commission_pct','lead_type'];
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
    db.prospects.push({ id, name:r.name||r.handle||'', email:r.email||'', phone:r.phone||'', platform:r.platform||'', handle:r.handle||'', profile_url:r.profile_url||'', audience_size:parseInt(r.audience_size||r.followers)||0, total_score:parseInt(r.fit_score||r.iap_score||r.score)||0, outreach_type:'cold', source:r.source||'csv-import', notes:r.notes||'', status:r.status||'prospect', content_focus:r.content_focus||r.niche||'', priority:parseInt(r.priority)||3, type:r.type||'affiliate', deal_value:parseFloat(r.deal_value)||0, commission_pct:parseFloat(r.commission_pct)||10, lead_type:r.lead_type||'Potential Affiliate Partner', outreach_sent_date:'', response_date:'', created_at:now, updated_at:now });
    added++;
  });
  save();
  res.json({ added, total:db.prospects.length });
});

// ─── DEALS ───────────────────────────────────────────────────────────────────
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

// ─── INBOX ───────────────────────────────────────────────────────────────────
app.get('/inbox/emails', auth, (req,res) => res.json([...db.inboxEmails].sort((a,b) => new Date(b.date||b.created_at)-new Date(a.date||a.created_at)).slice(0,200)));

app.post('/inbox/emails', auth, (req,res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error:'emails array required' });
  const newEmails = emails.filter(e => !db.inboxEmails.find(ex => ex.id===e.id));
  db.inboxEmails = [...newEmails, ...db.inboxEmails].slice(0, 500);
  save();
  res.json({ added:newEmails.length, total:db.inboxEmails.length });
});

// ─── AI ANALYZE ──────────────────────────────────────────────────────────────
app.post('/analyze', auth, async (req,res) => {
  const { prompt, context } = req.body;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Anthropic API key not configured on server.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system: context || 'You are Reid Foster, affiliate manager at apex.host. Be direct, lowercase, no corporate fluff.',
        messages: [{ role: 'user', content: prompt || 'Hello' }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const analysis = data.content?.[0]?.text || 'No response';
    res.json({ analysis });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REID ────────────────────────────────────────────────────────────────────
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

// ─── PLAYBOOK ────────────────────────────────────────────────────────────────
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

// ─── STATS ───────────────────────────────────────────────────────────────────
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
    activeAffiliates:db.prospects.filter(p=>p.lead_type==='Active Affiliate Partner').length,
    totalDealValue:db.prospects.reduce((s,p)=>s+(p.deal_value||0),0),
    totalCommission:db.prospects.reduce((s,p)=>s+(p.deal_value||0)*(p.commission_pct||10)/100,0),
    deals:db.deals.length,
    wonDealCount:db.deals.filter(d=>d.stage==='closed_won').length,
  });
});

// ─── AUDIENCE FETCH ──────────────────────────────────────────────────────────
app.post('/audience-fetch', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ audience_size: null, error: 'No URL' });
  try {
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    const data = await new Promise((resolve, reject) => {
      const r = client.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        timeout: 8000
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(body));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    });
    let audience_size = null;
    const tikMatch = data.match(/"followerCount":(\d+)/);
    if (tikMatch) audience_size = parseInt(tikMatch[1]);
    const igMatch = data.match(/"edge_followed_by":\{"count":(\d+)\}/) || data.match(/"followers":(\d+)/);
    if (igMatch && !audience_size) audience_size = parseInt(igMatch[1]);
    const ytMatch = data.match(/([\d.]+[KMB]?)\s+subscribers/i);
    if (ytMatch && !audience_size) {
      const raw = ytMatch[1];
      if (raw.includes('M')) audience_size = Math.round(parseFloat(raw)*1e6);
      else if (raw.includes('K')) audience_size = Math.round(parseFloat(raw)*1e3);
      else if (raw.includes('B')) audience_size = Math.round(parseFloat(raw)*1e9);
      else audience_size = parseInt(raw);
    }
    const genMatch = data.match(/([\d,]+)\s+(?:followers|Followers)/);
    if (genMatch && !audience_size) audience_size = parseInt(genMatch[1].replace(/,/g,''));
    res.json({ audience_size, fetched: !!audience_size });
  } catch(e) {
    res.json({ audience_size: null, error: e.message, fetched: false });
  }
});

// ─── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar email openid',
    access_type: 'offline',
    prompt: 'consent',
    state: 'apex-crm-auth'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<html><body style="font-family:sans-serif;background:#14161f;color:#e2e4ed;padding:40px"><h2>❌ Auth failed: ${error || 'no code'}</h2><p><a href="/" style="color:#4f7ef8">← Back to CRM</a></p></body></html>`);
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);
    googleTokens = { ...tokens, expiry_date: Date.now() + (tokens.expires_in * 1000) };
    db.settings.google_tokens = googleTokens;
    save();
    res.send(`<html><body style="font-family:sans-serif;background:#14161f;color:#e2e4ed;padding:40px;text-align:center"><h2>✅ Google Connected!</h2><p style="color:#22c88a">Gmail & Calendar authorized successfully.</p><p><a href="/" style="color:#4f7ef8;text-decoration:none;background:#1e2230;padding:10px 20px;border-radius:8px;display:inline-block;margin-top:16px">← Back to CRM</a></p><script>setTimeout(()=>window.location='/',2000)</script></body></html>`);
  } catch(e) {
    res.send(`<html><body style="font-family:sans-serif;background:#14161f;color:#e2e4ed;padding:40px"><h2>❌ Token exchange failed</h2><pre style="color:#f0545c">${e.message}</pre><p><a href="/" style="color:#4f7ef8">← Back to CRM</a></p></body></html>`);
  }
});

app.get('/auth/google/status', auth, (req, res) => {
  if (!googleTokens && db.settings.google_tokens) googleTokens = db.settings.google_tokens;
  res.json({ connected: !!googleTokens, expired: googleTokens ? Date.now() > googleTokens.expiry_date : false });
});

app.get('/auth/google/disconnect', auth, (req, res) => {
  googleTokens = null;
  delete db.settings.google_tokens;
  save();
  res.json({ ok: true });
});

app.post('/inbox/sync', auth, async (req, res) => {
  if (!googleTokens && db.settings.google_tokens) googleTokens = db.settings.google_tokens;
  if (!googleTokens) return res.status(401).json({ error: 'Google not connected. Connect in Admin.' });

  // Refresh token if expired
  if (Date.now() > googleTokens.expiry_date && googleTokens.refresh_token) {
    try {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: googleTokens.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const refreshed = await refreshRes.json();
      if (!refreshed.error) {
        googleTokens = { ...googleTokens, ...refreshed, expiry_date: Date.now() + (refreshed.expires_in * 1000) };
        db.settings.google_tokens = googleTokens;
        save();
      }
    } catch(e) { console.error('Token refresh failed:', e.message); }
  }

  try {
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&labelIds=INBOX', {
      headers: { Authorization: `Bearer ${googleTokens.access_token}` }
    });
    const listData = await listRes.json();
    if (listData.error) return res.status(400).json({ error: listData.error.message });

    const messages = listData.messages || [];
    const emails = [];

    for (const msg of messages.slice(0, 10)) {
      try {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
          headers: { Authorization: `Bearer ${googleTokens.access_token}` }
        });
        const msgData = await msgRes.json();
        const headers = msgData.payload?.headers || [];
        const get = (name) => headers.find(h => h.name === name)?.value || '';
        const fromRaw = get('From');
        const fromMatch = fromRaw.match(/^(.*?)\s*<(.+)>$/) || [null, fromRaw, fromRaw];
        emails.push({
          id: msg.id,
          from_name: (fromMatch[1] || '').trim().replace(/"/g, ''),
          from: fromMatch[2] || fromRaw,
          subject: get('Subject') || '(no subject)',
          snippet: msgData.snippet || '',
          date: get('Date'),
          unread: (msgData.labelIds || []).includes('UNREAD'),
          created_at: new Date().toISOString()
        });
      } catch(e) { /* skip */ }
    }

    // Upsert into in-memory store
    const byId = {};
    db.inboxEmails.forEach(e => { byId[e.id] = e; });
    emails.forEach(e => { byId[e.id] = { ...e, from_email: e.from, body: '' }; });
    db.inboxEmails = Object.values(byId)
      .sort((a, b) => new Date(b.date || b.created_at) - new Date(a.date || a.created_at))
      .slice(0, 500);
    save();

    res.json({ ok: true, synced: emails.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STATIC / HEALTH ─────────────────────────────────────────────────────────
app.get('/health', (req,res) => res.json({ ok:true, prospects:db.prospects.length, deals:db.deals.length, ts:new Date().toISOString() }));

const publicDir = path.join(__dirname,'../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req,res) => { if(!req.path.startsWith('/api')) res.sendFile(path.join(publicDir,'index.html')); });
}

app.listen(PORT, () => console.log(`Apex CRM on :${PORT} | DB: ${DB_PATH}.json`));
