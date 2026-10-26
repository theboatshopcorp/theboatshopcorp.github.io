/* ============================================================
   STATE & PERSISTENCE
   ============================================================ */
const DB_KEYS = { quotes:'frp_quotations', customers:'frp_customers', pricing:'frp_pricing_db', templates:'frp_boat_templates', signatories:'frp_signatories', logo:'frp_logo', company:'frp_company_details', sales:'frp_sales_log', auth:'frp_auth' };

/* ============================================================
   SUPABASE SYNC — shared team database.
   Every DB_KEYS.* value is stored as one row in `app_state`
   (key text primary key, value jsonb, updated_at timestamptz).
   localStorage stays as an instant local cache: save() writes to
   it immediately (so the UI never waits on the network) and then
   pushes the same value to Supabase in the background. On boot we
   pull the latest from Supabase (last writer wins) and then listen
   for realtime changes so every teammate's screen stays in sync.
   ============================================================ */
const SUPABASE_URL = "https://ysckyoantxkjvuazhtsv.supabase.co";
const SUPABASE_KEY = "sb_publishable_va2t25bERY4e3CZadZGYyw_MDPq2Nyt";
// Auth sessions are kept in sessionStorage (not localStorage) on purpose:
// sessionStorage is cleared automatically when the tab/window is closed, so
// every new browser session requires signing in again. Reloading the same
// tab still keeps you logged in, which is expected.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true }
});
const REMOTE_TABLE = 'app_state';
const SYNCED_KEYS = [DB_KEYS.quotes, DB_KEYS.customers, DB_KEYS.pricing, DB_KEYS.templates, DB_KEYS.signatories, DB_KEYS.logo, DB_KEYS.company, DB_KEYS.sales];

let load, save; // assigned below once ensureQuoteDefaults etc. exist in scope

function localLoad(key, fallback){ try{ const v = localStorage.getItem(key); return v? JSON.parse(v) : fallback; }catch(e){ return fallback; } }
function localSave(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ console.error('Local save failed', e); } }

load = localLoad;

let _pushTimers = {};
function pushRemote(key, val){
  if(!SYNCED_KEYS.includes(key)) return;
  clearTimeout(_pushTimers[key]);
  _pushTimers[key] = setTimeout(async ()=>{
    try{
      const { error } = await supabaseClient.from(REMOTE_TABLE)
        .upsert({ key, value: val, updated_at: new Date().toISOString() }, { onConflict:'key' });
      if(error) console.error('Supabase save failed for', key, error);
    }catch(e){ console.error('Supabase save failed for', key, e); }
  }, 400); // small debounce so rapid keystrokes don't spam the network
}

save = function(key, val){
  localSave(key, val);
  pushRemote(key, val);
};

// Deep-merges `source`'s data into `target`, mutating `target` in place
// rather than replacing it — this matters because open edit forms (a
// signatory card, an open quote in the editor, etc.) hold a direct
// reference to these objects. Swapping the reference out from under them
// silently orphans whatever the user is currently typing.
function mergeInPlace(target, source){
  if(!target || typeof target !== 'object' || !source || typeof source !== 'object') return;
  Object.keys(target).forEach(k=>{ if(!(k in source)) delete target[k]; });
  Object.keys(source).forEach(k=>{
    const sv = source[k];
    if(sv && typeof sv==='object' && !Array.isArray(sv) && target[k] && typeof target[k]==='object' && !Array.isArray(target[k])){
      mergeInPlace(target[k], sv);
    } else {
      target[k] = sv;
    }
  });
}

// Same idea but for arrays of records keyed by `id` (QUOTES, CUSTOMERS,
// TEMPLATES) — matches existing records by id and merges into them in
// place, so an open quote's object reference stays valid even after a
// remote sync of the whole list.
function mergeRecordArray(targetArr, sourceArr){
  sourceArr = sourceArr || [];
  const sourceIds = new Set(sourceArr.map(r=>r.id));
  for(let i=targetArr.length-1;i>=0;i--){ if(!sourceIds.has(targetArr[i].id)) targetArr.splice(i,1); }
  sourceArr.forEach(sr=>{
    const existing = targetArr.find(t=>t.id===sr.id);
    if(existing) mergeInPlace(existing, sr);
    else targetArr.push(sr);
  });
  targetArr.sort((a,b)=> sourceArr.findIndex(x=>x.id===a.id) - sourceArr.findIndex(x=>x.id===b.id));
}

// Applies a remotely-fetched value for a given key onto the in-memory globals.
// Defined as a function (not a literal object) so it can reference globals
// like QUOTES/PRICING/etc. that are declared further down this same script.
function applyRemoteValue(key, val){
  if(val === null || val === undefined) return;
  if(key === DB_KEYS.quotes){ mergeRecordArray(QUOTES, val||[]); QUOTES.forEach(ensureQuoteDefaults); }
  else if(key === DB_KEYS.customers){ mergeRecordArray(CUSTOMERS, val||[]); }
  else if(key === DB_KEYS.pricing){ mergeInPlace(PRICING, val); if(!PRICING.structuralCatalog) PRICING.structuralCatalog = JSON.parse(JSON.stringify(DEFAULT_PRICING.structuralCatalog)); ensurePricingShape(); migrateUnitsToImperial(); }
  else if(key === DB_KEYS.templates){ mergeRecordArray(TEMPLATES, val||DEFAULT_TEMPLATES); migrateUnitsToImperial(); }
  else if(key === DB_KEYS.signatories){ mergeInPlace(SIGNATORIES, val); ['prepared','approved','received'].forEach(k=>{ if(!SIGNATORIES[k]) SIGNATORIES[k]={name:'',title:'',img:''}; }); }
  else if(key === DB_KEYS.logo){ mergeInPlace(LOGO, val || { img:'', width:100, top:null, left:null }); }
  else if(key === DB_KEYS.company){ mergeInPlace(COMPANY, val); if(!COMPANY.bank) COMPANY.bank = []; }
  else if(key === DB_KEYS.sales){ mergeRecordArray(SALES, val||[]); }
  else return;
  localSave(key, val);
}

async function pullAllFromRemote(){
  try{
    const { data, error } = await supabaseClient.from(REMOTE_TABLE).select('key,value');
    if(error){ console.error('Supabase load failed', error); return; }
    const existingKeys = new Set((data||[]).map(r=>r.key));
    const missingKeys = SYNCED_KEYS.filter(k=>!existingKeys.has(k));
    if(data && data.length){
      data.forEach(row=> applyRemoteValue(row.key, row.value));
      if(typeof renderAll === 'function') renderAll();
    }
    if(missingKeys.length){
      // Any key with no row yet (fresh project, or a key that was never
      // explicitly saved locally) gets seeded from the app's current live
      // in-memory state — which always has a real value, unlike raw
      // localStorage which may never have been written for empty defaults.
      missingKeys.forEach(k=> pushRemote(k, currentValueFor(k)));
    }
  }catch(e){ console.error('Supabase load failed', e); }
}

function currentValueFor(key){
  if(key === DB_KEYS.quotes) return QUOTES;
  if(key === DB_KEYS.customers) return CUSTOMERS;
  if(key === DB_KEYS.pricing) return PRICING;
  if(key === DB_KEYS.templates) return TEMPLATES;
  if(key === DB_KEYS.signatories) return SIGNATORIES;
  if(key === DB_KEYS.logo) return LOGO;
  if(key === DB_KEYS.company) return COMPANY;
  if(key === DB_KEYS.sales) return SALES;
  return null;
}

let CURRENT_USER = { email:'Demo User', isOwner:false };

function subscribeRemote(){
  supabaseClient.channel('app_state_changes')
    .on('postgres_changes', { event:'*', schema:'public', table: REMOTE_TABLE }, payload=>{
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
      if(!row || !row.key || !SYNCED_KEYS.includes(row.key)) return;
      applyRemoteValue(row.key, row.value);
      // Don't yank an in-progress edit out from under someone typing in the
      // editor — just refresh quietly everywhere else.
      if(typeof CURRENT !== 'undefined' && CURRENT.view === 'editor'){
        if(typeof toast === 'function') toast('A teammate updated shared data elsewhere');
      } else if(typeof renderAll === 'function') renderAll();
    })
    .subscribe();
}

/* ============================================================
   ACCESS CONTROL — Quotations, Boat Presets, Pricing Database, and
   Settings are each independently restricted, based on rows in
   Supabase's user_permissions table (one row per email+section granted).
   Dashboard and Customers stay open to everyone signed in.
   Nav items stay visible to everyone (per request) — a user without
   access to a given section sees a clear "Access Restricted" screen
   instead of the tab disappearing.
   ============================================================ */
let CURRENT_PERMISSIONS = new Set(); // populated after login by checkUserPermissions()
let CURRENT_IS_ADMIN = false; // populated after login by loadMyProfile()
let ALL_PROFILES = []; // every known user_profiles row, used to look up Prepared By / Approved By
const ADMIN_ONLY_VIEWS = ['quotes','editor','sales','templates','pricing','settings'];
// 'editor' (the quote editor) is governed by the same permission as 'quotes',
// since opening/editing a quote is part of the Quotations section.
function permissionKeyFor(view){ return view==='editor' ? 'quotes' : view; }
// Admins bypass per-section permissions entirely — they always have full access.
function hasAccess(view){ return CURRENT_IS_ADMIN || CURRENT_PERMISSIONS.has(permissionKeyFor(view)); }
function profileByEmail(email){ return ALL_PROFILES.find(p=>p.email===(email||'').toLowerCase()) || null; }

async function checkUserPermissions(email){
  try{
    const { data, error } = await supabaseClient.from('user_permissions').select('section').eq('email', (email||'').toLowerCase());
    if(error) throw error;
    CURRENT_PERMISSIONS = new Set((data||[]).map(r=>r.section));
  }catch(e){
    console.error('Permission check failed, defaulting to no restricted access', e);
    CURRENT_PERMISSIONS = new Set();
  }
}

// Ensures the current user has a user_profiles row (creating a blank one on
// first login), determines whether they're an admin, and loads every known
// profile so Prepared By / Approved By can look up any user's name and
// e-signature, not just the current person's.
async function loadMyProfile(email){
  const lower = (email||'').toLowerCase();
  try{
    const { data: existing, error: selErr } = await supabaseClient.from('user_profiles').select('*').eq('email', lower).maybeSingle();
    if(selErr) throw selErr;
    if(!existing){
      const { error: insErr } = await supabaseClient.from('user_profiles').insert({ email: lower });
      if(insErr) throw insErr;
    }
    CURRENT_IS_ADMIN = existing ? !!existing.is_admin : false;
  }catch(e){
    console.error('Profile load/create failed, defaulting to non-admin', e);
    CURRENT_IS_ADMIN = false;
  }
  await refreshAllProfiles();
}

async function refreshAllProfiles(){
  try{
    const { data, error } = await supabaseClient.from('user_profiles').select('*');
    if(error) throw error;
    ALL_PROFILES = data || [];
    const mine = profileByEmail(CURRENT_USER.email);
    if(mine) CURRENT_IS_ADMIN = !!mine.is_admin;
  }catch(e){
    console.error('Loading profiles failed', e);
  }
}

async function saveMyProfile(fields){
  const email = (CURRENT_USER.email||'').toLowerCase();
  try{
    const { error } = await supabaseClient.from('user_profiles').update({ ...fields, updated_at: new Date().toISOString() }).eq('email', email);
    if(error) throw error;
    await refreshAllProfiles();
    return true;
  }catch(e){
    console.error('Saving profile failed', e);
    return false;
  }
}

function renderAccessRestricted(content, actions){
  actions.innerHTML = '';
  content.innerHTML = `
    <div class="card" style="max-width:480px;margin:60px auto;text-align:center;">
      <div class="card-body" style="padding:40px 32px;">
        <div style="font-size:32px;margin-bottom:12px;">🔒</div>
        <h3 style="margin-bottom:8px;">Access Restricted</h3>
        <div class="section-lead" style="margin-bottom:0;">This section is limited to selected team members. If you believe you should have access, ask an admin to add your account.</div>
      </div>
    </div>`;
}

function uid(prefix){ return prefix+'_'+Math.random().toString(36).slice(2,9); }
function fmt(n){ n = Number(n)||0; return '₱'+n.toLocaleString('en-PH',{minimumFractionDigits:2, maximumFractionDigits:2}); }
// Groups line items (each with a .cat) into a Map, preserving first-seen order.
function groupByCat(rows){
  const map = new Map();
  (rows||[]).forEach(r=>{
    const k = r.cat || 'Uncategorized';
    if(!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  });
  return map;
}
// Prefers Company Name, falls back to Client Name, then to the old combined
// .name field (for quotes saved before Client/Company were split).
function customerDisplayName(snap){
  return snap.companyName || snap.clientName || snap.name || '';
}
// Builds the project title automatically: "{LOA}ft {Boat Application} {Boat
// Model} with {Engine Brand} {HP}HP {OBM/IBM}" — e.g. "64ft Passenger Boat
// Embassy Series with Isuzu 340HP IBM".
function generateProjectTitle(q){
  const loa = q.hull.loa || 0;
  const app = q.project.boatApplication==='Other' ? (q.project.boatApplicationOther||'') : (q.project.boatApplication||'');
  const model = q.project.boatModel || '';
  const brand = (q.engine.brand||'').trim();
  const hp = q.engine.hp || 0;
  const type = q.engine.type || 'IBM';
  const parts = [`${loa}ft`];
  if(app) parts.push(app);
  if(model) parts.push(model);
  let title = parts.join(' ');
  const nEng = Number(q.engine.qty)||1;
  const multi = nEng===2 ? 'Dual' : nEng===3 ? 'Triple' : nEng===4 ? 'Quad' : nEng>4 ? `${nEng}x` : '';
  const enginePart = [multi, brand, hp? `${hp}HP` : '', type].filter(Boolean).join(' ');
  if(enginePart) title += ` with ${enginePart}`;
  return title.trim();
}
function fmtNum(n,d=2){ n=Number(n)||0; return n.toLocaleString('en-PH',{minimumFractionDigits:d,maximumFractionDigits:d}); }
function ftInToDec(ft, inch){ return (Number(ft)||0) + (Number(inch)||0)/12; }
function decToFtIn(dec){ dec = Number(dec)||0; let ft = Math.floor(dec); let inch = Math.round((dec-ft)*12); if(inch>=12){ inch-=12; ft+=1; } return {ft, inch}; }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(window._tt); window._tt=setTimeout(()=>t.classList.remove('show'),2200); }
function todayISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

/* ---------- default pricing database ---------- */
const DEFAULT_PRICING = {
  fiberglassPerKg: 210,
  resinPerLiter: 175,
  resinDensity: 1.1,
  resinRatio: 1.8,
  gelcoatPerKg: 260,
  gelcoatCoverage: 0.6,
  corePerSqm: 850,
  primerPerLiter: 320,
  primerCoverage: 6,
  paintPerLiter: 480,
  paintCoverage: 8,
  // Labor rate card: daily rate PER LABORER for each labor category. Boat Presets pick categories + head-count + days.
  laborDailyRates: { fabrication:1440, fiberglass:1520, painting:1280, electrical:1600, assembly:1360, testing:1680 },
  materialsFlatV1: true,
  materialsKgV1: true,
  overheadPct: 12,
  contingencyPct: 5,
  marginPct: 18,
  standardDurationDays: 180,
  rushFeePct: 15,
  accessoryCatalog: [
    {cat:'Hull & Deck Accessories', name:'Stainless Bollard (pair)', unitPrice:8500},
    {cat:'Hull & Deck Accessories', name:'Stainless Cleat', unitPrice:1800},
    {cat:'Hull & Deck Accessories', name:'Towing Bitt', unitPrice:6200},
    {cat:'Hull & Deck Accessories', name:'Rub Rail (per ft)', unitPrice:420},
    {cat:'Hull & Deck Accessories', name:'SS#316 Grab Handle', unitPrice:2600},
    {cat:'Electrical System', name:'12V Panel Switch Board', unitPrice:14500},
    {cat:'Electrical System', name:'Dome Light', unitPrice:950},
    {cat:'Electrical System', name:'Bilge Pump w/ Auto Float', unitPrice:4200},
    {cat:'Electrical System', name:'Battery (Marine Deep Cycle)', unitPrice:9800},
    {cat:'Anchor & Docking', name:'Anchor Set w/ Chain & Rope', unitPrice:22000},
    {cat:'Anchor & Docking', name:'Fender', unitPrice:1600},
  ],
  // Flat list of materials (no categories). Boat Presets pick from this list.
  structuralCatalog: [
    {name:'Fiberglass Cloth / Mat', unit:'kg', unitPrice:210},
    {name:'Laminating Resin', unit:'liter', unitPrice:175},
    {name:'Gelcoat', unit:'kg', unitPrice:260},
    {name:'Chopped Strand Mat (450gsm, per roll)', unit:'roll', unitPrice:4800},
    {name:'Woven Roving Reinforcement (per roll)', unit:'roll', unitPrice:6200},
    {name:'Structural Adhesive / Epoxy Filler', unit:'kg', unitPrice:650},
    {name:'Urethane Pour Foam (flotation/buoyancy)', unit:'cu.ft', unitPrice:850},
    {name:'PVC Foam Core Board (Divinycell-type)', unit:'sqm', unitPrice:2600},
    {name:'End-Grain Balsa Core', unit:'sqm', unitPrice:2200},
    {name:'Marine Plywood Coring (per sheet, 4x8ft)', unit:'sheet', unitPrice:3200},
  ]
};

/* ---------- Labor per day + flat Materials list ----------
   Boat Presets fill the formula's Labor Rate (per day, per person) from the daily trade rates in
   Pricing Database -> Labor Days & Daily Rates, using the mapping below. (This replaces the old
   "Category Rates" table, so there is only one place to edit labor rates.) */
const CATEGORY_LABOR_TRADE = {
  'Fiberglass':'fiberglass', 'Foam & Core Materials':'fiberglass',
  'Stiffeners & Framing':'fabrication', 'Bulkheads':'fabrication',
  'Other Structural Materials':'assembly', 'Console':'assembly',
  // Transom / Deck & Superstructure categories (edit the trade here if your shop books them differently)
  'Transom':'fiberglass', 'Deck':'fiberglass', 'Cabin':'fiberglass', 'Canopy':'fabrication'
};
// Old default catalog entries that were structural components rather than materials.
const LEGACY_COMPONENT_ITEMS = ['longitudinal stiffener (glassed-in)','transverse frame / stringer','hat-section stringer (foam-cored)','plywood bulkhead (marine ply, glassed both sides)','frp sandwich bulkhead (foam core)','collision / watertight bulkhead','deck beam / carlin (frp)'];
// Labor rate card. (The old per-category "Days" were removed: labor now comes from the labor teams
// inside each preset, so any leftover laborDays is dropped.)
function ensureLaborDaily(){
  delete PRICING.laborDays;
  if(PRICING.laborDailyRates && typeof PRICING.laborDailyRates==='object') return;
  const rates = PRICING.laborRates;
  if(rates && typeof rates==='object'){
    PRICING.laborDailyRates = {};
    Object.keys(rates).forEach(k=>{ PRICING.laborDailyRates[k] = +((Number(rates[k])||0)*8).toFixed(2); });
  } else {
    PRICING.laborDailyRates = JSON.parse(JSON.stringify(DEFAULT_PRICING.laborDailyRates));
  }
}
// One-time: Structural catalog -> flat Materials list. Component-type items (stiffeners, bulkheads...)
// leave the visible list but their prices are kept in a hidden map so older presets still price correctly.
function ensureMaterialsCatalog(){
  if(!Array.isArray(PRICING.structuralCatalog)) PRICING.structuralCatalog = JSON.parse(JSON.stringify(DEFAULT_PRICING.structuralCatalog));
  if(PRICING.materialsFlatV1) return;
  PRICING.materialsFlatV1 = true;
  const legacy = PRICING.legacyStructuralPrices = PRICING.legacyStructuralPrices || {};
  const seen = new Set(), keep = [];
  PRICING.structuralCatalog.forEach(a=>{
    const k = (a.name||'').trim().toLowerCase(); if(!k) return;
    if(LEGACY_COMPONENT_ITEMS.includes(k)){ legacy[k] = Number(a.unitPrice)||0; return; }
    if(seen.has(k)) return; seen.add(k);
    keep.push({ name:a.name, unit:a.unit||'', unitPrice:Number(a.unitPrice)||0 });
  });
  PRICING.structuralCatalog = keep;
  ['categoryRates','categorySeedV1','categorySeedV2','categorySeedV3'].forEach(k=>delete PRICING[k]);
}
/* ---------- Imperial units ----------
   The shop works in ft / in / sq ft, and weight stays in kg (liters stay for fuel, water, resin and paint).
   Material lists (the Materials catalog and the lines inside presets) are converted ONCE, with
   quantity and price converted together so every line keeps the same cost. Hull measurements and
   the Pricing Database rates stay stored exactly as before and are converted only on screen. */
const SQFT_PER_SQM = 10.763910417, LB_PER_KG = 2.2046226218, FT_PER_M = 3.280839895;
const r4 = v => Math.round((Number(v)||0)*10000)/10000;
const sqft = sqm => (Number(sqm)||0) * SQFT_PER_SQM;
const METRIC_UNITS = {
  sqm:{u:'sq ft',f:SQFT_PER_SQM}, m2:{u:'sq ft',f:SQFT_PER_SQM}, 'm²':{u:'sq ft',f:SQFT_PER_SQM},
  linearm:{u:'ft',f:FT_PER_M}, lm:{u:'ft',f:FT_PER_M}, linearmeter:{u:'ft',f:FT_PER_M}
  // Weight stays in kg for materials (no kg -> lb conversion).
};
const unitKey = u => String(u||'').toLowerCase().replace(/[\s.]/g,'');
function metricUnitInfo(unit){ return METRIC_UNITS[unitKey(unit)] || null; }
function convertMaterialLine(m){
  const mu = metricUnitInfo(m && m.unit); if(!mu) return false;
  m.qty = r4((Number(m.qty)||0) * mu.f); m.price = r4((Number(m.price)||0) / mu.f); m.unit = mu.u; return true;
}
function convertCatalogItem(a){
  const mu = metricUnitInfo(a && a.unit); if(!mu) return false;
  a.unitPrice = r4((Number(a.unitPrice)||0) / mu.f); a.unit = mu.u; return true;
}
// Pricing Database rates shown in imperial (stored value x f = shown value).
const IMPERIAL_RATE_FIELDS = {
  fiberglassPerKg:{ f:1/LB_PER_KG,               label:'Fiberglass (₱/lb)' },
  resinDensity:   { f:LB_PER_KG,                 label:'Resin Density (lb/L)' },
  gelcoatPerKg:   { f:1/LB_PER_KG,               label:'Gelcoat (₱/lb)' },
  gelcoatCoverage:{ f:LB_PER_KG/SQFT_PER_SQM,    label:'Gelcoat Coverage (lb/sq ft)' },
  corePerSqm:     { f:1/SQFT_PER_SQM,            label:'Core Material (₱/sq ft)' },
  primerCoverage: { f:SQFT_PER_SQM,              label:'Primer Coverage (sq ft/L)' },
  paintCoverage:  { f:SQFT_PER_SQM,              label:'Paint Coverage (sq ft/L per coat)' }
};
const GLASS_LAYER_F = 1/SQFT_PER_SQM;   // kg/sqm -> kg/sq ft
// Earlier versions converted kg materials to lb. Weight is kg again: this turns those lb lines back
// into kg ONCE (quantity and price converted together, so every line keeps the same cost).
const isLbUnit = u => ['lb','lbs'].includes(unitKey(u));
function revertLbToKg(m, priceKey){
  if(!m || !isLbUnit(m.unit)) return false;
  if(priceKey==='qty'){ m.qty = r4((Number(m.qty)||0) / LB_PER_KG); m.price = r4((Number(m.price)||0) * LB_PER_KG); }
  else { m.unitPrice = r4((Number(m.unitPrice)||0) * LB_PER_KG); }
  m.unit = 'kg'; return true;
}
function migrateWeightToKg(){
  let changed = false;
  if(!PRICING.materialsKgV1){
    (PRICING.structuralCatalog||[]).forEach(a=>{ revertLbToKg(a,'unitPrice'); });
    PRICING.materialsKgV1 = true; changed = true;
  }
  (TEMPLATES||[]).forEach(t=>{
    if(t.materialsKgV1) return;
    (t.components||[]).forEach(c=>(c.materials||[]).forEach(m=>revertLbToKg(m,'qty')));
    if(t.hullWork && Array.isArray(t.hullWork.materials)) t.hullWork.materials.forEach(m=>revertLbToKg(m,'qty'));
    t.materialsKgV1 = true; changed = true;
  });
  return changed;
}
// Boat Model presets no longer have a separate Hull block or laminate / paint fields: the hull is just
// another structural component (category "Hull"). Existing hull labor + materials move over once, so
// no preset loses its hull cost.
function moveHullToComponents(){
  let changed = false;
  (TEMPLATES||[]).forEach(t=>{
    ['hullAreaOverride','layers','glassPerLayer','paintType','paintArea','coats'].forEach(k=>{ if(k in t){ delete t[k]; changed = true; } });
    if(!('hullWork' in t)) return;
    const w = t.hullWork;
    if(w && typeof w==='object'){
      ensureLaborTeams(w);
      const hasLabor = laborTeamsOf(w).some(x=>(Number(x.laborers)||0)>0 && (Number(x.days)||0)>0);
      const hasMats = (w.materials||[]).length>0;
      if(hasLabor || hasMats){
        if(!Array.isArray(t.components)) t.components = [];
        t.components.unshift({ cat:'Hull', useFormula:true, numberDays:0, laborTeams:JSON.parse(JSON.stringify(w.laborTeams||[])), materials:JSON.parse(JSON.stringify(w.materials||[])) });
      }
    }
    delete t.hullWork; changed = true;
  });
  return changed;
}
function migrateUnitsToImperial(){
  let changed = false;
  // 1. bring every preset component to the formula shape first (uses the catalog as it is right now)
  (TEMPLATES||[]).forEach(t=>{ (t.components||[]).forEach(c=>{ if(!c.useFormula){ migratePresetComponent(c); changed = true; } }); });
  if(moveHullToComponents()) changed = true;
  // 2. preset material lines (components, hull)
  (TEMPLATES||[]).forEach(t=>{
    (t.components||[]).forEach(c=>(c.materials||[]).forEach(m=>{ if(convertMaterialLine(m)) changed = true; }));
    if(t.hullWork && Array.isArray(t.hullWork.materials)) t.hullWork.materials.forEach(m=>{ if(convertMaterialLine(m)) changed = true; });
  });
  // 3. the Materials catalog
  (PRICING.structuralCatalog||[]).forEach(a=>{ if(convertCatalogItem(a)) changed = true; });
  // 4. weight is kg: undo the old kg -> lb conversion (runs once)
  if(migrateWeightToKg()) changed = true;
  return changed;
}
function ensurePricingShape(){ ensureLaborDaily(); ensureMaterialsCatalog(); }
// ---------- Labor teams: a preset can use several labor categories, each with its own head-count ----------
function laborCategoryNames(){ return Object.keys(PRICING.laborDailyRates||{}); }
function capFirst(str){ str = String(str||''); return str.charAt(0).toUpperCase() + str.slice(1); }
function laborRateFor(name){
  const k = String(name||'').trim().toLowerCase();
  const rates = PRICING.laborDailyRates || {};
  const hit = Object.keys(rates).find(x=>x.trim().toLowerCase()===k);
  return hit===undefined ? 0 : (Number(rates[hit])||0);
}
// Older presets stored ONE labor rate + ONE head-count; they read as a single team with the same cost.
// Each labor team owns its own materials: a material carries the id of the team it belongs to.
// Components saved before this keep every cost: their materials move onto the first team.
function ensureTeamMaterials(c){
  if(!c) return;
  ensureLaborTeams(c); ensureMaterials(c);
  c.laborTeams.forEach(tm=>{ if(!tm.id) tm.id = uid('tm'); });
  if(!c.laborTeams.length){
    if(!(c.materials||[]).length) return;
    c.laborTeams.push({ id:uid('tm'), cat:'', laborers:0, days:0, rate:0 });
  }
  const ids = new Set(c.laborTeams.map(t=>t.id));
  c.materials.forEach(m=>{ if(!ids.has(m.teamId)) m.teamId = c.laborTeams[0].id; });
}
function teamMaterialsOf(c, tm){ return (c.materials||[]).filter(m=>m.teamId===tm.id); }
function teamCostOf(c, tm){
  const labor = (Number(tm.rate)||0)*(Number(tm.laborers)||0)*(Number(tm.days)||0);
  const mats = teamMaterialsOf(c,tm).reduce((sum,m)=>sum+(Math.max(0,Number(m.qty)||0))*(Math.max(0,Number(m.price)||0)),0);
  return { labor, mats, total: labor+mats };
}
function laborTeamsOf(c){
  if(Array.isArray(c.laborTeams)) return c.laborTeams;
  const n = Number(c.numLaborers)||0, r = Number(c.laborRate)||0;
  return n>0 ? [{cat:'', laborers:n, rate:r}] : [];
}
function ensureLaborTeams(c){
  if(!c) return;
  if(!Array.isArray(c.laborTeams)){
    const n = Math.max(0, Number(c.numLaborers)||0), r = Math.max(0, Number(c.laborRate)||0);
    let cat = '';
    const trade = CATEGORY_LABOR_TRADE[c.cat];
    if(trade){ const hit = laborCategoryNames().find(x=>x.toLowerCase()===trade); if(hit) cat = hit; }
    c.laborTeams = n>0 ? [{cat, laborers:n, rate:r}] : [];
  }
  delete c.laborRate; delete c.numLaborers;
  // Each labor category has its own number of days. Teams saved before this inherit the old
  // shared value, so existing prices do not change.
  const shared = Math.max(0, Number(c.numberDays)||0);
  c.laborTeams.forEach(tm=>{ if(tm.days===undefined) tm.days = shared; });
}
const PAINT_CATEGORIES = ['Painting','Surface Preparation','Primer & Surfacer','Topcoat','Antifouling / Bottom Paint','Striping & Livery'];
function paintCategoryList(extra){
  const set = new Set(PAINT_CATEGORIES);
  (TEMPLATES||[]).forEach(t=>{ (t.paintComponents||[]).forEach(c=>{ if(c.cat) set.add(c.cat); }); });
  if(extra) set.add(extra);
  return [...set];
}
function presetCategoryList(extra){
  const list = [...Object.keys(CATEGORY_LABOR_TRADE), ...getKnownStructuralCategories()];
  if(extra) list.push(extra);
  return [...new Set(list.filter(Boolean))];
}

/* ---------- Accessories: category order, sorting, and "known categories" ----------
   Items are always DISPLAYED grouped by category (in this fixed, sensible order)
   and alphabetically by name within a category — regardless of the order they
   were added in. "Custom" is the catch-all bucket and always sorts last. */
const ACCESSORY_CATEGORY_ORDER = ['Hull & Deck Accessories','Fuel System','Electrical System','Anchor & Docking'];
// Retired sections: no longer offered in the quotation editor (items already saved on old quotations still print).
const REMOVED_ACCESSORY_CATEGORIES = ['Navigational Equipment','SOLAS Safety Equipment'];
// Optional section for accessories that are not common to our builds. Hidden until its checkbox is ticked.
const SPECIAL_FEATURES_CAT = 'Special Features / Accessories';
// These categories always get their own named section in the printed
// output (in this order), each with a "Not Applicable" option — even if
// no items are entered yet. Any other category still prints too, grouped
// generically afterward.
const PRINTED_ACCESSORY_SECTIONS = ['Hull & Deck Accessories','Fuel System','Electrical System','Anchor & Docking'];
function accessoryCategoryRank(cat){
  if(!cat) return ACCESSORY_CATEGORY_ORDER.length;      // uncategorized: just before Custom
  if(cat === 'Custom') return Infinity;                  // catch-all always last
  if(cat === SPECIAL_FEATURES_CAT) return ACCESSORY_CATEGORY_ORDER.length + 1;   // after the standard sections
  const idx = ACCESSORY_CATEGORY_ORDER.indexOf(cat);
  return idx !== -1 ? idx : ACCESSORY_CATEGORY_ORDER.length; // any newer custom category: grouped together, before Custom
}
function compareAccessoryItems(a, b){
  const ra = accessoryCategoryRank(a.cat), rb = accessoryCategoryRank(b.cat);
  if(ra !== rb) return ra - rb;
  const catCmp = String(a.cat||'').localeCompare(String(b.cat||''));
  if(catCmp !== 0) return catCmp;
  return String(a.name||'').localeCompare(String(b.name||''), undefined, {numeric:true, sensitivity:'base'});
}
// Every category currently in use anywhere (the fixed list, the catalog, and any
// custom categories already typed into any quotation) — so picking a "familiar"
// category for a new custom item is a dropdown, not blind retyping.
function getKnownAccessoryCategories(){
  const set = new Set(ACCESSORY_CATEGORY_ORDER);
  (PRICING.accessoryCatalog||[]).forEach(a=>{ if(a.cat && !REMOVED_ACCESSORY_CATEGORIES.includes(a.cat)) set.add(a.cat); });
  (QUOTES||[]).forEach(qt=>{ (qt.accessories||[]).forEach(a=>{ if(a.cat && a.cat!=='Custom' && !REMOVED_ACCESSORY_CATEGORIES.includes(a.cat)) set.add(a.cat); }); });
  const rest = [...set].filter(c=>!ACCESSORY_CATEGORY_ORDER.includes(c)).sort((a,b)=>a.localeCompare(b));
  return [...ACCESSORY_CATEGORY_ORDER, ...rest, 'Custom'];
}

/* ---------- Testing & Delivery: same category/sorting approach as Accessories ---------- */
const TESTING_DELIVERY_ORDER = ['Trailer','Delivery','Sea Trial'];
const PRINTED_TESTING_DELIVERY_SECTIONS = ['Trailer','Delivery','Sea Trial'];
function testingCategoryRank(cat){
  if(!cat) return TESTING_DELIVERY_ORDER.length;
  if(cat === 'Custom') return Infinity;
  const idx = TESTING_DELIVERY_ORDER.indexOf(cat);
  return idx !== -1 ? idx : TESTING_DELIVERY_ORDER.length;
}
function compareTestingItems(a, b){
  const ra = testingCategoryRank(a.cat), rb = testingCategoryRank(b.cat);
  if(ra !== rb) return ra - rb;
  const catCmp = String(a.cat||'').localeCompare(String(b.cat||''));
  if(catCmp !== 0) return catCmp;
  return String(a.name||'').localeCompare(String(b.name||''), undefined, {numeric:true, sensitivity:'base'});
}
function getKnownTestingCategories(){
  const set = new Set(TESTING_DELIVERY_ORDER);
  (QUOTES||[]).forEach(qt=>{ (qt.testingDelivery||[]).forEach(a=>{ if(a.cat && a.cat!=='Custom') set.add(a.cat); }); });
  const rest = [...set].filter(c=>!TESTING_DELIVERY_ORDER.includes(c)).sort((a,b)=>a.localeCompare(b));
  return [...TESTING_DELIVERY_ORDER, ...rest, 'Custom'];
}

/* ---------- Structural Components: same sorting/category approach as accessories ----------
   "Other Structural Materials" is the catch-all bucket here (equivalent to "Custom"
   for accessories) and always sorts last. */
const STRUCTURAL_CATEGORY_ORDER = ['Stiffeners & Framing','Bulkheads','Foam & Core Materials'];
function structuralCategoryRank(cat){
  if(!cat) return STRUCTURAL_CATEGORY_ORDER.length;
  if(cat === 'Other Structural Materials') return Infinity;
  const idx = STRUCTURAL_CATEGORY_ORDER.indexOf(cat);
  return idx !== -1 ? idx : STRUCTURAL_CATEGORY_ORDER.length;
}
function compareStructuralItems(a, b){
  const ra = structuralCategoryRank(a.cat), rb = structuralCategoryRank(b.cat);
  if(ra !== rb) return ra - rb;
  const catCmp = String(a.cat||'').localeCompare(String(b.cat||''));
  if(catCmp !== 0) return catCmp;
  return String(a.name||'').localeCompare(String(b.name||''), undefined, {numeric:true, sensitivity:'base'});
}
// Presets store structural components without a price (pricing lives only in
// the Pricing Database). When a preset is applied to a quote, look up each
// component's current unit price by matching category + name; if no catalog
// entry matches, default to 0 so the user can pick/set it manually.
function lookupStructuralPrice(cat, name){
  const k = (name||'').trim().toLowerCase();
  const hit = (PRICING.structuralCatalog||[]).find(a=>(a.name||'').trim().toLowerCase()===k);
  if(hit) return hit.unitPrice;
  return Number((PRICING.legacyStructuralPrices||{})[k])||0;
}
// Total Work Cost = for each labor category (Laborers × Rate × that category's own Days)
//                 + the sum of (Quantity × Price per Unit) for every material used
// The result is converted to a per-unit price so the quote's existing
// quantity × unit-price calculation continues to work.
function computeLaborCost(c){
  // laborers x rate x days, summed over every labor category (each has its own days)
  const shared = Math.max(0, Number(c.numberDays)||0);   // only used by presets saved before per-category days
  return laborTeamsOf(c).reduce((sum,t)=>{
    const days = t.days!==undefined ? Math.max(0, Number(t.days)||0) : shared;
    return sum + Math.max(0,Number(t.laborers)||0) * Math.max(0,Number(t.rate)||0) * days;
  }, 0);
}
// Each material used by a component is its own line: quantity x price per unit.
function materialLinesCost(c){
  return (c.materials||[]).reduce((sum,m)=> sum + Math.max(0,Number(m.qty)||0) * Math.max(0,Number(m.price)||0), 0);
}
function computeFormulaWorkCost(c){
  // Components saved before the materials list existed keep their single material.
  const materialCost = Array.isArray(c.materials)
    ? materialLinesCost(c)
    : Math.max(0,Number(c.materialQty)||0) * Math.max(0,Number(c.materialPrice)||0);
  return computeLaborCost(c) + materialCost;
}
// Turn an old single "Material Quantity / Price" pair into the first line of the list.
function ensureMaterials(c){
  if(Array.isArray(c.materials)) return;
  const q = Number(c.materialQty)||0, pr = Number(c.materialPrice)||0;
  c.materials = (c.useFormula && q>0) ? [{cat:'', name:'Material', unit:'unit', qty:q, price:pr}] : [];
}
/* ---------- Multi-select materials picker ---------- */
function catalogKey(cat,name){ return (name||'').trim().toLowerCase(); } // materials are matched by name only
function findCatalogByKey(k){ return (PRICING.structuralCatalog||[]).find(a=>catalogKey('',a.name)===k); }
function openMaterialPicker(opts){
  const chosen = new Set(opts.selected||[]);
  const all = (PRICING.structuralCatalog||[]).filter(a=>a.name);
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.innerHTML = `
    <div class="picker" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="picker-head">
        <div><h3>${esc(opts.title)}</h3>${opts.subtitle?`<div class="hint" style="margin:3px 0 0;">${esc(opts.subtitle)}</div>`:''}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-pk="cancel" aria-label="Close">✕</button>
      </div>
      <input type="search" class="picker-search" placeholder="Search materials…" aria-label="Search materials">
      <div class="picker-list"></div>
      <div class="picker-foot">
        <span class="picker-count"></span>
        <div style="display:flex;gap:8px;"><button type="button" class="btn btn-ghost" data-pk="cancel">Cancel</button><button type="button" class="btn btn-primary" data-pk="ok">${esc(opts.confirmLabel||'Done')}</button></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const list = overlay.querySelector('.picker-list'), search = overlay.querySelector('.picker-search'), count = overlay.querySelector('.picker-count');
  const updateCount = ()=>{ const n = chosen.size; count.textContent = n ? `${n} material${n===1?'':'s'} selected` : 'None selected'; };
  function draw(){
    const q = search.value.trim().toLowerCase();
    list.innerHTML = all.filter(a=>!q || (a.name+' '+(a.unit||'')).toLowerCase().includes(q))
      .sort((x,y)=>(x.name||'').localeCompare(y.name||'')).map(a=>{ const k=catalogKey('',a.name); return `
        <label class="picker-item"><input type="checkbox" data-k="${esc(k)}" ${chosen.has(k)?'checked':''}>
          <span class="nm">${esc(a.name)} <em>(${esc(a.unit)})</em></span><span class="pr">${fmt(a.unitPrice)}</span></label>`; }).join('')
      || `<div class="empty" style="padding:24px;">No materials match. Add items in Pricing Database → Materials.</div>`;
    updateCount();
  }
  function close(){ document.removeEventListener('keydown', onKey); overlay.remove(); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  list.addEventListener('change', e=>{
    const cb = e.target.closest('input[data-k]'); if(!cb) return;
    if(cb.checked) chosen.add(cb.dataset.k); else chosen.delete(cb.dataset.k);
    updateCount();
  });
  search.addEventListener('input', draw);
  overlay.addEventListener('click', e=>{
    if(e.target===overlay) return close();
    const b = e.target.closest('[data-pk]'); if(!b) return;
    if(b.dataset.pk==='ok'){ opts.onConfirm([...chosen]); }
    close();
  });
  draw(); search.focus();
}
// Make a component's catalog-based materials match the ticked list: keep quantities of
// ones that stay, add new ones (qty 1, catalog price), drop unticked ones. Custom lines stay.
function applyPickedMaterialsForTeam(c, teamId, keys){
  if(!Array.isArray(c.materials)) c.materials = [];
  const others = c.materials.filter(m=>m.teamId!==teamId);
  const want = new Set(keys);
  const kept = c.materials.filter(m=>m.teamId===teamId && (!(!!m.cat && !!findCatalogByKey(catalogKey(m.cat,m.name))) || want.has(catalogKey(m.cat,m.name))));
  const have = new Set(kept.map(m=>catalogKey(m.cat,m.name)));
  keys.forEach(k=>{
    if(have.has(k)) return;
    const it = findCatalogByKey(k);
    if(it) kept.push({cat:it.cat||'Materials', name:it.name, unit:it.unit, qty:1, price:Number(it.unitPrice)||0, teamId});
  });
  c.materials = [...others, ...kept];
}
function applyPickedMaterials(c, keys){
  if(!Array.isArray(c.materials)) c.materials = [];
  const want = new Set(keys);
  const kept = c.materials.filter(m=>{
    const k = catalogKey(m.cat, m.name);
    const fromCatalog = !!m.cat && !!findCatalogByKey(k);
    return fromCatalog ? want.has(k) : true;
  });
  const have = new Set(kept.map(m=>catalogKey(m.cat,m.name)));
  keys.forEach(k=>{
    if(have.has(k)) return;
    const it = findCatalogByKey(k);
    if(it) kept.push({cat:it.cat||'Materials', name:it.name, unit:it.unit, qty:1, price:Number(it.unitPrice)||0});
  });
  c.materials = kept;
}
function materialPickerOptions(){
  const groups = {};
  (PRICING.structuralCatalog||[]).forEach((a,i)=>{ const g=a.cat||'Other'; (groups[g]=groups[g]||[]).push({...a,i}); });
  return Object.keys(groups).sort((x,y)=>x.localeCompare(y)).map(g=>
    `<optgroup label="${esc(g)}">${groups[g].sort((x,y)=>(x.name||'').localeCompare(y.name||'')).map(a=>
      `<option value="${a.i}">${esc(a.name)} (${esc(a.unit)}) — ${fmt(a.unitPrice)}</option>`).join('')}</optgroup>`).join('');
}
// Migrate existing saved formula rows to the new fields while retaining their
// previous total as closely as possible.
function migrateFormulaComponent(c){
  if(!c || !c.useFormula || c.numberDays !== undefined) return;
  const qty = Math.max(0, Number(c.qty)||0);
  const productivity = Math.max(0, Number(c.productivity)||0);
  const workers = Math.max(0, Number(c.numWorkers)||0);
  const materialConsumption = Math.max(0, Number(c.materialConsumption)||0);
  c.numberDays = productivity > 0 && workers > 0 ? qty/(productivity*workers) : 0;
  c.numLaborers = workers;
  c.materialQty = qty * materialConsumption;
}
function resolveComponentUnitPrice(c){
  if(c.useFormula){
    const qty = Number(c.qty)||0;
    return qty>0 ? computeFormulaWorkCost(c)/qty : 0;
  }
  return lookupStructuralPrice(c.cat, c.name);
}
// Boat Preset structural components have no item name, unit or quantity any more: they are always
// priced by the formula (labor + materials), like the Hull. Older components that were priced as
// quantity x catalog price are converted once, keeping exactly the same total.
function migratePresetComponent(c){
  if(!c) return;
  if(!c.useFormula){
    let qty = Math.max(0, Number(c.qty)||0), unit = c.unit||'unit';
    const price = lookupStructuralPrice(c.cat, c.name);
    const nameKey = (c.name||'').trim().toLowerCase();
    const hit = (PRICING.structuralCatalog||[]).find(a=>(a.name||'').trim().toLowerCase()===nameKey);
    const mu = metricUnitInfo(unit);
    if(hit && mu && unitKey(hit.unit)===unitKey(mu.u)){ qty = qty*mu.f; unit = mu.u; }   // the catalog already uses imperial units for this item
    c.materials = (qty>0 && price>0) ? [{cat:'', name:c.name||c.cat||'Material', unit, qty, price}] : [];
    c.numberDays = 0; c.numLaborers = 0;
    c.useFormula = true;
  } else {
    migrateFormulaComponent(c);
  }
  ensureMaterials(c);
  if(c.numberDays===undefined) c.numberDays = 0;
  ensureLaborTeams(c);
}
// A preset component becomes one line on the quotation's structural list, named after its category.
function presetComponentToQuoteItem(c){
  migratePresetComponent(c);
  const qty = Math.max(0, Number(c.qty)||0) || 1;
  return {...c, name: c.name || c.cat || 'Structural component', unit: c.unit || 'lot', qty,
    materials: JSON.parse(JSON.stringify(c.materials||[])), laborTeams: JSON.parse(JSON.stringify(c.laborTeams||[])), id:uid('si'), unitPrice: computeFormulaWorkCost(c)/qty};
}
// A whole preset (Boat Model, Transom, Console or Deck) becomes ONE line on the quotation's structural
// list: the preset name, its description, and the combined cost of all its components.
function presetToQuoteItems(p, name){
  const comps = p.components || [];
  if(!comps.length) return [];
  const clone = x=>JSON.parse(JSON.stringify(x));
  const total = comps.reduce((s,c)=>{ migratePresetComponent(c); return s + computeFormulaWorkCost(c); }, 0);
  return [{ id:uid('si'), cat:'', name: name || p.name || 'Structural', description: p.description || '', unit:'lot', qty:1, unitPrice: total,
    useFormula:true, materials: comps.flatMap(c=>clone(c.materials||[])), laborTeams: comps.flatMap(c=>clone(c.laborTeams||[])) }];
}
// A Boat Model's structural components become one quotation line each: the category is the item name
// and the component's description follows it.
function boatComponentsToQuoteItems(p){
  return (p.components||[]).map(c=>{
    const it = presetComponentToQuoteItem(c);
    it.cat = ''; it.name = c.cat || c.name || 'Structural component'; it.description = c.description || '';
    return it;
  });
}
// A Boat Model's Painting Component becomes one lump-sum line on the quotation's Paint & Finish tab,
// priced by the same formula as the structural components (labor + materials).
function presetPaintToQuoteItem(c){
  migratePresetComponent(c);
  return { id:uid('pi'), coatLabel: c.cat || 'Painting', type:'', color:'', area:null, pricePerSqm:0,
    presetPaint:true, lumpCost: computeFormulaWorkCost(c),
    materials: JSON.parse(JSON.stringify(c.materials||[])), laborTeams: JSON.parse(JSON.stringify(c.laborTeams||[])) };
}
// Whenever a new custom item is typed anywhere — the Quotation Editor's Hull
// tab, its Accessories tab, or Boat Presets' Structural Components — it gets
// pushed into the shared Pricing Database catalog too (if not already there),
// so it shows up in every "Add from catalog" picker everywhere else.
// Items typed directly in the Pricing Database are already the source of
// truth for everyone, so no extra sync is needed for that direction.
function syncStructuralCatalog(cat, name, unit, unitPrice){
  cat = (cat||'').trim(); name = (name||'').trim();
  if(!cat || !name || name==='New Item') return false;
  const exists = (PRICING.structuralCatalog||[]).some(a=>(a.name||'').trim().toLowerCase()===name.toLowerCase());
  if(exists) return false;
  PRICING.structuralCatalog.push({ name, unit: unit||'pc', unitPrice: Number(unitPrice)||0 });
  save(DB_KEYS.pricing, PRICING);
  return true;
}
// A material typed into a preset line (Choose materials -> Custom material) registers itself in
// Pricing Database -> Materials. Lines picked from the catalog are left alone. A line that this
// function registered keeps its catalog entry's unit and price in step while you finish typing.
function syncMaterialLine(m){
  const name = (m.name||'').trim();
  if(!name) return false;
  const cat = PRICING.structuralCatalog = PRICING.structuralCatalog || [];
  const key = name.toLowerCase();
  const hit = cat.find(a=>(a.name||'').trim().toLowerCase()===key);
  if(!hit){
    cat.push({ name, unit:(m.unit||'').trim()||'pc', unitPrice:Number(m.price)||0 });
    m.catName = name; save(DB_KEYS.pricing, PRICING);
    toast(`"${name}" added to Pricing Database → Materials`);
    return true;
  }
  if((m.catName||'').trim().toLowerCase()===key){
    const u = (m.unit||'').trim()||'pc', p = Number(m.price)||0;
    if(hit.unit!==u || hit.unitPrice!==p){ hit.unit = u; hit.unitPrice = p; save(DB_KEYS.pricing, PRICING); }
  }
  return false;
}
function syncAccessoryCatalog(cat, name, unitPrice){
  cat = (cat||'').trim(); name = (name||'').trim();
  if(!cat || !name || name==='New Item') return false;
  const exists = (PRICING.accessoryCatalog||[]).some(a=>
    (a.name||'').trim().toLowerCase()===name.toLowerCase() && (a.cat||'').trim().toLowerCase()===cat.toLowerCase()
  );
  if(exists) return false;
  PRICING.accessoryCatalog.push({ cat, name, unitPrice: Number(unitPrice)||0 });
  save(DB_KEYS.pricing, PRICING);
  return true;
}
function getKnownStructuralCategories(){
  const set = new Set(STRUCTURAL_CATEGORY_ORDER);
  (QUOTES||[]).forEach(qt=>{ ((qt.structural&&qt.structural.items)||[]).forEach(a=>{ if(a.cat && a.cat!=='Other Structural Materials') set.add(a.cat); }); });
  (TEMPLATES||[]).forEach(t=>{ (t.components||[]).forEach(c=>{ if(c.cat && c.cat!=='Other Structural Materials') set.add(c.cat); }); });
  const rest2 = [...set].filter(c=>!STRUCTURAL_CATEGORY_ORDER.includes(c)).sort((a,b)=>a.localeCompare(b));
  return [...STRUCTURAL_CATEGORY_ORDER, ...rest2, 'Other Structural Materials'];
}

const DEFAULT_TEMPLATES = [
  { id:uid('tpl'), name:"64' Passenger Boat — 80 Pax (Inboard)", boatModel:'Embassy Series', boatType:'Passenger Boat', loa:64, beam:14, depth:6, numHulls:1,
    components: [
      {cat:'Stiffeners & Bulkheads', name:'Plywood Bulkhead, 18mm Marine Grade', unit:'pc', qty:6},
      {cat:'Stiffeners & Bulkheads', name:'Fiberglass Stringer', unit:'lm', qty:64},
      {cat:'Core & Foam Materials', name:'Urethane Foam Flotation', unit:'cu.ft', qty:180},
      {cat:'Other Structural Materials', name:'Deck Coring Panel', unit:'sqm', qty:40},
    ]
  }
];

let PRICING = load(DB_KEYS.pricing, null) || JSON.parse(JSON.stringify(DEFAULT_PRICING));
if(!PRICING.structuralCatalog) PRICING.structuralCatalog = JSON.parse(JSON.stringify(DEFAULT_PRICING.structuralCatalog));
ensurePricingShape();
if(PRICING.standardDurationDays===undefined) PRICING.standardDurationDays = DEFAULT_PRICING.standardDurationDays;
if(PRICING.rushFeePct===undefined) PRICING.rushFeePct = DEFAULT_PRICING.rushFeePct;
let CUSTOMERS = load(DB_KEYS.customers, []);
let QUOTES = load(DB_KEYS.quotes, []);
// Sales Tracker log. First run seeds it from the old Excel sheet (see sales.js); after that the
// shared copy in Supabase is the source of truth.
let SALES = load(DB_KEYS.sales, null);
if(!Array.isArray(SALES)){ SALES = salesSeed(); localSave(DB_KEYS.sales, SALES); }
let TEMPLATES = load(DB_KEYS.templates, null) || DEFAULT_TEMPLATES;
if(!load(DB_KEYS.templates,null)) save(DB_KEYS.templates, TEMPLATES);
if(!load(DB_KEYS.pricing,null)) save(DB_KEYS.pricing, PRICING);
try{ migrateUnitsToImperial(); }catch(e){ console.error('Unit/preset migration skipped', e); }

const DEFAULT_COMPANY = {
  name:'The Boat Shop Corporation',
  tagline:'Crafted for Performance, Refined Through Experience since 1957',
  address:'239 Marseilla St, Silangan I, Rosario, Cavite, Philippines',
  contact:'+63 917 804 0766',
  email:'info@boatshopphilippines.com',
  tin:'004-681-502-000',
  bank:[
    { bankName:'BDO – CEPZA', branch:'Rosario Cavite Branch', accountName:'THE BOAT SHOP CORPORATION', accountNumber:'004788004770' },
    { bankName:'METRO BANK', branch:'Rosario Cavite Branch', accountName:'THE BOAT SHOP CORPORATION', accountNumber:'160316024952-9' },
  ]
};
let COMPANY = load(DB_KEYS.company, null) || JSON.parse(JSON.stringify(DEFAULT_COMPANY));
if(!COMPANY.bank) COMPANY.bank = [];
if(!load(DB_KEYS.company,null)) save(DB_KEYS.company, COMPANY);
function saveCompany(){ save(DB_KEYS.company, COMPANY); }

/* ---------- Signatories (name / title / signature image), persisted across all quotations ---------- */
const DEFAULT_SIGNATORIES = {
  prepared: { name:'Patrick Gonzales', title:'Executive Assistant', img:'' },
  approved: { name:'Corazon Bobadilla', title:'President', img:'' },
  received: { name:'', title:'', img:'' },
};
let SIGNATORIES = load(DB_KEYS.signatories, null) || JSON.parse(JSON.stringify(DEFAULT_SIGNATORIES));
['prepared','approved','received'].forEach(k=>{ if(!SIGNATORIES[k]) SIGNATORIES[k] = {name:'',title:'',img:''}; });
if(!load(DB_KEYS.signatories,null)) save(DB_KEYS.signatories, SIGNATORIES);
function saveSignatories(){ save(DB_KEYS.signatories, SIGNATORIES); }

/* ---------- Company logo: uploaded/linked image, draggable + resizable on the document header ---------- */
let LOGO = load(DB_KEYS.logo, null) || { img:'', width:100, top:null, left:null };
function saveLogo(){ save(DB_KEYS.logo, LOGO); }
let _logoDrag = { mode:null, startX:0, startY:0, startLeft:0, startTop:0, startWidth:0 };
function ensureLogoPixelPos(wrap, container){
  if(LOGO.top==null || LOGO.left==null){
    const cRect = container.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    LOGO.top = Math.round(wRect.top - cRect.top);
    LOGO.left = Math.round(wRect.left - cRect.left);
  }
}
function initLogoDragOnce(){
  if(window._logoDragInit) return;
  window._logoDragInit = true;
  window.addEventListener('mousemove', (e)=>{
    if(!_logoDrag.mode) return;
    const wrap = document.getElementById('docLogoWrap');
    if(!wrap) return;
    if(_logoDrag.mode==='drag'){
      LOGO.left = _logoDrag.startLeft + (e.clientX-_logoDrag.startX);
      LOGO.top = _logoDrag.startTop + (e.clientY-_logoDrag.startY);
      wrap.style.position = 'absolute'; wrap.style.left = LOGO.left+'px'; wrap.style.top = LOGO.top+'px';
    } else if(_logoDrag.mode==='resize'){
      LOGO.width = Math.max(30, _logoDrag.startWidth + (e.clientX-_logoDrag.startX));
      wrap.style.width = LOGO.width+'px';
    }
  });
  window.addEventListener('mouseup', ()=>{
    if(_logoDrag.mode) saveLogo();
    _logoDrag.mode = null;
  });
}

function fileToDataURL(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
/* Converts a typical Google Drive share link into a directly-viewable image URL.
   Requires the Drive file's sharing setting to be "Anyone with the link". */
function driveImgUrl(url){
  url = (url||'').trim();
  if(!url) return '';
  const m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if(m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  return url;
}

/* ---------- Number → words (Philippine Peso amount) ---------- */
function numberToWords(n){
  n = Math.round((Number(n)||0)*100)/100;
  const pesos = Math.floor(n);
  const centavos = Math.round((n-pesos)*100);
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
  const teens = ['Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function chunk(num){
    let s='';
    if(num>=100){ s+=ones[Math.floor(num/100)]+' Hundred'; num%=100; if(num>0) s+=' '; }
    if(num>=10 && num<20){ s+=teens[num-10]; }
    else if(num>=20){ s+=tens[Math.floor(num/10)]; if(num%10>0) s+='-'+ones[num%10].toLowerCase(); }
    else if(num>0){ s+=ones[num]; }
    return s;
  }
  function convert(num){
    if(num===0) return 'Zero';
    const scales = [['',1],['Thousand',1000],['Million',1000000],['Billion',1000000000]];
    let parts = [];
    for(let i=scales.length-1;i>=0;i--){
      const [label,val] = scales[i];
      if(num>=val){
        const c = Math.floor(num/val);
        parts.push(chunk(c)+(label?' '+label:''));
        num %= val;
      }
    }
    return parts.join(' ').trim();
  }
  let words = convert(pesos)+' Pesos';
  words += centavos>0 ? (' and '+centavos.toString().padStart(2,'0')+'/100') : '';
  words += ' Only';
  return words;
}

/* ============================================================
   NEW QUOTATION FACTORY
   ============================================================ */
function blankQuote(){
  return {
    id: uid('q'),
    refNo: nextRefNo(),
    status: 'draft',
    date: todayISO(),
    validityDays: 30,
    customerId: null,
    createdByEmail: (CURRENT_USER.email||'').toLowerCase(),
    approvedBy: null, // {email, name, esign, date} — set when an admin clicks Approve Quotation
    customerSnap: { name:'', companyName:'', clientName:'', clientPosition:'', companyTin:'', email:'', address:'', contact:'',
      repName:'', repPosition:'', repContact:'', repEmail:'', repNA:false },
    project: { title:'', notes:'', numBoats:1, passengerCapacity:0, multiplyPrice:false, buildType:'Standard Build', boatModel:'Apple Series', boatPresetId:null, boatApplication:'Passenger Boat', boatApplicationOther:'' },
    hull: { boatType:'Passenger Boat', loa:0, beam:0, depth:0, numHulls:1, hullAreaOverride:null, layers:3, glassPerLayer:0.6, coreArea:0, coreEnabled:false },
    structural: { items:[] },
    paint: { items: [
      {id:uid('pi'), coatLabel:'1st Coat', type:'Marine Polyurethane Topcoat', color:'White', area:null, pricePerSqm:60},
      {id:uid('pi'), coatLabel:'2nd Coat', type:'Marine Polyurethane Topcoat', color:'White', area:null, pricePerSqm:60},
      {id:uid('pi'), coatLabel:'3rd Coat', type:'Marine Polyurethane Topcoat', color:'White', area:null, pricePerSqm:60}
    ] },
    accessories: [],
    specialFeatures: { enabled:false, items:[] },
    accessoryCategoryNA: {},
    testingDelivery: [],
    testingDeliveryNA: {},
    engine: { model:'', brand:'', type:'IBM', hp:0, qty:2, unitPrice:0, installation:0, transmission:'', propeller:'', speed:'', fuelCapacity:'',
      description:"Dual Installation of Yamaha 250HP, Model: F250HETX, Model: FL250HETX\nFuel Injection, 4 Stroke, 24 Valve, Double Overhead Camshaft, V6, Standard Rotation and Counter Rotation, Shaft length 25 inches, Built-in Power trim & Tilt assy., Brand New complete with the following;",
      inclusions: ['Remote Control box with wiring harness (Dual Top mount)','Dual Panel switch','Gauge Kit - Multifunction Digital Tachometer/Speedometer','Battery Cable','Yamaha Primer Bulb','Stainless Propeller','Complete Dometic Hydraulic Steering & Control System',"Engine Owner's Manual"],
      steeringItems: []
    },
    // Labor hours & rates now live only in the global Pricing Database
    // (see computeLabor) — no per-quote labor field needed anymore.
    rates: JSON.parse(JSON.stringify(PRICING)), // snapshot, editable per-quote (overhead/contingency/margin/duration/rush)
    schedule: { startDate: todayISO(), standardDays: PRICING.standardDurationDays, requestedDays: PRICING.standardDurationDays },
    terms: [
      {title:'Completion Time', body:'12 months from date of receipt of downpayment and Purchase Order'},
      {title:'Payment Terms', body:'20% downpayment upon confirmation of order; progress billing per agreed schedule; 10% upon completion and sea trial before delivery'},
      {title:'Hull Warranty', body:'Two (2) years on hull structure for pleasure use, one (1) year for commercial use, covering manufacturing defects under normal use conditions.'},
      {title:'Warranty Exclusions', body:'Warranty excludes normal wear and tear, misuse or negligence, unauthorized modification, force majeure, and third-party accessories which follow manufacturer warranty.'},
      {title:'Delivery', body:'Delivery outside factory premises subject to separate agreement and additional logistics charges.'},
      {title:'Regulatory Compliance', body:'Boat registration, MARINA licenses, permits and certificates shall be borne by the customer.'},
    ],
    marina: {
      items: [
        {name:"MARINA Construction Permit (Certificate of Construction)", responsibility:'Company', remarks:'Filed prior to keel-laying', price:0},
        {name:"Certificate of Vessel Registry (COR)", responsibility:'Customer', remarks:'', price:0},
        {name:"Coastwise License / Certificate of Public Convenience", responsibility:'Customer', remarks:'If for commercial operation', price:0},
        {name:"Load Line Certificate", responsibility:'Customer', remarks:'', price:0},
        {name:"Cargo Ship Safety Equipment Certificate", responsibility:'Customer', remarks:'', price:0},
        {name:"Certificate of Inspection (COI)", responsibility:'Customer', remarks:'Annual renewal', price:0},
        {name:"Tonnage Certificate", responsibility:'Customer', remarks:'', price:0},
        {name:"Builder's Certificate", responsibility:'Company', remarks:'Issued upon delivery', price:0},
      ],
      notes:"All MARINA registration, licensing, permit, and certification fees are for the account of the Customer unless otherwise stated. The Company shall provide the Builder's Certificate and other builder-side documents required to support the Customer's registration application."
    },
    output: { showInternalCosts:false },
    invoice: { vatEnabled:true, vatPct:12, previousPayment:0, discountType:'pct', discountValue:0, discountNote:'' },
    paymentSchedule: [
      { description:'Downpayment', terms:'Upon order confirmation & signed conform', dueUpon:'Order Confirmation', percent:20 },
      { description:'Balance', terms:'Before shipping / delivery of the boat', dueUpon:'Before Delivery', percent:80 },
    ],
    createdAt: Date.now(), updatedAt: Date.now()
  };
}
function nextRefNo(){
  const yr = new Date().getFullYear().toString().slice(2);
  const n = QUOTES.length + 1;
  return 'Q'+yr+'-'+String(n).padStart(3,'0');
}
const STATUS_LABELS = { draft:'Draft', for_approval:'For Approval', for_revision:'For Revision', approved:'Approved' };
function statusLabel(s){ return STATUS_LABELS[s] || s; }
// Appends/increments a " REV NN" suffix on a reference number, e.g.
// "Q26-017" → "Q26-017 REV 01" → "Q26-017 REV 02" …
function incrementRevisionRef(refNo){
  const m = (refNo||'').match(/^(.*) REV (\d+)$/);
  if(m) return `${m[1]} REV ${String(Number(m[2])+1).padStart(2,'0')}`;
  return `${refNo} REV 01`;
}
function isDuplicateRefNo(refNo, excludeId){
  const norm = (refNo||'').trim().toLowerCase();
  if(!norm) return false;
  return QUOTES.some(x=>x.id!==excludeId && (x.refNo||'').trim().toLowerCase()===norm);
}

/* ============================================================
   CALCULATION ENGINE
   ============================================================ */
const FT2M = 0.3048;
function hullAreaEstimate(h){
  if(h.hullAreaOverride!=null && h.hullAreaOverride!=='') return Number(h.hullAreaOverride);
  const loaM = h.loa*FT2M, beamM = h.beam*FT2M;
  const kFactor = { 'Monohull':1.35, 'Catamaran':1.15, 'Passenger Boat':1.5, 'Fishing Boat':1.4, 'Patrol Boat':1.45, 'Pontoon':1.2 }[h.boatType] || 1.4;
  const perHull = loaM*beamM*kFactor;
  return +(perHull * (h.numHulls||1)).toFixed(2);
}
function computeHull(q){
  const h = q.hull, r = q.rates;
  const area = hullAreaEstimate(h);
  const glassWeight = area * h.layers * h.glassPerLayer;
  const resinWeight = glassWeight * r.resinRatio;
  const resinLiters = resinWeight / r.resinDensity;
  const gelcoatWeight = area * r.gelcoatCoverage;
  const coreCost = h.coreEnabled ? (Number(h.coreArea)||0) * r.corePerSqm : 0;
  const glassCost = glassWeight * r.fiberglassPerKg;
  const resinCost = resinLiters * r.resinPerLiter;
  const gelcoatCost = gelcoatWeight * r.gelcoatPerKg;
  // A Boat Preset's Hull formula (labor + materials) replaces the automatic
  // fiberglass / resin / gelcoat estimate; the quote's own core-material line stays on top.
  const work = h.work || null;
  const workCost = work ? computeFormulaWorkCost(work) : 0;
  const useWork = workCost > 0;
  const noLaminate = !!h.noLaminate && !useWork;   // hull is priced through the preset's structural components
  const total = (useWork ? workCost : noLaminate ? 0 : glassCost + resinCost + gelcoatCost) + coreCost;
  return { area, glassWeight, resinWeight, resinLiters, gelcoatWeight, glassCost, resinCost, gelcoatCost, coreCost, workCost, useWork, noLaminate, total };
}
function computePaint(q, hullCalc){
  const rows = (q.paint.items||[]).map(p=>{
    if(p.presetPaint) return {...p, area:null, cost:Number(p.lumpCost)||0};
    const area = (p.area!=null && p.area!=='') ? Number(p.area) : hullCalc.area;
    const cost = area * (Number(p.pricePerSqm)||0);
    return {...p, area, cost};
  });
  const total = rows.reduce((s,r)=>s+r.cost,0);
  return { rows, total };
}
function computeStructural(q){
  const rows = (q.structural.items||[]).map(a=>{
    const total = (Number(a.qty)||0) * (Number(a.unitPrice)||0);
    return {...a, total};
  }).sort(compareStructuralItems);
  const total = rows.reduce((s,r)=>s+r.total,0);
  return { rows, total };
}
function computeAccessories(q){
  // Special Features / Accessories only count (and only print) while its checkbox is ticked.
  const sf = q.specialFeatures;
  const sfItems = (sf && sf.enabled) ? (sf.items||[]).map(a=>({...a, cat:String(a.cat||'').trim() || SPECIAL_FEATURES_CAT, isSpecial:true})) : [];
  const rows = [...q.accessories, ...sfItems].map(a=>{
    const base = (Number(a.qty)||0) * (Number(a.unitPrice)||0);
    const total = base * (1 + (Number(a.markup)||0)/100);
    return {...a, base, total};
  }).sort(compareAccessoryItems);
  const total = rows.reduce((s,r)=>s+r.total,0);
  return { rows, total };
}
function computeTestingDelivery(q){
  const rows = (q.testingDelivery||[]).map(a=>{
    const base = (Number(a.qty)||0) * (Number(a.unitPrice)||0);
    const total = base * (1 + (Number(a.markup)||0)/100);
    return {...a, base, total};
  }).sort(compareTestingItems);
  const total = rows.reduce((s,r)=>s+r.total,0);
  return { rows, total };
}
function computeEngine(q){
  const e = q.engine;
  // The amount typed in is the whole propulsion cost; it is not multiplied by the number of engines.
  const unitsCost = Number(e.unitPrice)||0;
  const total = unitsCost;
  return { unitsCost, total };
}
function computeAll(q){
  const hull = computeHull(q);
  const paint = computePaint(q, hull);
  const structural = computeStructural(q);
  const acc = computeAccessories(q);
  const testing = computeTestingDelivery(q);
  const eng = computeEngine(q);
  // Every priced line is summed exactly once. There is no separate "equipment cost"
  // bucket and no duration / rush charge: the price depends only on the line items.
  // Labor lives inside the preset lines (hull / structural), so there is no separate labor charge.
  const materialCost = hull.total + paint.total + structural.total;
  const base = materialCost + acc.total + eng.total;
  const overheadCost = base * (Number(q.rates.overheadPct)||0)/100;
  const contingencyCost = base * (Number(q.rates.contingencyPct)||0)/100;
  const marginCost = base * (Number(q.rates.marginPct)||0)/100;
  const marinaCost = (q.marina && Array.isArray(q.marina.items)) ? q.marina.items.reduce((s,it)=>s+(Number(it.price)||0),0) : 0;
  const unitFinalTotal = base + overheadCost + contingencyCost + marginCost + marinaCost + testing.total;
  const numBoats = Math.max(1, Number(q.project.numBoats)||1);
  const multiplyPrice = !!q.project.multiplyPrice;
  const finalTotal = multiplyPrice ? unitFinalTotal * numBoats : unitFinalTotal;
  return { hull, paint, structural, acc, testing, eng, materialCost, overheadCost, contingencyCost, marginCost, marinaCost, base, unitFinalTotal, numBoats, multiplyPrice, finalTotal };
}
const round2 = n => Math.round((Number(n)||0)*100 + 1e-9)/100;
function computeInvoiceTotals(q, c){
  const inv = q.invoice || { vatEnabled:true, vatPct:12, previousPayment:0, discountType:'pct', discountValue:0 };
  const contractAmount = round2(c.finalTotal);
  const discountType = inv.discountType==='fixed' ? 'fixed' : 'pct';
  const discountValue = Math.max(0, Number(inv.discountValue)||0);
  // Discount comes off the full price (after any x-boats multiplication) and BEFORE VAT,
  // so VAT is charged only on what the client actually pays for.
  const requested = discountType==='fixed' ? discountValue : contractAmount*Math.min(discountValue,100)/100;
  const discountAmount = round2(Math.min(requested, contractAmount));
  const discountCapped = discountType==='fixed' ? discountValue > contractAmount : discountValue > 100;
  const discountPctEff = contractAmount>0 ? discountAmount/contractAmount*100 : 0;
  const discountNote = String(inv.discountNote||'').trim();
  const discountedAmount = round2(contractAmount - discountAmount);
  const vatPct = inv.vatEnabled ? (Number(inv.vatPct)||0) : 0;
  const vatAmount = round2(discountedAmount * vatPct/100);
  const totalContractAmount = round2(discountedAmount + vatAmount);
  const previousPayment = Number(inv.previousPayment)||0;
  const balanceDue = round2(totalContractAmount - previousPayment);
  const schedule = (q.paymentSchedule||[]).map(r=>({...r, amount: round2(totalContractAmount*(Number(r.percent)||0)/100)}));
  const scheduleTotal = schedule.reduce((s,r)=>s+r.amount,0);
  return { vatEnabled:inv.vatEnabled, vatPct, contractAmount, discountType, discountValue, discountAmount, discountCapped, discountPctEff, discountNote, discountedAmount, vatAmount, totalContractAmount, previousPayment, balanceDue, schedule, scheduleTotal };
}

/* ============================================================
   BUILD TYPE / BOAT MODEL / BOAT APPLICATION OPTIONS
   ============================================================ */
const BUILD_TYPES = ['Standard Build','Custom Build'];
// The original fixed list is kept as a floor so nothing already in use
// (existing quotes, dropdowns) disappears. Any additional models added via
// "Add Boat Model" on the Boat Presets page become new presets, and are
// picked up here too — so the list of available Boat Models is effectively
// unlimited. getBoatModelList() is called fresh everywhere it's needed, so
// it always reflects the current TEMPLATES/presets list.
const LEGACY_BOAT_MODELS = ['Dinghy Series','Apple Series','Reef Runner Series','Embassy Series','Outrigger Series','Navigator Series','Catamaran'];
function getBoatModelList(){
  const set = new Set(LEGACY_BOAT_MODELS);
  (TEMPLATES||[]).forEach(t=>{ if(t.boatModel) set.add(t.boatModel); });
  return Array.from(set);
}
// Boat Model presets are identified by id, so two presets can share a name when their LOA differs.
function isBoatPreset(t){ return !!(t && t.boatModel && !t.presetType); }
function fmtLoaShort(loa){ const f = decToFtIn(loa); return f.inch ? `${f.ft}ft ${f.inch}in` : `${f.ft}ft`; }
function boatPresetLabel(t){ return `${t.boatModel} — ${(Number(t.loa)||0) ? fmtLoaShort(t.loa)+' LOA' : 'LOA not set'}`; }
function escH(s){ return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// Options for the quotation's Boat Model picker: one per preset, labelled with its LOA.
function boatPickerOptions(q){
  const presets = (TEMPLATES||[]).filter(isBoatPreset).sort((x,y)=> x.boatModel.localeCompare(y.boatModel) || ((Number(x.loa)||0)-(Number(y.loa)||0)));
  const names = new Set(presets.map(t=>t.boatModel));
  let selId = presets.some(t=>t.id===q.project.boatPresetId) ? q.project.boatPresetId : null;
  if(!selId){
    const m = presets.find(t=>t.boatModel===q.project.boatModel && Math.abs((Number(t.loa)||0)-(Number(q.hull.loa)||0))<0.01)
           || presets.find(t=>t.boatModel===q.project.boatModel);
    if(m) selId = m.id;
  }
  let html = presets.map(t=>`<option value="${escH(t.id)}" ${t.id===selId?'selected':''}>${escH(boatPresetLabel(t))}</option>`).join('');
  const nameOnly = LEGACY_BOAT_MODELS.filter(n=>!names.has(n));
  if(!selId && q.project.boatModel && !names.has(q.project.boatModel) && !nameOnly.includes(q.project.boatModel)) nameOnly.push(q.project.boatModel);
  html += nameOnly.map(n=>`<option value="m:${escH(n)}" ${(!selId && q.project.boatModel===n)?'selected':''}>${escH(n)}</option>`).join('');
  return html;
}
const BOAT_APPLICATIONS = ['Passenger Boat','Ferry','Fishing Boat','Patrol Boat','Sea Ambulance','Fire Boat','Rescue Boat','Utility Boat','Research Vessel','Dive Boat','Pleasure/Leisure','Cargo/Utility Boat','Other'];
const ENGINE_INCLUSIONS_CATALOG = ['Remote Control box with wiring harness (Dual Top mount)','Dual Panel switch','Gauge Kit - Multifunction Digital Tachometer/Speedometer','Battery Cable','Yamaha Primer Bulb','Stainless Propeller','Complete Dometic Hydraulic Steering & Control System',"Engine Owner's Manual"];

/* ============================================================
   ROUTER / NAV
   ============================================================ */
const ROUTES = [
  {id:'dashboard', label:'Dashboard', icon:'grid'},
  {id:'quotes', label:'Quotations', icon:'list'},
  {id:'sales', label:'Sales Tracker', icon:'chart', hidden:true},   // hidden for now (see HIDE_SALES_TRACKER)
  {id:'customers', label:'Customers', icon:'user'},
  {id:'templates', label:'Presets', icon:'ship', adminOnly:true},
  {id:'pricing', label:'Pricing Database', icon:'db', adminOnly:true},
  {id:'profile', label:'My Profile', icon:'user'},
  {id:'settings', label:'Settings', icon:'settings', adminOnly:true},
];
const HIDE_SALES_TRACKER = true;   // Sales Tracker is hidden for now: set to false (and remove hidden:true above) to bring it back
let CURRENT = { view:'dashboard', quoteId:null, tab:'client' };

function icon(name){
  const p = {
    grid:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    list:'<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    ship:'<path d="M2 21c1.6 1.2 3.5 1.2 5 0 1.6 1.2 3.5 1.2 5 0 1.6 1.2 3.5 1.2 5 0"/><path d="M4 17l1-8h6l1 8"/><path d="M11 9V4h3l3 5"/>',
    db:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chart:'<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="11" width="3" height="9"/><rect x="11" y="5" width="3" height="15"/><rect x="16" y="14" width="3" height="6"/>',
    search:'<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  }[name]||'';
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

function renderNav(){
  const nav = document.getElementById('navList');
  const visibleRoutes = ROUTES.filter(r=>!(r.hidden && HIDE_SALES_TRACKER));
  nav.innerHTML = visibleRoutes.map((r,i)=>`
    <div class="nav-item ${CURRENT.view===r.id?'active':''}" data-route="${r.id}">
      ${icon(r.icon)}<span>${r.label}</span>
    </div>`).join('');
  nav.querySelectorAll('.nav-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      const route = el.dataset.route;
      if(route==='editor'){ openEditor(null); }
      else { CURRENT.view = route; renderAll(); }
      closeSidebar();
    });
  });
}

function openSidebar(){
  document.querySelector('.sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
}
function closeSidebar(){
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}
document.getElementById('menuBtn').addEventListener('click', ()=>{
  const sb = document.querySelector('.sidebar');
  sb.classList.contains('open') ? closeSidebar() : openSidebar();
});
document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);

function renderAll(){
  if(HIDE_SALES_TRACKER && CURRENT.view==='sales') CURRENT.view = 'dashboard';
  renderNav();
  const titleMap = {dashboard:'Dashboard', editor:'Quotation Editor', quotes:'Quotations', sales:'Sales Tracker', customers:'Customer Database', templates:'Presets', pricing:'Pricing Database', profile:'My Profile', settings:'Settings'};
  document.getElementById('topbarTitle').textContent = titleMap[CURRENT.view] || '';
  const content = document.getElementById('content');
  const actions = document.getElementById('topbarActions');
  actions.innerHTML='';
  if(ADMIN_ONLY_VIEWS.includes(CURRENT.view) && !hasAccess(CURRENT.view)){ renderAccessRestricted(content, actions); return; }
  if(CURRENT.view==='dashboard') renderDashboard(content, actions);
  else if(CURRENT.view==='editor') renderEditor(content, actions);
  else if(CURRENT.view==='quotes') renderQuotesList(content, actions);
  else if(CURRENT.view==='sales') renderSales(content, actions);
  else if(CURRENT.view==='customers') renderCustomers(content, actions);
  else if(CURRENT.view==='templates') renderTemplates(content, actions);
  else if(CURRENT.view==='pricing') renderPricing(content, actions);
  else if(CURRENT.view==='profile') renderMyProfile(content, actions);
  else if(CURRENT.view==='settings') renderSettings(content, actions);
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnNewQ">${icon('plus')} New Quotation</button>`;
  const totalVal = QUOTES.reduce((s,q)=>s+computeAll(q).finalTotal,0);
  const approved = QUOTES.filter(q=>q.status==='approved').length;
  const avg = QUOTES.length? totalVal/QUOTES.length : 0;
  const recent = [...QUOTES].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,6);
  const myEmail = (CURRENT_USER.email||'').toLowerCase();
  const needsRevision = QUOTES.filter(q=>q.createdByEmail===myEmail && q.status==='for_revision' && q.revisionChildId);
  const pendingCount = QUOTES.filter(q=>q.status==='for_approval').length;
  const mix = ['draft','for_approval','for_revision','approved'].map(key=>{
    const list = QUOTES.filter(q=>q.status===key);
    return { key, label: statusLabel(key), n: list.length, v: list.reduce((sum,q)=>sum+computeAll(q).finalTotal,0) };
  });

  content.innerHTML = `
    ${needsRevision.length ? `
    <div class="card" style="border:1px solid var(--danger);background:var(--danger-soft);margin-bottom:16px;">
      <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div>
          <div style="font-weight:700;color:var(--danger);font-size:13px;margin-bottom:2px;">⚠ ${needsRevision.length} quotation${needsRevision.length>1?'s':''} sent back for revision</div>
          <div class="hint" style="color:var(--danger);">${needsRevision.map(q=>esc(q.refNo)).join(', ')} — an editable copy has been created for each.</div>
        </div>
        <button class="btn btn-sm" id="btnViewRevisions">Review Now</button>
      </div>
    </div>` : ``}
    <div class="stat-row">
      <div class="stat">
        <span class="ico">${icon('list')}</span>
        <div class="txt"><div class="val">${QUOTES.length}${pendingCount?`<span class="chip y">${pendingCount} awaiting approval</span>`:''}</div><div class="lbl">Total quotations</div></div>
      </div>
      <div class="stat">
        <span class="ico">${icon('db')}</span>
        <div class="txt"><div class="val">${fmt(totalVal)}</div><div class="lbl">Total quoted value</div></div>
      </div>
      <div class="stat">
        <span class="ico">${icon('grid')}</span>
        <div class="txt"><div class="val">${fmt(avg)}</div><div class="lbl">Average quotation</div></div>
      </div>
      <div class="stat">
        <span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        <div class="txt"><div class="val">${approved}${QUOTES.length?`<span class="chip">${Math.round(approved/QUOTES.length*100)}% approved</span>`:''}</div><div class="lbl">Approved quotations</div></div>
      </div>
    </div>
    <div class="dash-grid">
      <div class="card">
        <div class="card-head"><h3>Recent quotations</h3><span class="btn btn-ghost btn-sm" id="viewAllQ">View all</span></div>
        ${recent.length ? `<div class="qcards">
          ${recent.map(q=>{
            const t = computeAll(q).finalTotal;
            return `<button type="button" class="qcard ${q.status}" data-open="${q.id}">
              <div class="q-top"><span>${esc(q.refNo)}</span><span>${esc(q.date||'')}</span></div>
              <div class="q-name">${esc(q.project.boatModel||q.hull.boatType)} · ${q.hull.loa||0}ft</div>
              <div class="q-client">${esc(customerDisplayName(q.customerSnap))||'No client yet'}</div>
              <div class="q-amt">${fmt(t)}</div>
              <div class="q-state">${statusLabel(q.status)}</div>
            </button>`;
          }).join('')}
        </div>` : `<div class="empty">No quotations yet. Create your first one to see it here.</div>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div class="card">
          <div class="card-head"><h3>Status mix</h3><span class="hint" style="margin:0;">${fmt(totalVal)} quoted</span></div>
          ${QUOTES.length ? `<div class="mixbar">${mix.filter(m=>m.n).map(m=>`<span class="${m.key}" style="flex:${m.n};" title="${m.label}: ${m.n}"></span>`).join('')}</div>` : ``}
          <div class="mixlist">
            ${mix.map(m=>`<div class="mixrow"><i class="${m.key}"></i><span>${m.label}</span><span class="n">${m.n}</span><span class="v">${fmt(m.v)}</span></div>`).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Quick actions</h3></div>
          <div class="quick">
            <button class="btn" id="qaTemplates">${icon('ship')} View presets</button>
            <button class="btn" id="qaCustomer">${icon('user')} Add a customer</button>
            <button class="btn" id="qaPricing">${icon('db')} Update pricing database</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('btnNewQ').onclick = ()=>openEditor(null);
  document.getElementById('viewAllQ').onclick = ()=>{CURRENT.view='quotes'; renderAll();};
  const viewRevBtn = document.getElementById('btnViewRevisions');
  if(viewRevBtn) viewRevBtn.onclick = ()=>{ openEditor(needsRevision[0].revisionChildId); };
  document.getElementById('qaTemplates').onclick = ()=>{CURRENT.view='templates'; renderAll();};
  document.getElementById('qaCustomer').onclick = ()=>{CURRENT.view='customers'; renderAll();};
  document.getElementById('qaPricing').onclick = ()=>{CURRENT.view='pricing'; renderAll();};
  content.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openEditor(b.dataset.open));
}

/* ============================================================
   QUOTATIONS LIST
   ============================================================ */
function renderQuotesList(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnNewQ2">${icon('plus')} New Quotation</button>`;
  const pendingApproval = CURRENT_IS_ADMIN ? QUOTES.filter(q=>q.status==='for_approval').sort((a,b)=>(a.refNo||'').localeCompare(b.refNo||'', undefined, {numeric:true})) : [];
  content.innerHTML = `
    <div class="pill-row" style="align-items:center;">
      <div class="search"><span>${icon('search')}</span><input id="qSearch" placeholder="Search by ref no., client, boat type, prepared by…" style="width:280px;padding:8px 10px 8px 30px;border:1px solid var(--paper-line);border-radius:7px;"></div>
      <select id="qFilterStatus" style="padding:8px 10px;border:1px solid var(--paper-line);border-radius:7px;">
        <option value="">All statuses</option>
        <option value="draft">Draft</option>
        <option value="for_approval">For Approval</option>
        <option value="for_revision">For Revision</option>
        <option value="approved">Approved</option>
      </select>
      ${CURRENT_IS_ADMIN ? `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${pendingApproval.length?'var(--green)':'var(--ink-faint)'};">${pendingApproval.length ? `Awaiting Your Approval:` : `Nothing awaiting approval`}</span>
        ${pendingApproval.map(q=>`<span class="btn btn-sm" data-open="${q.id}" style="background:var(--teal-soft);color:var(--green);border-color:var(--teal-soft);">${esc(q.refNo)}</span>`).join('')}
      </div>` : ``}
    </div>
    <div class="card"><div class="card-body" style="padding:0;" id="qTableWrap"></div></div>
  `;
  document.getElementById('btnNewQ2').onclick = ()=>openEditor(null);
  content.querySelectorAll('.pill-row [data-open]').forEach(b=>b.onclick=()=>openEditor(b.dataset.open));
  const wrap = document.getElementById('qTableWrap');
  function draw(){
    const term = document.getElementById('qSearch').value.toLowerCase();
    const st = document.getElementById('qFilterStatus').value;
    let rows = [...QUOTES].sort((a,b)=>(a.refNo||'').localeCompare(b.refNo||'', undefined, {numeric:true})).filter(q=>{
      const preparer = profileByEmail(q.createdByEmail);
      const hay = (q.refNo+' '+customerDisplayName(q.customerSnap)+' '+(q.customerSnap.clientName||'')+' '+q.hull.boatType+' '+(q.project.boatModel||'')+' '+(q.project.boatApplication||'')+' '+(q.createdByEmail||'')+' '+((preparer&&preparer.full_name)||'')).toLowerCase();
      return hay.includes(term) && (!st || q.status===st);
    });
    wrap.innerHTML = rows.length? `<table><thead><tr><th>Ref No.</th><th>Date</th><th>Client</th><th>Boat</th><th>Prepared By</th><th class="right">Total</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(q=>{
        const t = computeAll(q).finalTotal;
        const preparer = profileByEmail(q.createdByEmail);
        const preparerLabel = (preparer && preparer.full_name) || q.createdByEmail || '—';
        return `<tr>
          <td class="mono">${isDuplicateRefNo(q.refNo, q.id) ? `<span style="color:var(--danger);border:1.5px solid var(--danger);border-radius:5px;padding:2px 7px;display:inline-block;">${q.refNo}</span>` : q.refNo}${q.revisionChildId? `<br><span class="btn btn-ghost btn-sm" data-open="${q.revisionChildId}" style="margin-top:2px;">→ Open Revision</span>` : ``}</td>
          <td class="mono">${q.date}</td>
          <td>${esc(customerDisplayName(q.customerSnap))||'—'}</td>
          <td>${esc(q.project.boatModel||q.hull.boatType)} · ${q.hull.loa||0}ft</td>
          <td>${esc(preparerLabel)}</td>
          <td class="right mono">${fmt(t)}</td>
          <td><span class="badge ${q.status}">${statusLabel(q.status)}</span></td>
          <td class="right" style="white-space:nowrap;">
            <span class="btn btn-ghost btn-sm" data-open="${q.id}">Open</span>
            <span class="btn btn-ghost btn-sm" data-dup="${q.id}">Duplicate</span>
            <span class="btn btn-ghost btn-sm" data-del="${q.id}" style="color:var(--danger);">Delete</span>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table>` : `<div class="empty">No quotations match your search.</div>`;
    wrap.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openEditor(b.dataset.open));
    wrap.querySelectorAll('[data-dup]').forEach(b=>b.onclick=()=>{
      const src = QUOTES.find(x=>x.id===b.dataset.dup);
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid('q'); copy.refNo = nextRefNo()+'A'; copy.status='draft'; copy.date=todayISO();
      copy.createdAt = Date.now(); copy.updatedAt = Date.now();
      QUOTES.push(copy); save(DB_KEYS.quotes, QUOTES); toast('Quotation duplicated'); draw();
    });
    wrap.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      if(confirm('Delete this quotation? This cannot be undone.')){
        QUOTES = QUOTES.filter(x=>x.id!==b.dataset.del); save(DB_KEYS.quotes, QUOTES); toast('Quotation deleted'); draw();
      }
    });
  }
  document.getElementById('qSearch').oninput = draw;
  document.getElementById('qFilterStatus').onchange = draw;
  draw();
}

/* ============================================================
   CUSTOMERS
   ============================================================ */
function renderCustomers(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnAddCust">${icon('plus')} Add Customer</button>`;
  content.innerHTML = `<div class="section-lead">Client's Representative is the point-of-contact person at the client's company — this auto-fills into a quotation's "Client's Representative" fields when you load this customer.</div><div class="card"><div class="card-body" style="padding:0;" id="custWrap"></div></div>`;
  document.getElementById('btnAddCust').onclick = ()=>{
    CUSTOMERS.push({id:uid('c'), name:'New Customer', email:'', contact:'', address:'', repName:'', repPosition:'', repContact:'', repEmail:''});
    save(DB_KEYS.customers, CUSTOMERS); draw();
  };
  const wrap = document.getElementById('custWrap');

function draw() {
  wrap.innerHTML = CUSTOMERS.length
    ? `<table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Contact No.</th>
            <th>Address</th>
            <th colspan="4" style="text-align:center;border-left:1px solid var(--paper-line);">Client's Representative</th>
            <th></th>
          </tr>
          <tr>
            <th></th><th></th><th></th><th></th>
            <th style="border-left:1px solid var(--paper-line);font-weight:600;">Name</th>
            <th style="font-weight:600;">Position</th>
            <th style="font-weight:600;">Contact No.</th>
            <th style="font-weight:600;">Email</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${CUSTOMERS.map(c => `
            <tr>
              <td><input class="tbl-input" data-f="name" data-id="${c.id}" value="${esc(c.name)}"></td>
              <td><input class="tbl-input" data-f="email" data-id="${c.id}" value="${esc(c.email)}"></td>
              <td><input class="tbl-input" data-f="contact" data-id="${c.id}" value="${esc(c.contact)}"></td>
              <td>
  <textarea class="tbl-input" data-f="address" data-id="${c.id}" rows="2">${
    esc(
      (() => {
        const p = c.address.split(", ");
        return `${p[0]}, ${p[1]}\n${p.slice(2).join(", ")}`;
      })()
    )
  }</textarea>
</td>
              <td style="border-left:1px solid var(--paper-line);"><input class="tbl-input" data-f="repName" data-id="${c.id}" value="${esc(c.repName||'')}"></td>
              <td><input class="tbl-input" data-f="repPosition" data-id="${c.id}" value="${esc(c.repPosition||'')}"></td>
              <td><input class="tbl-input" data-f="repContact" data-id="${c.id}" value="${esc(c.repContact||'')}"></td>
              <td><input class="tbl-input" data-f="repEmail" data-id="${c.id}" value="${esc(c.repEmail||'')}"></td>
              <td class="right">
                <span class="btn btn-ghost btn-sm" data-del="${c.id}" style="color:var(--danger);">Remove</span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`
    : `<div class="empty">No customers yet. Add one to reuse across quotations.</div>`;

  wrap.querySelectorAll('input, textarea').forEach(field => {
    field.onchange = () => {
      const c = CUSTOMERS.find(x => x.id === field.dataset.id);
      c[field.dataset.f] = field.value;
      save(DB_KEYS.customers, CUSTOMERS);
      toast('Saved');
    };
  });

  wrap.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = () => {
      CUSTOMERS = CUSTOMERS.filter(x => x.id !== btn.dataset.del);
      save(DB_KEYS.customers, CUSTOMERS);
      draw();
    };
  });
}

draw();
}
function esc(s){ return (s||'').toString().replace(/"/g,'&quot;'); }
function escNl(s){ return esc(s).split('\n').map(l=>l.trim()).filter(Boolean).join('<br>'); }
// Splits an address into exactly two lines, breaking at the comma nearest
// the midpoint — more reliable than hoping the column width happens to wrap
// it onto two lines naturally.
function splitAddressTwoLines(addr){
  addr = (addr||'').trim();
  if(!addr) return '';
  const parts = addr.split(',').map(s=>s.trim()).filter(Boolean);
  if(parts.length<=1) return esc(addr);
  const mid = Math.ceil(parts.length/2);
  const line1 = parts.slice(0,mid).join(', ');
  const line2 = parts.slice(mid).join(', ');
  return `${esc(line1)}<br>${esc(line2)}`;
}

/* ============================================================
   BOAT PRESETS
   ============================================================ */
let _presetOpenModel = null;
const _collapsedWork = new WeakSet();   // preset components / the hull that are currently minimised
function chevronIcon(collapsed){
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transition:transform .15s;transform:rotate(${collapsed?-90:0}deg);display:block;"><polyline points="6 9 12 15 18 9"/></svg>`;
}
function workSummaryHTML(w){
  const heads = laborTeamsOf(w).reduce((sum,t)=>sum+(Number(t.laborers)||0),0), mats = (w.materials||[]).length;
  return `Labor <b class="mono">${fmt(computeLaborCost(w))}</b> · Materials <b class="mono">${fmt(materialLinesCost(w))}</b> · Total <b class="mono">${fmt(computeFormulaWorkCost(w))}</b> <span style="color:var(--ink-faint);">(${heads} laborer${heads===1?'':'s'}, ${mats} material${mats===1?'':'s'})</span>`;
}
let _presetKind = 'boat';      // which tab of the Presets page is showing
let _presetOpenId = null;      // open Transom / Console / Deck preset (by id)
const PRESET_KINDS = {
  boat:    { label:'Boat Models' },
  transom: { label:'Transom',               singular:'Transom',               defaultCat:'Transom', single:true  },
  console: { label:'Console',               singular:'Console',               defaultCat:'Console', single:true  },
  deck:    { label:'Deck & Superstructure', singular:'Deck / Superstructure', defaultCat:'Deck',    single:false }
};
/* Labor panel shared by the Hull, structural components and the Transom / Console / Deck presets. */
function laborPanelHTML(c, owner){
  ensureLaborTeams(c);
  const names = laborCategoryNames();
  const heads = c.laborTeams.reduce((sum,t)=>sum+(Number(t.laborers)||0),0);
  const teamCost = tm => (Number(tm.rate)||0)*(Number(tm.laborers)||0)*(Number(tm.days)||0);
  const rows = c.laborTeams.map((tm,ti)=>{
    const cur = String(tm.cat||'').toLowerCase();
    const known = names.some(n=>n.toLowerCase()===cur);
    const opts = (tm.cat ? '' : '<option value="">— choose category —</option>')
      + (tm.cat && !known ? `<option value="${esc(tm.cat)}" selected>${esc(tm.cat)} (not in Pricing Database)</option>` : '')
      + names.map(n=>`<option value="${esc(n)}" ${n.toLowerCase()===cur?'selected':''}>${esc(capFirst(n))}</option>`).join('');
    return `<tr>
      <td><select class="tbl-input lp-cat" data-lp="${owner}" data-t="${ti}">${opts}</select></td>
      <td style="width:92px;"><input class="tbl-input num lp-num" type="number" min="0" step="1" data-lp="${owner}" data-t="${ti}" data-f="laborers" value="${Number(tm.laborers)||0}"></td>
      <td style="width:92px;"><input class="tbl-input num lp-num" type="number" min="0" step="any" data-lp="${owner}" data-t="${ti}" data-f="days" value="${Number(tm.days)||0}"></td>
      <td style="width:128px;"><input class="tbl-input num lp-num" type="number" min="0" step="any" data-lp="${owner}" data-t="${ti}" data-f="rate" value="${Number(tm.rate)||0}"></td>
      <td class="right mono" style="width:120px;" id="lpCost_${owner}_${ti}">${fmt(teamCost(tm))}</td>
      <td class="right" style="width:40px;"><span class="btn btn-ghost btn-sm" data-lp-del="${owner}:${ti}" style="color:var(--danger);" title="Remove this labor category">✕</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="empty" style="padding:12px;">No laborers yet — add a labor category (for example Carpentry or Fiberglass), then set how many laborers it needs and for how many days.</td></tr>`;
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:4px 0;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-soft);">Labor <span style="text-transform:none;letter-spacing:0;font-weight:500;">· <span id="lpHeads_${owner}">${heads}</span> laborer${heads===1?'':'s'} in total</span></div>
      <button type="button" class="btn btn-sm" data-lp-add="${owner}">${icon('plus')} Add laborers</button>
    </div>
    <table class="mat-table"><thead><tr><th>Labor category</th><th class="right">Laborers</th><th class="right">Days</th><th class="right">Rate (₱/day/person)</th><th class="right">Cost</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function teamsPanelHTML(c, owner, matRowFn){
  ensureTeamMaterials(c);
  const names = laborCategoryNames();
  const heads = c.laborTeams.reduce((sum,t)=>sum+(Number(t.laborers)||0),0);
  const blocks = c.laborTeams.map((tm,ti)=>{
    const cur = String(tm.cat||'').toLowerCase();
    const known = names.some(n=>n.toLowerCase()===cur);
    const opts = (tm.cat ? '' : '<option value="">— choose labor category —</option>')
      + (tm.cat && !known ? `<option value="${esc(tm.cat)}" selected>${esc(tm.cat)} (not in Pricing Database)</option>` : '')
      + names.map(n=>`<option value="${esc(n)}" ${n.toLowerCase()===cur?'selected':''}>${esc(capFirst(n))}</option>`).join('');
    const mats = (c.materials||[]).map((m,mi)=>({m,mi})).filter(x=>x.m.teamId===tm.id);
    const tc = teamCostOf(c, tm);
    return `<div class="team-block" style="border:1px solid var(--paper-line);border-radius:10px;padding:10px 12px;margin:10px 0;background:var(--card, #fff);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <div style="font-size:12px;font-weight:700;color:var(--ink);">${esc(tm.cat ? capFirst(tm.cat)+' Team' : 'Team '+(ti+1))}</div>
        <span class="btn btn-ghost btn-sm" data-lp-del="${owner}:${ti}" style="color:var(--danger);" title="Remove this team and its materials">Remove team</span>
      </div>
      <table class="mat-table"><thead><tr><th>Labor category</th><th class="right">Laborers</th><th class="right">Days</th><th class="right">Rate (₱/day/person)</th><th class="right">Labor cost</th></tr></thead>
        <tbody><tr>
          <td><select class="tbl-input lp-cat" data-lp="${owner}" data-t="${ti}">${opts}</select></td>
          <td style="width:92px;"><input class="tbl-input num lp-num" type="number" min="0" step="1" data-lp="${owner}" data-t="${ti}" data-f="laborers" value="${Number(tm.laborers)||0}"></td>
          <td style="width:92px;"><input class="tbl-input num lp-num" type="number" min="0" step="any" data-lp="${owner}" data-t="${ti}" data-f="days" value="${Number(tm.days)||0}"></td>
          <td style="width:128px;"><input class="tbl-input num lp-num" type="number" min="0" step="any" data-lp="${owner}" data-t="${ti}" data-f="rate" value="${Number(tm.rate)||0}"></td>
          <td class="right mono" style="width:120px;" id="lpCost_${owner}_${ti}">${fmt(tc.labor)}</td>
        </tr></tbody></table>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:12px 0 4px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-soft);">Materials used by this team</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm mat-pick" data-idx="${owner}" data-team="${esc(tm.id)}">${icon('plus')} Choose materials${mats.length?` (${mats.length})`:''}</button>
          <button type="button" class="btn btn-ghost btn-sm mat-custom" data-idx="${owner}" data-team="${esc(tm.id)}">${icon('plus')} Custom material</button>
        </div>
      </div>
      <table class="mat-table"><thead><tr><th>Material</th><th>Unit</th><th class="right">Qty</th><th class="right">Price / unit (₱)</th><th class="right">Cost</th><th></th></tr></thead>
        <tbody>${mats.map(x=>matRowFn(x.m,x.mi)).join('') || `<tr><td colspan="6" class="empty" style="padding:10px;">No materials yet for this team.</td></tr>`}</tbody></table>
      <div class="hint" style="margin-top:8px;font-weight:600;color:var(--ink);">Team total: Labor <span class="mono" id="teamLab_${owner}_${ti}">${fmt(tc.labor)}</span> + Materials <span class="mono" id="teamMat_${owner}_${ti}">${fmt(tc.mats)}</span> = <span class="mono" id="teamTot_${owner}_${ti}">${fmt(tc.total)}</span></div>
    </div>`;
  }).join('') || `<div class="empty" style="padding:12px;">No teams yet — add a team (for example Fiberglass or Carpentry), set its laborers, days and rate, then choose the materials it uses.</div>`;
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:4px 0;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-soft);">Teams <span style="text-transform:none;letter-spacing:0;font-weight:500;">· <span id="lpHeads_${owner}">${heads}</span> laborer${heads===1?'':'s'} in total</span></div>
      <button type="button" class="btn btn-sm" data-lp-add="${owner}">${icon('plus')} Add team</button>
    </div>${blocks}`;
}
function bindLaborPanel(root, c, owner, onTotals, redraw){
  ensureLaborTeams(c);
  const refresh = ()=>{
    c.laborTeams.forEach((tm,ti)=>{
      const tc = teamCostOf(c, tm), set = (id,v)=>{ const el=root.querySelector(`#${id}_${owner}_${ti}`) || document.getElementById(`${id}_${owner}_${ti}`); if(el) el.textContent = fmt(v); };
      set('lpCost', tc.labor); set('teamLab', tc.labor); set('teamMat', tc.mats); set('teamTot', tc.total);
    });
    const h = root.querySelector(`#lpHeads_${owner}`) || document.getElementById(`lpHeads_${owner}`); if(h) h.textContent = c.laborTeams.reduce((sum,tm)=>sum+(Number(tm.laborers)||0),0);
    onTotals();
  };
  root.querySelectorAll(`.lp-num[data-lp="${owner}"]`).forEach(inp=>inp.addEventListener('input', ()=>{ c.laborTeams[Number(inp.dataset.t)][inp.dataset.f] = Math.max(0, Number(inp.value)||0); refresh(); }));
  root.querySelectorAll(`.lp-cat[data-lp="${owner}"]`).forEach(sel=>sel.onchange = ()=>{
    const tm = c.laborTeams[Number(sel.dataset.t)]; tm.cat = sel.value; tm.rate = laborRateFor(sel.value); redraw();
  });
  root.querySelectorAll(`[data-lp-del^="${owner}:"]`).forEach(b=>b.onclick = ()=>{
    const ti = Number(b.dataset.lpDel.split(':')[1]), tm = c.laborTeams[ti];
    const n = tm ? teamMaterialsOf(c, tm).length : 0;
    if(n && !confirm(`Remove this team and its ${n} material${n===1?'':'s'}?`)) return;
    if(tm) c.materials = (c.materials||[]).filter(m=>m.teamId!==tm.id);
    c.laborTeams.splice(ti,1); redraw();
  });
  root.querySelectorAll(`[data-lp-add="${owner}"]`).forEach(b=>b.onclick = ()=>{
    const used = new Set(c.laborTeams.map(t=>String(t.cat||'').toLowerCase()));
    const names = laborCategoryNames();
    const pick = names.find(n=>!used.has(n.toLowerCase())) || names[0] || '';
    const last = c.laborTeams[c.laborTeams.length-1];
    c.laborTeams.push({id:uid('tm'), cat:pick, laborers:1, days: last ? (Number(last.days)||0) : 0, rate:laborRateFor(pick)});
    redraw();
  });
}
function mergeAddonComponents(t, defaultCat){
  const comps = t.components || [];
  const clone = x=>JSON.parse(JSON.stringify(x));
  const one = { cat: (comps[0] && comps[0].cat) || defaultCat || '', useFormula:true, numberDays:0, laborTeams:[], materials:[] };
  comps.forEach(c=>{ migratePresetComponent(c); ensureTeamMaterials(c); one.laborTeams.push(...clone(c.laborTeams||[])); one.materials.push(...clone(c.materials||[])); });
  t.components = [one];
}
function addonPresets(kind){
  return (TEMPLATES||[]).filter(t=>t.presetType===kind).sort((a,b)=>(Number.isFinite(a.order)?a.order:1e9)-(Number.isFinite(b.order)?b.order:1e9));
}
function presetTotalCost(p){
  return (p.components||[]).reduce((sum,c)=>{ migratePresetComponent(c); return sum + computeFormulaWorkCost(c); }, 0);
}
// Transom / Console / Deck presets become tagged lines on the quotation's structural list.
function addonPresetToQuoteItems(p){
  return presetToQuoteItems(p, p.name).map(it=>{
    it.presetType = p.presetType; it.presetId = p.id; it.presetName = p.name;
    return it;
  });
}

function renderTemplates(content, actions){
  if(!PRESET_KINDS[_presetKind]) _presetKind = 'boat';
  const kind = _presetKind, meta = PRESET_KINDS[kind];
  actions.innerHTML = `<button class="btn btn-primary" id="btnSaveTemplates">Save Presets</button> <button class="btn" id="btnAddModel">${icon('plus')} ${kind==='boat' ? 'Add Boat Model' : 'Add '+esc(meta.singular)+' Preset'}</button>`;
  const leads = {
    boat: `Click a Boat Model's card to open and edit its standard measurements, structural components, and painting components. Drag a card by its ⠿ handle to rearrange the order. Selecting that model in a quotation's Hull Particulars tab automatically fills in these details. Edits here are staged until you click "Save Presets" — same as the Pricing Database.`,
    transom: `Standard transoms (for example a single-engine or twin-engine transom). Each preset is one set of labor teams and materials. In a quotation's Hull tab, pick one under "Transom, Console & Deck Presets" and its cost is added to the structural list.`,
    console: `Standard consoles (for example a center console or a side console). Each preset is one set of labor teams and materials. In a quotation's Hull tab, pick one under "Transom, Console & Deck Presets" and its cost is added to the structural list.`,
    deck: `Deck and superstructure work such as a canopy, cabin or wheelhouse. Make one preset per item. In a quotation's Hull tab you can add as many as you need under "Transom, Console & Deck Presets", and each one's cost is added to the structural list.`
  };
  content.innerHTML = `<div class="tabs" id="presetKinds">${Object.keys(PRESET_KINDS).map(k=>`<div class="tab ${k===kind?'active':''}" data-kind="${k}">${esc(PRESET_KINDS[k].label)}</div>`).join('')}</div>
  <div class="section-lead">${leads[kind]}</div>
  <div id="presetGrid"></div>`;
  content.querySelectorAll('#presetKinds .tab').forEach(el=>el.onclick=()=>{ _presetKind = el.dataset.kind; _presetOpenModel = null; _presetOpenId = null; renderTemplates(content, actions); });
  const grid = document.getElementById('presetGrid');

  document.getElementById('btnSaveTemplates').onclick = ()=>{
    save(DB_KEYS.templates, TEMPLATES); toast('Presets saved');
  };
  document.getElementById('btnAddModel').onclick = ()=>{
    if(kind!=='boat'){
      const nm = (prompt(`Name the new ${meta.singular} preset:`)||'').trim();
      if(!nm) return;
      if(addonPresets(kind).some(p=>(p.name||'').toLowerCase()===nm.toLowerCase())){ toast('A preset with that name already exists'); return; }
      const p = { id:uid('tpl'), presetType:kind, name:nm, components:[], order:addonPresets(kind).length };
      TEMPLATES.push(p); _presetOpenId = p.id; draw(); return;
    }
    const name = prompt('Name the new Boat Model:');
    if(name===null) return;
    const trimmed = name.trim();
    if(!trimmed) return;
    const loaIn = prompt('LOA (ft) of this model — the same name can be used again if the LOA is different:', '');
    if(loaIn===null) return;
    const loa = Number(loaIn)||0;
    if(TEMPLATES.some(t=>isBoatPreset(t) && t.boatModel.toLowerCase()===trimmed.toLowerCase() && (Number(t.loa)||0)===loa)){ toast('A Boat Model with that name and LOA already exists'); return; }
    const np = blankPreset(trimmed); np.loa = loa;
    TEMPLATES.push(np);
    _presetOpenModel = np.id;
    draw();
  };

  function blankPreset(model){
    return { id:uid('tpl'), name:model, boatModel:model, boatType:'Passenger Boat',
      loa:0, beam:0, depth:0, numHulls:1, components:[] };
  }
  function getPreset(id){ return TEMPLATES.find(x=>x.id===id); }

  function draw(){
    if(kind!=='boat'){ drawAddon(); return; }
    // Every default model name keeps at least one preset; the same name can repeat (different LOA).
    LEGACY_BOAT_MODELS.forEach(n=>{ if(!TEMPLATES.some(t=>isBoatPreset(t) && t.boatModel===n)) TEMPLATES.push(blankPreset(n)); });
    const models = TEMPLATES.filter(isBoatPreset);
    if(_presetOpenModel && !models.some(t=>t.id===_presetOpenModel)) _presetOpenModel = null;

    // Every displayed model needs a real preset object (auto-created by
    // getPreset), and every preset needs an `order` number so card position
    // is stable and can be rearranged by drag-and-drop, persisting the same
    // way as any other preset edit (staged until "Save Presets").
    let maxOrder = Math.max(-1, ...TEMPLATES.map(t=>Number.isFinite(t.order)?t.order:-1));
    TEMPLATES.forEach(t=>{ if(!Number.isFinite(t.order)){ maxOrder++; t.order = maxOrder; } });
    const orderedModels = [...models].sort((a,b)=> a.order - b.order);

    if(!_presetOpenModel){
      drawPreviewGrid(orderedModels);
    } else {
      drawDetail(_presetOpenModel);
    }
  }

  function drawPreviewGrid(models){
    grid.innerHTML = `<div class="grid g4" id="previewCardsWrap">${models.map(t=>{
      return `
      <div class="card preset-preview-card" draggable="true" data-openmodel="${esc(t.id)}" style="cursor:pointer;transition:box-shadow .15s, transform .15s, opacity .15s;position:relative;">
        <div class="card-body" style="padding-top:26px;">
          <div class="drag-handle" title="Drag to reorder" style="position:absolute;top:8px;right:10px;cursor:grab;color:var(--ink-faint);font-size:13px;letter-spacing:2px;line-height:1;user-select:none;">⠿</div>
          <div style="font-family:'Sora',sans-serif;font-weight:700;font-size:13.5px;margin-bottom:10px;padding-right:16px;">${esc(t.boatModel)}</div>
          <div style="display:flex;gap:14px;font-size:11.5px;color:var(--ink-soft);">
            <div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint);margin-bottom:2px;">LOA</div><div style="font-weight:600;color:var(--ink);">${t.loa||0} ft</div></div>
            <div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint);margin-bottom:2px;">Beam</div><div style="font-weight:600;color:var(--ink);">${t.beam||0} ft</div></div>
            <div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint);margin-bottom:2px;">Depth</div><div style="font-weight:600;color:var(--ink);">${t.depth||0} ft</div></div>
          </div>
        </div>
      </div>`;
    }).join('')}</div>`;

    let dragModel = null;
    grid.querySelectorAll('.preset-preview-card').forEach(el=>{
      el.onmouseenter = ()=>{ if(!dragModel){ el.style.boxShadow = '0 4px 14px -4px rgba(15,23,42,.18)'; el.style.transform='translateY(-1px)'; } };
      el.onmouseleave = ()=>{ el.style.boxShadow=''; el.style.transform=''; };
      el.onclick = ()=>{ if(dragModel) return; _presetOpenModel = el.dataset.openmodel; draw(); };

      el.addEventListener('dragstart', e=>{
        dragModel = el.dataset.openmodel;
        el.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragModel);
      });
      el.addEventListener('dragend', ()=>{
        el.style.opacity = '';
        grid.querySelectorAll('.preset-preview-card').forEach(c=>c.style.outline='');
        dragModel = null;
      });
      el.addEventListener('dragover', e=>{
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if(el.dataset.openmodel!==dragModel) el.style.outline = '2px solid var(--teal)';
      });
      el.addEventListener('dragleave', ()=>{ el.style.outline = ''; });
      el.addEventListener('drop', e=>{
        e.preventDefault();
        el.style.outline = '';
        const droppedOn = el.dataset.openmodel;
        const dragged = e.dataTransfer.getData('text/plain') || dragModel;
        if(!dragged || dragged===droppedOn) return;
        // Reorder: pull the dragged model out and insert it right before the
        // card it was dropped on, then reassign sequential order values to
        // every preset so this new arrangement is what gets saved.
        const arr = models.map(x=>x.id);
        const fromIdx = arr.indexOf(dragged);
        const toIdx = arr.indexOf(droppedOn);
        if(fromIdx===-1 || toIdx===-1) return;
        arr.splice(fromIdx,1);
        arr.splice(arr.indexOf(droppedOn), 0, dragged);
        arr.forEach((mm,i)=>{ getPreset(mm).order = i; });
        draw();
      });
    });
  }

  // Shared by Boat Models (structural components) and the Transom / Console / Deck presets.
  function componentEditorHTML(title, key, sfx, single){
    key = key || 'components'; sfx = sfx || '';
    return `<div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;gap:8px;flex-wrap:wrap;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-soft);">${esc(title)}</div>
            ${single ? '' : `<div style="display:flex;gap:6px;">
              <button class="btn btn-ghost btn-sm" id="btnCollapseAll${sfx}">Collapse all</button>
              <button class="btn btn-ghost btn-sm" id="btnAddComp${sfx}">${icon('plus')} Add Component</button>
            </div>`}
          </div>
          <table>${single ? '' : `<thead><tr><th>${key==='paintComponents' ? 'Category' : 'Category &nbsp;/&nbsp; Description'}</th><th style="width:90px;"></th></tr></thead>`}
          <tbody id="compRows${sfx}"></tbody></table>
          <div class="hint" style="margin-top:8px;">Formula: <em>Total Work Cost = for each labor category (Rate × Laborers × its own Days) + the cost of every material used (quantity × price per unit)</em>. ${key==='paintComponents' ? `Each painting component (for example Surface Preparation, Primer, Topcoat) becomes one line on the quotation's Paint &amp; Finish tab, named after its category.` : `Each component becomes one line on the quotation's structural list, named after its category.`}</div>`;
  }
  function initComponentEditor(t, defaultCat, key, sfx, single){
    key = key || 'components'; sfx = sfx || '';
    if(single) mergeAddonComponents(t, defaultCat);
    const body = document.getElementById('compRows'+sfx);
    function drawComponents(){
      body.innerHTML = (t[key]||[]).map((c,idx)=>{
        migratePresetComponent(c);
        ensureTeamMaterials(c);
        const cats = key==='paintComponents' ? paintCategoryList(c.cat) : presetCategoryList(c.cat);
        const matRowFn = (m,mi)=>`
          <tr>
            <td><input class="tbl-input mat-f" data-idx="${idx}" data-m="${mi}" data-f="name" value="${esc(m.name)}" placeholder="Material name"></td>
            <td style="width:76px;"><input class="tbl-input mat-f" data-idx="${idx}" data-m="${mi}" data-f="unit" value="${esc(m.unit)}"></td>
            <td style="width:86px;"><input class="tbl-input num mat-f" type="number" min="0" step="any" data-idx="${idx}" data-m="${mi}" data-f="qty" value="${Number(m.qty)||0}"></td>
            <td style="width:120px;"><input class="tbl-input num mat-f" type="number" min="0" step="any" data-idx="${idx}" data-m="${mi}" data-f="price" value="${Number(m.price)||0}"></td>
            <td class="right mono" style="width:120px;" id="matCost_${idx}_${mi}">${fmt((Number(m.qty)||0)*(Number(m.price)||0))}</td>
            <td class="right" style="width:40px;"><span class="btn btn-ghost btn-sm" data-delmat="${idx}:${mi}" style="color:var(--danger);" title="Remove material">✕</span></td>
          </tr>`;
        const collapsed = single ? false : _collapsedWork.has(c);
        return `
        ${single ? '' : `<tr>
          <td>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm comp-toggle" data-idx="${idx}" aria-expanded="${!collapsed}" title="${collapsed?'Show':'Hide'} labor and materials" style="padding:6px 8px;">${chevronIcon(collapsed)}</button>
<select class="tbl-input comp-cat" data-idx="${idx}" style="flex:1;min-width:180px;max-width:340px;">
              ${c.cat ? '' : '<option value="">— choose category —</option>'}
              ${cats.map(k=>`<option value="${esc(k)}" ${k===c.cat?'selected':''}>${esc(k)}</option>`).join('')}
              <option value="__new">+ New category…</option>
            </select>
            ${key==='paintComponents' ? '' : `<input class="tbl-input comp-desc" data-idx="${idx}" value="${esc(c.description||'')}" placeholder="Description" style="flex:2;min-width:220px;">`}
            ${collapsed ? `<span class="hint" style="margin:0;">${workSummaryHTML(c)}</span>` : ''}
            </div>
          </td>
          <td class="right"><span class="btn btn-ghost btn-sm" data-delcomp="${idx}" style="color:var(--danger);">Remove</span></td>
        </tr>`}
        ${collapsed ? '' : `<tr class="comp-formula-row" data-formula-idx="${idx}">
          <td colspan="2" style="background:var(--paper);padding:12px;">
            ${teamsPanelHTML(c, idx, matRowFn)}
            <div class="hint" style="margin-top:10px;font-weight:600;color:var(--ink);">Labor <span class="mono" id="formulaLabor_${idx}">${fmt(computeLaborCost(c))}</span> + Materials <span class="mono" id="formulaMat_${idx}">${fmt(materialLinesCost(c))}</span> = Total Work Cost <span class="mono" id="formulaTotal_${idx}">${fmt(computeFormulaWorkCost(c))}</span></div>
          </td>
        </tr>`}`;
      }).join('') || `<tr><td colspan="2" class="empty" style="padding:12px;">No components yet.</td></tr>`;
      const allBtn = document.getElementById('btnCollapseAll'+sfx);
      if(allBtn){
        const comps = t[key]||[];
        allBtn.style.display = comps.length ? '' : 'none';
        allBtn.textContent = comps.length && comps.every(c=>_collapsedWork.has(c)) ? 'Expand all' : 'Collapse all';
      }
      body.querySelectorAll('.comp-toggle').forEach(b=>b.onclick=()=>{
        const c = t[key][Number(b.dataset.idx)];
        if(_collapsedWork.has(c)) _collapsedWork.delete(c); else _collapsedWork.add(c);
        drawComponents();
      });
      body.querySelectorAll('.comp-cat').forEach(sel=>sel.onchange=()=>{
        const c = t[key][Number(sel.dataset.idx)];
        let v = sel.value;
        if(v==='__new'){
          v = (prompt('Name of the new category (for example: Fiberglass):')||'').trim();
          if(!v){ drawComponents(); return; }
        }
        c.cat = v;
        drawComponents();
      });
      body.querySelectorAll('.comp-desc').forEach(inp=>inp.addEventListener('input', ()=>{ t[key][Number(inp.dataset.idx)].description = inp.value; }));
      // Patch totals in place (no redraw) so typing never loses focus.
      function patchFormulaTotals(idx){
        const c = t[key][idx];
        const setTxt = (id,v)=>{ const el=body.querySelector('#'+id); if(el) el.textContent=v; };
        setTxt(`formulaLabor_${idx}`, fmt(computeLaborCost(c)));
        setTxt(`formulaMat_${idx}`, fmt(materialLinesCost(c)));
        setTxt(`formulaTotal_${idx}`, fmt(computeFormulaWorkCost(c)));
        (c.laborTeams||[]).forEach((tm,ti)=>{ const tc = teamCostOf(c,tm);
          setTxt(`teamLab_${idx}_${ti}`, fmt(tc.labor)); setTxt(`teamMat_${idx}_${ti}`, fmt(tc.mats)); setTxt(`teamTot_${idx}_${ti}`, fmt(tc.total)); });
      }
      (t[key]||[]).forEach((c,idx)=> bindLaborPanel(body, c, idx, ()=>patchFormulaTotals(idx), drawComponents));
      body.querySelectorAll('.mat-f').forEach(inp=>{
        inp.addEventListener('input', ()=>{
          const idx = Number(inp.dataset.idx), mi = Number(inp.dataset.m), f = inp.dataset.f;
          const m = t[key][idx].materials[mi];
          m[f] = (f==='qty'||f==='price') ? Math.max(0, Number(inp.value)||0) : inp.value;
          const cost = body.querySelector(`#matCost_${idx}_${mi}`);
          if(cost) cost.textContent = fmt((Number(m.qty)||0)*(Number(m.price)||0));
          patchFormulaTotals(idx);
        });
        inp.addEventListener('change', ()=>{
          syncMaterialLine(t[key][Number(inp.dataset.idx)].materials[Number(inp.dataset.m)]);
        });
      });
      body.querySelectorAll('.mat-pick').forEach(btn=>btn.onclick=()=>{
        const c = t[key][Number(btn.dataset.idx)], teamId = btn.dataset.team;
        const tm = c.laborTeams.find(x=>x.id===teamId);
        const selected = (c.materials||[]).filter(m=>m.teamId===teamId && m.cat && findCatalogByKey(catalogKey(m.cat,m.name))).map(m=>catalogKey(m.cat,m.name));
        openMaterialPicker({
          title: `Materials used by ${tm && tm.cat ? capFirst(tm.cat)+' Team' : 'this team'}${c.cat?` (${c.cat})`:''}`,
          subtitle: 'Tick everything this team uses. You can set quantities afterwards.',
          selected, confirmLabel: 'Apply materials',
          onConfirm: keys=>{ applyPickedMaterialsForTeam(c, teamId, keys); drawComponents(); }
        });
      });
      body.querySelectorAll('.mat-custom').forEach(b=>b.onclick=()=>{
        const c = t[key][Number(b.dataset.idx)];
        c.materials.push({cat:'', name:'', unit:'unit', qty:1, price:0, teamId:b.dataset.team});
        drawComponents();
      });
      body.querySelectorAll('[data-delmat]').forEach(b=>b.onclick=()=>{
        const [idx,mi] = b.dataset.delmat.split(':').map(Number);
        t[key][idx].materials.splice(mi,1);
        drawComponents();
      });
      body.querySelectorAll('[data-delcomp]').forEach(b=>b.onclick=()=>{
        t[key].splice(Number(b.dataset.delcomp),1); drawComponents();
      });
    }

    drawComponents();
    const _ca = document.getElementById('btnCollapseAll'+sfx);
    if(_ca) _ca.onclick = ()=>{
      const comps = t[key]||[], allCollapsed = comps.length>0 && comps.every(c=>_collapsedWork.has(c));
      comps.forEach(c=>{ if(allCollapsed) _collapsedWork.delete(c); else _collapsedWork.add(c); });
      drawComponents();
    };
    const _ab = document.getElementById('btnAddComp'+sfx);
    if(_ab) _ab.onclick = ()=>{
      if(!t[key]) t[key] = [];
      const nc = {cat:defaultCat, useFormula:true, numberDays:0, laborTeams:[], materials:[]};
      t[key].push(nc);
      drawComponents();
    };
  }

  function drawAddon(){
    const list = addonPresets(kind);
    if(_presetOpenId && !list.some(p=>p.id===_presetOpenId)) _presetOpenId = null;
    list.forEach((p,i)=>{ if(!Number.isFinite(p.order)) p.order = i; });
    if(_presetOpenId){ drawAddonDetail(list.find(p=>p.id===_presetOpenId)); return; }
    grid.innerHTML = list.length ? `<div class="grid g4">${list.map(p=>`
      <div class="card preset-preview-card" data-openaddon="${esc(p.id)}" style="cursor:pointer;transition:box-shadow .15s, transform .15s;">
        <div class="card-body">
          <div style="font-family:'Sora',sans-serif;font-weight:700;font-size:13.5px;margin-bottom:10px;">${esc(p.name)}</div>
          <div style="display:flex;gap:14px;font-size:11.5px;color:var(--ink-soft);">
            <div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint);margin-bottom:2px;">Teams</div><div style="font-weight:600;color:var(--ink);">${(p.components||[]).reduce((n,c)=>n+((c.laborTeams||[]).length),0)}</div></div>
            <div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint);margin-bottom:2px;">Total cost</div><div style="font-weight:600;color:var(--ink);">${fmt(presetTotalCost(p))}</div></div>
          </div>
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty" style="padding:28px;">No ${esc(meta.label)} presets yet. Click "Add ${esc(meta.singular)} Preset" above to create one.</div>`;
    grid.querySelectorAll('[data-openaddon]').forEach(el=>{
      el.onmouseenter = ()=>{ el.style.boxShadow = '0 4px 14px -4px rgba(15,23,42,.18)'; el.style.transform='translateY(-1px)'; };
      el.onmouseleave = ()=>{ el.style.boxShadow=''; el.style.transform=''; };
      el.onclick = ()=>{ _presetOpenId = el.dataset.openaddon; draw(); };
    });
  }
  function drawAddonDetail(t){
    grid.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="btnBackAddon" style="margin-bottom:14px;">← Back to ${esc(meta.label)}</button>
      <div class="card">
        <div class="card-head">
          <h3 id="addonTitle" style="font-family:'Sora',sans-serif;font-weight:700;font-size:14px;">${esc(t.name)}</h3>
          <button class="btn btn-ghost btn-sm" id="btnDelAddon" style="color:var(--danger);">Remove Preset</button>
        </div>
        <div class="card-body">
          <div class="field" style="max-width:420px;"><label>Preset name</label><input id="addonName" value="${esc(t.name)}"></div>
          <div class="field"><label>Description</label><textarea id="addonDesc" rows="2" placeholder="Printed after the preset name in the quotation">${escH(t.description||'')}</textarea></div>
          ${componentEditorHTML('Labor & Materials', 'components', '', true)}
        </div>
      </div>`;
    document.getElementById('btnBackAddon').onclick = ()=>{ _presetOpenId = null; draw(); };
    document.getElementById('addonName').onchange = e=>{
      const nm = e.target.value.trim();
      if(!nm){ e.target.value = t.name; return; }
      t.name = nm; document.getElementById('addonTitle').textContent = nm;
    };
    document.getElementById('addonDesc').addEventListener('input', e=>{ t.description = e.target.value; });
    document.getElementById('btnDelAddon').onclick = ()=>{
      if(!confirm(`Remove the "${t.name}" preset? It will be deleted once you click Save Presets. Quotations that already use it are not changed.`)) return;
      const i = TEMPLATES.indexOf(t); if(i>=0) TEMPLATES.splice(i,1);
      _presetOpenId = null; draw();
    };
    initComponentEditor(t, meta.defaultCat, 'components', '', true);
  }

  function drawDetail(pid){
    const t = getPreset(pid);
    let m = t.boatModel;
    const titleTxt = ()=> `${m} · ${(Number(t.loa)||0) ? fmtLoaShort(t.loa)+' LOA' : 'LOA not set'}`;
    grid.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="btnBackToModels" style="margin-bottom:14px;">← Back to Boat Models</button>
      <div class="card" data-model="${esc(m)}">
        <div class="card-head">
          <h3 id="boatModelTitle" style="font-family:'Sora',sans-serif;font-weight:700;font-size:14px;">${esc(titleTxt())}</h3>
          <button class="btn btn-ghost btn-sm" data-delmodel="${esc(m)}" style="color:var(--danger);">Remove Model</button>
        </div>
        <div class="card-body">
          <div class="field" style="max-width:420px;"><label>Boat Model name</label><input id="boatModelName" value="${esc(m)}"><div class="hint">Renaming updates this preset. Existing quotations keep the name they were saved with. The same name can be used for more than one model as long as the LOA is different.</div></div>
          <div class="grid g4">
            <div class="field"><label>LOA (ft)</label><input type="number" step="any" class="tpl-f" data-f="loa" value="${t.loa||0}"></div>
            ${['beam','depth'].map(f=>{ const v = decToFtIn(t[f]); return `<div class="field"><label>${f==='beam'?'Beam':'Depth'} (ft / in)</label><div style="display:flex;gap:6px;">
              <input type="number" step="any" class="tpl-ftin" data-f="${f}" data-p="ft" value="${v.ft}" placeholder="ft" style="flex:1;min-width:0;">
              <input type="number" min="0" max="11" step="1" class="tpl-ftin" data-f="${f}" data-p="in" value="${v.inch}" placeholder="in" style="flex:1;min-width:0;"></div></div>`; }).join('')}
            <div class="field"><label>Number of Hulls</label><input type="number" class="tpl-f" data-f="numHulls" value="${t.numHulls||1}"></div>
          </div>
          ${componentEditorHTML('Structural Components')}
          ${componentEditorHTML('Painting Components', 'paintComponents', 'Paint')}
        </div>
      </div>`;

    document.getElementById('btnBackToModels').onclick = ()=>{ _presetOpenModel = null; draw(); };
    document.querySelector('[data-delmodel]').onclick = ()=>{
      if(!confirm(`Remove "${titleTxt()}" as a Boat Model? Its saved preset will be deleted once you click Save Presets.`)) return;
      TEMPLATES = TEMPLATES.filter(x=>x.id!==t.id);
      if(LEGACY_BOAT_MODELS.includes(m)){
        toast('Removed — it will still appear as a default option elsewhere until removed from the code.');
      }
      _presetOpenModel = null; draw();
    };
    document.getElementById('boatModelName').onchange = e=>{
      const nm = e.target.value.trim();
      if(!nm){ e.target.value = m; return; }
      if(nm === m) return;
      if(TEMPLATES.some(x=>x!==t && isBoatPreset(x) && x.boatModel.toLowerCase()===nm.toLowerCase() && (Number(x.loa)||0)===(Number(t.loa)||0))){
        toast('Another Boat Model already has that name and LOA');
        e.target.value = m;
        return;
      }
      t.boatModel = nm;
      t.name = nm;
      m = nm;
      document.getElementById('boatModelTitle').textContent = titleTxt();
      const delBtn = document.querySelector('[data-delmodel]');
      if(delBtn) delBtn.dataset.delmodel = nm;
      const card = grid.querySelector('.card[data-model]');
      if(card) card.dataset.model = nm;
      toast('Boat Model renamed — click Save Presets to keep the change');
    };
    grid.querySelectorAll('.tpl-ftin').forEach(i=>i.onchange=()=>{
      const f = i.dataset.f, pair = {};
      grid.querySelectorAll(`.tpl-ftin[data-f="${f}"]`).forEach(x=>{ pair[x.dataset.p] = x.value; });
      t[f] = ftInToDec(pair.ft, pair.in);
    });
    grid.querySelectorAll('.tpl-f').forEach(i=>i.onchange=()=>{
      const f = i.dataset.f, conv = Number(i.dataset.conv)||1;   // glass weight and areas are stored metric
      if(['loa','beam','depth','numHulls'].includes(f)) t[f] = (Number(i.value)||0) / conv;
      else t[f] = i.value;
      if(f==='loa'){ const ti = document.getElementById('boatModelTitle'); if(ti) ti.textContent = titleTxt(); }
    });

    initComponentEditor(t, 'Other Structural Materials');
    initComponentEditor(t, 'Painting', 'paintComponents', 'Paint');
  }

  draw();
}

/* ============================================================
   PRICING DATABASE
   ============================================================ */
function renderPricing(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnSavePricing">Save Pricing Database</button> <button class="btn btn-ghost" id="btnResetPricing">Reset to Defaults</button>`;
  const r = PRICING;
  ensurePricingShape();
  content.innerHTML = `
    <div class="section-lead">These values feed every new quotation's default rates (each quotation keeps its own editable snapshot, so changes here won't retroactively alter saved quotes).</div>
    <div class="grid g-wide">
      <div class="card"><div class="card-head"><h3>Labor Rates</h3><button class="btn btn-sm" id="addLaborCat">${icon('plus')} Add Category</button></div><div class="card-body" style="padding:0;">
        <div class="section-lead" style="padding:14px 20px 0;">Daily rate per laborer for each labor category (for example Carpentry or Fiberglass). Boat Presets use these: pick the categories, how many laborers each needs, and the number of days. Add or remove categories as your shop needs.</div>
        <table style="margin-top:10px;"><thead><tr><th>Category</th><th style="width:150px;">Rate (₱/day)</th><th style="width:60px;"></th></tr></thead>
        <tbody id="laborRows"></tbody></table>
      </div></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Standard Accessory Catalog</h3><button class="btn btn-sm" id="addAccItem">${icon('plus')} Add Item</button></div>
      <div class="card-body" style="padding:0;"><table><thead><tr><th>Category</th><th>Item Name</th><th class="right">Unit Price (₱)</th><th></th></tr></thead><tbody id="accCatRows"></tbody></table></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Materials</h3><button class="btn btn-sm" id="addMaterial">${icon('plus')} Add Material</button></div>
      <div class="card-body section-lead">Fiberglass, resin, gelcoat, core and other materials (weights in kg). These are the items you tick under "Choose materials" in Presets, and the prices they start with.</div>
      <div class="card-body" style="padding:0;"><table><thead><tr><th>Material</th><th>Unit</th><th class="right">Unit Price (₱)</th><th></th></tr></thead><tbody id="matCatRows"></tbody></table></div>
    </div>
  `;
  function cap(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

  function drawAcc(){
    document.getElementById('accCatRows').innerHTML = r.accessoryCatalog.map((a,idx)=>`
      <tr>
        <td><input class="tbl-input acc-f" data-idx="${idx}" data-f="cat" value="${esc(a.cat)}"></td>
        <td><input class="tbl-input acc-f" data-idx="${idx}" data-f="name" value="${esc(a.name)}"></td>
        <td style="width:150px;"><input class="tbl-input num acc-f" data-idx="${idx}" data-f="unitPrice" type="number" value="${a.unitPrice}"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-del-acc="${idx}" style="color:var(--danger);">Remove</span></td>
      </tr>`).join('');
    document.querySelectorAll('.acc-f').forEach(i=>i.onchange=()=>{
      r.accessoryCatalog[i.dataset.idx][i.dataset.f] = i.dataset.f==='unitPrice'? Number(i.value) : i.value;
    });
    document.querySelectorAll('[data-del-acc]').forEach(b=>b.onclick=()=>{ r.accessoryCatalog.splice(Number(b.dataset.delAcc),1); drawAcc(); });
  }
  document.getElementById('addAccItem').onclick=()=>{ r.accessoryCatalog.push({cat:'Custom',name:'New Item',unitPrice:0}); drawAcc(); };

  function drawMaterials(){
    document.getElementById('matCatRows').innerHTML = r.structuralCatalog.map((a,idx)=>`
      <tr>
        <td><input class="tbl-input matcat-f" data-idx="${idx}" data-f="name" value="${esc(a.name)}"></td>
        <td style="width:120px;"><input class="tbl-input matcat-f" data-idx="${idx}" data-f="unit" value="${esc(a.unit)}"></td>
        <td style="width:160px;"><input class="tbl-input num matcat-f" data-idx="${idx}" data-f="unitPrice" type="number" min="0" step="any" value="${a.unitPrice}"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-del-matcat="${idx}" style="color:var(--danger);">Remove</span></td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty" style="padding:12px;">No materials yet.</td></tr>`;
    document.querySelectorAll('.matcat-f').forEach(i=>i.onchange=()=>{
      r.structuralCatalog[i.dataset.idx][i.dataset.f] = i.dataset.f==='unitPrice'? Math.max(0, Number(i.value)||0) : i.value;
    });
    document.querySelectorAll('[data-del-matcat]').forEach(b=>b.onclick=()=>{ r.structuralCatalog.splice(Number(b.dataset.delMatcat),1); drawMaterials(); });
  }
  document.getElementById('addMaterial').onclick=()=>{ r.structuralCatalog.push({name:'New Material',unit:'kg',unitPrice:0}); drawMaterials(); };

  function drawLaborRates(){
    const names = Object.keys(r.laborDailyRates);
    document.getElementById('laborRows').innerHTML = names.map(k=>`
      <tr>
        <td>${esc(capFirst(k))}</td>
        <td><input type="number" min="0" step="any" class="lr-f" data-k="${esc(k)}" value="${Number(r.laborDailyRates[k])||0}" style="width:100%;border:1px solid var(--paper-line);border-radius:6px;padding:6px 8px;"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-del-lr="${esc(k)}" style="color:var(--danger);" title="Remove this category">✕</span></td>
      </tr>`).join('') || `<tr><td colspan="3" class="empty" style="padding:12px;">No labor categories yet. Click "Add Category".</td></tr>`;
    document.querySelectorAll('.lr-f').forEach(i=>i.addEventListener('input', ()=>{ r.laborDailyRates[i.dataset.k] = Math.max(0, Number(i.value)||0); }));
    document.querySelectorAll('[data-del-lr]').forEach(b=>b.onclick=()=>{
      const k = b.dataset.delLr;
      if(!confirm(`Remove the "${capFirst(k)}" labor category? Presets that already use it keep the rate they saved.`)) return;
      delete r.laborDailyRates[k]; drawLaborRates();
    });
  }
  document.getElementById('addLaborCat').onclick = ()=>{
    let nm = (prompt('Name of the new labor category (for example: Carpentry):')||'').trim();
    if(!nm) return;
    nm = nm.charAt(0).toUpperCase() + nm.slice(1);
    if(Object.keys(r.laborDailyRates).some(k=>k.trim().toLowerCase()===nm.toLowerCase())){ toast('That labor category already exists'); return; }
    r.laborDailyRates[nm] = 0; drawLaborRates();
    const inputs = document.querySelectorAll('.lr-f'); if(inputs.length) inputs[inputs.length-1].focus();
  };

  drawAcc(); drawMaterials(); drawLaborRates();

  document.getElementById('btnSavePricing').onclick = ()=>{
    save(DB_KEYS.pricing, PRICING); toast('Pricing database saved');
  };
  document.getElementById('btnResetPricing').onclick = ()=>{
    if(confirm('Reset all pricing to factory defaults?')){ PRICING = JSON.parse(JSON.stringify(DEFAULT_PRICING)); migrateUnitsToImperial(); save(DB_KEYS.pricing,PRICING); renderPricing(content,actions); }
  };
}

/* ============================================================
   QUOTATION EDITOR
   ============================================================ */
function openEditor(quoteId, templateId){
  if(!hasAccess('editor')){ CURRENT.view = 'editor'; renderAll(); return; }
  CURRENT.view = 'editor'; CURRENT.tab='client';
  if(quoteId){
    CURRENT.quoteId = quoteId;
    const existing = QUOTES.find(x=>x.id===quoteId);
    if(existing && CURRENT_IS_ADMIN && existing.createdByEmail && existing.createdByEmail !== (CURRENT_USER.email||'').toLowerCase()){
      CURRENT.tab = 'output';
    }
  }
  else {
    const q = blankQuote();
    if(templateId){
      const t = TEMPLATES.find(x=>x.id===templateId);
      if(t){
        q.hull = { boatType:t.boatType, loa:t.loa, beam:t.beam, depth:t.depth, numHulls:t.numHulls||1, hullAreaOverride:null, layers:0, glassPerLayer:0, coreArea:0, coreEnabled:false, work:null, noLaminate:true };
        q.paint = { items: (t.paintComponents||[]).map(presetPaintToQuoteItem) };
        if(!q.structural) q.structural = { items:[] };
        q.structural.items = boatComponentsToQuoteItems(t);
        q.project.title = t.name;
        if(t.boatModel) q.project.boatModel = t.boatModel;
        if(isBoatPreset(t)) q.project.boatPresetId = t.id;
      }
    }
    QUOTES.push(q); save(DB_KEYS.quotes, QUOTES);
    CURRENT.quoteId = q.id;
  }
  renderAll();
}
function getCurrentQuote(){ return QUOTES.find(q=>q.id===CURRENT.quoteId); }
function ensureQuoteDefaults(q){
  if(!q.structural) q.structural = { items:[] };
  if(!q.paint) q.paint = { items:[] };
  if(!q.paint.items){
    // Migrate the very old single-spec paint object (areaOverride/coats/paintType)
    // straight into the new 3-coat list shape, so nothing is lost.
    const old = q.paint;
    const pricePerSqm = (Number(PRICING.paintPerLiter)||0) / (Number(PRICING.paintCoverage)||1);
    q.paint = { items: [
      {id:uid('pi'), coatLabel:'1st Coat', type: old.paintType || 'Marine Polyurethane Topcoat', color:'', area: old.areaOverride ?? null, pricePerSqm},
      {id:uid('pi'), coatLabel:'2nd Coat', type: old.paintType || 'Marine Polyurethane Topcoat', color:'', area: old.areaOverride ?? null, pricePerSqm},
      {id:uid('pi'), coatLabel:'3rd Coat', type: old.paintType || 'Marine Polyurethane Topcoat', color:'', area: old.areaOverride ?? null, pricePerSqm}
    ] };
  } else if(q.paint.items.some(it=>it.pricePerSqm===undefined)){
    // Migrate the previous list-item shape (coveragePerLiter/coats/pricePerLiter)
    // into coatLabel/pricePerSqm, preserving each row's original total cost.
    q.paint.items = q.paint.items.map((it,idx)=>{
      if(it.pricePerSqm!==undefined) return it;
      const coverage = Number(it.coveragePerLiter)||1;
      const coatsCount = Number(it.coats)||1;
      const pricePerLiter = Number(it.pricePerLiter)||0;
      return { id: it.id||uid('pi'), coatLabel: it.coatLabel || `Coat ${idx+1}`, type: it.type||'', color: it.color||'', area: it.area??null, pricePerSqm: (pricePerLiter/coverage)*coatsCount };
    });
  }
  if(q.createdByEmail===undefined) q.createdByEmail = '';
  if(q.approvedBy===undefined) q.approvedBy = null;
  if(q.revisionChildId===undefined) q.revisionChildId = null;
  if(q.revisionOf===undefined) q.revisionOf = null;
  if(!q.accessoryCategoryNA) q.accessoryCategoryNA = {};
  if(!q.specialFeatures) q.specialFeatures = { enabled:false, items:[] };
  if(!Array.isArray(q.specialFeatures.items)) q.specialFeatures.items = [];
  if(!q.testingDelivery) q.testingDelivery = [];
  if(!q.testingDeliveryNA) q.testingDeliveryNA = {};
  const oldTrailerItems = (q.accessories||[]).filter(a=>a.cat==='Trailer');
  if(oldTrailerItems.length){
    q.testingDelivery = [...q.testingDelivery, ...oldTrailerItems];
    q.accessories = q.accessories.filter(a=>a.cat!=='Trailer');
  }
  if(q.status==='sent') q.status = 'for_approval'; // migrate old 3-status quotes
  if(q.customerSnap.companyName===undefined) q.customerSnap.companyName = '';
  if(q.customerSnap.clientName===undefined) q.customerSnap.clientName = '';
  if(q.customerSnap.clientPosition===undefined) q.customerSnap.clientPosition = '';
  if(q.customerSnap.companyTin===undefined) q.customerSnap.companyTin = '';
  if(q.customerSnap.repName===undefined) q.customerSnap.repName = '';
  if(q.customerSnap.repPosition===undefined) q.customerSnap.repPosition = '';
  if(q.customerSnap.repContact===undefined) q.customerSnap.repContact = '';
  if(q.customerSnap.repEmail===undefined) q.customerSnap.repEmail = '';
  if(q.customerSnap.repNA===undefined) q.customerSnap.repNA = false;
  if(q.project.numBoats===undefined) q.project.numBoats = 1;
  if(q.project.passengerCapacity===undefined) q.project.passengerCapacity = 0;
  if(q.project.multiplyPrice===undefined) q.project.multiplyPrice = false;
  if(q.project.buildType===undefined) q.project.buildType = 'Standard Build';
  if(q.project.boatModel===undefined) q.project.boatModel = 'Apple Series';
  if(q.project.boatPresetId===undefined) q.project.boatPresetId = null;
  if(q.project.boatApplication===undefined) q.project.boatApplication = 'Passenger Boat';
  if(q.project.boatApplicationOther===undefined) q.project.boatApplicationOther = '';
  if(!q.engine) q.engine = { model:'', brand:'', type:'IBM', hp:0, qty:2, unitPrice:0, installation:0, transmission:'', propeller:'', description:'', inclusions:[], steeringItems:[] };
  if(q.engine.brand===undefined) q.engine.brand = '';
  if(q.engine.type===undefined) q.engine.type = 'IBM';
  if(q.engine.speed===undefined) q.engine.speed = '';
  if(q.engine.fuelCapacity===undefined) q.engine.fuelCapacity = '';
  if(q.engine.description===undefined) q.engine.description = '';
  if(!Array.isArray(q.engine.inclusions)) q.engine.inclusions = [];
  if(!Array.isArray(q.engine.steeringItems)) q.engine.steeringItems = [];
  if(!q.schedule) q.schedule = { startDate: q.date||todayISO(), standardDays: PRICING.standardDurationDays, requestedDays: PRICING.standardDurationDays };
  if(q.rates.dailyRate===undefined) q.rates.dailyRate = PRICING.dailyRate;
  if(q.rates.standardDurationDays===undefined) q.rates.standardDurationDays = PRICING.standardDurationDays;
  if(q.rates.rushFeePct===undefined) q.rates.rushFeePct = PRICING.rushFeePct;
  if(!q.marina){
    q.marina = {
      items: [
        {name:"MARINA Construction Permit (Certificate of Construction)", responsibility:'Company', remarks:'Filed prior to keel-laying', price:0},
        {name:"Certificate of Vessel Registry (COR)", responsibility:'Customer', remarks:'', price:0},
        {name:"Coastwise License / Certificate of Public Convenience", responsibility:'Customer', remarks:'If for commercial operation', price:0},
        {name:"Load Line Certificate", responsibility:'Customer', remarks:'', price:0},
        {name:"Cargo Ship Safety Equipment Certificate", responsibility:'Customer', remarks:'', price:0},
        {name:"Certificate of Inspection (COI)", responsibility:'Customer', remarks:'Annual renewal', price:0},
        {name:"Tonnage Certificate", responsibility:'Customer', remarks:'', price:0},
        {name:"Builder's Certificate", responsibility:'Company', remarks:'Issued upon delivery', price:0},
      ],
      notes:"All MARINA registration, licensing, permit, and certification fees are for the account of the Customer unless otherwise stated. The Company shall provide the Builder's Certificate and other builder-side documents required to support the Customer's registration application."
    };
  }
  if(!q.output) q.output = { showInternalCosts:false };
  if(Array.isArray(q.marina.items)) q.marina.items.forEach(it=>{ if(it.price===undefined) it.price = 0; });
  if(q.output.showInternalCosts === undefined) q.output.showInternalCosts = false;
  if(!q.invoice) q.invoice = { vatEnabled:true, vatPct:12, previousPayment:0, discountType:'pct', discountValue:0 };
  if(q.invoice.vatEnabled===undefined) q.invoice.vatEnabled = true;
  if(q.invoice.vatPct===undefined) q.invoice.vatPct = 12;
  if(q.invoice.previousPayment===undefined) q.invoice.previousPayment = 0;
  if(q.invoice.discountType===undefined) q.invoice.discountType = 'pct';
  if(q.invoice.discountValue===undefined) q.invoice.discountValue = 0;
  if(q.invoice.discountNote===undefined) q.invoice.discountNote = '';
  if(!Array.isArray(q.paymentSchedule)){
    q.paymentSchedule = [
      { description:'Downpayment', terms:'Upon order confirmation & signed conform', dueUpon:'Order Confirmation', percent:20 },
      { description:'Balance', terms:'Before shipping / delivery of the boat', dueUpon:'Before Delivery', percent:80 },
    ];
  }
  if(!Array.isArray(q.terms)){
    const t = q.terms || {};
    q.terms = [
      {title:'Completion Time', body:t.completion||'12 months from date of receipt of downpayment and Purchase Order'},
      {title:'Payment Terms', body:t.payment||'20% downpayment upon confirmation of order; progress billing per agreed schedule; 10% upon completion and sea trial before delivery'},
      {title:'Hull Warranty', body:t.warranty||'Two (2) years on hull structure for pleasure use, one (1) year for commercial use, covering manufacturing defects under normal use conditions.'},
      {title:'Warranty Exclusions', body:t.exclusions||'Warranty excludes normal wear and tear, misuse or negligence, unauthorized modification, force majeure, and third-party accessories which follow manufacturer warranty.'},
      {title:'Delivery', body:t.delivery||'Delivery outside factory premises subject to separate agreement and additional logistics charges.'},
      {title:'Regulatory Compliance', body:t.compliance||'Boat registration, MARINA licenses, permits and certificates shall be borne by the customer.'},
    ];
  }
}
function persistQuote(q){ q.updatedAt = Date.now(); save(DB_KEYS.quotes, QUOTES); }

const EDITOR_TABS = [
  {id:'client', n:'01', label:'Client & Project'},
  {id:'hull', n:'02', label:'Hull'},
  {id:'paint', n:'03', label:'Paint & Finish'},
  {id:'accessories', n:'04', label:'Accessories'},
  {id:'engine', n:'05', label:'Marine Propulsion System'},
  {id:'testing', n:'06', label:'Testing & Delivery'},
  {id:'marina', n:'07', label:'MARINA Documentation'},
  {id:'terms', n:'08', label:'Terms & Conditions'},
  {id:'output', n:'09', label:'Quotation Output'},
];

function renderEditor(content, actions){
  let q = getCurrentQuote();
  if(!q){ CURRENT.view='dashboard'; renderAll(); return; }
  ensureQuoteDefaults(q);

  actions.innerHTML = `
    <span class="badge ${q.status}" style="margin-right:10px;">${statusLabel(q.status)}</span>
    <button class="btn" id="btnBackList">${icon('list')} All Quotations</button>
    <button class="btn btn-primary" id="btnGoOutput">Preview Output →</button>
  `;

  content.innerHTML = `
    <div class="tabs" id="editTabs"></div>
    <div class="editor-grid" id="editorGrid">
      <div id="tabHost"></div>
      <div class="summary-panel">
        <div class="card">
          <div class="card-head"><h3>Live Total</h3></div>
          <div class="card-body" id="liveSummary">${liveSummaryShell(q)}</div>
        </div>
        <div class="card" style="margin-top:16px;">
          <div class="card-head"><h3>Status</h3></div>
          <div class="card-body">
            <div style="margin-bottom:12px;"><span class="badge ${q.status}">${statusLabel(q.status)}</span></div>

            ${q.status==='draft' ? `
              <div class="hint" style="margin-bottom:10px;">Still being worked on. Submit when ready for admin review — the quotation locks from editing once submitted.</div>
              <button class="btn btn-primary btn-sm" id="btnSubmitApproval">Submit for Approval</button>
            ` : ``}

            ${q.status==='for_approval' ? (CURRENT_IS_ADMIN ? `
              <div class="hint" style="margin-bottom:10px;">Awaiting your decision.</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-primary btn-sm" id="btnApprove">✓ Approve</button>
                <button class="btn btn-sm btn-ghost" id="btnRequestRevision">↺ Request Revision</button>
              </div>
            ` : `<div class="hint">Submitted — awaiting admin approval. Locked from editing until reviewed.</div>`) : ``}

            ${q.status==='for_revision' ? `
              <div class="hint" style="margin-bottom:10px;">This version is locked. ${q.revisionChildId ? 'A revised copy was created for editing.' : ''}</div>
              ${q.revisionChildId ? `<button class="btn btn-sm" data-open="${q.revisionChildId}">Open Revision Copy</button>` : ``}
            ` : ``}

            ${q.status==='approved' ? `
              <div style="display:flex;gap:10px;align-items:center;">
                ${q.approvedBy && q.approvedBy.esign ? `<img src="${esc(q.approvedBy.esign)}" alt="" style="height:36px;max-width:80px;object-fit:contain;">` : ``}
                <div>
                  <div style="font-weight:600;font-size:12.5px;">${esc(q.approvedBy && q.approvedBy.name || '')}</div>
                  <div class="hint">${esc(q.approvedBy && q.approvedBy.position || '')||'Position not set'}</div>
                </div>
              </div>
            ` : ``}
          </div>
        </div>
      </div>
    </div>
  `;
  [['sbOverhead','overheadPct'],['sbContingency','contingencyPct'],['sbMargin','marginPct']].forEach(([id,key])=>{
    const el = document.getElementById(id);
    el.addEventListener('input', ()=>{
      q.rates[key] = Math.max(0, Number(el.value)||0);
      persistQuote(q);
      updateLiveSummary(q);
    });
  });
  // VAT & Discount live inside the Live Total now.
  const refreshAfterEdit = ()=>{ persistQuote(q); updateLiveSummary(q); };
  document.getElementById('vatPct').addEventListener('input', (e)=>{ q.invoice.vatPct = Math.max(0, Number(e.target.value)||0); refreshAfterEdit(); });
  document.getElementById('discountType').addEventListener('change', (e)=>{
    // Switching % <-> ₱ keeps the same discount (50,000 off a 500,000 price becomes 10%, and back)
    // instead of reinterpreting the old number in the new unit.
    const before = computeInvoiceTotals(q, computeAll(q));
    const toType = e.target.value==='fixed' ? 'fixed' : 'pct';
    let v = Number(q.invoice.discountValue)||0;
    if(before.discountType !== toType){
      v = toType==='fixed' ? before.discountAmount : +before.discountPctEff.toFixed(2);
    }
    q.invoice.discountType = toType;
    q.invoice.discountValue = v;
    document.getElementById('discountValue').value = v;
    refreshAfterEdit();
  });
  // Typing is never rewritten mid-keystroke; the amount is capped in the math and the input is tidied on blur.
  document.getElementById('discountValue').addEventListener('input', (e)=>{ q.invoice.discountValue = Math.max(0, Number(e.target.value)||0); refreshAfterEdit(); });
  document.getElementById('discountValue').addEventListener('change', (e)=>{
    const t = computeInvoiceTotals(q, computeAll(q));
    let v = Math.max(0, Number(e.target.value)||0);
    if(t.discountType==='pct') v = Math.min(v, 100);
    else v = Math.min(v, t.contractAmount);
    q.invoice.discountValue = v; e.target.value = v;
    refreshAfterEdit();
  });
  document.getElementById('discountNote').addEventListener('input', (e)=>{ q.invoice.discountNote = e.target.value; persistQuote(q); });
  // If the printed preview is showing, redraw it once the person finishes editing a Live Total field.
  ['sbOverhead','sbContingency','sbMargin','vatPct','discountType','discountValue','discountNote'].forEach(id=>{
    document.getElementById(id).addEventListener('change', ()=>{ if(CURRENT.tab==='output') renderEditor(content, actions); });
  });
  document.getElementById('btnBackList').onclick = ()=>{ CURRENT.view='quotes'; renderAll(); };
  document.getElementById('btnGoOutput').onclick = ()=>{ CURRENT.tab='output'; renderEditor(content,actions); };
  document.querySelectorAll('.summary-panel [data-open]').forEach(b=>b.onclick=()=>openEditor(b.dataset.open));

  const submitBtn = document.getElementById('btnSubmitApproval');
  if(submitBtn) submitBtn.onclick = ()=>{
    q.status = 'for_approval'; persistQuote(q); toast('Submitted for approval'); renderEditor(content, actions);
  };

  const approveBtn = document.getElementById('btnApprove');
  if(approveBtn) approveBtn.onclick = ()=>{
    const me = profileByEmail(CURRENT_USER.email);
    q.approvedBy = {
      email: (CURRENT_USER.email||'').toLowerCase(),
      name: (me && me.full_name) || CURRENT_USER.email,
      position: (me && me.position) || '',
      esign: (me && me.esign) || '',
      date: todayISO()
    };
    q.status = 'approved';
    persistQuote(q); toast('Quotation approved'); renderEditor(content, actions);
  };

  const requestRevisionBtn = document.getElementById('btnRequestRevision');
  if(requestRevisionBtn) requestRevisionBtn.onclick = ()=>{
    if(!confirm('Send this quotation back for revision? A new editable copy will be created for the person who made it.')) return;
    const copy = JSON.parse(JSON.stringify(q));
    copy.id = uid('q');
    copy.refNo = incrementRevisionRef(q.refNo);
    copy.status = 'draft';
    copy.approvedBy = null;
    copy.revisionChildId = null;
    copy.revisionOf = q.id;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    q.status = 'for_revision';
    q.revisionChildId = copy.id;
    QUOTES.push(copy);
    persistQuote(q); save(DB_KEYS.quotes, QUOTES);
    toast(`Sent back for revision — ${copy.refNo} created`);
    CURRENT.view = 'quotes'; renderAll();
  };

  const tabsEl = document.getElementById('editTabs');
  tabsEl.innerHTML = EDITOR_TABS.map(t=>`<div class="tab ${CURRENT.tab===t.id?'active':''}" data-tab="${t.id}"><span class="n">${t.n}</span>${t.label}</div>`).join('');
  tabsEl.querySelectorAll('.tab').forEach(el=>el.onclick=()=>{ CURRENT.tab = el.dataset.tab; renderEditor(content,actions); });

  const host = document.getElementById('tabHost');
  const renderers = { client:tabClient, hull:tabHull, paint:tabPaint, accessories:tabAccessories, engine:tabEngine, marina:tabMarina, testing:tabTesting, terms:tabTerms, output:tabOutput };
  if(!renderers[CURRENT.tab]) CURRENT.tab = 'client';
  renderers[CURRENT.tab](host, q);

  // Once a quotation leaves Draft, it's locked from editing — only viewing
  // (Print, the internal-cost toggle) and the workflow action buttons stay
  // interactive. Those live outside #tabHost or are explicitly allow-listed.
  if(q.status !== 'draft'){
    const keepEnabled = new Set(['btnPrint']);
    host.querySelectorAll('input, select, textarea, button').forEach(el=>{
      if(!keepEnabled.has(el.id)) el.disabled = true;
    });
    ['vatPct','discountType','discountValue','discountNote','sbOverhead','sbContingency','sbMargin'].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.disabled = true;
    });
  }

  updateLiveSummary(q);
}

// Dimensions in the shop's style: LOA as 32ft, Beam / Depth as 07ft 08in (no decimals).
function fmtFtIn(dec, ftOnlyWhenNoInches){
  const {ft, inch} = decToFtIn(dec);
  const f = String(ft).padStart(2,'0') + 'ft';
  return (ftOnlyWhenNoInches && inch===0) ? f : `${f} ${String(inch).padStart(2,'0')}in`;
}
// Built once with the editor so typing in these fields never loses focus; updateLiveSummary() only patches the numbers.
function liveSummaryShell(q){
  const inv = q.invoice || {};
  const pctRow = (label, id, val, outId)=>`
    <div class="sum-row sum-edit"><span class="k">${label}</span>
      <span class="sum-ctl"><input type="number" min="0" step="any" id="${id}" class="side-input sum-input" value="${val}"><span class="unit">%</span></span>
      <span class="v" id="${outId}"></span></div>`;
  return `
    <div class="sum-label">Particulars</div>
    <div class="spec-plate" style="margin:0 0 14px;padding:12px 14px;">
      <div class="row">
        <div class="cell"><div class="l">LOA</div><div class="v" id="lsLoa"></div></div>
        <div class="cell"><div class="l">Beam</div><div class="v" id="lsBeam"></div></div>
        <div class="cell"><div class="l">Depth</div><div class="v" id="lsDepth"></div></div>
        <div class="cell"><div class="l">Hull Area</div><div class="v" id="lsArea"></div></div>
      </div>
    </div>
    <div class="sum-row"><span class="k">Materials &amp; Labor</span><span class="v" id="lsMaterials"></span></div>
    <div class="sum-row"><span class="k">MARINA Documentation</span><span class="v" id="lsMarina"></span></div>
    <div class="sum-row" id="lsBoatsRow" style="display:none;"><span class="k">Number of Boats</span><span class="v" id="lsBoats"></span></div>
    ${pctRow('Overhead','sbOverhead',q.rates.overheadPct,'lsOverhead')}
    ${pctRow('Contingency','sbContingency',q.rates.contingencyPct,'lsContingency')}
    ${pctRow('Profit Margin','sbMargin',q.rates.marginPct,'lsMargin')}
    <div class="sum-total"><span class="k">Final Price</span><span class="v" id="lsFinal"></span></div>
    <div class="sum-row sum-edit"><span class="k">Discount</span>
      <span class="sum-ctl">
        <select id="discountType" class="side-input sum-select"><option value="pct" ${inv.discountType!=='fixed'?'selected':''}>%</option><option value="fixed" ${inv.discountType==='fixed'?'selected':''}>₱ Fixed</option></select>
        <input type="number" min="0" step="any" id="discountValue" class="side-input sum-input" value="${Number(inv.discountValue)||0}">
      </span>
      <span class="v" id="lsDiscount"></span></div>
    <div class="sum-sub" id="lsDiscountMeta" style="display:none;">
      <input type="text" id="discountNote" class="side-input" maxlength="60" placeholder="Reason (optional) e.g. Early payment" value="${esc(inv.discountNote||'')}">
      <div class="sum-hint" id="lsDiscountHint"></div>
    </div>
    <div class="sum-row" id="lsNetRow" style="display:none;"><span class="k">Price After Discount</span><span class="v" id="lsNet"></span></div>
    ${pctRow('VAT','vatPct',Number(inv.vatPct)||0,'lsVat')}
    <div class="sum-total sum-total-contract"><span class="k">Total Contract Amount</span><span class="v" id="lsContract"></span></div>
  `;
}
function updateLiveSummary(q){
  if(!document.getElementById('liveSummary')) return;
  const c = computeAll(q), inv = computeInvoiceTotals(q, c);
  const set = (id, v)=>{ const el = document.getElementById(id); if(el) el.textContent = v; };
  set('lsLoa', fmtFtIn(q.hull.loa, true));
  set('lsBeam', fmtFtIn(q.hull.beam));
  set('lsDepth', fmtFtIn(q.hull.depth));
  set('lsArea', fmtNum(sqft(c.hull.area),1) + ' sq ft');
  set('lsMaterials', fmt(c.materialCost));
  set('lsMarina', fmt(c.marinaCost));
  const boats = document.getElementById('lsBoatsRow');
  if(boats) boats.style.display = c.numBoats>1 ? '' : 'none';
  set('lsBoats', c.numBoats + (c.multiplyPrice ? ' × unit price' : ' (price not multiplied)'));
  set('lsOverhead', fmt(c.overheadCost));
  set('lsContingency', fmt(c.contingencyCost));
  set('lsMargin', fmt(c.marginCost));
  set('lsFinal', fmt(c.finalTotal));
  set('lsDiscount', inv.discountAmount>0 ? '-' + fmt(inv.discountAmount) : fmt(0));
  const hasDisc = inv.discountAmount>0 || inv.discountValue>0;
  const meta = document.getElementById('lsDiscountMeta'); if(meta) meta.style.display = hasDisc ? '' : 'none';
  const netRow = document.getElementById('lsNetRow'); if(netRow) netRow.style.display = inv.discountAmount>0 ? '' : 'none';
  set('lsNet', fmt(inv.discountedAmount));
  const hint = document.getElementById('lsDiscountHint');
  if(hint){
    hint.classList.toggle('warn', !!inv.discountCapped);
    hint.textContent = inv.discountCapped
      ? (inv.discountType==='fixed' ? 'Capped at the full price' : 'Capped at 100%')
      : (inv.discountType==='fixed' && inv.discountAmount>0 ? '= ' + fmtNum(inv.discountPctEff,2) + '% of the price'
        : inv.discountType==='pct' && inv.discountAmount>0 ? '= ' + fmt(inv.discountAmount) + ' off' : '');
  }
  set('lsVat', fmt(inv.vatAmount));
  set('lsContract', fmt(inv.totalContractAmount));
}

/* ---- Tab: Client & Project ---- */
function tabClient(host, q){
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Client Information</h3></div>
      <div class="card-body">
        <div class="field"><label>Load Existing Customer</label>
          <select id="custPick"><option value="">— Select or fill manually below —</option>${CUSTOMERS.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="grid g2">
          <div class="field"><label>Client Name</label><input id="cClientName" value="${esc(q.customerSnap.clientName)}" placeholder="Individual person's name"></div>
          <div class="field"><label>Client Position</label><input id="cClientPosition" value="${esc(q.customerSnap.clientPosition)}" placeholder="e.g. Operations Manager"></div>
        </div>
        <div class="grid g2">
          <div class="field"><label>Company Name</label><input id="cCompanyName" value="${esc(q.customerSnap.companyName)}" placeholder="Business / organization name"></div>
          <div class="field"><label>Company TIN</label><input id="cCompanyTin" value="${esc(q.customerSnap.companyTin)}"></div>
        </div>
        <div class="field"><label>Address</label><input id="cAddress" value="${esc(q.customerSnap.address)}"></div>
        <div class="grid g2">
          <div class="field"><label>Contact Number</label><input id="cContact" value="${esc(q.customerSnap.contact)}"></div>
          <div class="field"><label>Email Address</label><input id="cEmail" value="${esc(q.customerSnap.email)}"></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Client's Representative</h3></div>
      <div class="card-body">
        <label class="field-inline" style="font-size:12.5px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;margin-bottom:14px;">
          <input type="checkbox" id="cRepNA" ${q.customerSnap.repNA?'checked':''} style="width:auto;">
          Not Applicable
        </label>
        <div class="grid g2">
          <div class="field"><label>Name</label><input id="cRepName" value="${esc(q.customerSnap.repName)}" ${q.customerSnap.repNA?'disabled':''}></div>
          <div class="field"><label>Position</label><input id="cRepPosition" value="${esc(q.customerSnap.repPosition)}" ${q.customerSnap.repNA?'disabled':''}></div>
        </div>
        <div class="grid g2">
          <div class="field"><label>Contact Number</label><input id="cRepContact" value="${esc(q.customerSnap.repContact)}" ${q.customerSnap.repNA?'disabled':''}></div>
          <div class="field"><label>Email Address</label><input id="cRepEmail" value="${esc(q.customerSnap.repEmail)}" ${q.customerSnap.repNA?'disabled':''}></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Project Information</h3></div>
      <div class="card-body">
        <div class="section-lead" style="margin-top:0;">The project title is generated automatically in the printed quotation from the Hull Particulars, Boat Application, Boat Model, and Engine details — no need to type it here.</div>
        <div class="grid g2">
          <div class="field"><label>Build Type</label>
            <select id="pBuildType">${BUILD_TYPES.map(o=>`<option ${q.project.buildType===o?'selected':''}>${o}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Boat Application</label>
            <select id="pBoatApp">${BOAT_APPLICATIONS.map(o=>`<option ${q.project.boatApplication===o?'selected':''}>${o}</option>`).join('')}</select>
            <input type="text" id="pBoatAppOther" value="${esc(q.project.boatApplicationOther||'')}" placeholder="Specify application" style="margin-top:6px;display:${q.project.boatApplication==='Other'?'block':'none'};">
          </div>
        </div>
        <div class="grid g3">
          <div class="field"><label>Reference No.</label><input id="pRef" value="${esc(q.refNo)}" class="${isDuplicateRefNo(q.refNo, q.id)?'dup-error':''}"><div class="hint" id="pRefWarning" style="color:var(--danger);display:${isDuplicateRefNo(q.refNo, q.id)?'block':'none'};">This reference number is already used by another quotation.</div></div>
          <div class="field"><label>Date</label><input type="date" id="pDate" value="${q.date}"></div>
          <div class="field"><label>Validity (days)</label><input type="number" id="pValid" value="${q.validityDays}"></div>
        </div>
        <div class="grid g3">
          <div class="field"><label>Passenger Capacity</label><input type="number" id="pPaxCap" min="0" step="1" value="${q.project.passengerCapacity||0}"></div>
          <div class="field"><label>Number of Boats to be Quoted</label><input type="number" id="pNumBoats" min="1" step="1" value="${q.project.numBoats}"></div>
          <div class="field">
            <label>&nbsp;</label>
            <label class="field-inline" style="font-size:12.5px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;margin-top:8px;">
              <input type="checkbox" id="pMultiply" ${q.project.multiplyPrice?'checked':''} style="width:auto;">
              Multiply total price by this quantity
            </label>
          </div>
        </div>
        <div class="field"><label>Project Note</label><textarea id="pNotes" rows="3" placeholder="Shown below the project title in the printed quotation">${esc(q.project.notes)}</textarea></div>
      </div>
    </div>
  `;
  document.getElementById('custPick').onchange = (e)=>{
    const c = CUSTOMERS.find(x=>x.id===e.target.value);
    if(c){
      q.customerId=c.id;
      q.customerSnap={...q.customerSnap, companyName:c.name, email:c.email, contact:c.contact, address:c.address,
        repName:c.repName||'', repPosition:c.repPosition||'', repContact:c.repContact||'', repEmail:c.repEmail||''};
      persistQuote(q); renderEditor(document.getElementById('content'), document.getElementById('topbarActions'));
    }
  };
  bindText('cClientName', v=>q.customerSnap.clientName=v, q);
  bindText('cClientPosition', v=>q.customerSnap.clientPosition=v, q);
  bindText('cCompanyName', v=>q.customerSnap.companyName=v, q);
  bindText('cCompanyTin', v=>q.customerSnap.companyTin=v, q);
  bindText('cEmail', v=>q.customerSnap.email=v, q);
  bindText('cContact', v=>q.customerSnap.contact=v, q);
  bindText('cAddress', v=>q.customerSnap.address=v, q);
  bindText('cRepName', v=>q.customerSnap.repName=v, q);
  bindText('cRepPosition', v=>q.customerSnap.repPosition=v, q);
  bindText('cRepContact', v=>q.customerSnap.repContact=v, q);
  bindText('cRepEmail', v=>q.customerSnap.repEmail=v, q);
  document.getElementById('cRepNA').addEventListener('change', (e)=>{
    q.customerSnap.repNA = e.target.checked;
    ['cRepName','cRepPosition','cRepContact','cRepEmail'].forEach(id=>{
      document.getElementById(id).disabled = e.target.checked;
    });
    persistQuote(q);
  });
  document.getElementById('pBuildType').addEventListener('change', (e)=>{ q.project.buildType = e.target.value; persistQuote(q); updateLiveSummary(q); });
  document.getElementById('pBoatApp').addEventListener('change', (e)=>{
    q.project.boatApplication = e.target.value;
    document.getElementById('pBoatAppOther').style.display = e.target.value==='Other' ? 'block' : 'none';
    persistQuote(q); updateLiveSummary(q);
  });
  bindText('pBoatAppOther', v=>q.project.boatApplicationOther=v, q);
  bindText('pRef', v=>q.refNo=v, q);
  document.getElementById('pRef').addEventListener('input', (e)=>{
    const dup = isDuplicateRefNo(e.target.value, q.id);
    e.target.classList.toggle('dup-error', dup);
    document.getElementById('pRefWarning').style.display = dup ? 'block' : 'none';
  });
  bindText('pDate', v=>q.date=v, q);
  bindText('pValid', v=>q.validityDays=Number(v), q);
  bindText('pNotes', v=>q.project.notes=v, q);
  bindText('pNumBoats', v=>q.project.numBoats=Math.max(1, Number(v)||1), q);
  bindText('pPaxCap', v=>q.project.passengerCapacity=Math.max(0, Number(v)||0), q);
  document.getElementById('pMultiply').addEventListener('change', (e)=>{
    q.project.multiplyPrice = e.target.checked; persistQuote(q); updateLiveSummary(q);
  });
}
function bindText(id, setter, q){
  const el = document.getElementById(id);
  el.addEventListener('input', ()=>{ setter(el.value); persistQuote(q); if(document.getElementById('liveSummary')) updateLiveSummary(q); });
}

/* ---- Tab: Hull ---- */
function tabHull(host, q){
  const h = q.hull;
  const loaFtIn = decToFtIn(h.loa), beamFtIn = decToFtIn(h.beam), depthFtIn = decToFtIn(h.depth);
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Hull Particulars</h3></div>
      <div class="card-body">
        <div class="grid g4">
          <div class="field"><label>Boat Model (name — LOA)</label>
            <select id="hBoatModel">${boatPickerOptions(q)}</select>
          </div>
          <div class="field"><label>Length Overall / LOA</label>
            <div style="display:flex;gap:5px;align-items:center;">
              <input type="number" step="any" id="hLoaFt" value="${loaFtIn.ft}" placeholder="ft" style="flex:1;min-width:0;">
              <span style="font-size:11px;color:var(--ink-faint);">ft</span>
              <input type="number" min="0" max="11" step="1" id="hLoaIn" value="${loaFtIn.inch}" placeholder="in" style="flex:1;min-width:0;">
              <span style="font-size:11px;color:var(--ink-faint);">in</span>
            </div>
          </div>
          <div class="field"><label>Beam</label>
            <div style="display:flex;gap:5px;align-items:center;">
              <input type="number" step="any" id="hBeamFt" value="${beamFtIn.ft}" placeholder="ft" style="flex:1;min-width:0;">
              <span style="font-size:11px;color:var(--ink-faint);">ft</span>
              <input type="number" min="0" max="11" step="1" id="hBeamIn" value="${beamFtIn.inch}" placeholder="in" style="flex:1;min-width:0;">
              <span style="font-size:11px;color:var(--ink-faint);">in</span>
            </div>
          </div>
          <div class="field"><label>Depth</label>
            <div style="display:flex;gap:5px;align-items:center;">
              <input type="number" step="any" id="hDepthFt" value="${depthFtIn.ft}" placeholder="ft" style="flex:1;min-width:0;">
              <span style="font-size:11px;color:var(--ink-faint);">ft</span>
              <input type="number" min="0" max="11" step="1" id="hDepthIn" value="${depthFtIn.inch}" placeholder="in" style="flex:1;min-width:0;">
              <span style="font-size:11px;color:var(--ink-faint);">in</span>
            </div>
          </div>
        </div>
        <div class="grid g3">
          <div class="field"><label>Number of Hulls</label><input type="number" id="hHulls" value="${h.numHulls}"></div>
          <div class="field"><label>Hull Area Override (sq ft)</label><input type="number" step="any" id="hAreaOv" value="${(h.hullAreaOverride==null||h.hullAreaOverride==='')?'':r4(h.hullAreaOverride*SQFT_PER_SQM)}" placeholder="auto"><div class="hint">Leave blank to auto-estimate from LOA and Beam</div></div>
          <div></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Core Material</h3></div>
      <div class="card-body">
        <div class="section-lead" style="margin-top:0;">Laminate layers and glass weight are set by the boat model's preset in Presets, not edited per-quotation.</div>
        <div class="grid g3">
          <div class="field"><label class="field-inline"><input type="checkbox" id="hCoreOn" ${h.coreEnabled?'checked':''} style="width:auto;"> Core Material</label>
            <input type="number" step="any" id="hCoreArea" value="${r4((Number(h.coreArea)||0)*SQFT_PER_SQM)}" placeholder="Core area (sq ft)" ${h.coreEnabled?'':'disabled'}>
          </div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Transom, Console &amp; Deck Presets</h3></div>
      <div class="card-body" id="addonPresetBody"></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Structural Components &amp; Core Materials</h3>
        <div style="display:flex;gap:8px;">
          <select id="structCatalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${PRICING.structuralCatalog.map((a,i)=>`<option value="${i}">${esc(a.name)} (${esc(a.unit)})</option>`).join('')}
          </select>
          <button class="btn btn-sm" id="addBlankStruct">${icon('plus')} Custom Item</button>
        </div>
      </div>
      <div class="card-body section-lead">Stiffeners, bulkheads, urethane foam, coring, and other structural materials — costed here and folded into Material Cost.</div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th>Item / Description</th><th style="width:90px;">Unit</th><th style="width:70px;">Qty</th><th style="width:110px;">Unit Price</th><th class="right" style="width:110px;">Total</th><th></th></tr></thead>
          <tbody id="structRows"></tbody>
        </table>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Hull Material Cost Breakdown</h3></div>
      <div class="card-body" id="hullCalcOut"></div>
    </div>
  `;
  const structBody = document.getElementById('structRows');
  function drawStruct(){
    // Always display grouped by category (fixed order) then alphabetically by
    // name, regardless of the order items were added in.
    const items = q.structural.items;
    const order = items.map((a,i)=>i).sort((i,j)=>compareStructuralItems(items[i], items[j]));
    const knownCats = getKnownStructuralCategories();
    structBody.innerHTML = order.length ? order.map(idx=>{
      const a = items[idx];
      const total = (Number(a.qty)||0)*(Number(a.unitPrice)||0);
      const catIsKnown = a.cat && knownCats.includes(a.cat);
      const catOptions = knownCats.map(c=>`<option value="${esc(c)}" ${a.cat===c?'selected':''}>${esc(c)}</option>`).join('');
      return `<tr>
        <td><input class="tbl-input srow" data-idx="${idx}" data-f="name" value="${esc(a.name)}">
          <input class="tbl-input srow" data-idx="${idx}" data-f="description" value="${esc(a.description||'')}" placeholder="Item description" style="margin-top:4px;"></td>
        <td><input class="tbl-input srow" data-idx="${idx}" data-f="unit" value="${esc(a.unit)}"></td>
        <td><input class="tbl-input num srow" type="number" data-idx="${idx}" data-f="qty" value="${a.qty}"></td>
        <td><input class="tbl-input num srow" type="number" data-idx="${idx}" data-f="unitPrice" value="${a.unitPrice}"></td>
        <td class="right mono">${fmt(total)}</td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delstruct="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="6"><div class="empty">No structural items yet. Add stiffeners, bulkheads, foam core, etc. from the catalog or as a custom line item.</div></td></tr>`;

    structBody.querySelectorAll('.srow').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const idx = Number(inp.dataset.idx);
        const a = q.structural.items[idx];
        a[inp.dataset.f] = ['qty','unitPrice'].includes(inp.dataset.f) ? Number(inp.value) : inp.value;
        persistQuote(q); drawHullCalc(); updateLiveSummary(q);
        // Only qty/unitPrice affect this row's total, and neither affects
        // sort order — patch the total cell instead of a full re-render,
        // which would otherwise steal keyboard focus after every keystroke.
        const total = (Number(a.qty)||0)*(Number(a.unitPrice)||0);
        const tr = inp.closest('tr');
        if(tr) tr.querySelector('td.right.mono').textContent = fmt(total);
      });
      // The name affects sort order (grouped alphabetically within category),
      // so only re-sort once the user is done editing this field, not on
      // every keystroke.
      if(inp.dataset.f === 'name'){
        inp.addEventListener('blur', ()=>{ drawStruct(); drawHullCalc(); updateLiveSummary(q); });
        inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); inp.blur(); } });
      }
      // Once the user finishes editing any field on a custom row, add it to
      // the shared Pricing Database catalog (if it isn't there already) so
      // it's selectable everywhere else too.
      inp.addEventListener('blur', ()=>{
        const idx = Number(inp.dataset.idx);
        const a = q.structural.items[idx];
        if(syncStructuralCatalog(a.cat, a.name, a.unit, a.unitPrice)) toast(`"${a.name}" added to the Pricing Database catalog`);
      });
    });
    structBody.querySelectorAll('[data-delstruct]').forEach(b=>b.onclick=()=>{
      q.structural.items.splice(Number(b.dataset.delstruct),1); persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
    });
  }
  document.getElementById('structCatalogPick').onchange = (e)=>{
    if(e.target.value==='') return;
    const item = PRICING.structuralCatalog[Number(e.target.value)];
    q.structural.items.push({id:uid('si'), cat:'', name:item.name, unit:item.unit, qty:1, unitPrice:item.unitPrice});
    e.target.value=''; persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
  };
  document.getElementById('addBlankStruct').onclick = ()=>{
    // No category preselected — the row's dropdown prompts a familiar/similar
    // category right away, or lets you type a new one.
    q.structural.items.push({id:uid('si'), cat:'', name:'New Item', unit:'pc', qty:1, unitPrice:0});
    persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
  };
  drawStruct();
  // Transom / Console / Deck & Superstructure presets: each adds tagged lines to the structural list.
  function drawAddonPresets(){
    const hostEl = document.getElementById('addonPresetBody');
    const applied = kind=>{
      const seen = new Map();
      (q.structural.items||[]).forEach(it=>{ if(it.presetType===kind && it.presetId && !seen.has(it.presetId)) seen.set(it.presetId, it.presetName||'Preset'); });
      return [...seen.entries()].map(([id,name])=>({id,name}));
    };
    hostEl.innerHTML = `<div class="grid g3">${['transom','console','deck'].map(kind=>{
      const meta = PRESET_KINDS[kind], list = addonPresets(kind), ap = applied(kind);
      const chips = ap.map(a=>`<span style="display:inline-flex;align-items:center;gap:6px;background:var(--paper);border-radius:999px;padding:4px 6px 4px 12px;font-size:12px;font-weight:600;margin:6px 6px 0 0;">${esc(a.name)} <span class="btn btn-ghost btn-sm" data-rmaddon="${kind}:${esc(a.id)}" title="Remove from quotation" style="padding:0 6px;color:var(--danger);">✕</span></span>`).join('');
      return `<div class="field"><label>${esc(meta.label)}</label>
        <select class="addon-pick" data-kind="${kind}">
          <option value="">${list.length ? (meta.single ? '— choose —' : '+ Add…') : 'No presets yet'}</option>
          ${list.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${fmt(presetTotalCost(p))})</option>`).join('')}
        </select>
        <div>${chips}</div></div>`;
    }).join('')}</div>
    <div class="hint" style="margin-top:10px;">Each preset adds its components as lines in the structural list below. Transom and Console hold one preset each (picking another replaces it); Deck &amp; Superstructure can hold several (canopy, cabin…). Create presets in the Presets page.</div>`;
    hostEl.querySelectorAll('.addon-pick').forEach(sel=>sel.onchange = ()=>{
      const kind = sel.dataset.kind, p = TEMPLATES.find(x=>x.id===sel.value);
      if(!p) return;
      let items = q.structural.items||[];
      if(PRESET_KINDS[kind].single) items = items.filter(it=>it.presetType!==kind);
      else if(items.some(it=>it.presetId===p.id)){ toast(`"${p.name}" is already on this quotation`); sel.value=''; return; }
      q.structural.items = [...items, ...addonPresetToQuoteItems(p)];
      persistQuote(q); drawAddonPresets(); drawStruct(); drawHullCalc(); updateLiveSummary(q);
    });
    hostEl.querySelectorAll('[data-rmaddon]').forEach(b=>b.onclick = ()=>{
      const [kind, id] = b.dataset.rmaddon.split(':');
      q.structural.items = (q.structural.items||[]).filter(it=>!(it.presetType===kind && it.presetId===id));
      persistQuote(q); drawAddonPresets(); drawStruct(); drawHullCalc(); updateLiveSummary(q);
    });
  }
  drawAddonPresets();
  document.getElementById('hBoatModel').addEventListener('change', (e)=>{
    const v = e.target.value;
    const preset = v.indexOf('m:')===0 ? null : TEMPLATES.find(t=>t.id===v);
    q.project.boatModel = preset ? preset.boatModel : v.replace(/^m:/,'');
    q.project.boatPresetId = preset ? preset.id : null;
    if(preset){
      q.hull = { boatType:preset.boatType, loa:preset.loa, beam:preset.beam, depth:preset.depth, numHulls:preset.numHulls||1, hullAreaOverride:null, layers:0, glassPerLayer:0, coreArea:q.hull.coreArea||0, coreEnabled:q.hull.coreEnabled||false, work:null, noLaminate:true };
      q.paint.items = (preset.paintComponents||[]).map(presetPaintToQuoteItem);
      if(!q.structural) q.structural = { items:[] };
      { const addons = (q.structural.items||[]).filter(i=>i.presetType); q.structural.items = [...boatComponentsToQuoteItems(preset), ...addons]; }
      persistQuote(q); tabHull(host, q); updateLiveSummary(q);
      toast(`Preset applied: ${preset.name}`);
    } else {
      persistQuote(q); updateLiveSummary(q);
    }
  });
  function syncFtIn(ftId, inId, apply){
    const ft = Number(document.getElementById(ftId).value)||0;
    const inch = Number(document.getElementById(inId).value)||0;
    apply(ftInToDec(ft, inch));
    persistQuote(q); drawHullCalc(); updateLiveSummary(q);
  }
  ['hLoaFt','hLoaIn'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=> syncFtIn('hLoaFt','hLoaIn', v=>{ h.loa=v; }));
  });
  ['hBeamFt','hBeamIn'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=> syncFtIn('hBeamFt','hBeamIn', v=>{ h.beam=v; }));
  });
  ['hDepthFt','hDepthIn'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=> syncFtIn('hDepthFt','hDepthIn', v=>{ h.depth=v; }));
  });
  ['hHulls','hAreaOv','hCoreArea'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      // areas are stored in sqm; the fields show sq ft. Only convert the field being edited.
      if(id==='hHulls') h.numHulls = Number(document.getElementById('hHulls').value)||1;
      if(id==='hAreaOv'){ const ov = document.getElementById('hAreaOv').value; h.hullAreaOverride = ov===''? null : Number(ov)/SQFT_PER_SQM; }
      if(id==='hCoreArea') h.coreArea = (Number(document.getElementById('hCoreArea').value)||0)/SQFT_PER_SQM;
      persistQuote(q); drawHullCalc(); updateLiveSummary(q);
    });
  });
  document.getElementById('hCoreOn').addEventListener('change', (e)=>{
    h.coreEnabled = e.target.checked; document.getElementById('hCoreArea').disabled = !h.coreEnabled;
    persistQuote(q); drawHullCalc(); updateLiveSummary(q);
  });
  function drawHullCalc(){
    const c = computeHull(q);
    const s = computeStructural(q);
    document.getElementById('hullCalcOut').innerHTML = `
      <table>
        <tbody>
          ${c.useWork ? `
          <tr><td>Hull Labor (from Boat Preset formula)</td><td class="right mono">${fmt(computeLaborCost(q.hull.work))}</td></tr>
          <tr><td>Hull Materials (from Boat Preset formula)</td><td class="right mono">${fmt(materialLinesCost(q.hull.work))}</td></tr>` : c.noLaminate ? '' : `
          <tr><td>Fiberglass Cost</td><td class="right mono">${fmt(c.glassCost)}</td></tr>
          <tr><td>Resin Cost</td><td class="right mono">${fmt(c.resinCost)}</td></tr>
          <tr><td>Gelcoat Cost</td><td class="right mono">${fmt(c.gelcoatCost)}</td></tr>`}
          <tr><td>Core Material Cost</td><td class="right mono">${fmt(c.coreCost)}</td></tr>
          <tr><td style="font-weight:700;">Laminate Cost Subtotal</td><td class="right mono" style="font-weight:700;">${fmt(c.total)}</td></tr>
          <tr><td>Structural Components (stiffeners, bulkheads, foam, etc.)</td><td class="right mono">${fmt(s.total)}</td></tr>
          <tr><td style="font-weight:700;">Hull &amp; Structural Material Cost Total</td><td class="right mono" style="font-weight:700;">${fmt(c.total + s.total)}</td></tr>
        </tbody>
      </table>`;
  }
  drawHullCalc();
}

/* ---- Tab: Paint ---- */
function tabPaint(host, q){
  if(!q.paint.items) q.paint.items = [];
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Surface Finishing &amp; Painting</h3>
        <button class="btn btn-sm" id="addPaintItem">${icon('plus')} Add Paint</button>
      </div>
      <div class="section-lead" style="padding:10px 20px 0;">Clicking "Add Paint" adds a 1st, 2nd, and 3rd Coat row together — edit the Type/Color/Area/Price for each. Leave Area blank to use the hull's calculated surface area automatically. Lines marked "lot" come from the Boat Model's Painting Components (labor + materials) and are priced there.</div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th style="width:80px;">Coat</th><th style="width:18%;">Type</th><th style="width:14%;">Color</th><th style="width:90px;">Area (sq ft)</th><th style="width:100px;">Price/sq ft</th><th class="right" style="width:110px;">Cost</th><th></th></tr></thead>
          <tbody id="paintRows"></tbody>
        </table>
      </div>
    </div>
  `;
  const rowsBody = document.getElementById('paintRows');
  function draw(){
    const hull = computeHull(q);
    const c = computePaint(q, hull);
    rowsBody.innerHTML = c.rows.length ? c.rows.map((r,idx)=>`
      <tr>
        <td><input class="tbl-input prow" data-idx="${idx}" data-f="coatLabel" value="${esc(r.coatLabel||'')}" placeholder="e.g. 1st Coat"></td>
        <td><input class="tbl-input prow" data-idx="${idx}" data-f="type" value="${esc(r.type)}"></td>
        <td><input class="tbl-input prow" data-idx="${idx}" data-f="color" value="${esc(r.color)}"></td>
        ${r.presetPaint ? `<td class="right" style="color:var(--ink-faint);" title="Priced as a lot by the Boat Model's Painting Components">lot</td><td class="right" style="color:var(--ink-faint);">—</td>` : `<td><input type="number" step="any" class="tbl-input num prow" data-idx="${idx}" data-f="area" value="${(q.paint.items[idx].area==null||q.paint.items[idx].area==='')?'':r4(q.paint.items[idx].area*SQFT_PER_SQM)}" placeholder="${fmtNum(sqft(hull.area),1)}"></td>
        <td><input type="number" step="any" class="tbl-input num prow" data-idx="${idx}" data-f="pricePerSqm" value="${r4((Number(r.pricePerSqm)||0)/SQFT_PER_SQM)}"></td>`}
        <td class="right mono">${fmt(r.cost)}</td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delpaint="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`).join('') : `<tr><td colspan="7"><div class="empty">No paint items yet. Click "Add Paint" to add a 1st/2nd/3rd Coat set.</div></td></tr>`;

    rowsBody.querySelectorAll('.prow').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const idx = Number(inp.dataset.idx);
        const item = q.paint.items[idx];
        const f = inp.dataset.f;
        if(f==='area') item.area = inp.value===''? null : Number(inp.value)/SQFT_PER_SQM;     // stored in sqm
        else if(f==='pricePerSqm') item[f] = Number(inp.value)*SQFT_PER_SQM;                  // stored per sqm
        else item[f] = inp.value;
        persistQuote(q); updateLiveSummary(q);
        // Patch just this row's Cost cell instead of a full redraw, so
        // typing in Coat/Type/Color doesn't lose focus after every keystroke.
        const hull2 = computeHull(q);
        const area = (item.area!=null && item.area!=='') ? Number(item.area) : hull2.area;
        const cost = item.presetPaint ? (Number(item.lumpCost)||0) : area * (Number(item.pricePerSqm)||0);
        const tr = inp.closest('tr');
        if(tr) tr.children[5].textContent = fmt(cost);
      });
    });
    rowsBody.querySelectorAll('[data-delpaint]').forEach(b=>b.onclick=()=>{
      q.paint.items.splice(Number(b.dataset.delpaint),1); persistQuote(q); draw(); updateLiveSummary(q);
    });
  }
  document.getElementById('addPaintItem').onclick = ()=>{
    ['1st Coat','2nd Coat','3rd Coat'].forEach(label=>{
      q.paint.items.push({id:uid('pi'), coatLabel:label, type:'New Paint Type', color:'', area:null, pricePerSqm:60});
    });
    persistQuote(q); draw(); updateLiveSummary(q);
  };
  draw();
}

/* Category suggestions for Special Features: the default heading, categories typed on any quotation's
   special features, and the regular accessory categories. Typing a new name simply creates it. */
function sfKnownCategories(q){
  const set = new Set([SPECIAL_FEATURES_CAT]);
  (QUOTES||[]).concat(q?[q]:[]).forEach(qt=>{ ((qt.specialFeatures&&qt.specialFeatures.items)||[]).forEach(a=>{ if(a.cat && String(a.cat).trim()) set.add(String(a.cat).trim()); }); });
  getKnownAccessoryCategories().forEach(c=>{ if(c!=='Custom') set.add(c); });
  return [...set];
}

/* ---- Tab: Accessories ---- */
function tabAccessories(host, q){
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Accessories &amp; Boat Components</h3>
        <div style="display:flex;gap:8px;">
          <select id="catalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${PRICING.accessoryCatalog.map((a,i)=>REMOVED_ACCESSORY_CATEGORIES.includes(a.cat) ? '' : `<option value="${i}">${esc(a.cat)} — ${esc(a.name)}</option>`).join('')}
          </select>
          <button class="btn btn-sm" id="addBlankItem">${icon('plus')} Custom Item</button>
        </div>
      </div>
      <div class="section-lead" style="padding:10px 20px 0;">Items are grouped and sorted by category automatically — add them in any order you like.</div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th style="width:16%;">Category</th><th>Item / Description</th><th style="width:60px;">Unit</th><th style="width:60px;">Qty</th><th style="width:100px;">Unit Price</th><th style="width:65px;">Markup %</th><th class="right" style="width:100px;">Total</th><th></th></tr></thead>
          <tbody id="accRows"></tbody>
        </table>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Special Features / Accessories</h3></div>
      <div class="card-body">
        <label class="field-inline" style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="sfEnable" ${q.specialFeatures.enabled?'checked':''} style="width:auto;">
          This quotation has special features / accessories
        </label>
        <div class="hint" style="margin-top:4px;">For accessories that are not common to our builds or designs. Leave unchecked and this section stays hidden, is not charged, and does not print.</div>
        <div id="sfBody" style="${q.specialFeatures.enabled?'':'display:none;'}margin-top:12px;">
          <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
            <button class="btn btn-sm" id="sfAdd">${icon('plus')} Add Special Feature</button>
          </div>
          <datalist id="sfCatList">${sfKnownCategories(q).map(c=>`<option value="${esc(c)}"></option>`).join('')}</datalist>
          <table><thead><tr><th style="width:21%;">Category</th><th>Item / Description</th><th style="width:70px;">Unit</th><th style="width:70px;">Qty</th><th style="width:110px;">Unit Price</th><th style="width:75px;">Markup %</th><th class="right" style="width:110px;">Total</th><th></th></tr></thead>
            <tbody id="sfRows"></tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Not Applicable Sections</h3></div>
      <div class="card-body">
        <div class="section-lead" style="margin-top:0;">Check any section that doesn't apply to this boat — the printed quotation will show "Not Applicable" there instead of an item list.</div>
        <div style="display:flex;flex-wrap:wrap;gap:16px 28px;">
          ${PRINTED_ACCESSORY_SECTIONS.map(cat=>`
            <label class="field-inline" style="font-size:12.5px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;">
              <input type="checkbox" class="naCheck" data-cat="${esc(cat)}" ${q.accessoryCategoryNA[cat]?'checked':''} style="width:auto;">
              ${esc(cat)}
            </label>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  const rowsBody = document.getElementById('accRows');
  function draw(){
    // Always display grouped by category (fixed sensible order) then
    // alphabetically by name, regardless of the order items were added in.
    const order = q.accessories.map((a,i)=>i).sort((i,j)=>compareAccessoryItems(q.accessories[i], q.accessories[j]));
    const knownCats = getKnownAccessoryCategories();
    rowsBody.innerHTML = order.length ? order.map(idx=>{
      const a = q.accessories[idx];
      const total = (Number(a.qty)||0)*(Number(a.unitPrice)||0)*(1+(Number(a.markup)||0)/100);
      const catIsKnown = a.cat && knownCats.includes(a.cat);
      const catOptions = knownCats.map(c=>`<option value="${esc(c)}" ${a.cat===c?'selected':''}>${esc(c)}</option>`).join('');
      return `<tr>
        <td>
          <select class="tbl-input arow-cat" data-idx="${idx}">
            <option value="" ${a.cat?'':'selected'}>— choose category —</option>
            ${catOptions}
            ${a.cat && !catIsKnown ? `<option value="${esc(a.cat)}" selected>${esc(a.cat)}</option>` : ''}
            <option value="__new__">+ New category…</option>
          </select>
          <input type="text" class="tbl-input arow-cat-new" data-idx="${idx}" placeholder="Type new category, e.g. Lighting" style="display:none;margin-top:4px;">
        </td>
        <td><input class="tbl-input arow" data-idx="${idx}" data-f="name" value="${esc(a.name)}"></td>
        <td><input class="tbl-input arow" data-idx="${idx}" data-f="unit" value="${esc(a.unit||'pc')}"></td>
        <td><input class="tbl-input num arow" type="number" data-idx="${idx}" data-f="qty" value="${a.qty}"></td>
        <td><input class="tbl-input num arow" type="number" data-idx="${idx}" data-f="unitPrice" value="${a.unitPrice}"></td>
        <td><input class="tbl-input num arow" type="number" data-idx="${idx}" data-f="markup" value="${a.markup}"></td>
        <td class="right mono">${fmt(total)}</td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delrow="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">No accessory items yet. Add from the catalog or add a custom line item.</div></td></tr>`;

    rowsBody.querySelectorAll('.arow-cat').forEach(sel=>{
      sel.addEventListener('change', ()=>{
        const idx = Number(sel.dataset.idx);
        const newInput = rowsBody.querySelector(`.arow-cat-new[data-idx="${idx}"]`);
        if(sel.value === '__new__'){
          sel.style.display = 'none';
          newInput.style.display = 'block';
          newInput.focus();
          return;
        }
        q.accessories[idx].cat = sel.value;
        persistQuote(q); draw(); updateLiveSummary(q);
      });
    });
    rowsBody.querySelectorAll('.arow-cat-new').forEach(inp=>{
      const commit = ()=>{
        const idx = Number(inp.dataset.idx);
        const v = inp.value.trim();
        if(v){ q.accessories[idx].cat = v; }
        persistQuote(q); draw(); updateLiveSummary(q);
      };
      inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); commit(); } });
      inp.addEventListener('blur', commit);
    });
    rowsBody.querySelectorAll('.arow').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const idx = Number(inp.dataset.idx);
        const a = q.accessories[idx];
        a[inp.dataset.f] = ['qty','unitPrice','markup'].includes(inp.dataset.f) ? Number(inp.value) : inp.value;
        persistQuote(q); updateLiveSummary(q);
        // Only qty/unitPrice/markup affect this row's total, and none of
        // them affect sort order — patch the total cell instead of a full
        // re-render, which would otherwise steal keyboard focus after every
        // keystroke.
        const total = (Number(a.qty)||0)*(Number(a.unitPrice)||0)*(1+(Number(a.markup)||0)/100);
        const tr = inp.closest('tr');
        if(tr) tr.querySelector('td.right.mono').textContent = fmt(total);
      });
      // The name affects sort order (grouped alphabetically within category),
      // so only re-sort once the user is done editing this field, not on
      // every keystroke.
      if(inp.dataset.f === 'name'){
        inp.addEventListener('blur', ()=>{ draw(); updateLiveSummary(q); });
        inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); inp.blur(); } });
      }
      // Once the user finishes editing any field on a custom row, add it to
      // the shared Pricing Database catalog (if it isn't there already) so
      // it's selectable everywhere else too.
      inp.addEventListener('blur', ()=>{
        const idx = Number(inp.dataset.idx);
        const a = q.accessories[idx];
        if(syncAccessoryCatalog(a.cat, a.name, a.unitPrice)) toast(`"${a.name}" added to the Pricing Database catalog`);
      });
    });
    rowsBody.querySelectorAll('[data-delrow]').forEach(b=>b.onclick=()=>{
      q.accessories.splice(Number(b.dataset.delrow),1); persistQuote(q); draw(); updateLiveSummary(q);
    });
  }
  document.getElementById('catalogPick').onchange = (e)=>{
    if(e.target.value===''){ return; }
    const item = PRICING.accessoryCatalog[Number(e.target.value)];
    q.accessories.push({id:uid('ai'), cat:item.cat, name:item.name, unit:'pc', qty:1, unitPrice:item.unitPrice, markup:15});
    e.target.value=''; persistQuote(q); draw(); updateLiveSummary(q);
  };
  document.getElementById('addBlankItem').onclick = ()=>{
    // No category preselected — the row's dropdown prompts the user to pick
    // a familiar/similar category, or type a new one, right away.
    q.accessories.push({id:uid('ai'), cat:'', name:'New Item', unit:'pc', qty:1, unitPrice:0, markup:15});
    persistQuote(q); draw(); updateLiveSummary(q);
  };
  // ---- Special Features / Accessories: checkbox reveals the details; unchecked = hidden, uncharged, unprinted ----
  (function(){
    const sf = q.specialFeatures;
    const body = document.getElementById('sfBody'), rows = document.getElementById('sfRows');
    const rowTotal = a => (Number(a.qty)||0)*(Number(a.unitPrice)||0)*(1+(Number(a.markup)||0)/100);
    function drawSF(){
      rows.innerHTML = sf.items.length ? sf.items.map((a,idx)=>`<tr>
        <td><input class="tbl-input sfrow" list="sfCatList" data-idx="${idx}" data-f="cat" value="${esc(a.cat||'')}" placeholder="${esc(SPECIAL_FEATURES_CAT)}"></td>
        <td><input class="tbl-input sfrow" data-idx="${idx}" data-f="name" value="${esc(a.name||'')}" placeholder="e.g. Dive compressor mount, deck winch"></td>
        <td><input class="tbl-input sfrow" data-idx="${idx}" data-f="unit" value="${esc(a.unit||'pc')}"></td>
        <td><input class="tbl-input num sfrow" type="number" data-idx="${idx}" data-f="qty" value="${Number(a.qty)||0}"></td>
        <td><input class="tbl-input num sfrow" type="number" data-idx="${idx}" data-f="unitPrice" value="${Number(a.unitPrice)||0}"></td>
        <td><input class="tbl-input num sfrow" type="number" data-idx="${idx}" data-f="markup" value="${Number(a.markup)||0}"></td>
        <td class="right mono">${fmt(rowTotal(a))}</td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delsf="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`).join('') : `<tr><td colspan="8"><div class="empty">No special features yet. Click "Add Special Feature".</div></td></tr>`;
      rows.querySelectorAll('.sfrow').forEach(inp=>inp.addEventListener('input', ()=>{
        const a = sf.items[Number(inp.dataset.idx)], f = inp.dataset.f;
        a[f] = (f==='qty'||f==='unitPrice'||f==='markup') ? Number(inp.value) : inp.value;
        const tr = inp.closest('tr'); if(tr) tr.children[6].textContent = fmt(rowTotal(a));   // patch the total only, so typing keeps focus
        persistQuote(q); updateLiveSummary(q);
      }));
      rows.querySelectorAll('[data-delsf]').forEach(b=>b.onclick=()=>{
        sf.items.splice(Number(b.dataset.delsf),1); persistQuote(q); drawSF(); updateLiveSummary(q);
      });
    }
    document.getElementById('sfEnable').addEventListener('change', e=>{
      sf.enabled = e.target.checked;
      body.style.display = sf.enabled ? '' : 'none';
      if(sf.enabled && !sf.items.length) sf.items.push({id:uid('sf'), cat:'', name:'', unit:'pc', qty:1, unitPrice:0, markup:15});
      drawSF(); persistQuote(q); updateLiveSummary(q);
    });
    document.getElementById('sfAdd').onclick = ()=>{
      sf.items.push({id:uid('sf'), cat:'', name:'', unit:'pc', qty:1, unitPrice:0, markup:15});
      drawSF(); persistQuote(q); updateLiveSummary(q);
    };
    drawSF();
  })();
  draw();
  document.querySelectorAll('.naCheck').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      q.accessoryCategoryNA[cb.dataset.cat] = cb.checked;
      persistQuote(q);
    });
  });
}

/* ---- Tab: Testing & Delivery ---- */
function tabTesting(host, q){
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Testing &amp; Delivery</h3>
        <button class="btn btn-sm" id="addTestingItem">${icon('plus')} Add Custom Item</button>
      </div>
      <div class="section-lead" style="padding:10px 20px 0;">Covers Trailer, Delivery, and Sea Trial line items — add any others you need too. Items are grouped and sorted by category automatically.</div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th style="width:16%;">Category</th><th>Item / Description</th><th style="width:60px;">Unit</th><th style="width:60px;">Qty</th><th style="width:100px;">Unit Price</th><th style="width:65px;">Markup %</th><th class="right" style="width:100px;">Total</th><th></th></tr></thead>
          <tbody id="testRows"></tbody>
        </table>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Not Applicable Sections</h3></div>
      <div class="card-body">
        <div class="section-lead" style="margin-top:0;">Check any section that doesn't apply to this boat — the printed quotation will show "Not Applicable" there instead of an item list.</div>
        <div style="display:flex;flex-wrap:wrap;gap:16px 28px;">
          ${PRINTED_TESTING_DELIVERY_SECTIONS.map(cat=>`
            <label class="field-inline" style="font-size:12.5px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;">
              <input type="checkbox" class="testNaCheck" data-cat="${esc(cat)}" ${q.testingDeliveryNA[cat]?'checked':''} style="width:auto;">
              ${esc(cat)}
            </label>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  const rowsBody = document.getElementById('testRows');
  function draw(){
    const order = q.testingDelivery.map((a,i)=>i).sort((i,j)=>compareTestingItems(q.testingDelivery[i], q.testingDelivery[j]));
    const knownCats = getKnownTestingCategories();
    rowsBody.innerHTML = order.length ? order.map(idx=>{
      const a = q.testingDelivery[idx];
      const total = (Number(a.qty)||0)*(Number(a.unitPrice)||0)*(1+(Number(a.markup)||0)/100);
      const catIsKnown = a.cat && knownCats.includes(a.cat);
      const catOptions = knownCats.map(c=>`<option value="${esc(c)}" ${a.cat===c?'selected':''}>${esc(c)}</option>`).join('');
      return `<tr>
        <td>
          <select class="tbl-input trow-cat" data-idx="${idx}">
            <option value="" ${a.cat?'':'selected'}>— choose category —</option>
            ${catOptions}
            ${a.cat && !catIsKnown ? `<option value="${esc(a.cat)}" selected>${esc(a.cat)}</option>` : ''}
            <option value="__new__">+ New category…</option>
          </select>
          <input type="text" class="tbl-input trow-cat-new" data-idx="${idx}" placeholder="Type new category" style="display:none;margin-top:4px;">
        </td>
        <td><input class="tbl-input trow" data-idx="${idx}" data-f="name" value="${esc(a.name)}"></td>
        <td><input class="tbl-input trow" data-idx="${idx}" data-f="unit" value="${esc(a.unit||'pc')}"></td>
        <td><input class="tbl-input num trow" type="number" data-idx="${idx}" data-f="qty" value="${a.qty}"></td>
        <td><input class="tbl-input num trow" type="number" data-idx="${idx}" data-f="unitPrice" value="${a.unitPrice}"></td>
        <td><input class="tbl-input num trow" type="number" data-idx="${idx}" data-f="markup" value="${a.markup}"></td>
        <td class="right mono">${fmt(total)}</td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delrow="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">No items yet. Add a Trailer, Delivery, Sea Trial, or custom line item.</div></td></tr>`;

    rowsBody.querySelectorAll('.trow-cat').forEach(sel=>{
      sel.addEventListener('change', ()=>{
        const idx = Number(sel.dataset.idx);
        const newInput = rowsBody.querySelector(`.trow-cat-new[data-idx="${idx}"]`);
        if(sel.value === '__new__'){
          sel.style.display = 'none';
          newInput.style.display = 'block';
          newInput.focus();
          return;
        }
        q.testingDelivery[idx].cat = sel.value;
        persistQuote(q); draw(); updateLiveSummary(q);
      });
    });
    rowsBody.querySelectorAll('.trow-cat-new').forEach(inp=>{
      const commit = ()=>{
        const idx = Number(inp.dataset.idx);
        const v = inp.value.trim();
        if(v){ q.testingDelivery[idx].cat = v; }
        persistQuote(q); draw(); updateLiveSummary(q);
      };
      inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); commit(); } });
      inp.addEventListener('blur', commit);
    });
    rowsBody.querySelectorAll('.trow').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const idx = Number(inp.dataset.idx);
        const a = q.testingDelivery[idx];
        a[inp.dataset.f] = ['qty','unitPrice','markup'].includes(inp.dataset.f) ? Number(inp.value) : inp.value;
        persistQuote(q); updateLiveSummary(q);
        const total = (Number(a.qty)||0)*(Number(a.unitPrice)||0)*(1+(Number(a.markup)||0)/100);
        const tr = inp.closest('tr');
        if(tr) tr.querySelector('td.right.mono').textContent = fmt(total);
      });
      if(inp.dataset.f === 'name'){
        inp.addEventListener('blur', ()=>{ draw(); updateLiveSummary(q); });
        inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); inp.blur(); } });
      }
    });
    rowsBody.querySelectorAll('[data-delrow]').forEach(b=>b.onclick=()=>{
      q.testingDelivery.splice(Number(b.dataset.delrow),1); persistQuote(q); draw(); updateLiveSummary(q);
    });
  }
  document.getElementById('addTestingItem').onclick = ()=>{
    q.testingDelivery.push({id:uid('ti'), cat:'', name:'New Item', unit:'pc', qty:1, unitPrice:0, markup:0});
    persistQuote(q); draw(); updateLiveSummary(q);
  };
  draw();
  document.querySelectorAll('.testNaCheck').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      q.testingDeliveryNA[cb.dataset.cat] = cb.checked;
      persistQuote(q);
    });
  });
}

/* ---- Tab: Marine Propulsion System ---- */
const PROPULSION_TYPES = [
  { value:'OBM', label:'Outboard Motor (OBM)', showDrive:false },
  { value:'IBM', label:'Inboard Motor (IBM)', showDrive:true },
  { value:'Sterndrive', label:'Sterndrive (I/O)', showDrive:true },
  { value:'Jet', label:'Jet Drive', showDrive:false },
];
function propulsionShowsDrive(type){
  const t = PROPULSION_TYPES.find(p=>p.value===type);
  return t ? t.showDrive : type==='IBM';
}

function tabEngine(host, q){
  const e = q.engine;
  if(!PROPULSION_TYPES.some(p=>p.value===e.type)) e.type = 'IBM';
  const showDrive = propulsionShowsDrive(e.type);
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Marine Propulsion System</h3></div>
      <div class="card-body">
        <div class="field" style="max-width:360px;"><label>Category *</label>
          <select id="eType">
            ${PROPULSION_TYPES.map(p=>`<option value="${p.value}" ${e.type===p.value?'selected':''}>${p.label}</option>`).join('')}
          </select>
          <div class="hint">Outboard (OBM) hides Transmission and Propeller. Inboard and Sterndrive show them.</div>
        </div>
        <div class="grid g3">
          <div class="field"><label>Brand</label><input id="eBrand" value="${esc(e.brand||'')}" placeholder="e.g. Isuzu, Yamaha"><div class="hint">Used in the auto-generated project title.</div></div>
          <div class="field"><label>Model / Description</label><input id="eModel" value="${esc(e.model)}"></div>
          <div class="field"><label>Horsepower (HP)</label><input type="number" id="eHp" value="${e.hp}"></div>
          <div class="field"><label>Number of Units</label><input type="number" id="eQty" value="${e.qty}"></div>
          <div class="field"><label>Fuel Capacity</label><input id="eFuelCap" value="${esc(e.fuelCapacity||'')}" placeholder="e.g. 200 liters"></div>
        </div>
        <div class="grid g2" id="eDriveFields" style="${showDrive?'':'display:none;'}">
          <div class="field"><label>Transmission</label><input id="eTrans" value="${esc(e.transmission)}"></div>
          <div class="field"><label>Propeller</label><input id="eProp" value="${esc(e.propeller)}"></div>
        </div>
        <div class="field"><label>Intro / Spec Paragraph</label><textarea id="eDesc" rows="4" placeholder="e.g. Dual Installation of Yamaha 250HP, Model: F250HETX...">${esc(e.description||'')}</textarea>
          <div class="hint">Prints as an intro paragraph above the inclusion lists under Marine Propulsion System.</div>
        </div>
        <div class="field" style="max-width:280px;"><label>Amount (₱)</label><input type="number" id="ePrice" value="${e.unitPrice}"><div class="hint">Total propulsion cost for all units — it is not multiplied by the number of units.</div></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Inclusions</h3>
        <div style="display:flex;gap:8px;">
          <select id="inclCatalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${ENGINE_INCLUSIONS_CATALOG.map((a,i)=>`<option value="${i}">${esc(a)}</option>`).join('')}
          </select>
          <button class="btn btn-sm" id="addBlankIncl">${icon('plus')} Custom Item</button>
        </div>
      </div>
      <div class="card-body section-lead">Items bundled with the propulsion package — printed as a bullet list under Marine Propulsion System.</div>
      <div class="card-body" style="padding:0;" id="inclRows"></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Propulsion Cost Summary</h3></div>
      <div class="card-body" id="engineCalcOut"></div>
    </div>
  `;
  function readEngineFields(){
    e.brand = document.getElementById('eBrand').value;
    e.model = document.getElementById('eModel').value;
    e.hp = Number(document.getElementById('eHp').value);
    e.qty = Number(document.getElementById('eQty').value);
    e.unitPrice = Number(document.getElementById('ePrice').value);
    e.fuelCapacity = document.getElementById('eFuelCap').value;
    e.description = document.getElementById('eDesc').value;
    const transEl = document.getElementById('eTrans');
    const propEl = document.getElementById('eProp');
    if(transEl) e.transmission = transEl.value;
    if(propEl) e.propeller = propEl.value;
    if(!propulsionShowsDrive(e.type)){ e.transmission = ''; e.propeller = ''; }
  }
  ['eBrand','eModel','eHp','eQty','ePrice','eFuelCap','eDesc'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      readEngineFields();
      persistQuote(q); drawEng(); updateLiveSummary(q);
    });
  });
  ['eTrans','eProp'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', ()=>{
      readEngineFields();
      persistQuote(q); drawEng(); updateLiveSummary(q);
    });
  });
  document.getElementById('eType').addEventListener('change', ()=>{
    e.type = document.getElementById('eType').value;
    const drive = document.getElementById('eDriveFields');
    const show = propulsionShowsDrive(e.type);
    if(drive) drive.style.display = show ? '' : 'none';
    if(!show){ e.transmission = ''; e.propeller = ''; }
    persistQuote(q); updateLiveSummary(q);
  });

  // Simple item-list renderer, used for the Inclusions list —
  // simple bundled/included items (no qty or price of their own).
  function drawItemList(containerId, list){
    const body = document.getElementById(containerId);
    body.innerHTML = list.length ? `<table><tbody>${list.map((name,idx)=>`
      <tr>
        <td><input class="tbl-input ilist" data-container="${containerId}" data-idx="${idx}" value="${esc(name)}"></td>
        <td class="right" style="width:44px;"><span class="btn btn-ghost btn-sm" data-delitem="${containerId}:${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`).join('')}</tbody></table>` : `<div class="empty" style="padding:14px 20px;">No items added yet.</div>`;
    body.querySelectorAll('.ilist').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        list[Number(inp.dataset.idx)] = inp.value;
        persistQuote(q); updateLiveSummary(q);
      });
    });
    body.querySelectorAll('[data-delitem]').forEach(b=>{
      b.onclick = ()=>{
        const [cid, idx] = b.dataset.delitem.split(':');
        e.inclusions.splice(Number(idx),1);
        persistQuote(q); drawItemList('inclRows', e.inclusions); updateLiveSummary(q);
      };
    });
  }
  document.getElementById('inclCatalogPick').onchange = (ev)=>{
    if(ev.target.value==='') return;
    e.inclusions.push(ENGINE_INCLUSIONS_CATALOG[Number(ev.target.value)]);
    ev.target.value=''; persistQuote(q); drawItemList('inclRows', e.inclusions); updateLiveSummary(q);
  };
  document.getElementById('addBlankIncl').onclick = ()=>{
    e.inclusions.push('New Item');
    persistQuote(q); drawItemList('inclRows', e.inclusions); updateLiveSummary(q);
  };
  drawItemList('inclRows', e.inclusions);

  function drawEng(){
    const c = computeEngine(q);
    document.getElementById('engineCalcOut').innerHTML = `
      <table><tbody>
        <tr><td>Propulsion amount (${e.qty} unit${Number(e.qty)===1?'':'s'})</td><td class="right mono">${fmt(c.unitsCost)}</td></tr>
        <tr><td style="font-weight:700;">Marine Propulsion System Total</td><td class="right mono" style="font-weight:700;">${fmt(c.total)}</td></tr>
      </tbody></table>`;
  }
  drawEng();
}

/* ---- Tab: MARINA Documentation ---- */
function tabMarina(host, q){
  const m = q.marina;
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>MARINA Documentation &amp; Regulatory Requirements</h3>
        <button class="btn btn-sm" id="addMarinaItem">${icon('plus')} Add Requirement</button>
      </div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th>Requirement / Certificate</th><th style="width:160px;">Price (₱)</th><th></th></tr></thead>
          <tbody id="marinaRows"></tbody>
          <tfoot><tr><td class="right" style="font-weight:600;">Total</td><td class="right mono" id="marinaTotal" style="font-weight:600;"></td><td></td></tr></tfoot>
        </table>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Notes for Quotation Output</h3></div>
      <div class="card-body">
        <div class="field"><textarea id="marinaNotes" rows="4">${esc(m.notes)}</textarea></div>
        <div class="hint">This section prints on the quotation document as "MARINA Documentation &amp; Regulatory Requirements", right after Marine Propulsion System. Only the requirement names and the total price show on the printed document.</div>
      </div>
    </div>
  `;
  const rowsBody = document.getElementById('marinaRows');
  const totalEl = document.getElementById('marinaTotal');
  function draw(){
    rowsBody.innerHTML = m.items.length ? m.items.map((it,idx)=>`
      <tr>
        <td><input class="tbl-input mrow" data-idx="${idx}" data-f="name" value="${esc(it.name)}"></td>
        <td><input type="number" class="tbl-input mrow" data-idx="${idx}" data-f="price" value="${it.price||0}"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delm="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`).join('') : `<tr><td colspan="3"><div class="empty">No MARINA requirements listed yet.</div></td></tr>`;
    rowsBody.querySelectorAll('.mrow').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const f = inp.dataset.f;
        m.items[inp.dataset.idx][f] = f==='price' ? Number(inp.value) : inp.value;
        persistQuote(q); updateTotal(); updateLiveSummary(q);
      });
    });
    rowsBody.querySelectorAll('[data-delm]').forEach(b=>b.onclick=()=>{
      m.items.splice(Number(b.dataset.delm),1); persistQuote(q); draw(); updateLiveSummary(q);
    });
    updateTotal();
  }
  function updateTotal(){
    const total = m.items.reduce((s,it)=>s+(Number(it.price)||0),0);
    totalEl.textContent = fmt(total);
  }
  document.getElementById('addMarinaItem').onclick = ()=>{
    m.items.push({name:'New Requirement', responsibility:'Customer', remarks:'', price:0});
    persistQuote(q); draw(); updateLiveSummary(q);
  };
  document.getElementById('marinaNotes').addEventListener('input', (e)=>{ m.notes = e.target.value; persistQuote(q); });
  draw();
}

/* ---- Tab: Terms & Conditions ---- */
function tabTerms(host, q){
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Terms &amp; Conditions</h3>
        <button class="btn btn-sm" id="addTerm">${icon('plus')} Add Clause</button>
      </div>
      <div class="card-body section-lead">
        Add, remove, reorder, or rewrite any clause. These print in order on the quotation, numbered automatically, followed by an auto-generated Validity clause based on the Validity (days) field set on the Client &amp; Project tab.
      </div>
      <div class="card-body" style="padding-top:0;" id="termRows"></div>
    </div>
  `;
  const wrap = document.getElementById('termRows');
  function draw(){
    wrap.innerHTML = q.terms.length ? q.terms.map((t,idx)=>`
      <div class="card" style="margin-bottom:10px;box-shadow:none;border:1px solid var(--paper-line);">
        <div class="card-body" style="padding:12px 14px;">
          <div class="grid" style="grid-template-columns:1fr auto;gap:10px;align-items:start;">
            <div class="field" style="margin-bottom:8px;"><label>Clause ${idx+1} Title</label><input class="term-f" data-idx="${idx}" data-f="title" value="${esc(t.title)}"></div>
            <div style="display:flex;gap:4px;padding-top:20px;">
              <button class="btn btn-ghost btn-sm" data-up="${idx}" ${idx===0?'disabled':''} title="Move up">↑</button>
              <button class="btn btn-ghost btn-sm" data-down="${idx}" ${idx===q.terms.length-1?'disabled':''} title="Move down">↓</button>
              <button class="btn btn-ghost btn-sm" data-del="${idx}" style="color:var(--danger);" title="Remove">✕</button>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;"><label>Clause Text</label><textarea class="term-f" data-idx="${idx}" data-f="body" rows="2">${esc(t.body)}</textarea></div>
        </div>
      </div>
    `).join('') : `<div class="empty">No clauses yet. Add one to start building your terms &amp; conditions.</div>`;
    wrap.querySelectorAll('.term-f').forEach(el=>{
      el.addEventListener('input', ()=>{
        q.terms[el.dataset.idx][el.dataset.f] = el.value; persistQuote(q);
      });
    });
    wrap.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>{
      const i = Number(b.dataset.up); [q.terms[i-1], q.terms[i]] = [q.terms[i], q.terms[i-1]]; persistQuote(q); draw();
    });
    wrap.querySelectorAll('[data-down]').forEach(b=>b.onclick=()=>{
      const i = Number(b.dataset.down); [q.terms[i+1], q.terms[i]] = [q.terms[i], q.terms[i+1]]; persistQuote(q); draw();
    });
    wrap.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      q.terms.splice(Number(b.dataset.del),1); persistQuote(q); draw();
    });
  }
  document.getElementById('addTerm').onclick = ()=>{
    q.terms.push({title:'New Clause', body:''}); persistQuote(q); draw();
  };
  draw();
}

/* ---- Tab: Output (printable quotation) ---- */
function logoCardHtml(){
  return `
    <div class="logocard" id="logoCard">
      <div class="prev ${LOGO.img?'':'empty'}">${LOGO.img? `<img src="${esc(LOGO.img)}" alt="">` : 'No logo'}</div>
      <div class="controls">
        <div class="row2">
          <button class="btn btn-sm logo-upload" type="button">⬆ Upload logo</button>
          <button class="btn btn-sm btn-ghost logo-reset" type="button">Reset position &amp; size</button>
          <button class="btn btn-sm btn-danger logo-clear" type="button">Remove logo</button>
        </div>
        <input type="file" class="logo-file" accept="image/*" style="display:none;">
        <div class="row2">
          <input type="text" class="logo-drive" placeholder="…or paste a Google Drive image share link">
          <button class="btn btn-sm logo-drive-apply" type="button">Use</button>
        </div>
        <div class="hint">Once uploaded, drag the logo directly on the document below to move it, or drag its bottom-right corner to resize it. Position is saved automatically.</div>
      </div>
    </div>`;
}
function bindLogoCard(host, q){
  const card = host.querySelector('#logoCard');
  if(!card) return;
  card.querySelector('.logo-upload').addEventListener('click', ()=> card.querySelector('.logo-file').click());
  card.querySelector('.logo-file').addEventListener('change', async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    LOGO.img = await fileToDataURL(f); saveLogo(); toast('Logo uploaded'); tabOutput(host, q);
  });
  card.querySelector('.logo-drive-apply').addEventListener('click', ()=>{
    const link = card.querySelector('.logo-drive').value;
    if(!link){ toast('Paste a Google Drive link first'); return; }
    LOGO.img = driveImgUrl(link); saveLogo(); toast('Logo linked from Drive');
    tabOutput(host, q);
  });
  card.querySelector('.logo-reset').addEventListener('click', ()=>{
    LOGO.top = null; LOGO.left = null; LOGO.width = 100; saveLogo(); tabOutput(host, q);
  });
  card.querySelector('.logo-clear').addEventListener('click', ()=>{
    LOGO.img=''; LOGO.top=null; LOGO.left=null; saveLogo(); tabOutput(host, q);
  });
}
function bindLogoDrag(host, q){
  const wrap = document.getElementById('docLogoWrap');
  const headerBox = document.getElementById('docHeaderTop');
  if(!wrap || !headerBox || !LOGO.img) return;
  initLogoDragOnce();
  const handle = wrap.querySelector('.logo-resize-handle');
  wrap.addEventListener('mousedown', (e)=>{
    if(e.target===handle) return;
    ensureLogoPixelPos(wrap, headerBox);
    wrap.style.position = 'absolute'; wrap.style.left = LOGO.left+'px'; wrap.style.top = LOGO.top+'px';
    _logoDrag.mode='drag'; _logoDrag.startX=e.clientX; _logoDrag.startY=e.clientY; _logoDrag.startLeft=LOGO.left; _logoDrag.startTop=LOGO.top;
    e.preventDefault();
  });
  if(handle){
    handle.addEventListener('mousedown', (e)=>{
      _logoDrag.mode='resize'; _logoDrag.startX=e.clientX; _logoDrag.startWidth=LOGO.width;
      e.preventDefault(); e.stopPropagation();
    });
  }
}

/* ============================================================
   SETTINGS  (Company Logo + Company Details)
   ============================================================ */
function bindLogoCardStandalone(host, onChange){
  const card = host.querySelector('#logoCard');
  if(!card) return;
  card.querySelector('.logo-upload').addEventListener('click', ()=> card.querySelector('.logo-file').click());
  card.querySelector('.logo-file').addEventListener('change', async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    LOGO.img = await fileToDataURL(f); saveLogo(); toast('Logo uploaded'); onChange && onChange();
  });
  card.querySelector('.logo-drive-apply').addEventListener('click', ()=>{
    const link = card.querySelector('.logo-drive').value;
    if(!link){ toast('Paste a Google Drive link first'); return; }
    LOGO.img = driveImgUrl(link); saveLogo(); toast('Logo linked from Drive'); onChange && onChange();
  });
  card.querySelector('.logo-reset').addEventListener('click', ()=>{
    LOGO.top = null; LOGO.left = null; LOGO.width = 100; saveLogo(); toast('Logo position reset'); onChange && onChange();
  });
  card.querySelector('.logo-clear').addEventListener('click', ()=>{
    LOGO.img=''; LOGO.top=null; LOGO.left=null; saveLogo(); toast('Logo removed'); onChange && onChange();
  });
}

/* ============================================================
   MY PROFILE — every signed-in user's own Name, Contact Number, and
   E-Signature (self-editable). Position and admin status are assigned
   by an admin directly in Supabase (user_profiles table), shown here
   read-only.
   ============================================================ */
function renderMyProfile(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnSaveProfile">Save My Profile</button>`;
  const p = profileByEmail(CURRENT_USER.email) || { email:CURRENT_USER.email, full_name:'', position:'', contact_number:'', esign:'', is_admin:false };
  content.innerHTML = `
    <div class="section-lead">This information automatically appears as "Prepared By" on any quotation you create, and — if you're an admin — as "Approved By" when you approve someone else's quotation.</div>
    <div class="card" style="max-width:640px;">
      <div class="card-body">
        <div class="grid g2">
          <div class="field"><label>Full Name</label><input id="myName" value="${esc(p.full_name)}"></div>
          <div class="field"><label>Position</label><input value="${esc(p.position)||'Not yet assigned'}" disabled><div class="hint">Assigned by an admin in Supabase (user_profiles table).</div></div>
        </div>
        <div class="grid g2">
          <div class="field"><label>Contact Number</label><input id="myContact" value="${esc(p.contact_number)}"></div>
          <div class="field"><label>Email</label><input value="${esc(CURRENT_USER.email)}" disabled></div>
        </div>
        <div class="field"><label>E-Signature</label>
          <div class="prev ${p.esign?'':'empty'}" style="margin-bottom:8px;">${p.esign? `<img src="${esc(p.esign)}" alt="">` : 'No signature uploaded'}</div>
          <div class="row2" style="display:flex;gap:8px;">
            <button class="btn btn-sm" type="button" id="myEsignUpload">⬆ Upload image</button>
            <button class="btn btn-sm btn-ghost" type="button" id="myEsignClear">Clear</button>
          </div>
          <input type="file" id="myEsignFile" accept="image/*" style="display:none;">
          <div class="field" style="margin:8px 0 0;">
            <div class="field-inline" style="display:flex;gap:8px;">
              <input type="text" id="myEsignDrive" placeholder="Paste Google Drive image share link…" style="flex:1;">
              <button class="btn btn-sm" type="button" id="myEsignDriveApply">Use</button>
            </div>
            <div class="hint">Drive file must be shared as "Anyone with the link".</div>
          </div>
        </div>
      </div>
    </div>
  `;
  let pendingEsign = p.esign;
  document.getElementById('myEsignUpload').onclick = ()=> document.getElementById('myEsignFile').click();
  document.getElementById('myEsignFile').addEventListener('change', async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    pendingEsign = await fileToDataURL(f);
    content.querySelector('.prev').innerHTML = `<img src="${esc(pendingEsign)}" alt="">`;
  });
  document.getElementById('myEsignDriveApply').onclick = ()=>{
    const link = document.getElementById('myEsignDrive').value;
    if(!link){ toast('Paste a Google Drive link first'); return; }
    pendingEsign = driveImgUrl(link);
    content.querySelector('.prev').innerHTML = `<img src="${esc(pendingEsign)}" alt="">`;
  };
  document.getElementById('myEsignClear').onclick = ()=>{
    pendingEsign = '';
    content.querySelector('.prev').innerHTML = 'No signature uploaded';
  };
  document.getElementById('btnSaveProfile').onclick = async ()=>{
    const ok = await saveMyProfile({
      full_name: document.getElementById('myName').value,
      contact_number: document.getElementById('myContact').value,
      esign: pendingEsign
    });
    toast(ok ? 'Profile saved' : 'Save failed — check your connection');
  };
}

function renderSettings(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnSaveCompany">Save Settings</button>`;
  const c = COMPANY;
  content.innerHTML = `
    <div class="section-lead">This logo and company information appear on the letterhead of every printed quotation and invoice.</div>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>Company Logo</h3></div>
        <div class="card-body">${logoCardHtml()}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Company Details</h3></div>
        <div class="card-body grid g2">
          <div class="field" style="grid-column:1/-1;"><label>Company Name</label><input type="text" class="cf" data-key="name" value="${esc(c.name)}"></div>
          <div class="field" style="grid-column:1/-1;"><label>Tagline</label><input type="text" class="cf" data-key="tagline" value="${esc(c.tagline)}"></div>
          <div class="field" style="grid-column:1/-1;"><label>Address</label><textarea class="cf" data-key="address" rows="2">${esc(c.address)}</textarea></div>
          <div class="field"><label>Contact Number</label><textarea class="cf" data-key="contact" rows="2">${esc(c.contact)}</textarea></div>
          <div class="field"><label>Email</label><textarea class="cf" data-key="email" rows="2">${esc(c.email)}</textarea></div>
          <div class="field" style="grid-column:1/-1;"><label>TIN</label><input type="text" class="cf" data-key="tin" value="${esc(c.tin)}"></div>
          <div class="hint" style="grid-column:1/-1;">Press Enter inside Address, Contact, or Email to split the entry across two lines on the printed letterhead.</div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Bank Accounts</h3><button class="btn btn-sm" id="addBank">${icon('plus')} Add Bank Account</button></div>
      <div class="card-body section-lead">Shown on the payment/invoice section of printed quotations.</div>
      <div class="card-body" style="padding:0;"><table><thead><tr><th>Bank Name</th><th>Branch</th><th>Account Name</th><th>Account Number</th><th></th></tr></thead><tbody id="bankRows"></tbody></table></div>
    </div>
  `;

  bindLogoCardStandalone(content, ()=>renderSettings(content, actions));

  content.querySelectorAll('.cf').forEach(i=>{
    i.addEventListener('input', ()=>{ c[i.dataset.key] = i.value; });
  });

  function drawBanks(){
    document.getElementById('bankRows').innerHTML = c.bank.map((b,idx)=>`
      <tr>
        <td><input class="tbl-input bank-f" data-idx="${idx}" data-f="bankName" value="${esc(b.bankName)}"></td>
        <td><input class="tbl-input bank-f" data-idx="${idx}" data-f="branch" value="${esc(b.branch)}"></td>
        <td><input class="tbl-input bank-f" data-idx="${idx}" data-f="accountName" value="${esc(b.accountName)}"></td>
        <td><input class="tbl-input bank-f" data-idx="${idx}" data-f="accountNumber" value="${esc(b.accountNumber)}"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-del-bank="${idx}" style="color:var(--danger);">Remove</span></td>
      </tr>`).join('') || `<tr><td colspan="5" class="empty">No bank accounts added yet.</td></tr>`;
    document.querySelectorAll('.bank-f').forEach(i=>i.onchange=()=>{ c.bank[Number(i.dataset.idx)][i.dataset.f] = i.value; });
    document.querySelectorAll('[data-del-bank]').forEach(b=>b.onclick=()=>{ c.bank.splice(Number(b.dataset.delBank),1); drawBanks(); });
  }
  drawBanks();
  document.getElementById('addBank').onclick = ()=>{ c.bank.push({bankName:'',branch:'',accountName:'',accountNumber:''}); drawBanks(); };

  document.getElementById('btnSaveCompany').onclick = ()=>{ saveCompany(); toast('Company details saved'); };
}

function tabOutput(host, q){
  const c = computeAll(q);
  const inv = computeInvoiceTotals(q, c);
  const validUntil = new Date(new Date(q.date).getTime() + q.validityDays*86400000);
  const dateIssued = new Date(q.date);
  const dateIssuedStr = isNaN(dateIssued)? q.date : (dateIssued.getMonth()+1)+'/'+dateIssued.getDate()+'/'+dateIssued.getFullYear();

  host.innerHTML = `
    <div class="no-print" style="margin-bottom:14px;">
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
        <button class="btn btn-primary" id="btnPrint">🖨 Print / Export as PDF</button>
        <span class="hint">Uses your browser's print dialog — choose "Save as PDF" as the destination.</span>
        <span class="hint">VAT and discount are set in the Live Total panel. Approval is there too. Prepared By, Approved By, and CONFORME all fill in automatically below — nothing to edit here.</span>
      </div>
    </div>

    <div class="doc-wrap">
      <div class="doc">

        <div class="doc-header-top" id="docHeaderTop">
          <div class="co">
            <h2>${esc(COMPANY.name)}</h2>
            <div class="tag">${esc(COMPANY.tagline)}</div>
          </div>
          <div class="doc-logo-wrap" id="docLogoWrap" style="width:${LOGO.width}px;${LOGO.top!=null? `position:absolute;top:${LOGO.top}px;left:${LOGO.left}px;` : ''}">
            ${LOGO.img? `<img src="${esc(LOGO.img)}" alt="Company logo">` : `<div class="logo-placeholder">Upload logo below</div>`}
            <div class="logo-resize-handle"></div>
          </div>
        </div>

        <div class="doc-header-row">
          <div class="doc-header-left">
            <div class="doc-titlebar">QUOTATION</div>
          </div>
          <div class="doc-header-right">
            <table class="doc-info-table">
              <tbody>
                <tr><td class="lbl">Address</td><td class="val">${splitAddressTwoLines(COMPANY.address)}</td></tr>
                <tr><td class="lbl">TIN</td><td class="val">${esc(COMPANY.tin)}</td></tr>
                <tr><td class="lbl">Ref No.</td><td class="val">${esc(q.refNo)}</td></tr>
                <tr><td class="lbl">Date Issued</td><td class="val">${dateIssuedStr}</td></tr>
                <tr><td class="lbl">Expiry Date</td><td class="val">${(validUntil.getMonth()+1)+'/'+validUntil.getDate()+'/'+validUntil.getFullYear()}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="doc-header-divider"></div>

        <div class="doc-band-head">Client Information</div>
        <div class="doc-band-row" style="margin-top:14px;">
          <div class="col">
            <div class="doc-band-body">
              <div class="doc-kv-row"><span class="k">Company Name</span><span class="v">${esc(q.customerSnap.companyName)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Client Name</span><span class="v">${esc(q.customerSnap.clientName)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Position</span><span class="v">${esc(q.customerSnap.clientPosition)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Address</span><span class="v">${esc(q.customerSnap.address)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Contact Number</span><span class="v">${esc(q.customerSnap.contact)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Email Address</span><span class="v">${esc(q.customerSnap.email)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Company Tax Identification Number</span><span class="v">${esc(q.customerSnap.companyTin)||'—'}</span></div>
            </div>
          </div>
          <div class="col">
            <div class="doc-band-body">
              ${q.customerSnap.repNA ? `
              <div class="doc-kv-row"><span class="k">Client Representative</span><span class="v doc-na">Not Applicable</span></div>
              <div class="doc-kv-row"><span class="k">Position</span><span class="v doc-na">Not Applicable</span></div>
              <div class="doc-kv-row"><span class="k">Contact Number</span><span class="v doc-na">Not Applicable</span></div>
              <div class="doc-kv-row"><span class="k">Email Address</span><span class="v doc-na">Not Applicable</span></div>
              ` : `
              <div class="doc-kv-row"><span class="k">Client Representative</span><span class="v">${esc(q.customerSnap.repName)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Position</span><span class="v">${esc(q.customerSnap.repPosition)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Contact Number</span><span class="v">${esc(q.customerSnap.repContact)||'—'}</span></div>
              <div class="doc-kv-row"><span class="k">Email Address</span><span class="v">${esc(q.customerSnap.repEmail)||'—'}</span></div>
              `}
            </div>
          </div>
        </div>

        <div class="doc-project-bar" ${q.project.notes?'':'style="margin-bottom:32px;"'}>${esc(generateProjectTitle(q))||'Boat Construction Project'}</div>
        ${q.project.notes ? `<div class="doc-project-note">${escNl(q.project.notes)}</div>` : ``}

        <!-- ===== FRONT PAGE: Cost Summary ===== -->
        <div class="doc-section-title">Cost Summary</div>
        <table class="doc-item-table">
          <tbody>
            <tr><td>Structural Components &amp; Core Materials</td><td class="right mono">${fmt(c.hull.total + c.structural.total)}</td></tr>
            <tr><td>Paint &amp; Finish</td><td class="right mono">${fmt(c.paint.total)}</td></tr>
            <tr><td>Accessories &amp; Components</td><td class="right mono">${fmt(c.acc.total)}</td></tr>
            <tr><td>Marine Propulsion System</td><td class="right mono">${fmt(c.eng.total)}</td></tr>
            <tr><td>Testing &amp; Delivery</td><td class="right mono">${fmt(c.testing.total)}</td></tr>
            <tr><td>MARINA Documentation &amp; Regulatory Requirements</td><td class="right mono">${fmt(c.marinaCost)}</td></tr>
            ${c.multiplyPrice && c.numBoats>1 ? `<tr><td style="font-weight:700;border-top:1px solid var(--doc-ink);">Per-Unit Price × ${c.numBoats} Boats Quoted</td><td class="right mono" style="font-weight:700;border-top:1px solid var(--doc-ink);">${fmt(c.unitFinalTotal)} × ${c.numBoats}</td></tr>` : ``}
          </tbody>
        </table>

        <div class="doc-words-row">
          <div class="doc-words-box">Amount in Words: ${esc(numberToWords(inv.totalContractAmount))}</div>
          <div class="doc-totalsbox">
            <div class="row"><span>Subtotal</span><span class="mono">${fmt(inv.contractAmount)}</span></div>
            ${inv.discountAmount>0 ? `<div class="row discount"><span>Discount (${fmtNum(inv.discountPctEff,2).replace(/\.00$/,'')}%)${inv.discountNote ? ` — ${esc(inv.discountNote)}` : ''}</span><span class="mono">-${fmt(inv.discountAmount)}</span></div>
            <div class="row net"><span>Price After Discount</span><span class="mono">${fmt(inv.discountedAmount)}</span></div>` : ``}
            <div class="row vat"><span>VAT ${inv.vatPct}%</span><span class="mono">${fmt(inv.vatAmount)}</span></div>
            <div class="row total"><span>TOTAL AMOUNT</span><span class="mono">${fmt(inv.totalContractAmount)}</span></div>
          </div>
        </div>

        <div class="doc-section-title">Bank Details</div>
        <div class="doc-bank-row">
          ${COMPANY.bank.map(b=>`
            <div class="acct">
              <div class="bn">${esc(b.bankName)}</div>
              <div>${esc(b.branch)}</div>
              <div>Account Name: ${esc(b.accountName)}</div>
              <div>Account Number: ${esc(b.accountNumber)}</div>
            </div>`).join('')}
        </div>

        <!-- ===== PAGE 2: Terms, Signatories ===== -->
        <div class="doc-pagebreak"><span class="lbl">Page 2</span></div>

        <div class="doc-section-title">Terms &amp; Conditions</div>
        <div class="doc-terms">
          <ol>
            ${q.terms.map(t=>`<li>${t.title?`<strong>${esc(t.title)}:</strong> `:''}${esc(t.body)}</li>`).join('')}
            <li><strong>Validity:</strong> This quotation is valid for ${q.validityDays} calendar days from date of issuance.</li>
          </ol>
        </div>

        <div class="doc-sign">
          <div data-sigprev="prepared">
            <div class="role">Prepared By</div>
            <div class="imgslot">${(()=>{ const pr = profileByEmail(q.createdByEmail); return pr && pr.esign ? `<img src="${esc(pr.esign)}" alt="">` : ''; })()}</div>
            <div class="ln"><div class="nm">${(()=>{ const pr = profileByEmail(q.createdByEmail); return esc(pr && pr.full_name || '')||'&nbsp;'; })()}</div><span class="ttl">${(()=>{ const pr = profileByEmail(q.createdByEmail); return esc(pr && pr.position || ''); })()}</span></div>
          </div>
          <div data-sigprev="approved">
            <div class="role">Approved By</div>
            <div class="imgslot">${q.approvedBy && q.approvedBy.esign ? `<img src="${esc(q.approvedBy.esign)}" alt="">` : ''}</div>
            <div class="ln"><div class="nm">${esc(q.approvedBy && q.approvedBy.name || '')||'&nbsp;'}</div><span class="ttl">${esc(q.approvedBy && q.approvedBy.position || '')}</span></div>
          </div>
          <div data-sigprev="received">
            <div class="role">CONFORME</div>
            <div class="imgslot"></div>
            <div class="ln"><div class="nm">${esc(q.customerSnap.clientName)||'&nbsp;'}</div><span class="ttl">${esc(q.customerSnap.clientPosition)||''}</span></div>
          </div>
        </div>

        <!-- ===== PAGE 3+: Quotation Details / Item Details ===== -->
        <div class="doc-pagebreak"><span class="lbl">Page 3</span></div>

        <div class="doc-section-title">I. Boat Specifications</div>
        <table>
          <tbody>
            <tr><td>Boat Model</td><td class="right mono">${esc(q.project.boatModel)||'—'}</td><td>Build Type</td><td class="right mono">${esc(q.project.buildType)||'—'}</td></tr>
            <tr><td>Boat Application</td><td class="right mono">${esc(q.project.boatApplication==='Other' ? (q.project.boatApplicationOther||'Other') : q.project.boatApplication)||'—'}</td><td>Passenger Capacity</td><td class="right mono">${q.project.passengerCapacity||0} pax</td></tr>
            <tr><td>Length Overall</td><td class="right mono">${(()=>{ const f=decToFtIn(q.hull.loa); return `${f.ft}ft ${f.inch}in`; })()}</td><td>Propulsion</td><td class="right mono">${esc(q.engine.brand)||'—'} ${q.engine.hp||0}HP ${esc(q.engine.type)||'IBM'}</td></tr>
            <tr><td>Beam</td><td class="right mono">${(()=>{ const f=decToFtIn(q.hull.beam); return `${f.ft}ft ${f.inch}in`; })()}</td><td>Engine Speed</td><td class="right mono">${esc(q.engine.speed)||'—'}</td></tr>
            <tr><td>Depth</td><td class="right mono">${(()=>{ const f=decToFtIn(q.hull.depth); return `${f.ft}ft ${f.inch}in`; })()}</td><td>Fuel Capacity</td><td class="right mono">${esc(q.engine.fuelCapacity)||'—'}</td></tr>
            ${c.numBoats>1?`<tr><td>Number of Boats Quoted</td><td class="right mono" colspan="3">${c.numBoats} unit(s)</td></tr>`:``}
          </tbody>
        </table>

        <div class="doc-section-title">II. Structural Components &amp; Core Materials</div>
        ${(()=>{
          const rows = c.structural.rows;
          if(!rows.length) return `<div class="doc-na-block" style="font-style:normal;">No structural items listed.</div>`;
          return `<table class="doc-item-table">
              <tbody>${rows.map(r=>`<tr><td>${escH(r.name)}${r.description ? ` - ${escH(r.description)}` : ''}</td><td class="right mono">${fmt(r.total)}</td></tr>`).join('')}</tbody>
            </table>`;
        })()}

        <div class="doc-section-title">III. Paint &amp; Finish</div>
        ${(()=>{
          if(!c.paint.rows.length) return `<div class="doc-na-block" style="font-style:normal;">No paint items listed.</div>`;
          const total = c.paint.rows.reduce((s,r)=>s+r.cost,0);
          return `
          <div class="marina-box">
            <div class="marina-row">
              <ul class="marina-list">
                ${c.paint.rows.map(r=>`<li>${esc(r.coatLabel||'Coat')}${r.type?` — ${esc(r.type)}`:''}${r.color?` (${esc(r.color)})`:''}</li>`).join('')}
              </ul>
              <div class="marina-price">${fmt(total)}</div>
            </div>
          </div>`;
        })()}

        <div class="doc-section-title">IV. Accessories &amp; Components</div>
        ${(()=>{
          const groups = groupByCat(c.acc.rows);
          const renderBox = rows => {
            const total = rows.reduce((s,r)=>s+r.total,0);
            return `
            <div class="marina-box">
              <div class="marina-row">
                <ul class="marina-list">
                  ${rows.map(r=>`<li>${r.qty} ${esc(r.unit)||'pc'} — ${esc(r.name)}</li>`).join('')}
                </ul>
                <div class="marina-price">${fmt(total)}</div>
              </div>
            </div>`;
          };
          // Fixed named sections always appear, in this order, each
          // supporting "Not Applicable"; any other category found in the
          // data prints afterward, grouped the same way.
          const fixedHtml = PRINTED_ACCESSORY_SECTIONS.map(cat=>{
            const rows = groups.get(cat);
            groups.delete(cat);
            const isNA = !!q.accessoryCategoryNA[cat];
            return `
              <div class="doc-subcat-title">${esc(cat)}</div>
              ${isNA ? `<div class="doc-na-block">Not Applicable</div>`
                : (rows && rows.length ? renderBox(rows) : `<div class="doc-na-block" style="font-style:normal;">No items listed.</div>`)}`;
          }).join('');
          const restHtml = Array.from(groups.entries()).map(([cat, rows])=>`
            <div class="doc-subcat-title">${esc(cat)}</div>
            ${renderBox(rows)}`).join('');
          return fixedHtml + restHtml;
        })()}

        <div class="doc-section-title">V. Marine Propulsion System</div>
        <table><tbody>
          <tr><td>${esc(q.engine.model)||'—'} ${q.engine.type?`(${esc(q.engine.type)})`:''}</td><td class="right mono">${q.engine.hp} HP × ${q.engine.qty} unit(s)</td></tr>
          ${propulsionShowsDrive(q.engine.type) ? `<tr><td>Transmission: ${esc(q.engine.transmission)||'—'} &nbsp; Propeller: ${esc(q.engine.propeller)||'—'}</td><td class="right mono">${fmt(c.eng.total)}</td></tr>`
            : `<tr><td></td><td class="right mono">${fmt(c.eng.total)}</td></tr>`}
        </tbody></table>
        ${q.engine.description ? `<div class="doc-band-body" style="margin-top:8px;line-height:1.6;">${escNl(q.engine.description)}</div>` : ``}
        ${q.engine.inclusions && q.engine.inclusions.length ? `
        <div style="margin-top:10px;">
          <ul style="margin:0;padding-left:18px;line-height:1.6;">${q.engine.inclusions.map(it=>`<li>${esc(it)}</li>`).join('')}</ul>
        </div>` : ``}

        <div class="doc-section-title">VI. Testing &amp; Delivery</div>
        ${(()=>{
          const groups = groupByCat(c.testing.rows);
          const rowsHtml = (items)=>`
            <table class="doc-item-table">
              <thead><tr><th style="width:50px;">Qty</th><th style="width:70px;">Unit</th><th>Item</th><th class="right">Amount</th></tr></thead>
              <tbody>
                ${items.map(r=>`<tr><td>${r.qty}</td><td>${esc(r.unit)}</td><td>${esc(r.name)}</td><td class="right mono">${fmt(r.total)}</td></tr>`).join('')}
              </tbody>
            </table>`;
          const namedHtml = PRINTED_TESTING_DELIVERY_SECTIONS.map(cat=>{
            const items = groups.get(cat);
            groups.delete(cat);
            const isNA = !!q.testingDeliveryNA[cat];
            return `
              <div class="doc-subcat-title">${esc(cat)}:</div>
              ${isNA ? `<div class="doc-na-block">Not Applicable</div>`
                : (items && items.length ? rowsHtml(items) : `<div class="hint">No items listed.</div>`)}
            `;
          }).join('');
          const otherHtml = Array.from(groups.entries()).map(([cat, items])=>`
            <div class="doc-subcat-title">${esc(cat)}:</div>
            ${rowsHtml(items)}
          `).join('');
          return namedHtml + otherHtml;
        })()}

        <div class="doc-section-title">VII. MARINA Documentation &amp; Regulatory Requirements</div>
        <div class="marina-box">
          <div class="marina-title">MARINA DOCUMENTS:</div>
          <div class="marina-row">
            <ul class="marina-list">
              ${q.marina.items.length ? q.marina.items.map(it=>`<li>${esc(it.name)}</li>`).join('') : `<li>No MARINA requirements listed.</li>`}
            </ul>
            <div class="marina-price">${fmt(q.marina.items.reduce((s,it)=>s+(Number(it.price)||0),0))}</div>
          </div>
        </div>
        <div class="doc-terms" style="margin-top:6px;">${esc(q.marina.notes)}</div>
      </div>
    </div>
  `;
  document.getElementById('btnPrint').onclick = ()=>window.print();
}

/* ============================================================
   SAMPLE QUOTATIONS (seeded once, on first run only)
   ============================================================ */
function sampleAccessory(cat, name, qty, unitPrice, markup){
  return { id:uid('ai'), cat, name, qty, unitPrice, markup };
}
function sampleStruct(cat, name, unit, qty, unitPrice){
  return { id:uid('si'), cat, name, unit, qty, unitPrice };
}
function buildSampleQuotes(){
  const built = [];

  // 1) 64' Passenger Boat — 80 Pax, dual inboard diesel (monohull)
  let s1 = blankQuote();
  s1.status = 'approved';
  s1.date = '2026-05-16';
  s1.customerSnap = { name:'Isla Ferries Corp.', email:'operations@islaferries.example', contact:'0917-201-4488', address:'Iloilo City, Philippines' };
  s1.project = { title:"64' Passenger Boat — 80 Pax (Dual Inboard)", notes:'SOLAS-compliant interisland passenger ferry, dual inboard diesel with enclosed head.', buildType:'Custom Build', boatModel:'Embassy Series', boatApplication:'Passenger Boat', boatApplicationOther:'' };
  s1.hull = { boatType:'Passenger Boat', loa:64, beam:14, depth:6, numHulls:1, hullAreaOverride:null, layers:3, glassPerLayer:0.6, coreArea:0, coreEnabled:false };
  s1.paint = { areaOverride:null, coats:3, paintType:'Marine Polyurethane Topcoat' };
  s1.accessories = [
    sampleAccessory('Hull & Deck Accessories','Stainless Bollard',2,8500,15),
    sampleAccessory('Hull & Deck Accessories','Stainless Cleat',6,1800,15),
    sampleAccessory('Hull & Deck Accessories','Towing Bitt',2,6200,15),
    sampleAccessory('Electrical System','Dome Light',16,950,15),
    sampleAccessory('Electrical System','Bilge Pump w/ Auto Float',2,4200,15),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,22000,15),
  ];
  s1.engine = { model:'Isuzu 340HP UM6SD1TCX + Dong-I DMT140H', hp:340, qty:2, unitPrice:3048856, installation:180000, transmission:'Dong-I DMT140H', propeller:'4-blade bronze' };
  s1.structural = { items: [
    sampleStruct('Stiffeners & Framing','Longitudinal Stiffener (glassed-in)','linear m',36,1450),
    sampleStruct('Stiffeners & Framing','Transverse Frame / Stringer','linear m',24,1650),
    sampleStruct('Bulkheads','Collision / Watertight Bulkhead','sqm',6,5200),
    sampleStruct('Bulkheads','Plywood Bulkhead (marine ply, glassed both sides)','sqm',10,3800),
    sampleStruct('Foam & Core Materials','Urethane Pour Foam (flotation/buoyancy)','cu.ft',40,850),
  ] };
  s1.labor = { fabrication:900, fiberglass:600, painting:260, electrical:320, assembly:400, testing:120 };
  s1.schedule = { startDate:'2026-05-16', standardDays:240, requestedDays:240 };
  built.push(s1); QUOTES.push(s1);

  // 2) 38' Catamaran Tourist / Dive Boat — twin hull
  let s2 = blankQuote();
  s2.status = 'sent';
  s2.date = '2026-06-02';
  s2.customerSnap = { name:'Coral Bay Dive Charters', email:'bookings@coralbaydive.example', contact:'0918-330-5521', address:'Puerto Galera, Oriental Mindoro' };
  s2.project = { title:"38' Catamaran Tourist / Dive Boat", notes:'Twin-hull catamaran, shaded deck, dive gear racks, twin outboard-ready transom (quoted with inboard option).', buildType:'Custom Build', boatModel:'Catamaran', boatApplication:'Dive Boat', boatApplicationOther:'' };
  s2.hull = { boatType:'Catamaran', loa:38, beam:16, depth:5, numHulls:2, hullAreaOverride:null, layers:3, glassPerLayer:0.5, coreArea:22, coreEnabled:true };
  s2.paint = { areaOverride:null, coats:3, paintType:'Marine Polyurethane Topcoat, high-gloss white with dive-charter livery' };
  s2.accessories = [
    sampleAccessory('Hull & Deck Accessories','Stainless Bollard',2,8500,15),
    sampleAccessory('Hull & Deck Accessories','Stainless Cleat',4,1800,15),
    sampleAccessory('Hull & Deck Accessories','Rub Rail (per ft)',76,420,15),
    sampleAccessory('Electrical System','12V Panel Switch Board',1,14500,15),
    sampleAccessory('Electrical System','Dome Light',10,950,15),
    sampleAccessory('Electrical System','Battery (Marine Deep Cycle)',2,9800,15),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,18000,15),
    sampleAccessory('Anchor & Docking','Fender',6,1600,15),
    sampleAccessory('Custom','Dive Tank Rack (Stainless, 12-tank)',2,15500,15),
  ];
  s2.engine = { model:'Yanmar 6LY440 (twin, per-hull)', hp:440, qty:2, unitPrice:3650000, installation:150000, transmission:'ZF Marine transmission', propeller:'4-blade bronze, per hull' };
  s2.structural = { items: [
    sampleStruct('Stiffeners & Framing','Hat-Section Stringer (foam-cored)','linear m',30,1950),
    sampleStruct('Bulkheads','FRP Sandwich Bulkhead (foam core)','sqm',8,4600),
    sampleStruct('Foam & Core Materials','PVC Foam Core Board (Divinycell-type)','sqm',22,2600),
    sampleStruct('Other Structural Materials','Deck Beam / Carlin (FRP)','linear m',14,1800),
  ] };
  s2.labor = { fabrication:620, fiberglass:520, painting:190, electrical:180, assembly:260, testing:90 };
  s2.schedule = { startDate:'2026-06-02', standardDays:150, requestedDays:120 };
  built.push(s2); QUOTES.push(s2);

  // 3) 42' Fishing Boat — commercial monohull
  let s3 = blankQuote();
  s3.status = 'sent';
  s3.date = '2026-06-10';
  s3.customerSnap = { name:'Bantayan Fishing Cooperative', email:'coop@bantayanfish.example', contact:'0920-115-7742', address:'Bantayan Island, Cebu' };
  s3.project = { title:"42' Commercial Fishing Boat", notes:'Fish hold with insulated ice box, outrigger-ready, deck winch mounting points.', buildType:'Standard Build', boatModel:'Reef Runner Series', boatApplication:'Fishing Boat', boatApplicationOther:'' };
  s3.hull = { boatType:'Fishing Boat', loa:42, beam:11, depth:5.5, numHulls:1, hullAreaOverride:null, layers:3, glassPerLayer:0.6, coreArea:0, coreEnabled:false };
  s3.paint = { areaOverride:null, coats:2, paintType:'Marine Antifouling Bottom Paint + Topside Enamel' };
  s3.accessories = [
    sampleAccessory('Hull & Deck Accessories','Stainless Bollard',2,8500,15),
    sampleAccessory('Hull & Deck Accessories','Stainless Cleat',4,1800,15),
    sampleAccessory('Hull & Deck Accessories','Towing Bitt',1,6200,15),
    sampleAccessory('Electrical System','Dome Light',6,950,15),
    sampleAccessory('Electrical System','Bilge Pump w/ Auto Float',1,4200,15),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,20000,15),
    sampleAccessory('Anchor & Docking','Fender',4,1600,15),
    sampleAccessory('Custom','Insulated Fish Hold w/ Hatch (600L)',1,48000,15),
    sampleAccessory('Custom','Deck Winch Mounting Plate (SS)',2,7200,15),
  ];
  s3.engine = { model:'Isuzu 4JB1T (120HP)', hp:120, qty:1, unitPrice:980000, installation:60000, transmission:'Marine reduction gear 2.5:1', propeller:'3-blade bronze' };
  s3.structural = { items: [
    sampleStruct('Stiffeners & Framing','Transverse Frame / Stringer','linear m',18,1650),
    sampleStruct('Bulkheads','Plywood Bulkhead (marine ply, glassed both sides)','sqm',5,3800),
    sampleStruct('Foam & Core Materials','Urethane Pour Foam (flotation/buoyancy)','cu.ft',20,850),
  ] };
  s3.labor = { fabrication:480, fiberglass:340, painting:140, electrical:90, assembly:180, testing:60 };
  s3.schedule = { startDate:'2026-06-10', standardDays:150, requestedDays:150 };
  built.push(s3); QUOTES.push(s3);

  // 4) 30' Patrol / Rescue Boat — monohull, high speed
  let s4 = blankQuote();
  s4.status = 'approved';
  s4.date = '2026-06-18';
  s4.customerSnap = { name:'Municipal Disaster Risk Reduction Office', email:'mdrrmo@lgu.example.gov.ph', contact:'0919-442-0093', address:'Roxas City, Capiz' };
  s4.project = { title:"30' Patrol / Rescue Boat", notes:'High-speed monohull for coastal patrol and swift water rescue operations.', buildType:'Standard Build', boatModel:'Navigator Series', boatApplication:'Patrol Boat', boatApplicationOther:'' };
  s4.hull = { boatType:'Patrol Boat', loa:30, beam:9, depth:4.5, numHulls:1, hullAreaOverride:null, layers:4, glassPerLayer:0.55, coreArea:0, coreEnabled:false };
  s4.paint = { areaOverride:null, coats:3, paintType:'Marine Polyurethane Topcoat, high-visibility orange/white livery' };
  s4.accessories = [
    sampleAccessory('Hull & Deck Accessories','Stainless Bollard',2,8500,15),
    sampleAccessory('Hull & Deck Accessories','Stainless Cleat',4,1800,15),
    sampleAccessory('Hull & Deck Accessories','SS#316 Grab Handle',6,2600,15),
    sampleAccessory('Electrical System','12V Panel Switch Board',1,14500,15),
    sampleAccessory('Electrical System','Dome Light',8,950,15),
    sampleAccessory('Electrical System','Battery (Marine Deep Cycle)',2,9800,15),
    sampleAccessory('Custom','Rescue Boarding Ladder (Stainless)',1,22000,15),
    sampleAccessory('Custom','Emergency Siren & Beacon Light Bar',1,38000,15),
  ];
  s4.engine = { model:'Twin Yamaha 200HP Outboard (quoted as inboard-equivalent package)', hp:200, qty:2, unitPrice:1150000, installation:95000, transmission:'Direct drive', propeller:'Stainless 3-blade' };
  s4.structural = { items: [
    sampleStruct('Stiffeners & Framing','Longitudinal Stiffener (glassed-in)','linear m',16,1450),
    sampleStruct('Foam & Core Materials','PVC Foam Core Board (Divinycell-type)','sqm',12,2600),
    sampleStruct('Foam & Core Materials','Urethane Pour Foam (flotation/buoyancy)','cu.ft',15,850),
  ] };
  s4.labor = { fabrication:360, fiberglass:280, painting:130, electrical:150, assembly:190, testing:70 };
  s4.schedule = { startDate:'2026-06-18', standardDays:100, requestedDays:100 };
  built.push(s4); QUOTES.push(s4);

  // 5) 50' Passenger Ferry — monohull
  let s5 = blankQuote();
  s5.status = 'sent';
  s5.date = '2026-06-25';
  s5.customerSnap = { name:'Tri-Island Shipping Lines', email:'fleet@triisland.example', contact:'0917-660-2214', address:'Cagayan de Oro City' };
  s5.project = { title:"50' Passenger Ferry — 50 Pax (Single Inboard)", notes:'Short-route interisland ferry with covered passenger cabin and open aft deck.', buildType:'Standard Build', boatModel:'Embassy Series', boatApplication:'Ferry', boatApplicationOther:'' };
  s5.hull = { boatType:'Passenger Boat', loa:50, beam:12, depth:5.5, numHulls:1, hullAreaOverride:null, layers:3, glassPerLayer:0.6, coreArea:0, coreEnabled:false };
  s5.paint = { areaOverride:null, coats:3, paintType:'Marine Polyurethane Topcoat' };
  s5.accessories = [
    sampleAccessory('Hull & Deck Accessories','Stainless Bollard',2,8500,15),
    sampleAccessory('Hull & Deck Accessories','Stainless Cleat',6,1800,15),
    sampleAccessory('Hull & Deck Accessories','Towing Bitt',2,6200,15),
    sampleAccessory('Electrical System','Dome Light',12,950,15),
    sampleAccessory('Electrical System','Bilge Pump w/ Auto Float',1,4200,15),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,20000,15),
    sampleAccessory('Anchor & Docking','Fender',4,1600,15),
  ];
  s5.engine = { model:'Cummins QSB6.7 (450HP)', hp:450, qty:1, unitPrice:3820000, installation:140000, transmission:'ZF marine gearbox', propeller:'4-blade bronze' };
  s5.structural = { items: [
    sampleStruct('Stiffeners & Framing','Longitudinal Stiffener (glassed-in)','linear m',28,1450),
    sampleStruct('Bulkheads','Plywood Bulkhead (marine ply, glassed both sides)','sqm',8,3800),
    sampleStruct('Foam & Core Materials','Urethane Pour Foam (flotation/buoyancy)','cu.ft',30,850),
  ] };
  s5.labor = { fabrication:700, fiberglass:480, painting:210, electrical:230, assembly:300, testing:100 };
  s5.schedule = { startDate:'2026-06-25', standardDays:200, requestedDays:200 };
  built.push(s5); QUOTES.push(s5);

  built.forEach(ensureQuoteDefaults);
  localSave(DB_KEYS.quotes, QUOTES);
}

/* ============================================================
   BOOT (standalone — plain localStorage, no server dependency)
   ============================================================ */
QUOTES.forEach(ensureQuoteDefaults);
// Boot must never push a possibly stale local cache to the shared database.
// The remote database is authoritative on startup; pullAllFromRemote() seeds
// only genuinely missing remote keys after authentication.
localSave(DB_KEYS.quotes, QUOTES);
if(!localStorage.getItem('frp_sample_seeded_v1') && QUOTES.length === 0){
  buildSampleQuotes();
  localStorage.setItem('frp_sample_seeded_v1', '1');
}

/* Floating dock (quick actions) */
document.querySelectorAll('[data-dock]').forEach(function(btn){
  btn.addEventListener('click', function(){
    const d = btn.dataset.dock;
    if(d === 'new'){ openEditor(null); }
    else if(d === 'search'){ CURRENT.view = 'quotes'; renderAll(); const el = document.getElementById('qSearch'); if(el) el.focus(); }
    else { CURRENT.view = d; renderAll(); }
  });
});

async function startApp(session){
  CURRENT_USER = { email: session.user.email, isOwner:false };
  document.getElementById('loginScreen').style.display = 'none';
  document.querySelectorAll('#bootScreen').forEach(function(node){ node.remove(); });
  await checkUserPermissions(session.user.email);
  await loadMyProfile(session.user.email);
  updateSidebarFoot();
  renderAll();
  pullAllFromRemote().then(subscribeRemote);
}

function showLogin(msg){
  document.querySelectorAll('#bootScreen').forEach(function(node){ node.remove(); });
  document.getElementById('loginScreen').style.display = 'flex';
  if(msg){
    const e = document.getElementById('loginError');
    e.textContent = msg; e.style.display = 'block';
  }
}

function updateSidebarFoot(){
  const foot = document.getElementById('sidebarFoot');
  if(!foot) return;
  const me = (typeof profileByEmail==='function' && profileByEmail(CURRENT_USER.email)) || {};
  const shown = me.full_name || CURRENT_USER.email || '';
  const initials = (me.full_name
    ? me.full_name.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('')
    : String(CURRENT_USER.email||'?').split('@')[0].slice(0,2)).toUpperCase();
  foot.innerHTML = `<span class="who-name">${esc(shown)}</span><span class="avatar" title="${esc(CURRENT_USER.email)}">${esc(initials)}</span><button type="button" class="who-out" id="signOutLink">Sign out</button>`;
  const link = document.getElementById('signOutLink');
  if(link) link.addEventListener('click', async (e)=>{ e.preventDefault(); await supabaseClient.auth.signOut(); });
}

document.getElementById('loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const btn = document.getElementById('loginSubmit');
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  btn.disabled = true; const oldLabel = btn.textContent; btn.textContent = 'Signing in…';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try{
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error){
      errEl.textContent = error.message || 'Sign in failed. Check your email and password.';
      errEl.style.display = 'block';
      return;
    }
    if(!data || !data.session){
      errEl.textContent = 'Sign-in did not return a session. Please try again.';
      errEl.style.display = 'block';
      return;
    }
    await startApp(data.session);
  }catch(error){
    console.error('Sign-in failed', error);
    errEl.textContent = 'Unable to sign in right now. Check your connection and try again.';
    errEl.style.display = 'block';
  }finally{
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
});

supabaseClient.auth.onAuthStateChange((event)=>{
  if(event === 'SIGNED_OUT') location.reload();
});

(async function boot(){
  try{
    const { data, error } = await supabaseClient.auth.getSession();
    if(error) throw error;
    const session = data && data.session;
    if(session) await startApp(session);
    else showLogin();
  }catch(error){
    console.error('Application startup failed', error);
    showLogin('Unable to connect to the sign-in service. Check your internet connection and try again.');
  }
})();
