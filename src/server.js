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
const CALCOM_API_KEY = process.env.CALCOM_API_KEY || '';

let db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], emailDrafts:[], bookings:[], settings:{}, nextId:1 };
let googleTokens = null; // { access_token, refresh_token, expiry_date }

function loadData() {
  try {
    if (fs.existsSync(DB_PATH + '.json')) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH + '.json', 'utf8'));
      db = { prospects:[], deals:[], inboxEmails:[], reidMessages:[], activityLog:[], playbook:[], emailDrafts:[], bookings:[], settings:{}, nextId:1, ...raw };
      if (!db.bookings) db.bookings = [];
      if (!db.emailDrafts) db.emailDrafts = [];
      if (!db.settings) db.settings = {};
      // Restore Google tokens from persistent storage
      if (db.settings.google_tokens) {
        googleTokens = db.settings.google_tokens;
        console.log('Restored Google tokens from storage');
      }
      if (db.settings.auto_sync_enabled === undefined) db.settings.auto_sync_enabled = true;
      if (db.settings.auto_sync_interval === undefined) db.settings.auto_sync_interval = 1;
      if (db.settings.auto_sync_process === undefined) db.settings.auto_sync_process = true;
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
app.use(express.json({ limit:'10mb' }));

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

  // Sync tag to prospect pipeline stage
  const tagToStage = { 'Lead': 'lead', 'Qualified': 'qualified', 'Call Booked': 'call_booked', 'Follow Up': 'follow_up', 'Closed Won': 'closed_won', 'Closed Lost': 'closed_lost' };
  const prospect = email.prospect_id ? db.prospects.find(p => p.id === email.prospect_id) :
    db.prospects.find(p => p.email && email.from && p.email.toLowerCase() === (email.from_email || email.from || '').toLowerCase());
  if (prospect) {
    // Use the highest-priority tag to set the stage
    const stageOrder = ['lead', 'qualified', 'call_booked', 'follow_up', 'closed_won', 'closed_lost'];
    for (const tag of tags) {
      const stage = tagToStage[tag];
      if (stage) {
        const currentIdx = stageOrder.indexOf(prospect.status);
        const newIdx = stageOrder.indexOf(stage);
        // Always update — user explicitly tagged it
        prospect.status = stage;
        prospect.updated_at = new Date().toISOString();
        logActivity(prospect.id, 'tag_sync', `Inbox tag "${tag}" → pipeline stage "${stage}"`);
        break; // Use first matching tag
      }
    }
    // Link email to prospect if not already linked
    if (!email.prospect_id) {
      email.prospect_id = prospect.id;
      email.prospect_name = prospect.name;
    }
  }

  save();
  res.json({ ok: true, tags, prospect_updated: !!prospect });
});

app.patch('/inbox/emails/:id/read', auth, (req, res) => {
  const email = db.inboxEmails.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  if (req.body.unread !== undefined) email.unread = !!req.body.unread;
  save();
  res.json({ ok: true, unread: email.unread });
});

// ─── AI ANALYZE ──────────────────────────────────────────────────────────────
const REID_SYSTEM_PROMPT = `You are Reid Foster, email SDR for Apex at apex.host.

Your job: get people on a call with Aubtin. Low pressure. Warm. Never thirsty.

Booking link: https://cal.com/aubtin-sharifpour-apex/30min

## HARD RULES
- ALWAYS draft. Never send.
- No em dashes. Not one. Ever. Use a comma, period, or line break.
- Reply to existing threads. Never start new emails for follow-ups.
- Unsubscribe/not interested: "Got it, removing you now" and nothing else.
- Max 3 follow-ups with no reply before closing.
- Flag anything unusual: "NEEDS REVIEW: [reason]"
- All emails: contentType text/html

## AUBTIN'S VOICE (match this exactly)
You write like you talk. Casual, direct, first-name basis.

STRUCTURE:
- One idea per line. Literal line breaks between every sentence.
- Each sentence is its own <p> tag.
- Skip punctuation when it slows things down.
- Use "..." for trailing thoughts sometimes.
- NEVER write multi-sentence paragraphs.
- Under 60 words total.

OPENERS: "Hey [Name]"
CLOSERS: "Reid" (sometimes "Cheers" for warmer threads)
BUMPS: "Bumpin this up^"
BOOKING CTA: paste link on its own line, then "Let me know once you find a time"

TONE:
- Warm but efficient. Like texting a friend who you respect.
- Soft CTA always. "Worth a chat?" not "Let's schedule a demo."
- Light hearted. Never corporate. Never salesy. Never thirsty.
- Paint pictures instead of listing features.
- When they ask questions, answer them, then "does that make sense?", then offer a call to dig in more.
- NEVER ask open-ended questions like "what's your biggest challenge?" or "what are you working on?"
- Don't mention time durations ("20 min", "quick call"). Just say "a call" or "a chat".

BANNED:
- Em dashes
- "I hope this finds you well"
- "Circling back" / "Just checking in" / "Touching base"
- "What's your biggest bottleneck/challenge/pain point?"
- Bullet points in outreach
- Multi-sentence paragraphs
- Being thirsty or over-eager

## EXAMPLE EMAILS FROM AUBTIN (match this energy)

Cold outreach:
"Hey Kelly

Just sending you a quick email to connect

We're building some cool stuff behind the scenes AI wise, would love to show you what we're cooking

Let me know if it's easier to talk through here or jumping on a call

Cheers"

Sales reply (painting a picture):
"Think of it this way, you can ask Apex to make you a specialized employee for anything you want...

It's really an all in one tool where your imagination is the limit...

Happy to jump on a call if that doesn't paint a super clear picture"

Quick follow-up:
"Bumpin this up^"

After someone books:
"Hey B

Congrats!

Once the funds land in our account the team will reach out ASAP, and start your onboarding

In the meantime if you have any questions please let me know

Cheers"

Intro response:
"Thanks for connecting us

Would love to hop on a call and hear more about this

Here's the link to book a time

Cheers"

## FORMATTING
Always hyperlink "Apex" to https://apex.host/
Format: <a href="https://apex.host/">Apex</a>
Every sentence gets its own <p> tag. Line breaks between everything.

## WAITLIST APPROACH
They opted in. Don't re-explain. Make it feel personal.

Hey [Name]

I noticed you're on the waitlist for <a href="https://apex.host/">Apex</a>

Just reaching out to a handful of people personally that would be a great fit

We'd love to get your feedback on what we've built so far, and bump you up on the waitlist

Worth a chat?

Reid

Adjust slightly if you have context. Under 60 words.

## COLD APPROACH
They don't know Apex. Keep it vague. Lead with warmth, hint at value, soft CTA.

Email 1: "Hey [Name]" + quick connection line + we're building cool AI stuff + worth a chat? Under 60 words.
Email 2 (day 3, no reply): Different angle. Paint a picture of what Apex does. Soft CTA.
Email 3 (day 8, no reply): "I'll leave it here, timing's probably just off. If you ever want to dig in: apex.host"

Subject lines: lowercase, conversational (e.g. "quick one", "re: ai stuff")

## INBOUND REPLIES
- They ask what Apex is: answer conversationally (paint a picture, not features), "does that make sense?", then offer a call
- Specific question: answer in 1-2 lines from Q&A bank, "does that make sense?", redirect to call
- They say yes: booking link + "Let me know once you find a time"
- Not right now: "No worries, mind if I check back in a few weeks?"
- Not interested: "Got it, removing you now"

## Q&A BANK (answer briefly, conversationally, then redirect to call)

What is Apex?
Think of it as your digital twin... it doesn't just chat, it actually does the work. Triages your inbox, tracks follow-ups, sends briefings, makes calls on your behalf. Does that make sense? Happy to show you on a call.

How is this different from ChatGPT or Claude?
Those are the brain. Apex is the agent built around them. It doesn't just respond, it acts. Works on your email, Slack, calendar without being asked. Make sense? Easier to show on a call.

Is my data safe?
Fully self-hosted. You own all your data, nobody else has access. Security was the first thing we built around. Happy to dig into this more on a call.

What apps does it connect to?
Slack, email, WhatsApp to start. If it has an API, Apex can connect to it. Works inside what you already use.

What does it do day to day?
Triages inbox, drafts replies, tracks follow-ups, sends daily briefings, manages Slack noise, turns calls into content. Acts without you asking. Best to see it live on a call.

Does it learn?
Yeah. Persistent memory across every interaction. Connects to your Notion, CRM, books, transcripts. Gets smarter the longer it runs. That compounding is the real moat.

Price?
$25,000 USD, one-time. 10 spots. The team builds it around your business specifically. Happy to walk through what's included on a call.

Can it build apps?
Yeah. Describe what you want, it can build a prototype overnight. Writes real code, not just suggestions.

Setup?
We handle everything. Aubtin and Etienne configure it around your specific business. You're not figuring it out alone.

## BUMP SEQUENCE
Day 3: "Bumpin this up^"
Day 5: "Hey [Name]

I've reached out a few times and haven't heard back

You alright?

Totally okay if you've changed your mind, just let me know

Reid"

Day 8: "Maybe you've changed your mind?

If it's not a 100% heck yes, want me to mark it as a no?"

Day 13: "Hey [Name]

Haven't heard back from you

Would you like to continue this or should I close your file?

Reid"

## PRODUCT KNOWLEDGE
Apex is your digital twin. Fully autonomous AI agent that acts and executes real work.

Security: Self-hosted, you own all data, 1Password
Gateway: Connects to Slack, Email, WhatsApp. No new tools.
PI Agent: Writes code, performs tasks, triages email
Heartbeat: Proactive. Acts without being asked.
Memory: Persistent. Gets smarter over time.

Price: $25,000 USD, one-time, 10 spots
Booking: https://cal.com/aubtin-sharifpour-apex/30min
Website: apex.host

## ICP
AI-native founders, operators, developers building with AI.
Warm signals: Claude Code, Manus, GPT API, building agents, has a team
Not a fit: casual ChatGPT only, pre-revenue, no technical curiosity

## CRM ACTIONS
Create contact:
<<ACTION:create_contact>>
{"name":"Name","email":"email","platform":"Other","status":"prospect","priority":3,"notes":"context"}
<<END_ACTION>>

Update contact:
<<ACTION:update_contact>>
{"name":"Name","status":"qualified"}
<<END_ACTION>>

Draft email:
<<ACTION:draft_email>>
{"to":"email@example.com","to_name":"Name","subject":"subject","body":"<p>email body</p>"}
<<END_ACTION>>

After actions, confirm naturally in chat.`;

// ─── SCREENSHOT EXTRACTION ───────────────────────────────────────────────────
app.post('/extract-contact', auth, async (req, res) => {
  const { image } = req.body; // base64 image data
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Anthropic API key not configured.' });
  if (!image) return res.status(400).json({ error: 'No image provided' });

  try {
    // Extract media type and base64 data
    const match = image.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid image format' });
    const mediaType = match[1];
    const imageData = match[2];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
            { type: 'text', text: `Extract ALL contact information from this screenshot. Look for: name, email address, phone number, Instagram URL, TikTok URL, YouTube URL, LinkedIn URL, Twitter URL, website URL, company name, bio/description, follower count/audience size.

Return ONLY valid JSON in this exact format, nothing else:
{"name":"","email":"","phone":"","platform":"Instagram|TikTok|YouTube|LinkedIn|Twitter|Other","profile_url":"","audience_size":0,"notes":"any relevant bio or context","source":"screenshot"}

Fill in whatever you can find. Leave empty string for fields not visible. For platform, pick the primary one shown. For profile_url, use the full URL if visible. For audience_size, parse follower counts (e.g. "52.3K" = 52300, "1.2M" = 1200000).` }
          ]
        }]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ extracted: {}, raw: text });
    const extracted = JSON.parse(jsonMatch[0]);
    res.json({ extracted });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Standalone sync function — used by endpoint AND background loop
async function doGmailSync() {
  if (!googleTokens && db.settings.google_tokens) googleTokens = db.settings.google_tokens;
  if (!googleTokens) throw new Error('Google not connected');

  // Refresh token if expired
  if (Date.now() > googleTokens.expiry_date && googleTokens.refresh_token) {
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
      if (!refreshed.error) {
        googleTokens = { ...googleTokens, ...refreshed, expiry_date: Date.now() + (refreshed.expires_in * 1000) };
        db.settings.google_tokens = googleTokens;
        save();
      }
    } catch(e) { console.error('Token refresh failed:', e.message); }
  }

  const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&labelIds=INBOX', {
    headers: { Authorization: `Bearer ${googleTokens.access_token}` }
  });
  const listData = await listRes.json();
  if (listData.error) throw new Error(listData.error.message);

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
        id: msg.id, thread_id: msgData.threadId || '',
        from_name: (fromMatch[1] || '').trim().replace(/"/g, ''),
        from: fromMatch[2] || fromRaw, to: get('To'),
        subject: get('Subject') || '(no subject)',
        snippet: msgData.snippet || '', body: body || msgData.snippet || '',
        date: get('Date'), unread: (msgData.labelIds || []).includes('UNREAD'),
        labels: msgData.labelIds || [], created_at: new Date().toISOString()
      });
    } catch(e) { /* skip */ }
  }

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
  return emails.length;
}

app.post('/inbox/sync', auth, async (req, res) => {
  try {
    const synced = await doGmailSync();
    res.json({ ok: true, synced });
  } catch(e) {
    res.status(e.message.includes('not connected') ? 401 : 500).json({ error: e.message });
  }
});

// ─── REID AUTO-PROCESS INBOX ─────────────────────────────────────────────────
// Standalone process function — used by endpoint AND background loop
async function doAutoProcess() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('Anthropic API key not configured.');

  const unprocessed = db.inboxEmails.filter(e => !e.reid_processed);
  if (!unprocessed.length) return { processed: 0 };

  const prospectList = db.prospects.map(p => `${p.name} <${p.email}> — ${p.status} — ${p.platform}`).join('\n');
  let processed = 0;

  for (const email of unprocessed.slice(0, 30)) {
    try {
      const prompt = `Process this email from the inbox. Do THREE things:

1. TAG IT: Pick the best CRM tag from: Lead, Qualified, Call Booked, Follow Up, Closed Won, Closed Lost, Ignore. "Ignore" means spam/newsletter/automated/no-reply-address.
   Also set "is_spam" to true if this is spam, a newsletter, an automated notification, a no-reply address, or any non-human email. Set "is_spam" to false if this is a real person writing a real email.
2. FOLLOW-UP CHECK: Determine if this email needs a follow-up. Set "needs_follow_up" to true if:
   - They asked a question we haven't answered
   - They showed interest but no next step is scheduled
   - They went quiet after a previous conversation (stale thread)
   - They said "let me think about it" or similar soft stalls
   - A previous outreach got no reply and it's been 3+ days
   Set "follow_up_reason" to a short explanation (e.g. "Asked about pricing, no reply yet", "Showed interest 5 days ago, went quiet").
   Set "follow_up_date" to when the follow-up should happen: "today", "tomorrow", "3_days", "1_week".
3. DRAFT A REPLY as Reid Foster. HTML format, each sentence in its own <p> tag.
   VOICE: Write like you're texting a friend you respect. Casual, warm, low pressure. Never thirsty.
   - Open: "Hey [Name]"
   - Close: "Reid" (or "Cheers" for warmer threads)
   - One idea per line. Each sentence is its own <p> tag.
   - Under 60 words. Skip punctuation when it slows things down.
   - NO em dashes. NO open-ended questions. NO "what's your biggest challenge?"
   - Don't mention time durations. Just "a call" or "a chat".
   - Paint pictures instead of listing features. Use "..." for trailing thoughts.
   - If they ask a question: answer conversationally, then "does that make sense?", then offer a call
   - If they showed interest: booking link on its own line, "Let me know once you find a time"
   - If no reply: "Bumpin this up^"
   - Soft CTAs only: "Worth a chat?" or "Happy to jump on a call if that helps"
   - Hyperlink Apex: <a href="https://apex.host/">Apex</a>
   - Booking: <a href="https://cal.com/aubtin-sharifpour-apex/30min">https://cal.com/aubtin-sharifpour-apex/30min</a>
   - BANNED: em dashes, "circling back", "just checking in", "touching base", "I hope this finds you well", bullet points
   - If spam/newsletter: set draft to "SKIP".

EMAIL:
From: ${email.from_name} <${email.from}>
Subject: ${email.subject}
Date: ${email.date}
Body: ${(email.body || email.snippet || '').slice(0, 1500)}

KNOWN CRM CONTACTS:
${prospectList || '(none yet)'}

Respond ONLY in this exact JSON format, nothing else:
{"tag":"Lead","draft_subject":"Re: ${email.subject}","draft_body":"the reply text","priority":"high","summary":"one line summary of what this email is about","should_reply":true,"is_spam":false,"needs_follow_up":false,"follow_up_reason":"","follow_up_date":""}

Rules:
- If is_spam is true: set should_reply=false, draft_body="", tag="Ignore"
- If is_spam is false (real person): ALWAYS set should_reply=true and draft a reply. Every real person gets a draft.
- Every real person who emails us is at minimum a "Lead". Tag them as Lead unless they clearly qualify for a higher stage.
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
      const isSpam = result.is_spam || result.tag === 'Ignore';
      if (result.tag && result.tag !== 'Ignore') {
        email.tags = [...new Set([...(email.tags || []), result.tag])];
      }
      email.reid_processed = true;
      email.reid_priority = result.priority || 'medium';
      email.reid_summary = result.summary || '';
      email.is_spam = isSpam;
      email.needs_follow_up = result.needs_follow_up || false;
      email.follow_up_reason = result.follow_up_reason || '';
      email.follow_up_date = result.follow_up_date || '';
      email.follow_up_done = email.follow_up_done || false;

      // Create a draft for EVERY email — real people get actionable drafts, spam gets flagged
      const draftBody = result.draft_body || (isSpam ? '(spam — no reply needed)' : `Hey ${email.from_name || 'there'}\n\nThanks for reaching out.\n\nReid`);
      const draftId = crypto.randomUUID();
      db.emailDrafts.push({
        id: draftId,
        email_id: email.id,
        thread_id: email.thread_id || '',
        to: email.from,
        to_name: email.from_name || '',
        subject: result.draft_subject || `Re: ${email.subject}`,
        body: draftBody,
        status: isSpam ? 'spam' : 'draft',
        is_spam: isSpam,
        priority: result.priority || 'medium',
        created_at: new Date().toISOString()
      });
      email.reid_draft_id = draftId;

      // Auto-link to CRM prospect if email matches
      const matchingProspect = db.prospects.find(p =>
        p.email && email.from && p.email.toLowerCase() === email.from.toLowerCase()
      );
      if (matchingProspect) {
        email.prospect_id = matchingProspect.id;
        email.prospect_name = matchingProspect.name;
        // Auto-upgrade to "lead" if they're still a prospect (they responded = they're a lead)
        if (matchingProspect.status === 'prospect' || matchingProspect.status === 'outreach_sent') {
          matchingProspect.status = 'lead';
          matchingProspect.updated_at = new Date().toISOString();
          logActivity(matchingProspect.id, 'auto_upgraded', 'Reid auto-tagged as Lead (responded to email)');
        }
      }

      // Auto-create contact for unknown real senders
      if (!matchingProspect && !isSpam && email.from) {
        const newId = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prospects.push({
          id: newId, name: email.from_name || email.from.split('@')[0] || 'Unknown',
          email: email.from, phone: '', platform: 'Other', handle: '',
          profile_url: '', audience_size: 0, total_score: 0, outreach_type: 'inbound',
          source: 'gmail-inbox', notes: `Auto-added by Reid. First email: "${email.subject}"`,
          status: 'lead', content_focus: '', priority: 2, type: 'affiliate',
          deal_value: 0, commission_pct: 10, lead_type: 'Potential Affiliate Partner',
          outreach_sent_date: '', response_date: now, created_at: now, updated_at: now
        });
        email.prospect_id = newId;
        email.prospect_name = email.from_name || email.from.split('@')[0];
        logActivity(newId, 'auto_created', `Reid auto-added from inbox: ${email.from}`);
      }

      processed++;
    } catch(e) {
      console.error('Auto-process error:', e.message);
      email.reid_processed = true;
    }
  }

  save();
  return { processed, total_unprocessed: db.inboxEmails.filter(e => !e.reid_processed).length };
}

app.post('/inbox/auto-process', auth, async (req, res) => {
  try {
    const result = await doAutoProcess();
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Force reprocess all emails (clears processed flag and drafts)
app.post('/inbox/reprocess', auth, async (req, res) => {
  // Clear all processed flags and remove old drafts
  db.inboxEmails.forEach(e => { e.reid_processed = false; e.reid_draft_id = null; });
  db.emailDrafts = [];
  save();
  try {
    const result = await doAutoProcess();
    res.json({ reset: true, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
app.post('/inbox/drafts', auth, (req, res) => {
  const { to, to_name, subject, body, email_id, thread_id } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'to and body required' });
  const id = crypto.randomUUID();
  const draft = { id, email_id: email_id || '', thread_id: thread_id || '', to, to_name: to_name || '', subject: subject || '', body, status: 'draft', priority: 'medium', created_at: new Date().toISOString() };
  db.emailDrafts.push(draft);
  save();
  res.json(draft);
});

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
  // Detect if body contains HTML tags
  // Find the original email to get Message-ID for threading
  const originalEmail = draft.email_id ? db.inboxEmails.find(e => e.id === draft.email_id) : null;
  const isHtml = /<[a-z][\s\S]*>/i.test(draft.body);
  const headers = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`
  ];
  // Add threading headers so reply stays in the same thread
  if (originalEmail?.id) {
    headers.push(`In-Reply-To: <${originalEmail.id}@mail.gmail.com>`);
    headers.push(`References: <${originalEmail.id}@mail.gmail.com>`);
  }
  const rawEmail = [...headers, '', draft.body].join('\r\n');

  const encodedEmail = Buffer.from(rawEmail).toString('base64url');

  try {
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${googleTokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodedEmail, threadId: draft.thread_id || originalEmail?.thread_id || undefined })
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

// ─── CAL.COM BOOKINGS ───────────────────────────────────────────────────────
async function doCalSync() {
  if (!CALCOM_API_KEY) throw new Error('Cal.com API key not configured');

  const bookings = [];
  for (const status of ['upcoming', 'past']) {
    try {
      const res = await fetch(`https://api.cal.com/v2/bookings?status=${status}&take=50`, {
        headers: { Authorization: `Bearer ${CALCOM_API_KEY}` }
      });
      const data = await res.json();
      if (data.status === 'success' && data.data?.bookings) {
        bookings.push(...data.data.bookings);
      }
    } catch(e) { console.error(`Cal.com ${status} fetch error:`, e.message); }
  }

  // Dedupe by id
  const byId = {};
  db.bookings.forEach(b => { byId[b.id] = b; });

  let newCount = 0;
  for (const b of bookings) {
    const isNew = !byId[b.id];
    const responses = b.responses || {};
    byId[b.id] = {
      id: b.id,
      uid: b.uid,
      title: b.title || '',
      guest_name: responses.name || '',
      guest_email: responses.email || '',
      start_time: b.startTime,
      end_time: b.endTime,
      status: b.status,
      location: b.location || '',
      meet_url: b.metadata?.videoCallUrl || '',
      created_at: b.createdAt,
      synced_at: new Date().toISOString()
    };

    // Auto-match to prospect and upgrade to call_booked
    if (responses.email) {
      const prospect = db.prospects.find(p =>
        p.email && p.email.toLowerCase() === responses.email.toLowerCase()
      );
      if (prospect) {
        byId[b.id].prospect_id = prospect.id;
        byId[b.id].prospect_name = prospect.name;
        if (isNew && !['call_booked', 'follow_up', 'closed_won'].includes(prospect.status)) {
          prospect.status = 'call_booked';
          prospect.updated_at = new Date().toISOString();
          logActivity(prospect.id, 'call_booked', `Cal.com: ${b.title}`);
        }
      } else if (isNew) {
        // Auto-create prospect from booking
        const newId = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prospects.push({
          id: newId, name: responses.name || responses.email.split('@')[0],
          email: responses.email, phone: '', platform: 'Other', handle: '',
          profile_url: '', audience_size: 0, total_score: 0, outreach_type: 'inbound',
          source: 'cal.com', notes: `Booked: ${b.title}`,
          status: 'call_booked', content_focus: '', priority: 1, type: 'affiliate',
          deal_value: 0, commission_pct: 10, lead_type: 'Potential Affiliate Partner',
          outreach_sent_date: '', response_date: now, created_at: now, updated_at: now
        });
        byId[b.id].prospect_id = newId;
        byId[b.id].prospect_name = responses.name;
        logActivity(newId, 'auto_created', `Cal.com booking: ${responses.name} <${responses.email}>`);
      }
    }

    if (isNew) newCount++;
  }

  db.bookings = Object.values(byId).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  save();
  return { synced: bookings.length, new: newCount };
}

app.get('/bookings', auth, (req, res) => {
  res.json([...db.bookings].sort((a, b) => new Date(a.start_time) - new Date(b.start_time)));
});

app.post('/bookings/sync', auth, async (req, res) => {
  try {
    const result = await doCalSync();
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AUTO-SYNC BACKGROUND LOOP ──────────────────────────────────────────────
let autoSyncTimer = null;
let autoSyncRunning = false;

function getAutoSyncSettings() {
  return {
    enabled: db.settings.auto_sync_enabled || false,
    interval_minutes: db.settings.auto_sync_interval || 10,
    auto_process: db.settings.auto_sync_process !== false, // default true
    last_sync: db.settings.last_auto_sync || null,
    last_result: db.settings.last_auto_sync_result || null
  };
}

async function runAutoSync() {
  if (autoSyncRunning) return;
  autoSyncRunning = true;
  const now = new Date().toISOString();
  console.log(`[Auto-Sync] Running at ${now}`);
  try {
    const synced = await doGmailSync();
    console.log(`[Auto-Sync] Synced ${synced} emails`);
    let processResult = { processed: 0 };
    if (db.settings.auto_sync_process !== false) {
      processResult = await doAutoProcess();
      console.log(`[Auto-Sync] Processed ${processResult.processed} emails`);
    }
    // Sync Cal.com bookings
    let calResult = { synced: 0 };
    if (CALCOM_API_KEY) {
      try { calResult = await doCalSync(); console.log(`[Auto-Sync] Cal.com: ${calResult.new} new bookings`); }
      catch(e) { console.error('[Auto-Sync] Cal.com error:', e.message); }
    }
    db.settings.last_auto_sync = now;
    db.settings.last_auto_sync_result = { synced, processed: processResult.processed, bookings: calResult.new || 0, status: 'ok' };
    save();
  } catch(e) {
    console.error('[Auto-Sync] Error:', e.message);
    db.settings.last_auto_sync = now;
    db.settings.last_auto_sync_result = { status: 'error', error: e.message };
    save();
  }
  autoSyncRunning = false;
}

function startAutoSync() {
  stopAutoSync();
  const settings = getAutoSyncSettings();
  if (!settings.enabled) return;
  const ms = Math.max(settings.interval_minutes, 1) * 60 * 1000;
  console.log(`[Auto-Sync] Started — every ${settings.interval_minutes} min`);
  // Run immediately on start, then on interval
  setTimeout(() => runAutoSync(), 5000);
  autoSyncTimer = setInterval(runAutoSync, ms);
}

function stopAutoSync() {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
}

// Settings endpoints
app.get('/settings/auto-sync', auth, (req, res) => {
  res.json(getAutoSyncSettings());
});

app.patch('/settings/auto-sync', auth, (req, res) => {
  const { enabled, interval_minutes, auto_process } = req.body;
  if (enabled !== undefined) db.settings.auto_sync_enabled = !!enabled;
  if (interval_minutes !== undefined) db.settings.auto_sync_interval = Math.max(parseInt(interval_minutes) || 1, 1);
  if (auto_process !== undefined) db.settings.auto_sync_process = !!auto_process;
  save();
  // Restart or stop the loop
  if (db.settings.auto_sync_enabled) startAutoSync();
  else stopAutoSync();
  res.json(getAutoSyncSettings());
});

// ─── STATIC / HEALTH ─────────────────────────────────────────────────────────
app.get('/health', (req,res) => res.json({ ok:true, prospects:db.prospects.length, deals:db.deals.length, ts:new Date().toISOString() }));

const publicDir = path.join(__dirname,'../public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req,res) => { if(!req.path.startsWith('/api')) res.sendFile(path.join(publicDir,'index.html')); });
}

app.listen(PORT, () => {
  console.log(`Apex CRM on :${PORT} | DB: ${DB_PATH}.json`);
  // Start auto-sync if it was enabled
  if (db.settings.auto_sync_enabled) {
    console.log('[Auto-Sync] Resuming from saved settings');
    startAutoSync();
  }
});
