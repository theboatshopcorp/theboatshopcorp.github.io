/* ============================================================
   STATE & PERSISTENCE
   ============================================================ */
const DB_KEYS = { quotes:'frp_quotations', customers:'frp_customers', pricing:'frp_pricing_db', templates:'frp_boat_templates', signatories:'frp_signatories', logo:'frp_logo', company:'frp_company_details', auth:'frp_auth' };

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
const SYNCED_KEYS = [DB_KEYS.quotes, DB_KEYS.customers, DB_KEYS.pricing, DB_KEYS.templates, DB_KEYS.signatories, DB_KEYS.logo, DB_KEYS.company];

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
  else if(key === DB_KEYS.pricing){ mergeInPlace(PRICING, val); if(!PRICING.structuralCatalog) PRICING.structuralCatalog = JSON.parse(JSON.stringify(DEFAULT_PRICING.structuralCatalog)); }
  else if(key === DB_KEYS.templates){ mergeRecordArray(TEMPLATES, val||DEFAULT_TEMPLATES); }
  else if(key === DB_KEYS.signatories){ mergeInPlace(SIGNATORIES, val); ['prepared','approved','received'].forEach(k=>{ if(!SIGNATORIES[k]) SIGNATORIES[k]={name:'',title:'',img:''}; }); }
  else if(key === DB_KEYS.logo){ mergeInPlace(LOGO, val || { img:'', width:100, top:null, left:null }); }
  else if(key === DB_KEYS.company){ mergeInPlace(COMPANY, val); if(!COMPANY.bank) COMPANY.bank = []; }
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
const ADMIN_ONLY_VIEWS = ['quotes','editor','templates','pricing','settings'];
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
  const enginePart = [brand, hp? `${hp}HP` : '', type].filter(Boolean).join(' ');
  if(enginePart) title += ` with ${enginePart}`;
  return title.trim();
}
function fmtNum(n,d=2){ n=Number(n)||0; return n.toLocaleString('en-PH',{minimumFractionDigits:d,maximumFractionDigits:d}); }
function ftInToDec(ft, inch){ return (Number(ft)||0) + (Number(inch)||0)/12; }
function decToFtIn(dec){ dec = Number(dec)||0; let ft = Math.floor(dec); let inch = Math.round((dec-ft)*12); if(inch>=12){ inch-=12; ft+=1; } return {ft, inch}; }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(window._tt); window._tt=setTimeout(()=>t.classList.remove('show'),2200); }
function todayISO(){ return new Date().toISOString().slice(0,10); }

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
  laborRates: { fabrication:180, fiberglass:190, painting:160, electrical:200, assembly:170, testing:210 },
  overheadPct: 12,
  contingencyPct: 5,
  marginPct: 18,
  dailyRate: 3500,
  standardDurationDays: 180,
  rushFeePct: 15,
  engineDb: [
    {id:uid('eng'), name:'Isuzu 340HP UM6SD1TCX + Dong-I DMT140H', hp:340, price:3048856},
    {id:uid('eng'), name:'Yanmar 6LY440 (440HP)', hp:440, price:3650000},
    {id:uid('eng'), name:'Cummins QSB6.7 (450HP)', hp:450, price:3820000},
  ],
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
    {cat:'Navigational Equipment', name:'GPS Chartplotter 10in', unitPrice:95000},
    {cat:'Navigational Equipment', name:'Marine Radar 36NM', unitPrice:185000},
    {cat:'Anchor & Docking', name:'Anchor Set w/ Chain & Rope', unitPrice:22000},
    {cat:'Anchor & Docking', name:'Fender', unitPrice:1600},
    {cat:'SOLAS Safety Equipment', name:'Life Vest', unitPrice:850},
    {cat:'SOLAS Safety Equipment', name:'Ring Buoy', unitPrice:2400},
    {cat:'SOLAS Safety Equipment', name:'Fire Extinguisher', unitPrice:1850},
  ],
  structuralCatalog: [
    {cat:'Stiffeners & Framing', name:'Longitudinal Stiffener (glassed-in)', unit:'linear m', unitPrice:1450},
    {cat:'Stiffeners & Framing', name:'Transverse Frame / Stringer', unit:'linear m', unitPrice:1650},
    {cat:'Stiffeners & Framing', name:'Hat-Section Stringer (foam-cored)', unit:'linear m', unitPrice:1950},
    {cat:'Bulkheads', name:'Plywood Bulkhead (marine ply, glassed both sides)', unit:'sqm', unitPrice:3800},
    {cat:'Bulkheads', name:'FRP Sandwich Bulkhead (foam core)', unit:'sqm', unitPrice:4600},
    {cat:'Bulkheads', name:'Collision / Watertight Bulkhead', unit:'sqm', unitPrice:5200},
    {cat:'Foam & Core Materials', name:'Urethane Pour Foam (flotation/buoyancy)', unit:'cu.ft', unitPrice:850},
    {cat:'Foam & Core Materials', name:'PVC Foam Core Board (Divinycell-type)', unit:'sqm', unitPrice:2600},
    {cat:'Foam & Core Materials', name:'End-Grain Balsa Core', unit:'sqm', unitPrice:2200},
    {cat:'Foam & Core Materials', name:'Marine Plywood Coring (per sheet, 4x8ft)', unit:'sheet', unitPrice:3200},
    {cat:'Other Structural Materials', name:'Chopped Strand Mat (450gsm, per roll)', unit:'roll', unitPrice:4800},
    {cat:'Other Structural Materials', name:'Woven Roving Reinforcement (per roll)', unit:'roll', unitPrice:6200},
    {cat:'Other Structural Materials', name:'Structural Adhesive / Epoxy Filler', unit:'kg', unitPrice:650},
    {cat:'Other Structural Materials', name:'Deck Beam / Carlin (FRP)', unit:'linear m', unitPrice:1800},
  ]
};

/* ---------- Accessories: category order, sorting, and "known categories" ----------
   Items are always DISPLAYED grouped by category (in this fixed, sensible order)
   and alphabetically by name within a category — regardless of the order they
   were added in. "Custom" is the catch-all bucket and always sorts last. */
const ACCESSORY_CATEGORY_ORDER = ['Hull & Deck Accessories','Fuel System','Electrical System','Navigational Equipment','Enclosed Toilet','SOLAS Safety Equipment','Anchor & Docking'];
// These categories always get their own named section in the printed
// output (in this order), each with a "Not Applicable" option — even if
// no items are entered yet. Any other category still prints too, grouped
// generically afterward.
const PRINTED_ACCESSORY_SECTIONS = ['Hull & Deck Accessories','Fuel System','Electrical System','Navigational Equipment','Enclosed Toilet','SOLAS Safety Equipment','Anchor & Docking'];
function accessoryCategoryRank(cat){
  if(!cat) return ACCESSORY_CATEGORY_ORDER.length;      // uncategorized: just before Custom
  if(cat === 'Custom') return Infinity;                  // catch-all always last
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
  (PRICING.accessoryCatalog||[]).forEach(a=>{ if(a.cat) set.add(a.cat); });
  (QUOTES||[]).forEach(qt=>{ (qt.accessories||[]).forEach(a=>{ if(a.cat && a.cat!=='Custom') set.add(a.cat); }); });
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
  const hit = (PRICING.structuralCatalog||[]).find(a=>
    (a.name||'').trim().toLowerCase()===(name||'').trim().toLowerCase() &&
    (a.cat||'').trim().toLowerCase()===(cat||'').trim().toLowerCase()
  );
  return hit ? hit.unitPrice : 0;
}
function getKnownStructuralCategories(){
  const set = new Set(STRUCTURAL_CATEGORY_ORDER);
  (PRICING.structuralCatalog||[]).forEach(a=>{ if(a.cat) set.add(a.cat); });
  (QUOTES||[]).forEach(qt=>{ ((qt.structural&&qt.structural.items)||[]).forEach(a=>{ if(a.cat && a.cat!=='Other Structural Materials') set.add(a.cat); }); });
  const rest2 = [...set].filter(c=>!STRUCTURAL_CATEGORY_ORDER.includes(c)).sort((a,b)=>a.localeCompare(b));
  return [...STRUCTURAL_CATEGORY_ORDER, ...rest2, 'Other Structural Materials'];
}

const DEFAULT_TEMPLATES = [
  { id:uid('tpl'), name:"64' Passenger Boat — 80 Pax (Inboard)", boatModel:'Embassy Series', boatType:'Passenger Boat', loa:64, beam:14, depth:6, numHulls:1,
    hullAreaOverride:null, layers:3, glassPerLayer:0.6,
    paintType:'Marine Polyurethane Topcoat', paintArea:null, coats:3,
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
if(PRICING.dailyRate===undefined) PRICING.dailyRate = DEFAULT_PRICING.dailyRate;
if(PRICING.standardDurationDays===undefined) PRICING.standardDurationDays = DEFAULT_PRICING.standardDurationDays;
if(PRICING.rushFeePct===undefined) PRICING.rushFeePct = DEFAULT_PRICING.rushFeePct;
let CUSTOMERS = load(DB_KEYS.customers, []);
let QUOTES = load(DB_KEYS.quotes, []);
let TEMPLATES = load(DB_KEYS.templates, null) || DEFAULT_TEMPLATES;
if(!load(DB_KEYS.templates,null)) save(DB_KEYS.templates, TEMPLATES);
if(!load(DB_KEYS.pricing,null)) save(DB_KEYS.pricing, PRICING);

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
    project: { title:'', notes:'', numBoats:1, passengerCapacity:0, multiplyPrice:false, buildType:'Standard Build', boatModel:'Apple Series', boatApplication:'Passenger Boat', boatApplicationOther:'' },
    hull: { boatType:'Passenger Boat', loa:0, beam:0, depth:0, numHulls:1, hullAreaOverride:null, layers:3, glassPerLayer:0.6, coreArea:0, coreEnabled:false },
    structural: { items:[] },
    paint: { areaOverride:null, coats:3, paintType:'Marine Polyurethane Topcoat' },
    accessories: [],
    accessoryCategoryNA: {},
    testingDelivery: [],
    testingDeliveryNA: {},
    engine: { model:'', brand:'', type:'IBM', hp:0, qty:2, unitPrice:0, installation:0, transmission:'', propeller:'', speed:'', fuelCapacity:'',
      description:"Dual Installation of Yamaha 250HP, Model: F250HETX, Model: FL250HETX\nFuel Injection, 4 Stroke, 24 Valve, Double Overhead Camshaft, V6, Standard Rotation and Counter Rotation, Shaft length 25 inches, Built-in Power trim & Tilt assy., Brand New complete with the following;",
      inclusions: ['Remote Control box with wiring harness (Dual Top mount)','Dual Panel switch','Gauge Kit - Multifunction Digital Tachometer/Speedometer','Battery Cable','Yamaha Primer Bulb','Stainless Propeller','Complete Dometic Hydraulic Steering & Control System',"Engine Owner's Manual"],
      steeringItems: ['Hydraulic Helm 2.4','Front Mount Cylinder','Hydraulic Hose','Hydraulic Oil','Tie Bar Kit for Twin Cylinder','Tee Fittings','Steering Wheel','Control Cable','Ext. Wire Harness','See-through Water Separator Assy.','Fuel Hose','Rigging Kit','Battery Tray 3sm','Battery Terminal']
    },
    labor: { fabrication:0, fiberglass:0, painting:0, electrical:0, assembly:0, testing:0 },
    rates: JSON.parse(JSON.stringify(PRICING)), // snapshot, editable per-quote
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
    invoice: { vatEnabled:true, vatPct:12, previousPayment:0, discountType:'pct', discountValue:0 },
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
  const total = glassCost + resinCost + gelcoatCost + coreCost;
  return { area, glassWeight, resinWeight, resinLiters, gelcoatWeight, glassCost, resinCost, gelcoatCost, coreCost, total };
}
function computePaint(q, hullCalc){
  const p = q.paint, r = q.rates;
  const area = (p.areaOverride!=null && p.areaOverride!=='') ? Number(p.areaOverride) : hullCalc.area;
  const primerLiters = area / r.primerCoverage;
  const paintLiters = (area / r.paintCoverage) * (p.coats||1);
  const primerCost = primerLiters * r.primerPerLiter;
  const paintCost = paintLiters * r.paintPerLiter;
  const total = primerCost + paintCost;
  return { area, primerLiters, paintLiters, primerCost, paintCost, total };
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
  const rows = q.accessories.map(a=>{
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
  const unitsCost = (Number(e.qty)||0) * (Number(e.unitPrice)||0);
  const total = unitsCost + (Number(e.installation)||0);
  return { unitsCost, total };
}
function computeLabor(q){
  const l = q.labor, rates = q.rates.laborRates;
  const rows = Object.keys(l).map(k=>({
    key:k, hours:Number(l[k])||0, rate: Number(rates[k])||0, cost: (Number(l[k])||0)*(Number(rates[k])||0)
  }));
  const total = rows.reduce((s,r)=>s+r.cost,0);
  return { rows, total };
}
function computeAll(q){
  const hull = computeHull(q);
  const paint = computePaint(q, hull);
  const structural = computeStructural(q);
  const acc = computeAccessories(q);
  const testing = computeTestingDelivery(q);
  const eng = computeEngine(q);
  const labor = computeLabor(q);
  const materialCost = hull.total + paint.total + structural.total;
  const equipmentCost = acc.total + eng.total;
  const laborCost = labor.total;
  const base = materialCost + equipmentCost + laborCost;
  const overheadCost = base * (Number(q.rates.overheadPct)||0)/100;
  const contingencyCost = base * (Number(q.rates.contingencyPct)||0)/100;
  const marginCost = base * (Number(q.rates.marginPct)||0)/100;
  const sch = q.schedule || { startDate: todayISO(), standardDays: q.rates.standardDurationDays||180, requestedDays: q.rates.standardDurationDays||180 };
  const standardDays = Number(sch.standardDays)||0;
  const requestedDays = Number(sch.requestedDays)||standardDays;
  const durationCost = requestedDays * (Number(q.rates.dailyRate)||0);
  const isRush = standardDays>0 && requestedDays < standardDays;
  const rushFee = isRush ? base * (Number(q.rates.rushFeePct)||0)/100 : 0;
  const deliveryDate = sch.startDate ? new Date(new Date(sch.startDate).getTime() + requestedDays*86400000) : null;
  const marinaCost = (q.marina && Array.isArray(q.marina.items)) ? q.marina.items.reduce((s,it)=>s+(Number(it.price)||0),0) : 0;
  const unitFinalTotal = materialCost + laborCost + equipmentCost + overheadCost + contingencyCost + marginCost + durationCost + rushFee + marinaCost + testing.total;
  const numBoats = Math.max(1, Number(q.project.numBoats)||1);
  const multiplyPrice = !!q.project.multiplyPrice;
  const finalTotal = multiplyPrice ? unitFinalTotal * numBoats : unitFinalTotal;
  return { hull, paint, structural, acc, testing, eng, labor, materialCost, equipmentCost, laborCost, overheadCost, contingencyCost, marginCost, marinaCost, base, standardDays, requestedDays, durationCost, isRush, rushFee, deliveryDate, unitFinalTotal, numBoats, multiplyPrice, finalTotal };
}
function computeInvoiceTotals(q, c){
  const inv = q.invoice || { vatEnabled:true, vatPct:12, previousPayment:0, discountType:'pct', discountValue:0 };
  const contractAmount = c.finalTotal;
  const discountType = inv.discountType || 'pct';
  const discountValue = Number(inv.discountValue)||0;
  let discountAmount = discountType==='fixed' ? discountValue : contractAmount*discountValue/100;
  discountAmount = Math.max(0, Math.min(discountAmount, contractAmount));
  const discountedAmount = contractAmount - discountAmount;
  const vatPct = inv.vatEnabled ? (Number(inv.vatPct)||0) : 0;
  const vatAmount = discountedAmount * vatPct/100;
  const totalContractAmount = discountedAmount + vatAmount;
  const previousPayment = Number(inv.previousPayment)||0;
  const balanceDue = totalContractAmount - previousPayment;
  const schedule = (q.paymentSchedule||[]).map(r=>({...r, amount: totalContractAmount*(Number(r.percent)||0)/100}));
  const scheduleTotal = schedule.reduce((s,r)=>s+r.amount,0);
  return { vatEnabled:inv.vatEnabled, vatPct, contractAmount, discountType, discountValue, discountAmount, discountedAmount, vatAmount, totalContractAmount, previousPayment, balanceDue, schedule, scheduleTotal };
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
const BOAT_APPLICATIONS = ['Passenger Boat','Ferry','Fishing Boat','Patrol Boat','Sea Ambulance','Fire Boat','Rescue Boat','Utility Boat','Research Vessel','Dive Boat','Pleasure/Leisure','Cargo/Utility Boat','Other'];
const ENGINE_INCLUSIONS_CATALOG = ['Remote Control box with wiring harness (Dual Top mount)','Dual Panel switch','Gauge Kit - Multifunction Digital Tachometer/Speedometer','Battery Cable','Yamaha Primer Bulb','Stainless Propeller','Complete Dometic Hydraulic Steering & Control System',"Engine Owner's Manual"];
const STEERING_SYSTEM_CATALOG = ['Hydraulic Helm 2.4','Front Mount Cylinder','Hydraulic Hose','Hydraulic Oil','Tie Bar Kit for Twin Cylinder','Tee Fittings','Steering Wheel','Control Cable','Ext. Wire Harness','See-through Water Separator Assy.','Fuel Hose','Rigging Kit','Battery Tray 3sm','Battery Terminal'];

/* ============================================================
   ROUTER / NAV
   ============================================================ */
const ROUTES = [
  {id:'dashboard', label:'Dashboard', icon:'grid'},
  {id:'quotes', label:'Quotations', icon:'list'},
  {id:'customers', label:'Customers', icon:'user'},
  {id:'templates', label:'Boat Presets', icon:'ship', adminOnly:true},
  {id:'pricing', label:'Pricing Database', icon:'db', adminOnly:true},
  {id:'profile', label:'My Profile', icon:'user'},
  {id:'settings', label:'Settings', icon:'settings', adminOnly:true},
];
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
    search:'<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  }[name]||'';
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

function renderNav(){
  const nav = document.getElementById('navList');
  const visibleRoutes = ROUTES;
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
  renderNav();
  const titleMap = {dashboard:'Dashboard', editor:'Quotation Editor', quotes:'Quotations', customers:'Customer Database', templates:'Boat Presets', pricing:'Pricing Database', profile:'My Profile', settings:'Settings'};
  document.getElementById('topbarTitle').textContent = titleMap[CURRENT.view] || '';
  const content = document.getElementById('content');
  const actions = document.getElementById('topbarActions');
  actions.innerHTML='';
  if(ADMIN_ONLY_VIEWS.includes(CURRENT.view) && !hasAccess(CURRENT.view)){ renderAccessRestricted(content, actions); return; }
  if(CURRENT.view==='dashboard') renderDashboard(content, actions);
  else if(CURRENT.view==='editor') renderEditor(content, actions);
  else if(CURRENT.view==='quotes') renderQuotesList(content, actions);
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
      <div class="stat"><div class="lbl">Total Quotations</div><div class="val">${QUOTES.length}</div></div>
      <div class="stat teal"><div class="lbl">Total Quoted Value</div><div class="val">${fmt(totalVal)}</div></div>
      <div class="stat amber"><div class="lbl">Average Quotation</div><div class="val">${fmt(avg)}</div></div>
      <div class="stat"><div class="lbl">Approved</div><div class="val">${approved}</div></div>
    </div>
    <div class="grid g2" style="align-items:start;">
      <div class="card">
        <div class="card-head"><h3>Recent Quotations</h3><span class="btn btn-ghost btn-sm" id="viewAllQ">View All</span></div>
        <div class="card-body" style="padding:0;">
          ${recent.length? `<table><thead><tr><th>Ref No.</th><th>Client</th><th>Boat</th><th class="right">Total</th><th>Status</th><th></th></tr></thead><tbody>
            ${recent.map(q=>{
              const t = computeAll(q).finalTotal;
              return `<tr>
                <td class="mono">${q.refNo}</td>
                <td>${esc(customerDisplayName(q.customerSnap))||'—'}</td>
                <td>${esc(q.project.boatModel||q.hull.boatType)} · ${q.hull.loa||0}ft</td>
                <td class="right mono">${fmt(t)}</td>
                <td><span class="badge ${q.status}">${statusLabel(q.status)}</span></td>
                <td class="right"><span class="btn btn-ghost btn-sm" data-open="${q.id}">Open →</span></td>
              </tr>`;
            }).join('')}
          </tbody></table>` : `<div class="empty">No quotations yet. Create your first one to see it here.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Quick Actions</h3></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px;">
          <button class="btn" id="qaTemplates">${icon('ship')} Start from a Boat Template</button>
          <button class="btn" id="qaCustomer">${icon('user')} Add a Customer</button>
          <button class="btn" id="qaPricing">${icon('db')} Update Pricing Database</button>
        </div>
        <div class="card-head" style="border-top:1px solid var(--paper-line);"><h3>System Notes</h3></div>
        <div class="card-body section-lead">
          Quotations calculate automatically from hull dimensions, laminate schedule, paint coverage, itemized accessories, engine package, and labor hours — all priced from the editable Pricing Database. Update rates once; every new quotation applies them.
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
        <span style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${pendingApproval.length?'#2563a8':'var(--ink-faint)'};">${pendingApproval.length ? `Awaiting Your Approval:` : `Nothing awaiting approval`}</span>
        ${pendingApproval.map(q=>`<span class="btn btn-sm" data-open="${q.id}" style="background:#eaf1fb;color:#2563a8;border-color:#eaf1fb;">${esc(q.refNo)}</span>`).join('')}
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
  content.innerHTML = `<div class="card"><div class="card-body" style="padding:0;" id="custWrap"></div></div>`;
  document.getElementById('btnAddCust').onclick = ()=>{
    CUSTOMERS.push({id:uid('c'), name:'New Customer', email:'', contact:'', address:''});
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

/* ============================================================
   BOAT PRESETS
   ============================================================ */
let _presetOpenModel = null;

function renderTemplates(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnSaveTemplates">Save Boat Presets</button> <button class="btn" id="btnAddModel">${icon('plus')} Add Boat Model</button>`;
  content.innerHTML = `<div class="section-lead">Click a Boat Model's card to open and edit its standard measurements, painting specs, and structural components. Drag a card by its ⠿ handle to rearrange the order. Selecting that model in a quotation's Hull Particulars tab automatically fills in these details. Edits here are staged until you click "Save Boat Presets" — same as the Pricing Database.</div>
  <div id="presetGrid"></div>`;
  const grid = document.getElementById('presetGrid');

  document.getElementById('btnSaveTemplates').onclick = ()=>{
    save(DB_KEYS.templates, TEMPLATES); toast('Boat Presets saved');
  };
  document.getElementById('btnAddModel').onclick = ()=>{
    const name = prompt('Name the new Boat Model:');
    if(name===null) return;
    const trimmed = name.trim();
    if(!trimmed) return;
    if(getBoatModelList().includes(trimmed)){ toast('That Boat Model already exists'); return; }
    TEMPLATES.push(blankPreset(trimmed));
    _presetOpenModel = trimmed;
    draw();
  };

  function blankPreset(model){
    return { id:uid('tpl'), name:model, boatModel:model, boatType:'Passenger Boat',
      loa:0, beam:0, depth:0, numHulls:1, hullAreaOverride:null, layers:3, glassPerLayer:0.6,
      paintType:'Marine Polyurethane Topcoat', paintArea:null, coats:3, components:[] };
  }
  function getPreset(model){
    let t = TEMPLATES.find(x=>x.boatModel===model);
    if(!t){ t = blankPreset(model); TEMPLATES.push(t); }
    return t;
  }

  function draw(){
    const models = getBoatModelList();
    if(_presetOpenModel && !models.includes(_presetOpenModel)) _presetOpenModel = null;

    // Every displayed model needs a real preset object (auto-created by
    // getPreset), and every preset needs an `order` number so card position
    // is stable and can be rearranged by drag-and-drop, persisting the same
    // way as any other preset edit (staged until "Save Boat Presets").
    models.forEach(m=>getPreset(m));
    let maxOrder = Math.max(-1, ...TEMPLATES.map(t=>Number.isFinite(t.order)?t.order:-1));
    TEMPLATES.forEach(t=>{ if(!Number.isFinite(t.order)){ maxOrder++; t.order = maxOrder; } });
    const orderedModels = [...models].sort((a,b)=> getPreset(a).order - getPreset(b).order);

    if(!_presetOpenModel){
      drawPreviewGrid(orderedModels);
    } else {
      drawDetail(_presetOpenModel);
    }
  }

  function drawPreviewGrid(models){
    grid.innerHTML = `<div class="grid g4" id="previewCardsWrap">${models.map(m=>{
      const t = getPreset(m);
      return `
      <div class="card preset-preview-card" draggable="true" data-openmodel="${esc(m)}" style="cursor:pointer;transition:box-shadow .15s, transform .15s, opacity .15s;position:relative;">
        <div class="card-body" style="padding-top:26px;">
          <div class="drag-handle" title="Drag to reorder" style="position:absolute;top:8px;right:10px;cursor:grab;color:var(--ink-faint);font-size:13px;letter-spacing:2px;line-height:1;user-select:none;">⠿</div>
          <div style="font-family:'Sora',sans-serif;font-weight:700;font-size:13.5px;margin-bottom:10px;padding-right:16px;">${esc(m)}</div>
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
        const arr = models.slice();
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

  function drawDetail(m){
    const t = getPreset(m);
    grid.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="btnBackToModels" style="margin-bottom:14px;">← Back to Boat Models</button>
      <div class="card" data-model="${esc(m)}">
        <div class="card-head">
          <h3 style="font-family:'Sora',sans-serif;font-weight:700;font-size:14px;">${esc(m)}</h3>
          <button class="btn btn-ghost btn-sm" data-delmodel="${esc(m)}" style="color:var(--danger);">Remove Model</button>
        </div>
        <div class="card-body">
          <div class="grid g4">
            <div class="field"><label>LOA (ft)</label><input type="number" step="any" class="tpl-f" data-f="loa" value="${t.loa||0}"></div>
            <div class="field"><label>Beam (ft)</label><input type="number" step="any" class="tpl-f" data-f="beam" value="${t.beam||0}"></div>
            <div class="field"><label>Depth (ft)</label><input type="number" step="any" class="tpl-f" data-f="depth" value="${t.depth||0}"></div>
            <div class="field"><label>Number of Hulls</label><input type="number" class="tpl-f" data-f="numHulls" value="${t.numHulls||1}"></div>
          </div>
          <div class="grid g3">
            <div class="field"><label>Laminate Layers</label><input type="number" class="tpl-f" data-f="layers" value="${t.layers||0}"></div>
            <div class="field"><label>Glass per Layer (kg/sqm)</label><input type="number" step="any" class="tpl-f" data-f="glassPerLayer" value="${t.glassPerLayer||0}"></div>
            <div class="field"><label>Hull Area Override (sqm)</label><input type="number" step="any" class="tpl-f" data-f="hullAreaOverride" value="${t.hullAreaOverride??''}" placeholder="auto"></div>
          </div>
          <div class="grid g3">
            <div class="field"><label>Paint Type</label><input class="tpl-f" data-f="paintType" value="${esc(t.paintType||'')}"></div>
            <div class="field"><label>Paint Area Override (sqm)</label><input type="number" step="any" class="tpl-f" data-f="paintArea" value="${t.paintArea??''}" placeholder="auto"></div>
            <div class="field"><label>Coats</label><input type="number" class="tpl-f" data-f="coats" value="${t.coats||0}"></div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-soft);">Structural Components</div>
            <button class="btn btn-ghost btn-sm" id="btnAddComp">${icon('plus')} Add Component</button>
          </div>
          <table><thead><tr><th>Category</th><th>Item Name</th><th style="width:70px;">Unit</th><th style="width:64px;">Qty</th><th></th></tr></thead>
          <tbody id="compRows"></tbody></table>
        </div>
      </div>`;

    document.getElementById('btnBackToModels').onclick = ()=>{ _presetOpenModel = null; draw(); };
    document.querySelector('[data-delmodel]').onclick = ()=>{
      if(!confirm(`Remove "${m}" as a Boat Model? Its saved preset will be deleted once you click Save Boat Presets.`)) return;
      TEMPLATES = TEMPLATES.filter(t=>t.boatModel!==m);
      if(LEGACY_BOAT_MODELS.includes(m)){
        toast('Removed — it will still appear as a default option elsewhere until removed from the code.');
      }
      _presetOpenModel = null; draw();
    };
    grid.querySelectorAll('.tpl-f').forEach(i=>i.onchange=()=>{
      const f = i.dataset.f;
      if(['loa','beam','depth','numHulls','layers','glassPerLayer','coats'].includes(f)) t[f] = Number(i.value)||0;
      else if(['hullAreaOverride','paintArea'].includes(f)) t[f] = i.value===''? null : Number(i.value);
      else t[f] = i.value;
    });

    const body = document.getElementById('compRows');
    function drawComponents(){
      body.innerHTML = (t.components||[]).map((c,idx)=>`
        <tr>
          <td><input class="tbl-input comp-f" data-idx="${idx}" data-f="cat" value="${esc(c.cat)}"></td>
          <td><input class="tbl-input comp-f" data-idx="${idx}" data-f="name" value="${esc(c.name)}"></td>
          <td><input class="tbl-input comp-f" data-idx="${idx}" data-f="unit" value="${esc(c.unit)}"></td>
          <td><input class="tbl-input num comp-f" data-idx="${idx}" data-f="qty" type="number" step="any" value="${c.qty}"></td>
          <td class="right"><span class="btn btn-ghost btn-sm" data-delcomp="${idx}" style="color:var(--danger);">Remove</span></td>
        </tr>`).join('') || `<tr><td colspan="5" class="empty" style="padding:12px;">No components yet.</td></tr>`;
      body.querySelectorAll('.comp-f').forEach(i=>i.onchange=()=>{
        const c = t.components[Number(i.dataset.idx)];
        c[i.dataset.f] = i.dataset.f==='qty' ? Number(i.value) : i.value;
      });
      body.querySelectorAll('[data-delcomp]').forEach(b=>b.onclick=()=>{
        t.components.splice(Number(b.dataset.idx),1); drawComponents();
      });
    }
    drawComponents();
    document.getElementById('btnAddComp').onclick = ()=>{
      if(!t.components) t.components = [];
      t.components.push({cat:'Other Structural Materials', name:'New Item', unit:'pc', qty:1});
      drawComponents();
    };
  }

  draw();
}

/* ============================================================
   PRICING DATABASE
   ============================================================ */
function renderPricing(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnSavePricing">Save Pricing Database</button> <button class="btn btn-ghost" id="btnResetPricing">Reset to Defaults</button>`;
  const r = PRICING;
  content.innerHTML = `
    <div class="section-lead">These values feed every new quotation's default rates (each quotation keeps its own editable snapshot, so changes here won't retroactively alter saved quotes).</div>
    <div class="grid g2">
      <div class="card"><div class="card-head"><h3>Hull Materials</h3></div><div class="card-body grid g2">
        ${numField('Fiberglass (₱/kg)','fiberglassPerKg',r.fiberglassPerKg)}
        ${numField('Resin (₱/liter)','resinPerLiter',r.resinPerLiter)}
        ${numField('Resin Density (kg/L)','resinDensity',r.resinDensity)}
        ${numField('Resin:Glass Ratio','resinRatio',r.resinRatio)}
        ${numField('Gelcoat (₱/kg)','gelcoatPerKg',r.gelcoatPerKg)}
        ${numField('Gelcoat Coverage (kg/sqm)','gelcoatCoverage',r.gelcoatCoverage)}
        ${numField('Core Material (₱/sqm)','corePerSqm',r.corePerSqm)}
      </div></div>
      <div class="card"><div class="card-head"><h3>Paint &amp; Finishing</h3></div><div class="card-body grid g2">
        ${numField('Primer (₱/liter)','primerPerLiter',r.primerPerLiter)}
        ${numField('Primer Coverage (sqm/L)','primerCoverage',r.primerCoverage)}
        ${numField('Topcoat Paint (₱/liter)','paintPerLiter',r.paintPerLiter)}
        ${numField('Paint Coverage (sqm/L per coat)','paintCoverage',r.paintCoverage)}
      </div></div>
      <div class="card"><div class="card-head"><h3>Labor Rates (₱/hour)</h3></div><div class="card-body grid g3">
        ${Object.keys(r.laborRates).map(k=>numField(cap(k),'labor_'+k,r.laborRates[k])).join('')}
      </div></div>
      <div class="card"><div class="card-head"><h3>Overhead, Contingency &amp; Margin</h3></div><div class="card-body grid g3">
        ${numField('Overhead (%)','overheadPct',r.overheadPct)}
        ${numField('Contingency (%)','contingencyPct',r.contingencyPct)}
        ${numField('Profit Margin (%)','marginPct',r.marginPct)}
      </div></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Engine Package Catalog</h3><button class="btn btn-sm" id="addEngine">${icon('plus')} Add Engine Package</button></div>
      <div class="card-body" style="padding:0;"><table><thead><tr><th>Model / Description</th><th>HP</th><th class="right">Price (₱)</th><th></th></tr></thead><tbody id="engineRows"></tbody></table></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Standard Accessory Catalog</h3><button class="btn btn-sm" id="addAccItem">${icon('plus')} Add Item</button></div>
      <div class="card-body" style="padding:0;"><table><thead><tr><th>Category</th><th>Item Name</th><th class="right">Unit Price (₱)</th><th></th></tr></thead><tbody id="accCatRows"></tbody></table></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Structural Components &amp; Core Materials Catalog</h3><button class="btn btn-sm" id="addStructItem">${icon('plus')} Add Item</button></div>
      <div class="card-body section-lead">Stiffeners, bulkheads, urethane foam, coring, and other structural materials used in the Hull tab.</div>
      <div class="card-body" style="padding:0;"><table><thead><tr><th>Category</th><th>Item Name</th><th>Unit</th><th class="right">Unit Price (₱)</th><th></th></tr></thead><tbody id="structCatRows"></tbody></table></div>
    </div>
  `;
  function numField(label,key,val){
    return `<div class="field"><label>${label}</label><input type="number" step="any" class="pf" data-key="${key}" value="${val}"></div>`;
  }
  function cap(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

  function drawEngines(){
    document.getElementById('engineRows').innerHTML = r.engineDb.map(e=>`
      <tr>
        <td><input class="tbl-input eng-f" data-id="${e.id}" data-f="name" value="${esc(e.name)}"></td>
        <td style="width:80px;"><input class="tbl-input num eng-f" data-id="${e.id}" data-f="hp" type="number" value="${e.hp}"></td>
        <td style="width:150px;"><input class="tbl-input num eng-f" data-id="${e.id}" data-f="price" type="number" value="${e.price}"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-del-eng="${e.id}" style="color:var(--danger);">Remove</span></td>
      </tr>`).join('');
    document.querySelectorAll('.eng-f').forEach(i=>i.onchange=()=>{
      const e = r.engineDb.find(x=>x.id===i.dataset.id);
      e[i.dataset.f] = i.dataset.f==='name'? i.value : Number(i.value);
    });
    document.querySelectorAll('[data-del-eng]').forEach(b=>b.onclick=()=>{ r.engineDb = r.engineDb.filter(x=>x.id!==b.dataset.delEng); drawEngines(); });
  }
  document.getElementById('addEngine').onclick=()=>{ r.engineDb.push({id:uid('eng'),name:'New Engine Package',hp:0,price:0}); drawEngines(); };

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

  function drawStructCat(){
    document.getElementById('structCatRows').innerHTML = r.structuralCatalog.map((a,idx)=>`
      <tr>
        <td><input class="tbl-input structcat-f" data-idx="${idx}" data-f="cat" value="${esc(a.cat)}"></td>
        <td><input class="tbl-input structcat-f" data-idx="${idx}" data-f="name" value="${esc(a.name)}"></td>
        <td style="width:100px;"><input class="tbl-input structcat-f" data-idx="${idx}" data-f="unit" value="${esc(a.unit)}"></td>
        <td style="width:150px;"><input class="tbl-input num structcat-f" data-idx="${idx}" data-f="unitPrice" type="number" value="${a.unitPrice}"></td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-del-structcat="${idx}" style="color:var(--danger);">Remove</span></td>
      </tr>`).join('');
    document.querySelectorAll('.structcat-f').forEach(i=>i.onchange=()=>{
      r.structuralCatalog[i.dataset.idx][i.dataset.f] = i.dataset.f==='unitPrice'? Number(i.value) : i.value;
    });
    document.querySelectorAll('[data-del-structcat]').forEach(b=>b.onclick=()=>{ r.structuralCatalog.splice(Number(b.dataset.delStructcat),1); drawStructCat(); });
  }
  document.getElementById('addStructItem').onclick=()=>{ r.structuralCatalog.push({cat:'Other Structural Materials',name:'New Item',unit:'pc',unitPrice:0}); drawStructCat(); };

  drawEngines(); drawAcc(); drawStructCat();

  document.getElementById('btnSavePricing').onclick = ()=>{
    document.querySelectorAll('.pf').forEach(i=>{
      const k = i.dataset.key, v = Number(i.value);
      if(k.startsWith('labor_')) r.laborRates[k.replace('labor_','')] = v;
      else r[k] = v;
    });
    save(DB_KEYS.pricing, PRICING); toast('Pricing database saved');
  };
  document.getElementById('btnResetPricing').onclick = ()=>{
    if(confirm('Reset all pricing to factory defaults?')){ PRICING = JSON.parse(JSON.stringify(DEFAULT_PRICING)); save(DB_KEYS.pricing,PRICING); renderPricing(content,actions); }
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
        q.hull = { boatType:t.boatType, loa:t.loa, beam:t.beam, depth:t.depth, numHulls:t.numHulls||1, hullAreaOverride:t.hullAreaOverride, layers:t.layers, glassPerLayer:t.glassPerLayer, coreArea:0, coreEnabled:false };
        q.paint = { areaOverride:t.paintArea, coats:t.coats, paintType:t.paintType||'Marine Polyurethane Topcoat' };
        if(!q.structural) q.structural = { items:[] };
        q.structural.items = (t.components||[]).map(c=>({...c, id:uid('si'), unitPrice: lookupStructuralPrice(c.cat, c.name)}));
        q.project.title = t.name;
        if(t.boatModel) q.project.boatModel = t.boatModel;
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
  if(q.createdByEmail===undefined) q.createdByEmail = '';
  if(q.approvedBy===undefined) q.approvedBy = null;
  if(q.revisionChildId===undefined) q.revisionChildId = null;
  if(q.revisionOf===undefined) q.revisionOf = null;
  if(!q.accessoryCategoryNA) q.accessoryCategoryNA = {};
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
  {id:'engine', n:'05', label:'Engine'},
  {id:'labor', n:'06', label:'Labor'},
  {id:'pricing', n:'07', label:'Timeline & Margin'},
  {id:'marina', n:'08', label:'MARINA Documentation'},
  {id:'testing', n:'09', label:'Testing & Delivery'},
  {id:'terms', n:'10', label:'Terms & Conditions'},
  {id:'output', n:'11', label:'Quotation Output'},
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
          <div class="card-body" id="liveSummary"></div>
        </div>
        <div class="card" style="margin-top:16px;">
          <div class="card-head"><h3>VAT &amp; Discount</h3></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:12px;">
            <div class="field-inline" style="font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;">
              <span style="min-width:52px;">VAT</span>
              <input type="number" id="vatPct" value="${q.invoice.vatPct}" style="width:64px;padding:6px 8px;border:1px solid var(--paper-line);border-radius:6px;">
              <span>%</span>
            </div>
            <div class="field-inline" style="font-size:12px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="min-width:52px;">Discount</span>
              <select id="discountType" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:6px;">
                <option value="pct" ${q.invoice.discountType==='pct'?'selected':''}>%</option>
                <option value="fixed" ${q.invoice.discountType==='fixed'?'selected':''}>₱ Fixed</option>
              </select>
              <input type="number" id="discountValue" value="${q.invoice.discountValue}" style="width:90px;padding:6px 8px;border:1px solid var(--paper-line);border-radius:6px;">
            </div>
          </div>
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
              ${CURRENT_IS_ADMIN ? `<button class="btn btn-sm btn-ghost" id="btnUnapprove" style="margin-top:10px;">Revoke Approval</button>` : ``}
            ` : ``}
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('vatPct').onchange = (e)=>{
    q.invoice.vatPct = Number(e.target.value)||0; persistQuote(q); renderEditor(content, actions);
  };
  document.getElementById('discountType').onchange = (e)=>{
    q.invoice.discountType = e.target.value; persistQuote(q); renderEditor(content, actions);
  };
  document.getElementById('discountValue').onchange = (e)=>{
    q.invoice.discountValue = Number(e.target.value)||0; persistQuote(q); renderEditor(content, actions);
  };
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

  const unapproveBtn = document.getElementById('btnUnapprove');
  if(unapproveBtn) unapproveBtn.onclick = ()=>{
    if(!confirm('Revoke this approval? The quotation will return to "For Approval" status.')) return;
    q.approvedBy = null;
    q.status = 'for_approval';
    persistQuote(q); toast('Approval revoked'); renderEditor(content, actions);
  };

  const tabsEl = document.getElementById('editTabs');
  tabsEl.innerHTML = EDITOR_TABS.map(t=>`<div class="tab ${CURRENT.tab===t.id?'active':''}" data-tab="${t.id}"><span class="n">${t.n}</span>${t.label}</div>`).join('');
  tabsEl.querySelectorAll('.tab').forEach(el=>el.onclick=()=>{ CURRENT.tab = el.dataset.tab; renderEditor(content,actions); });

  const host = document.getElementById('tabHost');
  const renderers = { client:tabClient, hull:tabHull, paint:tabPaint, accessories:tabAccessories, engine:tabEngine, labor:tabLabor, pricing:tabPricing, marina:tabMarina, testing:tabTesting, terms:tabTerms, output:tabOutput };
  renderers[CURRENT.tab](host, q);

  // Once a quotation leaves Draft, it's locked from editing — only viewing
  // (Print, the internal-cost toggle) and the workflow action buttons stay
  // interactive. Those live outside #tabHost or are explicitly allow-listed.
  if(q.status !== 'draft'){
    const keepEnabled = new Set(['btnPrint','toggleInternal']);
    host.querySelectorAll('input, select, textarea, button').forEach(el=>{
      if(!keepEnabled.has(el.id)) el.disabled = true;
    });
    ['vatPct','discountType','discountValue'].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.disabled = true;
    });
  }

  updateLiveSummary(q);
}

function updateLiveSummary(q){
  const c = computeAll(q);
  document.getElementById('liveSummary').innerHTML = `
    <div class="spec-plate" style="margin:0 0 14px;padding:12px 14px;">
      <div class="row">
        <div class="cell"><div class="l">LOA</div><div class="v">${q.hull.loa||0}′</div></div>
        <div class="cell"><div class="l">Beam</div><div class="v">${q.hull.beam||0}′</div></div>
        <div class="cell"><div class="l">Hull Area</div><div class="v">${fmtNum(c.hull.area,1)}m²</div></div>
      </div>
    </div>
    <div class="sum-row"><span class="k">Material Cost</span><span class="v">${fmt(c.materialCost)}</span></div>
    <div class="sum-row"><span class="k">Labor Cost</span><span class="v">${fmt(c.laborCost)}</span></div>
    <div class="sum-row"><span class="k">Equipment Cost</span><span class="v">${fmt(c.equipmentCost)}</span></div>
    <div class="sum-row"><span class="k">Overhead (${q.rates.overheadPct}%)</span><span class="v">${fmt(c.overheadCost)}</span></div>
    <div class="sum-row"><span class="k">Contingency (${q.rates.contingencyPct}%)</span><span class="v">${fmt(c.contingencyCost)}</span></div>
    <div class="sum-row"><span class="k">Profit Margin (${q.rates.marginPct}%)</span><span class="v">${fmt(c.marginCost)}</span></div>
    <div class="sum-row"><span class="k">Duration (${c.requestedDays}d × ${fmt(q.rates.dailyRate)})</span><span class="v">${fmt(c.durationCost)}</span></div>
    <div class="sum-row"><span class="k">Rush Surcharge${c.isRush?'':' (n/a)'}</span><span class="v">${fmt(c.rushFee)}</span></div>
    <div class="sum-row"><span class="k">MARINA Documentation</span><span class="v">${fmt(c.marinaCost)}</span></div>
    ${c.numBoats>1 ? `<div class="sum-row"><span class="k">Number of Boats</span><span class="v">${c.numBoats}${c.multiplyPrice? ` × unit price` : ' (price not multiplied)'}</span></div>` : ``}
    <div class="sum-total"><span class="k">Final Price</span><span class="v">${fmt(c.finalTotal)}</span></div>
  `;
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
    if(c){ q.customerId=c.id; q.customerSnap={...q.customerSnap, companyName:c.name, email:c.email, contact:c.contact, address:c.address}; persistQuote(q); renderEditor(document.getElementById('content'), document.getElementById('topbarActions')); }
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
          <div class="field"><label>Boat Model</label>
            <select id="hBoatModel">${getBoatModelList().map(o=>`<option ${q.project.boatModel===o?'selected':''}>${o}</option>`).join('')}</select>
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
          <div class="field"><label>Hull Area Override (sqm)</label><input type="number" step="any" id="hAreaOv" value="${h.hullAreaOverride??''}" placeholder="auto"><div class="hint">Leave blank to auto-estimate from LOA and Beam</div></div>
          <div></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Laminate Schedule</h3></div>
      <div class="card-body">
        <div class="grid g3">
          <div class="field"><label>Number of Layers</label><input type="number" id="hLayers" value="${h.layers}"></div>
          <div class="field"><label>Glass Weight per Layer (kg/sqm)</label><input type="number" step="any" id="hGlassPerLayer" value="${h.glassPerLayer}"></div>
          <div class="field"><label class="field-inline"><input type="checkbox" id="hCoreOn" ${h.coreEnabled?'checked':''} style="width:auto;"> Core Material</label>
            <input type="number" step="any" id="hCoreArea" value="${h.coreArea}" placeholder="Core area (sqm)" ${h.coreEnabled?'':'disabled'}>
          </div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Structural Components &amp; Core Materials</h3>
        <div style="display:flex;gap:8px;">
          <select id="structCatalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${PRICING.structuralCatalog.map((a,i)=>`<option value="${i}">${esc(a.cat)} — ${esc(a.name)} (${esc(a.unit)})</option>`).join('')}
          </select>
          <button class="btn btn-sm" id="addBlankStruct">${icon('plus')} Custom Item</button>
        </div>
      </div>
      <div class="card-body section-lead">Stiffeners, bulkheads, urethane foam, coring, and other structural materials — costed here and folded into Material Cost.</div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th style="width:16%;">Category</th><th>Item / Description</th><th style="width:90px;">Unit</th><th style="width:70px;">Qty</th><th style="width:110px;">Unit Price</th><th class="right" style="width:110px;">Total</th><th></th></tr></thead>
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
        <td>
          <select class="tbl-input srow-cat" data-idx="${idx}">
            <option value="" ${a.cat?'':'selected'}>— choose category —</option>
            ${catOptions}
            ${a.cat && !catIsKnown ? `<option value="${esc(a.cat)}" selected>${esc(a.cat)}</option>` : ''}
            <option value="__new__">+ New category…</option>
          </select>
          <input type="text" class="tbl-input srow-cat-new" data-idx="${idx}" placeholder="Type new category" style="display:none;margin-top:4px;">
        </td>
        <td><input class="tbl-input srow" data-idx="${idx}" data-f="name" value="${esc(a.name)}"></td>
        <td><input class="tbl-input srow" data-idx="${idx}" data-f="unit" value="${esc(a.unit)}"></td>
        <td><input class="tbl-input num srow" type="number" data-idx="${idx}" data-f="qty" value="${a.qty}"></td>
        <td><input class="tbl-input num srow" type="number" data-idx="${idx}" data-f="unitPrice" value="${a.unitPrice}"></td>
        <td class="right mono">${fmt(total)}</td>
        <td class="right"><span class="btn btn-ghost btn-sm" data-delstruct="${idx}" style="color:var(--danger);">✕</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="7"><div class="empty">No structural items yet. Add stiffeners, bulkheads, foam core, etc. from the catalog or as a custom line item.</div></td></tr>`;

    structBody.querySelectorAll('.srow-cat').forEach(sel=>{
      sel.addEventListener('change', ()=>{
        const idx = Number(sel.dataset.idx);
        const newInput = structBody.querySelector(`.srow-cat-new[data-idx="${idx}"]`);
        if(sel.value === '__new__'){
          sel.style.display = 'none';
          newInput.style.display = 'block';
          newInput.focus();
          return;
        }
        q.structural.items[idx].cat = sel.value;
        persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
      });
    });
    structBody.querySelectorAll('.srow-cat-new').forEach(inp=>{
      const commit = ()=>{
        const idx = Number(inp.dataset.idx);
        const v = inp.value.trim();
        if(v){ q.structural.items[idx].cat = v; }
        persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
      };
      inp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); commit(); } });
      inp.addEventListener('blur', commit);
    });
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
    });
    structBody.querySelectorAll('[data-delstruct]').forEach(b=>b.onclick=()=>{
      q.structural.items.splice(Number(b.dataset.delstruct),1); persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
    });
  }
  document.getElementById('structCatalogPick').onchange = (e)=>{
    if(e.target.value==='') return;
    const item = PRICING.structuralCatalog[Number(e.target.value)];
    q.structural.items.push({id:uid('si'), cat:item.cat, name:item.name, unit:item.unit, qty:1, unitPrice:item.unitPrice});
    e.target.value=''; persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
  };
  document.getElementById('addBlankStruct').onclick = ()=>{
    // No category preselected — the row's dropdown prompts a familiar/similar
    // category right away, or lets you type a new one.
    q.structural.items.push({id:uid('si'), cat:'', name:'New Item', unit:'pc', qty:1, unitPrice:0});
    persistQuote(q); drawStruct(); drawHullCalc(); updateLiveSummary(q);
  };
  drawStruct();
  document.getElementById('hBoatModel').addEventListener('change', (e)=>{
    q.project.boatModel = e.target.value;
    const preset = TEMPLATES.find(t=>t.boatModel && t.boatModel===e.target.value);
    if(preset){
      q.hull = { boatType:preset.boatType, loa:preset.loa, beam:preset.beam, depth:preset.depth, numHulls:preset.numHulls||1, hullAreaOverride:preset.hullAreaOverride, layers:preset.layers, glassPerLayer:preset.glassPerLayer, coreArea:q.hull.coreArea||0, coreEnabled:q.hull.coreEnabled||false };
      q.paint.areaOverride = preset.paintArea; q.paint.coats = preset.coats;
      if(preset.paintType) q.paint.paintType = preset.paintType;
      if(!q.structural) q.structural = { items:[] };
      q.structural.items = (preset.components||[]).map(c=>({...c, id:uid('si'), unitPrice: lookupStructuralPrice(c.cat, c.name)}));
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
  ['hHulls','hAreaOv','hLayers','hGlassPerLayer','hCoreArea'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      h.numHulls = Number(document.getElementById('hHulls').value)||1;
      const ov = document.getElementById('hAreaOv').value;
      h.hullAreaOverride = ov===''? null : Number(ov);
      h.layers = Number(document.getElementById('hLayers').value);
      h.glassPerLayer = Number(document.getElementById('hGlassPerLayer').value);
      h.coreArea = Number(document.getElementById('hCoreArea').value);
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
          <tr><td>Estimated Hull Surface Area</td><td class="right mono">${fmtNum(c.area,2)} sqm</td></tr>
          <tr><td>Fiberglass Weight Required</td><td class="right mono">${fmtNum(c.glassWeight,1)} kg</td></tr>
          <tr><td>Resin Consumption</td><td class="right mono">${fmtNum(c.resinLiters,1)} L</td></tr>
          <tr><td>Gelcoat Requirement</td><td class="right mono">${fmtNum(c.gelcoatWeight,1)} kg</td></tr>
          <tr><td>Fiberglass Cost</td><td class="right mono">${fmt(c.glassCost)}</td></tr>
          <tr><td>Resin Cost</td><td class="right mono">${fmt(c.resinCost)}</td></tr>
          <tr><td>Gelcoat Cost</td><td class="right mono">${fmt(c.gelcoatCost)}</td></tr>
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
  const p = q.paint;
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Surface Finishing &amp; Painting</h3></div>
      <div class="card-body">
        <div class="grid g3">
          <div class="field"><label>Paintable Area Override (sqm)</label><input type="number" step="any" id="pArea" value="${p.areaOverride??''}" placeholder="uses hull area"></div>
          <div class="field"><label>Number of Coats</label><input type="number" id="pCoats" value="${p.coats}"></div>
          <div class="field"><label>Paint Type</label><input id="pType" value="${esc(p.paintType)}"></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Paint Material Cost Breakdown</h3></div>
      <div class="card-body" id="paintCalcOut"></div>
    </div>
  `;
  ['pArea','pCoats','pType'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      const ov = document.getElementById('pArea').value;
      p.areaOverride = ov===''? null : Number(ov);
      p.coats = Number(document.getElementById('pCoats').value);
      p.paintType = document.getElementById('pType').value;
      persistQuote(q); drawPaintCalc(); updateLiveSummary(q);
    });
  });
  function drawPaintCalc(){
    const hull = computeHull(q); const c = computePaint(q, hull);
    document.getElementById('paintCalcOut').innerHTML = `
      <table><tbody>
        <tr><td>Paintable Surface Area</td><td class="right mono">${fmtNum(c.area,2)} sqm</td></tr>
        <tr><td>Primer Required</td><td class="right mono">${fmtNum(c.primerLiters,1)} L</td></tr>
        <tr><td>Paint Required (${p.coats} coats)</td><td class="right mono">${fmtNum(c.paintLiters,1)} L</td></tr>
        <tr><td>Primer Cost</td><td class="right mono">${fmt(c.primerCost)}</td></tr>
        <tr><td>Paint Cost</td><td class="right mono">${fmt(c.paintCost)}</td></tr>
        <tr><td style="font-weight:700;">Paint Material Cost Total</td><td class="right mono" style="font-weight:700;">${fmt(c.total)}</td></tr>
      </tbody></table>
      <div class="hint" style="margin-top:8px;">Painting labor hours are entered on the Labor tab.</div>`;
  }
  drawPaintCalc();
}

/* ---- Tab: Accessories ---- */
function tabAccessories(host, q){
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Accessories &amp; Boat Components</h3>
        <div style="display:flex;gap:8px;">
          <select id="catalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${PRICING.accessoryCatalog.map((a,i)=>`<option value="${i}">${esc(a.cat)} — ${esc(a.name)}</option>`).join('')}
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

/* ---- Tab: Engine ---- */
function tabEngine(host, q){
  const e = q.engine;
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Engine &amp; Mechanical System</h3></div>
      <div class="card-body">
        <div class="field"><label>Load from Engine Package Catalog</label>
          <select id="engPick"><option value="">— Custom entry —</option>${PRICING.engineDb.map(p=>`<option value="${p.id}">${esc(p.name)} (₱${p.price.toLocaleString()})</option>`).join('')}</select>
        </div>
        <div class="grid g3">
          <div class="field"><label>Engine Brand</label><input id="eBrand" value="${esc(e.brand||'')}" placeholder="e.g. Isuzu, Yamaha"><div class="hint">Used in the auto-generated project title.</div></div>
          <div class="field"><label>Engine Model / Description</label><input id="eModel" value="${esc(e.model)}"></div>
          <div class="field"><label>Motor Type</label>
            <select id="eType"><option value="IBM" ${e.type==='IBM'?'selected':''}>Inboard Motor (IBM)</option><option value="OBM" ${e.type==='OBM'?'selected':''}>Outboard Motor (OBM)</option></select>
          </div>
          <div class="field"><label>Horsepower (HP)</label><input type="number" id="eHp" value="${e.hp}"></div>
          <div class="field"><label>Number of Engines</label><input type="number" id="eQty" value="${e.qty}"></div>
          <div class="field"><label>Unit Price (₱)</label><input type="number" id="ePrice" value="${e.unitPrice}"></div>
          <div class="field"><label>Transmission</label><input id="eTrans" value="${esc(e.transmission)}"></div>
          <div class="field"><label>Propeller</label><input id="eProp" value="${esc(e.propeller)}"></div>
          <div class="field"><label>Engine Speed</label><input id="eSpeed" value="${esc(e.speed||'')}" placeholder="e.g. 25 knots"></div>
          <div class="field"><label>Fuel Capacity</label><input id="eFuelCap" value="${esc(e.fuelCapacity||'')}" placeholder="e.g. 200 liters"></div>
        </div>
        <div class="field"><label>Installation Cost (₱)</label><input type="number" id="eInstall" value="${e.installation}"></div>
        <div class="field"><label>Intro / Spec Paragraph</label><textarea id="eDesc" rows="4" placeholder="e.g. Dual Installation of Yamaha 250HP, Model: F250HETX...">${esc(e.description||'')}</textarea>
          <div class="hint">Prints as an intro paragraph above the inclusion lists under Engine &amp; Mechanical System.</div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Engine Inclusions</h3>
        <div style="display:flex;gap:8px;">
          <select id="inclCatalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${ENGINE_INCLUSIONS_CATALOG.map((a,i)=>`<option value="${i}">${esc(a)}</option>`).join('')}
          </select>
          <button class="btn btn-sm" id="addBlankIncl">${icon('plus')} Custom Item</button>
        </div>
      </div>
      <div class="card-body section-lead">Items bundled with the engine package — printed as a bullet list under Engine &amp; Mechanical System.</div>
      <div class="card-body" style="padding:0;" id="inclRows"></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Steering System &amp; Control System</h3>
        <div style="display:flex;gap:8px;">
          <select id="steerCatalogPick" style="padding:6px 8px;border:1px solid var(--paper-line);border-radius:7px;">
            <option value="">+ Add from catalog…</option>
            ${STEERING_SYSTEM_CATALOG.map((a,i)=>`<option value="${i}">${esc(a)}</option>`).join('')}
          </select>
          <button class="btn btn-sm" id="addBlankSteer">${icon('plus')} Custom Item</button>
        </div>
      </div>
      <div class="card-body section-lead">Steering helm, hydraulics, and rigging components — printed as its own subsection under Engine &amp; Mechanical System.</div>
      <div class="card-body" style="padding:0;" id="steerRows"></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Engine Cost Summary</h3></div>
      <div class="card-body" id="engineCalcOut"></div>
    </div>
  `;
  document.getElementById('engPick').onchange = (ev)=>{
    const pkg = PRICING.engineDb.find(x=>x.id===ev.target.value);
    if(pkg){ e.model=pkg.name; e.hp=pkg.hp; e.unitPrice=pkg.price; persistQuote(q); tabEngine(host,q); updateLiveSummary(q); }
  };
  ['eBrand','eModel','eHp','eQty','ePrice','eTrans','eProp','eSpeed','eFuelCap','eInstall','eDesc'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      e.brand = document.getElementById('eBrand').value;
      e.model = document.getElementById('eModel').value;
      e.hp = Number(document.getElementById('eHp').value);
      e.qty = Number(document.getElementById('eQty').value);
      e.unitPrice = Number(document.getElementById('ePrice').value);
      e.transmission = document.getElementById('eTrans').value;
      e.propeller = document.getElementById('eProp').value;
      e.speed = document.getElementById('eSpeed').value;
      e.fuelCapacity = document.getElementById('eFuelCap').value;
      e.installation = Number(document.getElementById('eInstall').value);
      e.description = document.getElementById('eDesc').value;
      persistQuote(q); drawEng(); updateLiveSummary(q);
    });
  });
  document.getElementById('eType').addEventListener('change', ()=>{
    e.type = document.getElementById('eType').value;
    persistQuote(q); updateLiveSummary(q);
  });

  // Generic item-list renderer, used for both Inclusions and Steering System —
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
        (cid==='inclRows' ? e.inclusions : e.steeringItems).splice(Number(idx),1);
        persistQuote(q); drawItemList('inclRows', e.inclusions); drawItemList('steerRows', e.steeringItems); updateLiveSummary(q);
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
  document.getElementById('steerCatalogPick').onchange = (ev)=>{
    if(ev.target.value==='') return;
    e.steeringItems.push(STEERING_SYSTEM_CATALOG[Number(ev.target.value)]);
    ev.target.value=''; persistQuote(q); drawItemList('steerRows', e.steeringItems); updateLiveSummary(q);
  };
  document.getElementById('addBlankSteer').onclick = ()=>{
    e.steeringItems.push('New Item');
    persistQuote(q); drawItemList('steerRows', e.steeringItems); updateLiveSummary(q);
  };
  drawItemList('inclRows', e.inclusions);
  drawItemList('steerRows', e.steeringItems);

  function drawEng(){
    const c = computeEngine(q);
    document.getElementById('engineCalcOut').innerHTML = `
      <table><tbody>
        <tr><td>Engines (${e.qty} × ${fmt(e.unitPrice)})</td><td class="right mono">${fmt(c.unitsCost)}</td></tr>
        <tr><td>Installation</td><td class="right mono">${fmt(e.installation)}</td></tr>
        <tr><td style="font-weight:700;">Engine &amp; Mechanical Total</td><td class="right mono" style="font-weight:700;">${fmt(c.total)}</td></tr>
      </tbody></table>`;
  }
  drawEng();
}

/* ---- Tab: Labor ---- */
function tabLabor(host, q){
  const l = q.labor, rates = q.rates.laborRates;
  const labels = {fabrication:'Hull Fabrication', fiberglass:'Fiberglass Work', painting:'Painting', electrical:'Electrical Installation', assembly:'Assembly', testing:'Testing & Commissioning'};
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Labor &amp; Manufacturing Hours</h3></div>
      <div class="card-body" style="padding:0;">
        <table><thead><tr><th>Category</th><th style="width:120px;">Hours</th><th style="width:140px;">Rate (₱/hr)</th><th class="right" style="width:130px;">Cost</th></tr></thead>
        <tbody id="laborRows"></tbody></table>
      </div>
    </div>
  `;
  function draw(){
    const c = computeLabor(q);
    document.getElementById('laborRows').innerHTML = c.rows.map(r=>`
      <tr>
        <td>${labels[r.key]}</td>
        <td><input type="number" class="tbl-input num lrow" data-k="${r.key}" data-f="hours" value="${r.hours}"></td>
        <td><input type="number" class="tbl-input num lrow" data-k="${r.key}" data-f="rate" value="${r.rate}"></td>
        <td class="right mono">${fmt(r.cost)}</td>
      </tr>`).join('') + `<tr><td colspan="3" style="font-weight:700;">Total Labor Cost</td><td class="right mono" style="font-weight:700;">${fmt(c.total)}</td></tr>`;
    document.querySelectorAll('.lrow').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        if(inp.dataset.f==='hours') l[inp.dataset.k] = Number(inp.value);
        else rates[inp.dataset.k] = Number(inp.value);
        persistQuote(q); updateLiveSummary(q);
        // Patch just this row's cost and the grand total in place, instead
        // of rebuilding the whole table — a full rebuild would destroy and
        // recreate the focused input, kicking focus out after every
        // keystroke.
        const c = computeLabor(q);
        const row = c.rows.find(r=>r.key===inp.dataset.k);
        const tr = inp.closest('tr');
        if(tr) tr.querySelector('td:last-child').textContent = fmt(row.cost);
        const totalCell = document.querySelector('#laborRows tr:last-child td:last-child');
        if(totalCell) totalCell.textContent = fmt(c.total);
      });
    });
  }
  draw();
}

/* ---- Tab: Overhead & Margin ---- */
function tabPricing(host, q){
  const r = q.rates;
  const sch = q.schedule;
  host.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Construction Timeline</h3></div>
      <div class="card-body">
        <div class="section-lead">Price scales with how long the build takes — every day of construction carries a facility/overhead cost, and delivery dates faster than the standard build time carry a rush surcharge.</div>
        <div class="grid g3">
          <div class="field"><label>Construction Start Date</label><input type="date" id="schStart" value="${sch.startDate}"></div>
          <div class="field"><label>Standard Build Duration (days)</label><input type="number" id="schStandard" value="${sch.standardDays}"></div>
          <div class="field"><label>Requested / Quoted Duration (days)</label><input type="number" id="schRequested" value="${sch.requestedDays}"></div>
        </div>
        <div class="field"><label>Daily Rate (₱/day)</label><input type="number" step="any" id="schDailyRate" value="${r.dailyRate}"><div class="hint">Facility, utilities, and standby crew cost accrued per calendar day of construction.</div></div>
        <div class="field"><label>Rush Surcharge (%)</label><input type="number" step="any" id="schRushPct" value="${r.rushFeePct}"><div class="hint">Applied to base cost only if the requested duration is shorter than the standard build duration.</div></div>
        <div id="timelineOut"></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Pricing Formula — This Quotation</h3></div>
      <div class="card-body">
        <div class="section-lead">These percentages are copied from the Pricing Database when the quotation is created and can be adjusted per-job without affecting other quotations.</div>
        <div class="grid g3">
          <div class="field"><label>Overhead (%)</label><input type="number" step="any" id="oPct" value="${r.overheadPct}"></div>
          <div class="field"><label>Contingency (%)</label><input type="number" step="any" id="cPct" value="${r.contingencyPct}"></div>
          <div class="field"><label>Profit Margin (%)</label><input type="number" step="any" id="mPct" value="${r.marginPct}"></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-head"><h3>Full Pricing Formula</h3></div>
      <div class="card-body" id="formulaOut"></div>
    </div>
  `;
  ['schStart','schStandard','schRequested','schDailyRate','schRushPct'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      sch.startDate = document.getElementById('schStart').value;
      sch.standardDays = Number(document.getElementById('schStandard').value);
      sch.requestedDays = Number(document.getElementById('schRequested').value);
      r.dailyRate = Number(document.getElementById('schDailyRate').value);
      r.rushFeePct = Number(document.getElementById('schRushPct').value);
      persistQuote(q); drawFormula(); updateLiveSummary(q);
    });
  });
  ['oPct','cPct','mPct'].forEach(id=>{
    document.getElementById(id).addEventListener('input', ()=>{
      r.overheadPct = Number(document.getElementById('oPct').value);
      r.contingencyPct = Number(document.getElementById('cPct').value);
      r.marginPct = Number(document.getElementById('mPct').value);
      persistQuote(q); drawFormula(); updateLiveSummary(q);
    });
  });
  function drawFormula(){
    const c = computeAll(q);
    document.getElementById('timelineOut').innerHTML = `
      <table style="margin-top:6px;"><tbody>
        <tr><td>Requested Duration</td><td class="right mono">${c.requestedDays} days</td></tr>
        <tr><td>Estimated Delivery Date</td><td class="right mono">${c.deliveryDate? c.deliveryDate.toISOString().slice(0,10) : '—'}</td></tr>
        <tr><td>${c.isRush? 'Rush Build (faster than standard)' : 'Standard Build Schedule'}</td><td class="right">${c.isRush? '⚡ Rush surcharge applies' : '✓ No surcharge'}</td></tr>
      </tbody></table>`;
    document.getElementById('formulaOut').innerHTML = `
      <table><tbody>
        <tr><td>Material Cost</td><td class="right mono">${fmt(c.materialCost)}</td></tr>
        <tr><td>+ Labor Cost</td><td class="right mono">${fmt(c.laborCost)}</td></tr>
        <tr><td>+ Equipment Cost</td><td class="right mono">${fmt(c.equipmentCost)}</td></tr>
        <tr><td style="border-top:1px solid var(--paper-line);">= Base Cost</td><td class="right mono" style="border-top:1px solid var(--paper-line);">${fmt(c.base)}</td></tr>
        <tr><td>+ Overhead (${r.overheadPct}%)</td><td class="right mono">${fmt(c.overheadCost)}</td></tr>
        <tr><td>+ Contingency (${r.contingencyPct}%)</td><td class="right mono">${fmt(c.contingencyCost)}</td></tr>
        <tr><td>+ Profit Margin (${r.marginPct}%)</td><td class="right mono">${fmt(c.marginCost)}</td></tr>
        <tr><td>+ Construction Duration Cost (${c.requestedDays} days × ${fmt(r.dailyRate)}/day)</td><td class="right mono">${fmt(c.durationCost)}</td></tr>
        <tr><td>+ Rush Surcharge ${c.isRush?`(${r.rushFeePct}%)`:'(not applicable)'}</td><td class="right mono">${fmt(c.rushFee)}</td></tr>
        <tr><td>+ MARINA Documentation &amp; Regulatory Requirements</td><td class="right mono">${fmt(c.marinaCost)}</td></tr>
        ${c.multiplyPrice && c.numBoats>1 ? `<tr><td style="border-top:1px solid var(--paper-line);">= Per-Unit Price</td><td class="right mono" style="border-top:1px solid var(--paper-line);">${fmt(c.unitFinalTotal)}</td></tr>
        <tr><td>× Number of Boats</td><td class="right mono">${c.numBoats}</td></tr>` : ``}
        <tr class="grand"><td style="font-weight:700;">= Final Quotation Price</td><td class="right mono" style="font-weight:700;">${fmt(c.finalTotal)}</td></tr>
      </tbody></table>`;
  }
  drawFormula();
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
        <div class="hint">This section prints on the quotation document as "MARINA Documentation &amp; Regulatory Requirements", right after Engine &amp; Mechanical System. Only the requirement names and the total price show on the printed document.</div>
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
function sigCardHtml(role, label, noUpload){
  const s = SIGNATORIES[role];
  if(noUpload){
    return `
    <div class="sigcard" data-role="${role}">
      <div class="role">${label}</div>
      <input type="text" class="sig-name" placeholder="Full name" value="${esc(s.name)}">
      <input type="text" class="sig-title" placeholder="Title / position" value="${esc(s.title)}">
      <div class="hint" style="margin-top:8px;">Signed physically on the printed copy — no image upload needed.</div>
    </div>`;
  }
  return `
    <div class="sigcard" data-role="${role}">
      <div class="role">${label}</div>
      <div class="prev ${s.img?'':'empty'}">${s.img? `<img src="${esc(s.img)}" alt="">` : 'No signature'}</div>
      <input type="text" class="sig-name" placeholder="Full name" value="${esc(s.name)}">
      <input type="text" class="sig-title" placeholder="Title / position" value="${esc(s.title)}">
      <div class="row2">
        <button class="btn btn-sm sig-upload" type="button">⬆ Upload image</button>
        <button class="btn btn-sm btn-ghost sig-clear" type="button">Clear</button>
      </div>
      <input type="file" class="sig-file" accept="image/*" style="display:none;">
      <div class="field" style="margin:8px 0 0;">
        <div class="field-inline">
          <input type="text" class="sig-drive" placeholder="Paste Google Drive image share link…" style="flex:1;">
          <button class="btn btn-sm sig-drive-apply" type="button">Use</button>
        </div>
        <div class="hint">Drive file must be shared as "Anyone with the link".</div>
      </div>
    </div>`;
}
function bindSigCards(host, q){
  host.querySelectorAll('.sigcard:not(.sigcard-readonly)').forEach(card=>{
    const role = card.dataset.role;
    const s = SIGNATORIES[role];
    card.querySelector('.sig-name').addEventListener('input', e=>{
      s.name = e.target.value; saveSignatories();
      const nm = document.querySelector(`[data-sigprev="${role}"] .nm`);
      if(nm) nm.textContent = s.name || '\u00A0';
    });
    card.querySelector('.sig-title').addEventListener('input', e=>{
      s.title = e.target.value; saveSignatories();
      const ttl = document.querySelector(`[data-sigprev="${role}"] .ttl`);
      if(ttl) ttl.textContent = s.title || '';
    });
    const uploadBtn = card.querySelector('.sig-upload');
    const fileInput = card.querySelector('.sig-file');
    const driveApplyBtn = card.querySelector('.sig-drive-apply');
    const clearBtn = card.querySelector('.sig-clear');
    if(uploadBtn && fileInput){
      uploadBtn.addEventListener('click', ()=> fileInput.click());
      fileInput.addEventListener('change', async (e)=>{
        const f = e.target.files[0]; if(!f) return;
        s.img = await fileToDataURL(f); saveSignatories(); toast('Signature uploaded'); tabOutput(host.closest('#tabHost')||host.parentElement, q);
      });
    }
    if(driveApplyBtn){
      driveApplyBtn.addEventListener('click', ()=>{
        const link = card.querySelector('.sig-drive').value;
        if(!link){ toast('Paste a Google Drive link first'); return; }
        s.img = driveImgUrl(link); saveSignatories(); toast('Signature linked from Drive');
        tabOutput(host.closest('#tabHost')||host.parentElement, q);
      });
    }
    if(clearBtn){
      clearBtn.addEventListener('click', ()=>{
        s.img=''; saveSignatories(); tabOutput(host.closest('#tabHost')||host.parentElement, q);
      });
    }
  });
}

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
   E-Signature (self-editable). Position and admin status are set by
   an admin in Settings → User Management, shown here read-only.
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
          <div class="field"><label>Position</label><input value="${esc(p.position)||'Not yet assigned'}" disabled><div class="hint">Set by an admin in Settings → User Management.</div></div>
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

async function drawUserManagement(){
  const tbody = document.getElementById('userMgmtRows');
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="empty">Loading…</td></tr>`;
  let permsRows = [];
  try{
    const { data, error } = await supabaseClient.from('user_permissions').select('email,section');
    if(error) throw error;
    permsRows = data || [];
  }catch(e){ console.error('Loading permissions failed', e); }

  const permsByEmail = {};
  permsRows.forEach(r=>{ (permsByEmail[r.email] = permsByEmail[r.email]||new Set()).add(r.section); });

  const rows = ALL_PROFILES.slice().sort((a,b)=>a.email.localeCompare(b.email));
  tbody.innerHTML = rows.map(p=>{
    const perms = permsByEmail[p.email] || new Set();
    const sections = ['quotes','templates','pricing','settings'];
    return `
    <tr data-email="${esc(p.email)}">
      <td>${esc(p.email)}</td>
      <td><input class="tbl-input um-position" value="${esc(p.position)}" style="min-width:140px;"></td>
      <td class="right"><input type="checkbox" class="um-admin" ${p.is_admin?'checked':''}></td>
      ${sections.map(s=>`<td class="right"><input type="checkbox" class="um-perm" data-section="${s}" ${perms.has(s)?'checked':''}></td>`).join('')}
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="empty">No one has logged in yet.</td></tr>`;

  tbody.querySelectorAll('tr[data-email]').forEach(tr=>{
    const email = tr.dataset.email;
    tr.querySelector('.um-position').addEventListener('change', async (e)=>{
      const { error } = await supabaseClient.from('user_profiles').update({ position: e.target.value, updated_at: new Date().toISOString() }).eq('email', email);
      if(error){ toast('Failed to save position'); console.error(error); } else { toast('Position updated'); await refreshAllProfiles(); }
    });
    tr.querySelector('.um-admin').addEventListener('change', async (e)=>{
      const { error } = await supabaseClient.from('user_profiles').update({ is_admin: e.target.checked, updated_at: new Date().toISOString() }).eq('email', email);
      if(error){ toast('Failed to update admin status'); console.error(error); e.target.checked=!e.target.checked; }
      else { toast(e.target.checked? `${email} is now an admin` : `${email} is no longer an admin`); await refreshAllProfiles(); }
    });
    tr.querySelectorAll('.um-perm').forEach(cb=>{
      cb.addEventListener('change', async (e)=>{
        const section = e.target.dataset.section;
        if(e.target.checked){
          const { error } = await supabaseClient.from('user_permissions').insert({ email, section });
          if(error){ toast('Failed to grant access'); console.error(error); e.target.checked=false; }
        } else {
          const { error } = await supabaseClient.from('user_permissions').delete().eq('email', email).eq('section', section);
          if(error){ toast('Failed to remove access'); console.error(error); e.target.checked=true; }
        }
      });
    });
  });
}

function renderSettings(content, actions){
  actions.innerHTML = `<button class="btn btn-primary" id="btnSaveCompany">Save Settings</button>`;
  const c = COMPANY;
  content.innerHTML = `
    ${CURRENT_IS_ADMIN ? `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-head"><h3>User Management</h3></div>
      <div class="card-body">
        <div class="section-lead" style="margin-top:0;">Assign each person's Position and which sections they can access. Admins automatically get full access to everything, regardless of the checkboxes below. Changes save immediately.</div>
        <div style="overflow-x:auto;">
        <table><thead><tr><th>Email</th><th>Position</th><th class="right">Admin</th><th class="right">Quotations</th><th class="right">Boat Presets</th><th class="right">Pricing DB</th><th class="right">Settings</th></tr></thead>
        <tbody id="userMgmtRows"></tbody></table>
        </div>
      </div>
    </div>` : ``}
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

  if(CURRENT_IS_ADMIN) drawUserManagement();

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
        <label class="field-inline" style="font-size:11.5px;color:var(--ink-soft);">
          <input type="checkbox" id="toggleInternal" ${q.output.showInternalCosts?'checked':''} style="width:auto;">
          Include internal cost breakdown in printed output
        </label>
        <span class="hint">VAT and discount are set in the "VAT &amp; Discount" panel next to Live Total. Approval is there too. Prepared By, Approved By, and CONFORME all fill in automatically below — nothing to edit here.</span>
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
        <table>
          <tbody>
            <tr><td>Hull Material Cost (fiberglass, resin, gelcoat, core)</td><td class="right mono">${fmt(c.hull.total)}</td></tr>
            <tr><td>Structural Components &amp; Core Materials</td><td class="right mono">${fmt(c.structural.total)}</td></tr>
            <tr><td>Paint &amp; Finishing Material Cost</td><td class="right mono">${fmt(c.paint.total)}</td></tr>
            <tr><td>Accessories &amp; Components</td><td class="right mono">${fmt(c.acc.total)}</td></tr>
            <tr><td>Engine &amp; Mechanical System</td><td class="right mono">${fmt(c.eng.total)}</td></tr>
            <tr><td>MARINA Documentation &amp; Regulatory Requirements</td><td class="right mono">${fmt(c.marinaCost)}</td></tr>
            <tr><td>Testing &amp; Delivery</td><td class="right mono">${fmt(c.testing.total)}</td></tr>
            ${q.output.showInternalCosts ? `
            <tr><td>Labor &amp; Manufacturing</td><td class="right mono">${fmt(c.laborCost)}</td></tr>
            <tr><td>Overhead (${q.rates.overheadPct}%)</td><td class="right mono">${fmt(c.overheadCost)}</td></tr>
            <tr><td>Contingency (${q.rates.contingencyPct}%)</td><td class="right mono">${fmt(c.contingencyCost)}</td></tr>
            <tr><td>Profit Margin (${q.rates.marginPct}%)</td><td class="right mono">${fmt(c.marginCost)}</td></tr>
            <tr><td>Construction Duration Cost (${c.requestedDays} days)</td><td class="right mono">${fmt(c.durationCost)}</td></tr>
            <tr><td>Rush Surcharge${c.isRush?'':' (not applicable)'}</td><td class="right mono">${fmt(c.rushFee)}</td></tr>
            ` : ``}
            ${c.multiplyPrice && c.numBoats>1 ? `
            <tr><td style="font-weight:700;">Per-Unit Price</td><td class="right mono" style="font-weight:700;">${fmt(c.unitFinalTotal)}</td></tr>
            <tr><td style="font-weight:700;">Number of Boats Quoted</td><td class="right mono" style="font-weight:700;">× ${c.numBoats}</td></tr>
            ` : ``}
          </tbody>
        </table>

        <div class="doc-words-row">
          <div class="doc-words-box">Amount in Words: ${esc(numberToWords(inv.totalContractAmount))}</div>
          <div class="doc-totalsbox">
            <div class="row"><span>Subtotal</span><span class="mono">${fmt(inv.contractAmount)}</span></div>
            ${inv.discountAmount>0 ? `<div class="row discount"><span>Discount${inv.discountType==='pct'? ` (${inv.discountValue}%)` : ''}</span><span class="mono">-${fmt(inv.discountAmount)}</span></div>` : ``}
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
            <tr><td>Length Overall</td><td class="right mono">${(()=>{ const f=decToFtIn(q.hull.loa); return `${f.ft}ft ${f.inch}in`; })()}</td><td>Engine</td><td class="right mono">${esc(q.engine.brand)||'—'} ${q.engine.hp||0}HP ${esc(q.engine.type)||'IBM'}</td></tr>
            <tr><td>Beam</td><td class="right mono">${(()=>{ const f=decToFtIn(q.hull.beam); return `${f.ft}ft ${f.inch}in`; })()}</td><td>Engine Speed</td><td class="right mono">${esc(q.engine.speed)||'—'}</td></tr>
            <tr><td>Depth</td><td class="right mono">${(()=>{ const f=decToFtIn(q.hull.depth); return `${f.ft}ft ${f.inch}in`; })()}</td><td>Fuel Capacity</td><td class="right mono">${esc(q.engine.fuelCapacity)||'—'}</td></tr>
            ${c.numBoats>1?`<tr><td>Number of Boats Quoted</td><td class="right mono" colspan="3">${c.numBoats} unit(s)</td></tr>`:``}
          </tbody>
        </table>

        <div class="doc-section-title">II. Structural Components &amp; Core Materials</div>
        ${(()=>{
          const groups = groupByCat(c.structural.rows);
          if(!groups.size) return `<div class="doc-na-block" style="font-style:normal;">No structural items listed.</div>`;
          return Array.from(groups.entries()).map(([cat, rows])=>`
            <div class="doc-subcat-title">${esc(cat)}</div>
            <table class="doc-item-table">
              <thead><tr><th>Item</th><th class="right">Amount</th></tr></thead>
              <tbody>${rows.map(r=>`<tr><td>${esc(r.name)}</td><td class="right mono">${fmt(r.total)}</td></tr>`).join('')}</tbody>
            </table>`).join('');
        })()}

        <div class="doc-section-title">III. Accessories &amp; Components</div>
        ${(()=>{
          const groups = groupByCat(c.acc.rows);
          const sumRow = (cat, rows) => {
            const total = rows.reduce((s,r)=>s+r.total,0);
            return `<div class="doc-kv-row"><span class="k">${esc(cat)}</span><span class="v mono">${fmt(total)}</span></div>`;
          };
          // Fixed named sections always appear, in this order, each
          // supporting "Not Applicable"; any other category found in the
          // data prints afterward, in the same one-line-per-category format.
          const fixedHtml = PRINTED_ACCESSORY_SECTIONS.map(cat=>{
            const rows = groups.get(cat);
            groups.delete(cat);
            const isNA = !!q.accessoryCategoryNA[cat];
            if(isNA) return `<div class="doc-kv-row"><span class="k">${esc(cat)}</span><span class="v doc-na">Not Applicable</span></div>`;
            if(!rows || !rows.length) return `<div class="doc-kv-row"><span class="k">${esc(cat)}</span><span class="v" style="color:var(--doc-ink-faint);">No items listed</span></div>`;
            return sumRow(cat, rows);
          }).join('');
          const restHtml = Array.from(groups.entries()).map(([cat, rows])=>sumRow(cat, rows)).join('');
          return fixedHtml + restHtml;
        })()}

        <div class="doc-section-title">IV. Engine &amp; Mechanical System</div>
        <table><tbody>
          <tr><td>${esc(q.engine.model)||'—'}</td><td class="right mono">${q.engine.hp} HP × ${q.engine.qty} unit(s)</td></tr>
          <tr><td>Transmission: ${esc(q.engine.transmission)||'—'} &nbsp; Propeller: ${esc(q.engine.propeller)||'—'}</td><td class="right mono">${fmt(c.eng.total)}</td></tr>
        </tbody></table>
        ${q.engine.description ? `<div class="doc-band-body" style="margin-top:8px;line-height:1.6;">${escNl(q.engine.description)}</div>` : ``}
        ${q.engine.inclusions && q.engine.inclusions.length ? `
        <div style="margin-top:10px;">
          <ul style="margin:0;padding-left:18px;line-height:1.6;">${q.engine.inclusions.map(it=>`<li>${esc(it)}</li>`).join('')}</ul>
        </div>` : ``}
        ${q.engine.steeringItems && q.engine.steeringItems.length ? `
        <div style="margin-top:14px;">
          <div style="font-weight:700;font-size:12.5px;margin-bottom:4px;">STEERING SYSTEM &amp; CONTROL SYSTEM:</div>
          <ul style="margin:0;padding-left:18px;line-height:1.6;">${q.engine.steeringItems.map(it=>`<li>${esc(it)}</li>`).join('')}</ul>
        </div>` : ``}

        <div class="doc-section-title">V. Testing &amp; Delivery</div>
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

        <div class="doc-section-title">VI. MARINA Documentation &amp; Regulatory Requirements</div>
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
  document.getElementById('toggleInternal').onchange = (e)=>{
    q.output.showInternalCosts = e.target.checked; persistQuote(q);
    tabOutput(host, q);
  };
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
    sampleAccessory('Navigational Equipment','GPS Chartplotter 10in',1,95000,10),
    sampleAccessory('Navigational Equipment','Marine Radar 36NM',1,185000,10),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,22000,15),
    sampleAccessory('SOLAS Safety Equipment','Life Vest',84,850,15),
    sampleAccessory('SOLAS Safety Equipment','Fire Extinguisher',4,1850,15),
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
    sampleAccessory('Navigational Equipment','GPS Chartplotter 10in',1,95000,10),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,18000,15),
    sampleAccessory('Anchor & Docking','Fender',6,1600,15),
    sampleAccessory('SOLAS Safety Equipment','Life Vest',24,850,15),
    sampleAccessory('SOLAS Safety Equipment','Ring Buoy',2,2400,15),
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
    sampleAccessory('SOLAS Safety Equipment','Life Vest',12,850,15),
    sampleAccessory('SOLAS Safety Equipment','Fire Extinguisher',2,1850,15),
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
    sampleAccessory('Navigational Equipment','GPS Chartplotter 10in',1,95000,10),
    sampleAccessory('SOLAS Safety Equipment','Life Vest',10,850,15),
    sampleAccessory('SOLAS Safety Equipment','Ring Buoy',4,2400,15),
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
    sampleAccessory('Navigational Equipment','GPS Chartplotter 10in',1,95000,10),
    sampleAccessory('Anchor & Docking','Anchor Set w/ Chain & Rope',1,20000,15),
    sampleAccessory('Anchor & Docking','Fender',4,1600,15),
    sampleAccessory('SOLAS Safety Equipment','Life Vest',55,850,15),
    sampleAccessory('SOLAS Safety Equipment','Fire Extinguisher',3,1850,15),
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
  save(DB_KEYS.quotes, QUOTES);
}

/* ============================================================
   BOOT (standalone — plain localStorage, no server dependency)
   ============================================================ */
QUOTES.forEach(ensureQuoteDefaults);
save(DB_KEYS.quotes, QUOTES);
if(!localStorage.getItem('frp_sample_seeded_v1') && QUOTES.length === 0){
  buildSampleQuotes();
  localStorage.setItem('frp_sample_seeded_v1', '1');
}

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
  foot.innerHTML = `${esc(CURRENT_USER.email)} &nbsp;·&nbsp; <a href="#" id="signOutLink" style="color:var(--teal);text-decoration:none;">Sign Out</a>`;
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
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = oldLabel;
  if(error){
    errEl.textContent = error.message || 'Sign in failed. Check your email and password.';
    errEl.style.display = 'block';
    return;
  }
  startApp(data.session);
});

supabaseClient.auth.onAuthStateChange((event)=>{
  if(event === 'SIGNED_OUT') location.reload();
});

(async function boot(){
  const { data:{ session } } = await supabaseClient.auth.getSession();
  if(session){ startApp(session); }
  else{ showLogin(); }
})();
