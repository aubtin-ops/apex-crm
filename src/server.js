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

let db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], emailDrafts:[], settings:{}, nextId:1 };
let googleTokens = null; // { access_token, refresh_token, expiry_date }

function loadData() {
  try {
    if (fs.existsSync(DB_PATH + '.json')) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH + '.json', 'utf8'));
      db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], emailDrafts:[], settings:{}, nextId:1, ...raw };
      if (!db.emailDrafts) db.emailDrafts = [];
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
app.get('/inbox/emails', auth, (req,res) => {
  const emails = [...db.inboxEmails]
    .sort((a,b) => new Date(b.date||b.created_at)-new Date(a.date||a.created_at))
    .slice(0,200)
    .map(e => ({ ...e, tags: Array.isArray(e.tags) ? e.tags : [] }));
  res.json(emails);
});

app.post('/inbox/emails', auth, (req,res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error:'emails array required' });
  const newEmails = emails.filter(e => !db.inboxEmails.find(ex => ex.id===e.id)).map(e => ({ ...e, tags: e.tags || [] }));
  db.inboxEmails = [...newEmails, ...db.inboxEmails].slice(0, 500);
  save();
  res.json({ added:newEmails.length, total:db.inboxEmails.length });
});

app.patch('/inbox/emails/:id/tags', auth, (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be array' });
  const email = db.inboxEmails.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  email.tags = tags;
  save();
  res.json({ ok: true, tags });
});

// ─── AI ANALYZE ──────────────────────────────────────────────────────────────
const REID_SYSTEM_PROMPT = `You are Reid Foster, affiliate manager at apex.host.

Your job: manage Aubtin's inbox and draft email responses for his review. You don't send — you draft. Aubtin reviews and approves before anything goes out.

VOICE & STYLE — Dan Martell style:
- Short sentences. High energy. Direct.
- Genuinely curious, never salesy.
- Compliment something specific (their content, their expertise, their audience).
- Never pitch. Always ask for advice or perspective.
- End every outreach with one clear CTA: book a call.
- Sign off as: Reid | apex.host

THE ANGLE for outreach:
"I've seen your work in [space]. Love what you're doing. We're launching Apex — it's going to compete directly with OpenClaw but we're building it differently. Would love 20 minutes to get your take on the market."

This is an advice ask, not a pitch. Pure curiosity. Get them on a call.

INBOX RESPONSE RULES:
1. When drafting a reply, always start with something specific about what they said.
2. Keep it under 5 sentences unless the email is complex.
3. Always include a next step (book a call, reply with X, send me Y).
4. No corporate language. No "I hope this email finds you well." No fluff.
5. If it's a warm lead or someone interested — move fast to a call.
6. If it's cold/unresponsive — short follow-up, keep it light.

DEAL CRITERIA:
- No deal-breakers right now. Talk to everybody.
- Priority: creators, operators, founders in the AI/automation space.
- Always capture: audience size, platform, what they're building.

When asked to draft an email, format it clearly:
---
DRAFT EMAIL
Subject: [subject line]
---
[email body]
---

When analyzing the inbox, flag: urgent replies needed, warm leads, anyone who asked a question.

CREATING CONTACTS:
When the user asks you to add someone to the CRM, or when you have enough info to create a contact, include an action block in your response (invisible to the user, handled by the system):

<<ACTION:create_contact>>
{
  "name": "Full Name or Brand",
  "email": "email if known",
  "phone": "phone if known",
  "platform": "Instagram|TikTok|YouTube|LinkedIn|Twitter|Podcast|Newsletter|Other",
  "lead_type": "Potential Affiliate Partner|Active Affiliate Partner|Deal/Close",
  "profile_url": "url if known",
  "audience_size": 0,
  "deal_value": 0,
  "status": "prospect",
  "priority": 3,
  "notes": "any relevant context"
}
<<END_ACTION>>

Only include fields you actually know. Always include name. After the action block, confirm naturally: "added [name] to the pipeline as a prospect."

You can also UPDATE a contact's stage if the user says something like "move X to qualified" — use:
<<ACTION:update_contact>>
{"name": "Name", "status": "qualified"}
<<END_ACTION>>`;

app.post('/analyze', auth, async (req, res) => {
  const { prompt, context } = req.body;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Anthropic API key not configured.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: context || REID_SYSTEM_PROMPT,
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
  // Channel breakdown with stage distribution
  const channelMap = {};
  db.prospects.forEach(p => {
    if (!p.platform || p.platform === '') return;
    if (!channelMap[p.platform]) channelMap[p.platform] = { platform: p.platform, total: 0, stages: {}, dealValue: 0 };
    channelMap[p.platform].total += 1;
    channelMap[p.platform].stages[p.status] = (channelMap[p.platform].stages[p.status] || 0) + 1;
    channelMap[p.platform].dealValue += (p.deal_value || 0);
  });
  const byChannel = Object.values(channelMap).sort((a,b) => b.total - a.total);
  res.json({
    total:db.prospects.length,
    byStatus:Object.entries(byStatus).map(([status,c])=>({status,c})),
    byPlatform:Object.entries(byPlatform).map(([platform,c])=>({platform,c})),
    byType:Object.entries(byType).map(([type,c])=>({type,c})),
    byChannel,
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
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar email openid',
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
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&labelIds=INBOX', {
      headers: { Authorization: `Bearer ${googleTokens.access_token}` }
    });
    const listData = await listRes.json();
    if (listData.error) return res.status(400).json({ error: listData.error.message });

    const messages = listData.messages || [];
    const emails = [];

    for (const msg of messages.slice(0, 30)) {
      try {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
          headers: { Authorization: `Bearer ${googleTokens.access_token}` }
        });
        const msgData = await msgRes.json();
        const headers = msgData.payload?.headers || [];
        const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        const fromRaw = get('From');
        const fromMatch = fromRaw.match(/^(.*?)\s*<(.+)>$/) || [null, fromRaw, fromRaw];
        // Extract body from payload
        let body = '';
        function extractBody(part) {
          if (part.body?.data) {
            const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
            if (part.mimeType === 'text/plain') body = decoded;
            else if (!body && part.mimeType === 'text/html') body = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
          if (part.parts) part.parts.forEach(extractBody);
        }
        extractBody(msgData.payload || {});
        emails.push({
          id: msg.id,
          thread_id: msgData.threadId || '',
          from_name: (fromMatch[1] || '').trim().replace(/"/g, ''),
          from: fromMatch[2] || fromRaw,
          to: get('To'),
          subject: get('Subject') || '(no subject)',
          snippet: msgData.snippet || '',
          body: body || msgData.snippet || '',
          date: get('Date'),
          unread: (msgData.labelIds || []).includes('UNREAD'),
          labels: msgData.labelIds || [],
          created_at: new Date().toISOString()
        });
      } catch(e) { /* skip */ }
    }

    // Upsert into in-memory store — preserve existing tags and reid_processed flag
    const byId = {};
    db.inboxEmails.forEach(e => { byId[e.id] = e; });
    emails.forEach(e => {
      const existing = byId[e.id] || {};
      byId[e.id] = { ...e, from_email: e.from, tags: existing.tags || [], reid_processed: existing.reid_processed || false, reid_draft_id: existing.reid_draft_id || null };
    });
    db.inboxEmails = Object.values(byId)
      .sort((a, b) => new Date(b.date || b.created_at) - new Date(a.date || a.created_at))
      .slice(0, 500);
    save();

    res.json({ ok: true, synced: emails.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REID AUTO-PROCESS INBOX ─────────────────────────────────────────────────
app.post('/inbox/auto-process', auth, async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Anthropic API key not configured.' });

  // Find unprocessed emails
  const unprocessed = db.inboxEmails.filter(e => !e.reid_processed);
  if (!unprocessed.length) return res.json({ processed: 0, message: 'All emails already processed' });

  const prospectList = db.prospects.map(p => `${p.name} <${p.email}> — ${p.status} — ${p.platform}`).join('\n');
  let processed = 0;

  for (const email of unprocessed.slice(0, 15)) {
    try {
      const prompt = `Process this email from the inbox. Do THREE things:

1. TAG IT: Pick the best CRM tag from: Lead, Qualified, Call Booked, Follow Up, Closed Won, Closed Lost, Ignore. "Ignore" means spam/newsletter/automated.
2. FOLLOW-UP CHECK: Determine if this email needs a follow-up. Set "needs_follow_up" to true if:
   - They asked a question we haven't answered
   - They showed interest but no next step is scheduled
   - They went quiet after a previous conversation (stale thread)
   - They said "let me think about it" or similar soft stalls
   - A previous outreach got no reply and it's been 3+ days
   Set "follow_up_reason" to a short explanation (e.g. "Asked about pricing, no reply yet", "Showed interest 5 days ago, went quiet").
   Set "follow_up_date" to when the follow-up should happen: "today", "tomorrow", "3_days", "1_week".
3. DRAFT A REPLY: Write a reply in Aubtin's voice (short, direct, Dan Martell style). If it's spam/newsletter, set draft to "SKIP".

EMAIL:
From: ${email.from_name} <${email.from}>
Subject: ${email.subject}
Date: ${email.date}
Body: ${(email.body || email.snippet || '').slice(0, 1500)}

KNOWN CRM CONTACTS:
${prospectList || '(none yet)'}

Respond ONLY in this exact JSON format, nothing else:
{"tag":"Lead","draft_subject":"Re: ${email.subject}","draft_body":"the reply text","priority":"high","summary":"one line summary of what this email is about","should_reply":true,"needs_follow_up":false,"follow_up_reason":"","follow_up_date":""}

If should_reply is false (spam, newsletter, no-reply), set draft_body to "" and tag to "Ignore".
Priority: "high" = needs response today, "medium" = within 2 days, "low" = whenever.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1024, system: REID_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await response.json();
      const text = data.content?.[0]?.text || '';

      // Parse JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { email.reid_processed = true; continue; }

      const result = JSON.parse(jsonMatch[0]);

      // Auto-tag the email
      if (result.tag && result.tag !== 'Ignore') {
        email.tags = [...new Set([...(email.tags || []), result.tag])];
      }
      email.reid_processed = true;
      email.reid_priority = result.priority || 'medium';
      email.reid_summary = result.summary || '';
      email.needs_follow_up = result.needs_follow_up || false;
      email.follow_up_reason = result.follow_up_reason || '';
      email.follow_up_date = result.follow_up_date || '';
      email.follow_up_done = email.follow_up_done || false;

      // Create draft if should_reply
      if (result.should_reply && result.draft_body) {
        const draftId = crypto.randomUUID();
        db.emailDrafts.push({
          id: draftId,
          email_id: email.id,
          thread_id: email.thread_id || '',
          to: email.from,
          to_name: email.from_name || '',
          subject: result.draft_subject || `Re: ${email.subject}`,
          body: result.draft_body,
          status: 'draft', // draft | approved | sent
          priority: result.priority || 'medium',
          created_at: new Date().toISOString()
        });
        email.reid_draft_id = draftId;
      }

      // Auto-link to CRM prospect if email matches
      const matchingProspect = db.prospects.find(p =>
        p.email && email.from && p.email.toLowerCase() === email.from.toLowerCase()
      );
      if (matchingProspect) {
        email.prospect_id = matchingProspect.id;
        email.prospect_name = matchingProspect.name;
      }

      processed++;
    } catch(e) {
      console.error('Auto-process error:', e.message);
      email.reid_processed = true;
    }
  }

  save();
  res.json({ processed, total_unprocessed: db.inboxEmails.filter(e => !e.reid_processed).length });
});

// ─── FOLLOW-UPS ─────────────────────────────────────────────────────────────
app.get('/inbox/follow-ups', auth, (req, res) => {
  const followUps = db.inboxEmails
    .filter(e => e.needs_follow_up && !e.follow_up_done)
    .sort((a, b) => {
      const order = { today: 0, tomorrow: 1, '3_days': 2, '1_week': 3 };
      return (order[a.follow_up_date] ?? 4) - (order[b.follow_up_date] ?? 4);
    });
  res.json(followUps);
});

app.patch('/inbox/emails/:id/follow-up', auth, (req, res) => {
  const email = db.inboxEmails.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  if (req.body.follow_up_done !== undefined) email.follow_up_done = req.body.follow_up_done;
  if (req.body.needs_follow_up !== undefined) email.needs_follow_up = req.body.needs_follow_up;
  if (req.body.follow_up_reason !== undefined) email.follow_up_reason = req.body.follow_up_reason;
  if (req.body.follow_up_date !== undefined) email.follow_up_date = req.body.follow_up_date;
  save();
  res.json({ ok: true });
});

// ─── DRAFTS ─────────────────────────────────────────────────────────────────
app.get('/inbox/drafts', auth, (req, res) => {
  res.json([...db.emailDrafts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.patch('/inbox/drafts/:id', auth, (req, res) => {
  const draft = db.emailDrafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  const { body, subject, status } = req.body;
  if (body !== undefined) draft.body = body;
  if (subject !== undefined) draft.subject = subject;
  if (status !== undefined) draft.status = status;
  draft.updated_at = new Date().toISOString();
  save();
  res.json(draft);
});

app.delete('/inbox/drafts/:id', auth, (req, res) => {
  const draft = db.emailDrafts.find(d => d.id === req.params.id);
  if (draft) {
    const email = db.inboxEmails.find(e => e.reid_draft_id === draft.id);
    if (email) email.reid_draft_id = null;
  }
  db.emailDrafts = db.emailDrafts.filter(d => d.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ─── SEND EMAIL VIA GMAIL ───────────────────────────────────────────────────
async function refreshGoogleToken() {
  if (!googleTokens) return false;
  if (Date.now() < googleTokens.expiry_date) return true;
  if (!googleTokens.refresh_token) return false;
  try {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: googleTokens.refresh_token, grant_type: 'refresh_token'
      })
    });
    const refreshed = await refreshRes.json();
    if (refreshed.error) return false;
    googleTokens = { ...googleTokens, ...refreshed, expiry_date: Date.now() + (refreshed.expires_in * 1000) };
    db.settings.google_tokens = googleTokens;
    save();
    return true;
  } catch(e) { return false; }
}

app.post('/inbox/send/:draftId', auth, async (req, res) => {
  if (!googleTokens && db.settings.google_tokens) googleTokens = db.settings.google_tokens;
  if (!googleTokens) return res.status(401).json({ error: 'Google not connected' });

  const draft = db.emailDrafts.find(d => d.id === req.params.draftId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const tokenOk = await refreshGoogleToken();
  if (!tokenOk) return res.status(401).json({ error: 'Google token refresh failed — reconnect in Admin' });

  // Build raw email
  const rawEmail = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    draft.body
  ].join('\r\n');

  const encodedEmail = Buffer.from(rawEmail).toString('base64url');

  try {
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${googleTokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodedEmail, threadId: draft.thread_id || undefined })
    });
    const sendData = await sendRes.json();
    if (sendData.error) throw new Error(sendData.error.message);

    draft.status = 'sent';
    draft.sent_at = new Date().toISOString();
    draft.gmail_message_id = sendData.id;

    // Log activity if linked to prospect
    const email = db.inboxEmails.find(e => e.reid_draft_id === draft.id);
    if (email?.prospect_id) {
      logActivity(email.prospect_id, 'email_sent', `Reid sent reply to ${draft.to}: "${draft.subject}"`);
    }

    save();
    res.json({ ok: true, message_id: sendData.id });
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
