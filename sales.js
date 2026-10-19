/* ============================================================
   SALES TRACKER
   Replaces the Google Sheet / Excel boat-sales log. Records live in
   the global SALES array (see app.js), are saved with
   save(DB_KEYS.sales, SALES) and therefore sync through Supabase
   like every other list. Loaded BEFORE app.js; it only touches
   app.js globals at call-time, never at load-time.
   ============================================================ */
const SALES_STATUSES = ['Pending','Approved','Not Approved'];
const SALES_CLIENT_TYPES = ['Government','Private - Commercial','Private - Personal'];
const SALES_BUILD_TYPES = ['Standard Build','Custom Build','Reconstruction'];
const SALES_UI = { status:'', incharge:'', model:'', clientType:'', month:'', term:'', metric:'value' };

/* Historical data imported once from BOAT_SALES_ANALYTICS_REPORT_2026.xlsx */
function salesSeed(){
  return [{"id":"s_001","refNo":"Q26-05 rev05","inquiryDate":"2026-02-18","draftDate":"2026-02-18","submitDate":"2026-02-18","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":28.0,"boatModel":"Apple Series","application":"Pleasure Boat","project":"","client":"DDC Land","location":"","clientType":"Private - Commercial","boats":1,"value":3430399.84,"status":"Approved","notes":""},{"id":"s_002","refNo":"Q26-17","inquiryDate":"2026-01-26","draftDate":"2026-01-26","submitDate":"2026-01-26","incharge":"Sales Team","buildType":"Custom Build","loa":40.0,"boatModel":"Custom Boat","application":"Passenger Boat","project":"","client":"City of Isabela, Basilan","location":"","clientType":"Government","boats":1,"value":10800000.0,"status":"Approved","notes":""},{"id":"s_003","refNo":"Q26-18","inquiryDate":"2026-02-20","draftDate":"2026-02-20","submitDate":"2026-02-20","incharge":"Sales Team","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Dive Boat","project":"","client":"Asia Divers","location":"","clientType":"Private - Commercial","boats":1,"value":1248487.0,"status":"Approved","notes":""},{"id":"s_004","refNo":"Q26-26","inquiryDate":"2026-02-24","draftDate":"2026-02-24","submitDate":"2026-02-24","incharge":"Sales Team","buildType":"Standard Build","loa":40.0,"boatModel":"Apple Series","application":"Pleasure Boat","project":"","client":"Gallo","location":"","clientType":"Private - Personal","boats":1,"value":2173741.0,"status":"Not Approved","notes":""},{"id":"s_005","refNo":"Q26-30","inquiryDate":"2026-03-06","draftDate":"2026-03-06","submitDate":"2026-03-06","incharge":"Sales Team","buildType":"Standard Build","loa":30.0,"boatModel":"Embassy Series","application":"Patrol Boat","project":"","client":"PNP SAF","location":"","clientType":"Government","boats":1,"value":17280000.0,"status":"Not Approved","notes":""},{"id":"s_006","refNo":"Q26-43","inquiryDate":"2026-04-16","draftDate":"2026-04-16","submitDate":"2026-04-16","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Dive Boat","project":"","client":"ML Puerto Galera","location":"","clientType":"Private - Commercial","boats":1,"value":1242360.0,"status":"Approved","notes":""},{"id":"s_007","refNo":"Q26-45","inquiryDate":"2026-04-20","draftDate":"2026-04-20","submitDate":"2026-04-20","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Dive Boat","project":"30-Footer Dive Boat - APPLE WIDE","client":"Mr.Ivan YJ","location":"Puerto Galera","clientType":"Private - Commercial","boats":1,"value":2353721.44,"status":"Not Approved","notes":""},{"id":"s_008","refNo":"Q26-46","inquiryDate":"2026-04-20","draftDate":"2026-04-20","submitDate":"2026-04-20","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":27.0,"boatModel":"Apple Series","application":"Dive Boat","project":"27-Footer Dive Boat - APPLE NARROW","client":"Mr.Ivan YJ","location":"Puerto Galera","clientType":"Private - Commercial","boats":1,"value":1542632.0,"status":"Not Approved","notes":""},{"id":"s_009","refNo":"Q26-47","inquiryDate":"2026-04-20","draftDate":"2026-04-20","submitDate":"2026-04-20","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":28.0,"boatModel":"Apple Series","application":"Dive Boat","project":"28 Footer Tour/Dive Boat - Apple Wide","client":"Mr.Ivan YJ","location":"Puerto Galera","clientType":"Private - Commercial","boats":1,"value":3377824.8,"status":"Not Approved","notes":""},{"id":"s_010","refNo":"Q26-48","inquiryDate":"2026-04-20","draftDate":"2026-04-20","submitDate":"2026-04-23","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Dive Boat","project":"30-Footer Dive Boat - APPLE WIDE","client":"Mr.Ivan YJ","location":"Puerto Galera","clientType":"Private - Commercial","boats":1,"value":1790152.0,"status":"Not Approved","notes":""},{"id":"s_011","refNo":"Q26-51","inquiryDate":"2026-04-24","draftDate":"2026-04-24","submitDate":"2026-04-24","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":52.0,"boatModel":"Catamaran Series","application":"Restaurant Boat","project":"52ft Catamaran Restaurant Boat","client":"Mayor Hajiri","location":"Lugus, Sulu","clientType":"Private - Commercial","boats":1,"value":28048428.57,"status":"Not Approved","notes":""},{"id":"s_012","refNo":"Q26-55","inquiryDate":"2026-05-10","draftDate":"2026-05-10","submitDate":"2026-05-10","incharge":"Sales Team","buildType":"Custom Build","loa":26.0,"boatModel":"Custom Boat","application":"Sea Ambulance","project":"","client":"Mr. Efren Palmiery","location":"","clientType":"Private - Commercial","boats":1,"value":3240135.0,"status":"Not Approved","notes":""},{"id":"s_013","refNo":"Q26-59","inquiryDate":"2026-05-15","draftDate":"2026-05-15","submitDate":"2026-05-15","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":40.0,"boatModel":"Embassy Series","application":"Passenger Boat","project":"40Ft Passenger Boat - E SERIES no engine","client":"The Lind Hotels","location":"","clientType":"Private - Commercial","boats":1,"value":0,"status":"Not Approved","notes":""},{"id":"s_014","refNo":"Q26-61","inquiryDate":"2026-05-15","draftDate":"2026-05-16","submitDate":"2026-05-16","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":40.0,"boatModel":"Embassy Series","application":"Passenger Boat","project":"40Ft Passenger Boat - E SERIES no engine","client":"Ms. Josephine Balita","location":"","clientType":"Private - Commercial","boats":1,"value":0,"status":"Not Approved","notes":""},{"id":"s_015","refNo":"Q26-63","inquiryDate":"2026-05-16","draftDate":"2026-05-16","submitDate":"2026-05-18","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Dive Boat","project":"30ft   Dive Boat Reef runner series With single 250hp SUZUKI OBM","client":"Mr. Sean Clubmir","location":"","clientType":"Private - Commercial","boats":1,"value":4459134.4,"status":"Not Approved","notes":""},{"id":"s_016","refNo":"Q26-64","inquiryDate":"2026-05-16","draftDate":"2026-05-16","submitDate":"2026-05-18","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Dive Boat","project":"30ft Dive Boat Apple Series With single 150hp SUZUKI OBM","client":"Mr. Sean Clubmir","location":"","clientType":"Private - Commercial","boats":1,"value":3102148.0,"status":"Not Approved","notes":""},{"id":"s_017","refNo":"Q26-64.2","inquiryDate":"2026-05-16","draftDate":"2026-05-16","submitDate":"2026-05-18","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Dive Boat","project":"30ft Dive Boat Apple Series With single 150hp SUZUKI OBM","client":"Mr. Sean Clubmir","location":"","clientType":"Private - Commercial","boats":1,"value":2736843.6,"status":"Not Approved","notes":""},{"id":"s_018","refNo":"Q26-65","inquiryDate":"2026-05-05","draftDate":"2026-05-21","submitDate":"2026-05-22","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Dive Boat","project":"30ft Dive Boat Reef runner series With single 250hp Mercury OBM","client":"Mr. Jhong Queron","location":"","clientType":"Private - Commercial","boats":1,"value":3712304.0,"status":"Not Approved","notes":""},{"id":"s_019","refNo":"Q26-66","inquiryDate":"2026-05-29","draftDate":"2026-05-29","submitDate":"2026-05-29","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Sea Ambulance","project":"30ft Sea Ambulance with dual 150hp Mercury OBM","client":"Ronald Maghanoy","location":"","clientType":"Government","boats":1,"value":8261118.0,"status":"Not Approved","notes":""},{"id":"s_020","refNo":"Q26-60BFAR","inquiryDate":"2026-06-02","draftDate":"2026-06-02","submitDate":"2026-06-02","incharge":"Sales Team","buildType":"Standard Build","loa":55.0,"boatModel":"Outrigger Boat","application":"Patrol Boat","project":"","client":"BFAR-FISHCORE","location":"","clientType":"Government","boats":6,"value":42004000.0,"status":"Not Approved","notes":""},{"id":"s_021","refNo":"Q26-67","inquiryDate":"2026-06-02","draftDate":"2026-06-02","submitDate":"2026-06-02","incharge":"Corazon Bobadilla","buildType":"Reconstruction","loa":40.0,"boatModel":"Custom Boat","application":"","project":"40Ft Passenger ES dual 350hp OBM","client":"Mr. Qieng Feng","location":"Puerto Galera","clientType":"Private - Commercial","boats":1,"value":4132764.0,"status":"Not Approved","notes":""},{"id":"s_022","refNo":"Q26-68","inquiryDate":"2026-06-02","draftDate":"2026-06-02","submitDate":"2026-06-02","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Sea Ambulance","project":"30ft Sea Ambulance with dual 150hp Mercury OBM","client":"Felix - Scan Marine","location":"","clientType":"Private - Commercial","boats":1,"value":8061118.0,"status":"Not Approved","notes":""},{"id":"s_023","refNo":"Q26-69","inquiryDate":"2026-06-05","draftDate":"2026-06-05","submitDate":"2026-06-05","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":"","boatModel":"Embassy Series","application":"","project":"","client":"South West","location":"","clientType":"Private - Commercial","boats":1,"value":9075000.0,"status":"Not Approved","notes":""},{"id":"s_024","refNo":"Q26-70","inquiryDate":"2026-06-06","draftDate":"2026-06-06","submitDate":"2026-06-06","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":24.0,"boatModel":"Apple Series","application":"Speed Boat","project":"24Ft Center Console with single 200hp Yamaha OBM","client":"Toea Chan","location":"Papua New Guinea","clientType":"Private - Personal","boats":1,"value":4618000.0,"status":"Pending","notes":""},{"id":"s_025","refNo":"Q26-71","inquiryDate":"2026-06-09","draftDate":"2026-06-09","submitDate":"2026-06-09","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":35.0,"boatModel":"Navigator Series","application":"Passenger Boat","project":"35Ft Navigator Series with dual 300hp Yamaha OBM , dual 350hp Yamaha","client":"Toea Chan","location":"Papua New Guinea","clientType":"Private - Personal","boats":1,"value":15045000.0,"status":"Pending","notes":""},{"id":"s_026","refNo":"Q26-72","inquiryDate":"2026-06-09","draftDate":"2026-06-09","submitDate":"2026-06-09","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Passenger Boat","project":"30Ft. Passenger 16 pax Reef Runner with dual 150Hp Yamaha OBM","client":"Toea Chan","location":"Papua New Guinea","clientType":"Private - Personal","boats":1,"value":8109500.0,"status":"Pending","notes":""},{"id":"s_027","refNo":"Q26-70Trailer","inquiryDate":"2026-06-09","draftDate":"2026-06-09","submitDate":"2026-06-09","incharge":"Corazon Bobadilla","buildType":"Custom Build","loa":"","boatModel":"Custom Boat","application":"","project":"Trailer","client":"","location":"","clientType":"Private - Commercial","boats":1,"value":375000.0,"status":"Approved","notes":""},{"id":"s_028","refNo":"Q26-75","inquiryDate":"2026-06-19","draftDate":"2026-06-19","submitDate":"2026-06-24","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":40.0,"boatModel":"Embassy Series","application":"Passenger Boat","project":"40Ft. Passenger Embassy Series","client":"Joey Uy","location":"","clientType":"Private - Commercial","boats":1,"value":9833600.0,"status":"Not Approved","notes":""},{"id":"s_029","refNo":"Q26-76","inquiryDate":"2026-06-19","draftDate":"2026-06-19","submitDate":"2026-06-24","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Passenger Boat","project":"30Ft. Transfer Boat Apple","client":"Joey Uy","location":"","clientType":"Private - Commercial","boats":1,"value":2458000.0,"status":"Not Approved","notes":""},{"id":"s_030","refNo":"Q26-77","inquiryDate":"2026-06-19","draftDate":"2026-06-19","submitDate":"2026-06-24","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Passenger Boat","project":"30Ft. Passenger Reef Runner","client":"Joey Uy","location":"","clientType":"Private - Commercial","boats":1,"value":3015040.0,"status":"Not Approved","notes":""},{"id":"s_031","refNo":"Q26-78","inquiryDate":"2026-06-19","draftDate":"2026-06-19","submitDate":"2026-06-24","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":50.0,"boatModel":"Outrigger Boat","application":"Passenger Boat","project":"50ft Passenger Outrigger Boat","client":"Joey Uy","location":"","clientType":"Private - Commercial","boats":1,"value":3771040.0,"status":"Not Approved","notes":""},{"id":"s_032","refNo":"Q26-79","inquiryDate":"2026-06-19","draftDate":"2026-06-19","submitDate":"2026-06-24","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":26.0,"boatModel":"Reef Runner Series","application":"Passenger Boat","project":"26Ft. Passenger 16 Reef Runner","client":"Joey Uy","location":"","clientType":"Private - Commercial","boats":1,"value":2662240.0,"status":"Not Approved","notes":""},{"id":"s_033","refNo":"Q26-80","inquiryDate":"2026-06-26","draftDate":"2026-06-26","submitDate":"2026-06-26","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":40.0,"boatModel":"Reef Runner Series","application":"Passenger Boat","project":"40 Footer Sea Ambulance Boat - ES Series","client":"Mr. Efren P. Palmiery","location":"Makati City","clientType":"Private - Commercial","boats":1,"value":9329600.0,"status":"Not Approved","notes":""},{"id":"s_034","refNo":"Q26-82","inquiryDate":"2026-07-03","draftDate":"2026-07-03","submitDate":"2026-07-03","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Reef Runner Series","application":"Passenger Boat","project":"30 Footer Passenger - Reef Runner Boat for Lake Use","client":"Ms. Kimverly Agua","location":"170 Salcedo St., Makati City","clientType":"Private - Commercial","boats":1,"value":5082560.0,"status":"Not Approved","notes":""},{"id":"s_035","refNo":"Q26-83","inquiryDate":"2026-07-03","draftDate":"2026-07-03","submitDate":"2026-07-03","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":40.0,"boatModel":"Reef Runner Series","application":"Passenger Boat","project":"40 Footer Passenger boat - Embassy Series Offshore/Interisland","client":"Ms. Kimverly Agua","location":"170 Salcedo St., Makati City","clientType":"Private - Commercial","boats":1,"value":12826576.0,"status":"Not Approved","notes":""},{"id":"s_036","refNo":"Q26-84","inquiryDate":"","draftDate":"","submitDate":"","incharge":"Corazon Bobadilla","buildType":"Standard Build","loa":40.0,"boatModel":"Apple Series","application":"Ambulance Boat","project":"","client":"Scan Marine","location":"","clientType":"Private - Commercial","boats":1,"value":6944000.0,"status":"Pending","notes":""},{"id":"s_037","refNo":"Q26-85","inquiryDate":"2026-07-15","draftDate":"2026-07-15","submitDate":"2026-07-15","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Patrol Boat","project":"","client":"BFAR Reg. 4B","location":"MIMAROPA","clientType":"Government","boats":1,"value":3685000,"status":"Pending","notes":""},{"id":"s_038","refNo":"Q26-86","inquiryDate":"2026-07-15","draftDate":"2026-07-15","submitDate":"2026-07-17","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":28.0,"boatModel":"Apple Series","application":"Dive Boat","project":"28 Footer Tour/Dive Boat - Reef Runner","client":"Crimson Hotel & Spa Mactan","location":"Crimson Hotel","clientType":"Private - Commercial","boats":1,"value":3992800.0,"status":"Not Approved","notes":""},{"id":"s_039","refNo":"Q26-00","inquiryDate":"2026-07-24","draftDate":"2026-07-24","submitDate":"2026-07-24","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":"","boatModel":"Apple Series","application":"Rescue Boat","project":"","client":"","location":"","clientType":"Private - Commercial","boats":1,"value":1500000.0,"status":"Pending","notes":""},{"id":"s_040","refNo":"Q26-88","inquiryDate":"2026-07-24","draftDate":"2026-07-24","submitDate":"2026-07-24","incharge":"Psyche Pilapil","buildType":"Custom Build","loa":32.0,"boatModel":"Custom Boat","application":"Center Console","project":"32 Footer Center onsole Boat","client":"Arnold Lamusao","location":"Arnold Lamusao","clientType":"Private - Commercial","boats":1,"value":4765000.0,"status":"Not Approved","notes":""},{"id":"s_041","refNo":"Q26-89","inquiryDate":"2026-07-25","draftDate":"2026-07-25","submitDate":"2026-07-27","incharge":"Psyche Pilapil","buildType":"Standard Build","loa":30.0,"boatModel":"Apple Series","application":"Dive Boat","project":"30 Footer Tour/Dive Boat - Reef Runner","client":"Crimson Hotel & Spa Mactan","location":"Mactan, Cebu","clientType":"Private - Commercial","boats":1,"value":4300856.0,"status":"Not Approved","notes":""}];
}

/* ---------- small helpers ---------- */
function slEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function slShort(n){
  n = Number(n)||0;
  if(Math.abs(n)>=1e9) return '₱'+(n/1e9).toFixed(2)+'B';
  if(Math.abs(n)>=1e6) return '₱'+(n/1e6).toFixed(1)+'M';
  if(Math.abs(n)>=1e3) return '₱'+Math.round(n/1e3).toLocaleString('en-PH')+'K';
  return '₱'+Math.round(n).toLocaleString('en-PH');
}
function slPct(a,b){ return b>0 ? (a/b*100) : 0; }
function slPctTxt(a,b){ return b>0 ? (Math.round(a/b*1000)/10)+'%' : '—'; }
function slDay(iso){ if(!iso) return null; const p=String(iso).split('-').map(Number); if(p.length<3||p.some(isNaN)) return null; return Math.round(Date.UTC(p[0],p[1]-1,p[2])/86400000); }
function slTurnaround(s){ const a=slDay(s.inquiryDate), b=slDay(s.submitDate); return (a==null||b==null||b<a) ? null : b-a; }
function slMonthKey(iso){ return iso ? String(iso).slice(0,7) : ''; }
const SL_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function slMonthLabel(key, withYear){ const [y,m]=key.split('-').map(Number); return SL_MON[m-1]+(withYear?' '+y:''); }
function slDateTxt(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-').map(Number); return SL_MON[m-1]+' '+d+', '+y; }
function slStatusClass(st){ return st==='Approved'?'won':(st==='Pending'?'open':'lost'); }
function slSum(list, f){ return list.reduce((s,x)=>s+(Number(f?f(x):x)||0),0); }
function slGroup(list, keyFn){
  const m = new Map();
  list.forEach(s=>{
    const k = keyFn(s) || '—';
    if(!m.has(k)) m.set(k, { label:k, n:0, total:0, won:0, wonN:0, openN:0, open:0, days:[] });
    const g = m.get(k), v = Number(s.value)||0;
    g.n++; g.total+=v;
    if(s.status==='Approved'){ g.won+=v; g.wonN++; }
    if(s.status==='Pending'){ g.open+=v; g.openN++; }
    const t = slTurnaround(s); if(t!=null) g.days.push(t);
  });
  return Array.from(m.values()).sort((a,b)=>b.total-a.total);
}
function slAvg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

function slFiltered(){
  const u = SALES_UI, term = u.term.trim().toLowerCase();
  return SALES.filter(s=>{
    if(u.status && s.status!==u.status) return false;
    if(u.incharge && s.incharge!==u.incharge) return false;
    if(u.model && s.boatModel!==u.model) return false;
    if(u.clientType && s.clientType!==u.clientType) return false;
    if(u.month && slMonthKey(s.inquiryDate)!==u.month) return false;
    if(term){
      const hay = [s.refNo,s.client,s.project,s.location,s.boatModel,s.application,s.incharge,s.notes].join(' ').toLowerCase();
      if(!hay.includes(term)) return false;
    }
    return true;
  });
}

/* ============================================================
   PAGE
   ============================================================ */
function renderSales(content, actions){
  actions.innerHTML = `
    <button class="btn" id="slImportBtn" title="Import rows from an Excel or CSV file">Import</button>
    <button class="btn" id="slExportBtn" title="Download every sale as a CSV file">Export</button>
    <button class="btn btn-primary" id="slAddBtn">${icon('plus')} Log a sale</button>`;

  const uniq = f => Array.from(new Set(SALES.map(f).filter(Boolean)));
  const monthKeys = uniq(s=>slMonthKey(s.inquiryDate)).sort();
  const opt = (arr, cur, fmtFn) => arr.map(v=>`<option value="${slEsc(v)}" ${v===cur?'selected':''}>${slEsc(fmtFn?fmtFn(v):v)}</option>`).join('');

  content.innerHTML = `
    <div class="sl-filters">
      <div class="search sl-search"><span>${icon('search')}</span><input id="slTerm" placeholder="Search ref no., client, project…" value="${slEsc(SALES_UI.term)}"></div>
      <select id="slFStatus"><option value="">All statuses</option>${opt(SALES_STATUSES,SALES_UI.status)}</select>
      <select id="slFIncharge"><option value="">All in-charge</option>${opt(uniq(s=>s.incharge).sort(),SALES_UI.incharge)}</select>
      <select id="slFModel"><option value="">All boat models</option>${opt(uniq(s=>s.boatModel).sort(),SALES_UI.model)}</select>
      <select id="slFType"><option value="">All client types</option>${opt(uniq(s=>s.clientType).sort(),SALES_UI.clientType)}</select>
      <select id="slFMonth"><option value="">All months</option>${opt(monthKeys,SALES_UI.month,k=>slMonthLabel(k,true))}</select>
      <button class="btn btn-ghost btn-sm" id="slReset">Clear filters</button>
    </div>
    <div id="slBody"></div>`;

  const bind = (id, key, ev) => { document.getElementById(id).addEventListener(ev||'change', e=>{ SALES_UI[key]=e.target.value; drawSales(); }); };
  bind('slTerm','term','input'); bind('slFStatus','status'); bind('slFIncharge','incharge');
  bind('slFModel','model'); bind('slFType','clientType'); bind('slFMonth','month');
  document.getElementById('slReset').onclick = ()=>{ Object.assign(SALES_UI,{status:'',incharge:'',model:'',clientType:'',month:'',term:''}); renderAll(); };
  document.getElementById('slAddBtn').onclick = ()=>slOpenEditor(null);
  document.getElementById('slExportBtn').onclick = slExportCSV;
  document.getElementById('slImportBtn').onclick = slOpenImport;
  drawSales();
}

function drawSales(){
  const body = document.getElementById('slBody');
  if(!body) return;
  const rows = slFiltered();
  const total = slSum(rows, s=>s.value);
  const won = rows.filter(s=>s.status==='Approved');
  const open = rows.filter(s=>s.status==='Pending');
  const lost = rows.filter(s=>s.status==='Not Approved');
  const wonV = slSum(won, s=>s.value), openV = slSum(open, s=>s.value);
  const turn = rows.map(slTurnaround).filter(x=>x!=null);
  const avgTurn = slAvg(turn);
  const winRate = slPct(won.length, rows.length);
  const decided = won.length + lost.length;

  if(!SALES.length){
    body.innerHTML = `<div class="card"><div class="empty">No sales logged yet. Use “Log a sale”, import your Excel file, or pull in your existing quotations.
      <div style="margin-top:14px;"><button class="btn" id="slFromQ">Add from quotations</button></div></div></div>`;
    const b = document.getElementById('slFromQ'); if(b) b.onclick = slImportFromQuotes;
    return;
  }

  body.innerHTML = `
    <div class="sl-kpis">
      <div class="sl-kpi"><div class="sl-k-val">${slShort(total)}</div><div class="sl-k-lbl">Total quoted</div><div class="sl-k-sub">${rows.length} quotations · ${slSum(rows,s=>s.boats)} boats</div></div>
      <div class="sl-kpi won"><div class="sl-k-val">${slShort(wonV)}</div><div class="sl-k-lbl">Won (approved)</div><div class="sl-k-sub">${won.length} deals · ${slPctTxt(wonV,total)} of value</div></div>
      <div class="sl-kpi open"><div class="sl-k-val">${slShort(openV)}</div><div class="sl-k-lbl">Open pipeline</div><div class="sl-k-sub">${open.length} pending quotations</div></div>
      <div class="sl-kpi"><div class="sl-k-val">${slPctTxt(won.length, rows.length)}</div><div class="sl-k-lbl">Win rate</div><div class="sl-k-sub">${won.length} of ${rows.length} quotes · ${decided?slPctTxt(won.length,decided):'—'} of decided</div></div>
      <div class="sl-kpi"><div class="sl-k-val">${avgTurn==null?'—':avgTurn.toFixed(1)}<small> days</small></div><div class="sl-k-lbl">Avg turnaround</div><div class="sl-k-sub">${turn.length?`fastest ${Math.min(...turn)} · slowest ${Math.max(...turn)} days`:'inquiry to submission'}</div></div>
    </div>

    <div class="sl-grid sl-g-main">
      <div class="card"><div class="card-head"><h3>Quotations by month</h3>
        <div class="sl-seg" role="tablist"><button data-metric="value" class="${SALES_UI.metric==='value'?'on':''}">Value</button><button data-metric="count" class="${SALES_UI.metric==='count'?'on':''}">Count</button></div></div>
        <div class="card-body">${slMonthlyChart(rows)}
          <div class="sl-legend"><span><i class="won"></i>Approved</span><span><i class="open"></i>Pending</span><span><i class="lost"></i>Not approved</span></div></div></div>
      <div class="card"><div class="card-head"><h3>Where the value stands</h3><span class="hint" style="margin:0;">${slShort(total)}</span></div>
        <div class="card-body">${slStatusSplit(rows)}</div></div>
    </div>

    <div class="sl-grid sl-g-three">
      <div class="card"><div class="card-head"><h3>By boat model</h3></div><div class="card-body">${slBars(slGroup(rows,s=>s.boatModel||'Not specified'),total)}</div></div>
      <div class="card"><div class="card-head"><h3>By application</h3></div><div class="card-body">${slBars(slGroup(rows,s=>s.application||'Not specified'),total)}</div></div>
      <div class="card"><div class="card-head"><h3>By client type</h3></div><div class="card-body">${slBars(slGroup(rows,s=>s.clientType||'Not specified'),total)}</div></div>
    </div>

    <div class="sl-grid sl-g-main">
      <div class="card"><div class="card-head"><h3>Quotation in-charge</h3></div><div class="card-body" style="padding:0 8px 14px;">${slInchargeTable(rows)}</div></div>
      <div class="card"><div class="card-head"><h3>What needs attention</h3></div><div class="card-body">${slInsights(rows,total,openV,winRate)}</div></div>
    </div>

    <div class="card sl-tablecard"><div class="card-head"><h3>All quotations</h3><span class="hint" style="margin:0;">${rows.length} shown${rows.length!==SALES.length?` of ${SALES.length}`:''} · ${fmt(total)}</span></div>
      <div class="card-body" style="padding:0;">${slTable(rows)}</div></div>
  `;

  body.querySelectorAll('[data-metric]').forEach(b=>b.onclick=()=>{ SALES_UI.metric=b.dataset.metric; drawSales(); });
  body.querySelectorAll('[data-slstatus]').forEach(sel=>sel.onchange=()=>{
    const s = SALES.find(x=>x.id===sel.dataset.slstatus); if(!s) return;
    s.status = sel.value; s.updatedAt = Date.now(); save(DB_KEYS.sales, SALES); toast('Status updated'); drawSales();
  });
  body.querySelectorAll('[data-sledit]').forEach(b=>b.onclick=()=>slOpenEditor(b.dataset.sledit));
  body.querySelectorAll('[data-sldel]').forEach(b=>b.onclick=()=>{
    const s = SALES.find(x=>x.id===b.dataset.sldel); if(!s) return;
    if(confirm(`Delete ${s.refNo} (${s.client||'no client'})? This cannot be undone.`)){
      SALES.splice(SALES.indexOf(s),1); save(DB_KEYS.sales, SALES); toast('Sale deleted'); renderAll();
    }
  });
  body.querySelectorAll('[data-slfilter]').forEach(b=>b.onclick=()=>{ const [k,v]=b.dataset.slfilter.split('|'); SALES_UI[k]=v; renderAll(); });
}

/* ---------- charts (plain HTML/CSS, no library) ---------- */
function slMonthlyChart(rows){
  const dated = rows.filter(s=>s.inquiryDate);
  if(!dated.length) return `<div class="empty" style="padding:30px;">No dated quotations to chart.</div>`;
  const keys = dated.map(s=>slMonthKey(s.inquiryDate)).sort();
  let [y,m] = keys[0].split('-').map(Number);
  const last = keys[keys.length-1];
  const now = todayISO().slice(0,7);
  const endKey = now>last ? now : last;
  const months = [];
  while(true){
    const k = y+'-'+String(m).padStart(2,'0');
    months.push(k); if(k>=endKey || months.length>36) break;
    m++; if(m>12){ m=1; y++; }
  }
  const useVal = SALES_UI.metric==='value';
  const data = months.map(k=>{
    const list = dated.filter(s=>slMonthKey(s.inquiryDate)===k);
    const pick = st => { const l=list.filter(s=>s.status===st); return useVal ? slSum(l,s=>s.value) : l.length; };
    const won=pick('Approved'), open=pick('Pending'), lost=pick('Not Approved');
    return { k, won, open, lost, tot:won+open+lost, n:list.length };
  });
  const max = Math.max(1, ...data.map(d=>d.tot));
  const multiYear = months[0].slice(0,4)!==months[months.length-1].slice(0,4);
  return `<div class="sl-months">${data.map(d=>`
    <button type="button" class="sl-mcol" data-slfilter="month|${d.k}" title="${slMonthLabel(d.k,true)}: ${d.n} quotations — click to filter">
      <div class="sl-mval">${d.tot? (useVal?slShort(d.tot):d.tot) : ''}</div>
      <div class="sl-mbar">
        ${d.lost?`<i class="lost" style="height:${d.lost/max*100}%"></i>`:''}
        ${d.open?`<i class="open" style="height:${d.open/max*100}%"></i>`:''}
        ${d.won?`<i class="won" style="height:${d.won/max*100}%"></i>`:''}
      </div>
      <div class="sl-mlbl">${slMonthLabel(d.k, multiYear)}</div>
      <div class="sl-mcnt">${d.n||'·'}</div>
    </button>`).join('')}</div>`;
}

function slStatusSplit(rows){
  const tot = slSum(rows,s=>s.value);
  const parts = SALES_STATUSES.map(st=>{
    const l = rows.filter(s=>s.status===st);
    return { st, n:l.length, v:slSum(l,s=>s.value), cls:slStatusClass(st) };
  });
  return `
    <div class="sl-split">${parts.filter(p=>p.v>0).map(p=>`<span class="${p.cls}" style="flex:${p.v};" title="${p.st}: ${slShort(p.v)}"></span>`).join('')}</div>
    <div class="sl-splitlist">${parts.map(p=>`
      <button type="button" class="sl-srow" data-slfilter="status|${p.st}">
        <i class="${p.cls}"></i><span>${p.st}</span><span class="n">${p.n}</span><span class="v">${slShort(p.v)}</span><span class="p">${slPctTxt(p.v,tot)}</span>
      </button>`).join('')}</div>
    <div class="sl-note">Percent is share of quoted value. Click a status to filter.</div>`;
}

function slBars(groups, total){
  if(!groups.length) return `<div class="empty" style="padding:24px;">No data</div>`;
  const max = Math.max(1, ...groups.map(g=>g.total));
  return `<div class="sl-bars">${groups.slice(0,8).map(g=>`
    <div class="sl-brow" title="${slEsc(g.label)}: ${g.n} quotes, ${slShort(g.total)} quoted, ${slShort(g.won)} won">
      <div class="sl-bl"><span class="nm">${slEsc(g.label)}</span><span class="v">${slShort(g.total)}</span></div>
      <div class="sl-bt"><i class="all" style="width:${g.total/max*100}%"></i><i class="win" style="width:${g.won/max*100}%"></i></div>
      <div class="sl-bs">${g.n} quote${g.n===1?'':'s'}${g.wonN?` · ${g.wonN} won`:''} · ${slPctTxt(g.total,total)}</div>
    </div>`).join('')}
    ${groups.length>8?`<div class="sl-note">+${groups.length-8} more not shown</div>`:''}
    <div class="sl-note"><i class="sl-sw all"></i>quoted <i class="sl-sw win"></i>won</div></div>`;
}

function slInchargeTable(rows){
  const g = slGroup(rows, s=>s.incharge||'Unassigned');
  if(!g.length) return `<div class="empty" style="padding:24px;">No data</div>`;
  return `<table class="sl-mini"><thead><tr><th>Name</th><th class="right">Quotes</th><th class="right">Won</th><th class="right">Pending</th><th class="right">Win rate</th><th class="right">Quoted value</th><th class="right">Avg days</th></tr></thead><tbody>
    ${g.map(x=>{ const a=slAvg(x.days); return `<tr>
      <td><button type="button" class="sl-link" data-slfilter="incharge|${slEsc(x.label)}">${slEsc(x.label)}</button></td>
      <td class="right">${x.n}</td><td class="right">${x.wonN}</td><td class="right">${x.openN}</td>
      <td class="right">${slPctTxt(x.wonN,x.n)}</td><td class="right mono">${slShort(x.total)}</td><td class="right">${a==null?'—':a.toFixed(1)}</td></tr>`; }).join('')}
  </tbody></table>`;
}

function slInsights(rows,total,openV,winRate){
  const items = [];
  if(!rows.length) return `<div class="empty" style="padding:24px;">Nothing to analyse with these filters.</div>`;
  const clients = slGroup(rows, s=>s.client||'No client name');
  const top = clients[0];
  if(top && total>0){
    const share = slPct(top.total,total);
    items.push({ tone: share>=25?'warn':'info', t:'Client concentration', d:`${slEsc(top.label)} is ${share.toFixed(1)}% of quoted value (${slShort(top.total)}). Top 5 clients: ${slPct(slSum(clients.slice(0,5),c=>c.total),total).toFixed(1)}%.` });
  }
  const gov = slSum(rows.filter(s=>s.clientType==='Government'),s=>s.value);
  if(total>0 && gov>0) items.push({ tone:'info', t:'Government vs private', d:`${slPct(gov,total).toFixed(1)}% of quoted value is Government, ${(100-slPct(gov,total)).toFixed(1)}% Private.` });
  const pend = rows.filter(s=>s.status==='Pending').sort((a,b)=>b.value-a.value);
  if(pend.length){
    const rate = rows.length ? rows.filter(s=>s.status==='Approved').length/rows.length : 0;
    items.push({ tone:'open', t:'Open pipeline', d:`${pend.length} pending worth ${slShort(openV)}. Biggest: ${slEsc(pend[0].refNo)} for ${slEsc(pend[0].client||'—')} (${slShort(pend[0].value)}). At the current ${(rate*100).toFixed(1)}% win rate, expect about ${slShort(openV*rate)}.` });
  }
  const slow = rows.filter(s=>{ const t=slTurnaround(s); return t!=null && t>3; });
  if(slow.length) items.push({ tone:'warn', t:'Slow quotations', d:`${slow.length} took more than 3 days to submit (${slShort(slSum(slow,s=>s.value))} of value): ${slow.slice(0,4).map(s=>slEsc(s.refNo)).join(', ')}${slow.length>4?'…':''}.` });
  const big = [...rows].sort((a,b)=>b.value-a.value)[0];
  if(big && big.value>0) items.push({ tone:'info', t:'Largest quotation', d:`${slEsc(big.refNo)} — ${slEsc(big.client||'—')}, ${big.boats>1?big.boats+' × ':''}${slEsc(big.boatModel||'boat')} (${slShort(big.value)}), ${slEsc(big.status).toLowerCase()}.` });
  const noVal = rows.filter(s=>!(Number(s.value)>0));
  const noDate = rows.filter(s=>!s.inquiryDate);
  if(noVal.length||noDate.length) items.push({ tone:'warn', t:'Missing information', d:[noVal.length?`${noVal.length} without a value (${noVal.map(s=>slEsc(s.refNo)).join(', ')})`:'', noDate.length?`${noDate.length} without an inquiry date (${noDate.map(s=>slEsc(s.refNo)).join(', ')})`:''].filter(Boolean).join('; ')+'.' });
  return `<ul class="sl-ins">${items.map(i=>`<li class="${i.tone}"><b>${i.t}</b><span>${i.d}</span></li>`).join('')}</ul>`;
}

function slTable(rows){
  if(!rows.length) return `<div class="empty">No quotations match these filters.</div>`;
  const sorted = [...rows].sort((a,b)=> (b.inquiryDate||'').localeCompare(a.inquiryDate||'') || (b.refNo||'').localeCompare(a.refNo||'',undefined,{numeric:true}));
  return `<table class="sl-table"><thead><tr><th>Ref No.</th><th>Client</th><th>Boat</th><th>In-charge</th><th>Inquiry</th><th class="right">Days</th><th class="right">Value</th><th>Status</th><th></th></tr></thead><tbody>
    ${sorted.map(s=>{
      const t = slTurnaround(s);
      return `<tr>
        <td class="mono">${slEsc(s.refNo)}</td>
        <td><div class="sl-cl">${slEsc(s.client)||'<span class="sl-faint">No client</span>'}</div><div class="sl-sub">${slEsc(s.project||s.location||s.clientType||'')}</div></td>
        <td><div>${slEsc(s.boatModel)||'—'}${s.loa?` · ${slEsc(s.loa)}ft`:''}${s.boats>1?` · ×${s.boats}`:''}</div><div class="sl-sub">${slEsc(s.application||'')}</div></td>
        <td>${slEsc(s.incharge)||'—'}</td>
        <td class="mono">${slDateTxt(s.inquiryDate)}</td>
        <td class="right ${t!=null&&t>3?'sl-slow':''}">${t==null?'—':t}</td>
        <td class="right mono">${Number(s.value)>0?fmt(s.value):'<span class="sl-faint">—</span>'}</td>
        <td><select class="sl-status ${slStatusClass(s.status)}" data-slstatus="${s.id}" aria-label="Status for ${slEsc(s.refNo)}">${SALES_STATUSES.map(st=>`<option ${st===s.status?'selected':''}>${st}</option>`).join('')}</select></td>
        <td class="right" style="white-space:nowrap;"><span class="btn btn-ghost btn-sm" data-sledit="${s.id}">Edit</span><span class="btn btn-ghost btn-sm" data-sldel="${s.id}" style="color:var(--danger);">Delete</span></td>
      </tr>`; }).join('')}
  </tbody></table>`;
}

/* ============================================================
   ADD / EDIT DIALOG
   ============================================================ */
function slNextRef(){
  const nums = SALES.map(s=>{ const m=/^Q(\d+)-(\d+)/i.exec(s.refNo||''); return m? Number(m[2]) : 0; });
  const yr = String(new Date().getFullYear()).slice(2);
  return `Q${yr}-${Math.max(0,...nums)+1}`;
}

function slOpenEditor(id){
  const existing = id ? SALES.find(s=>s.id===id) : null;
  const s = existing ? { ...existing } : { id:uid('s'), refNo:slNextRef(), inquiryDate:todayISO(), draftDate:'', submitDate:'', incharge:'', buildType:'Standard Build', loa:'', boatModel:'', application:'', project:'', client:'', location:'', clientType:'', boats:1, value:'', status:'Pending', notes:'' };
  let models = []; try{ models = getBoatModelList(); }catch(e){}
  models = Array.from(new Set([...models, ...SALES.map(x=>x.boatModel).filter(Boolean)]));
  let apps = []; try{ apps = BOAT_APPLICATIONS.slice(); }catch(e){}
  apps = Array.from(new Set([...apps, ...SALES.map(x=>x.application).filter(Boolean)]));
  const people = Array.from(new Set([...(ALL_PROFILES||[]).map(p=>p.full_name).filter(Boolean), ...SALES.map(x=>x.incharge).filter(Boolean)]));
  const dl = (name, arr) => `<datalist id="${name}">${arr.map(v=>`<option value="${slEsc(v)}">`).join('')}</datalist>`;
  const sel = (key, arr) => `<select data-f="${key}"><option value="">—</option>${arr.map(v=>`<option ${v===s[key]?'selected':''}>${slEsc(v)}</option>`).join('')}</select>`;

  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.innerHTML = `
    <div class="picker sl-modal" role="dialog" aria-modal="true" aria-label="${existing?'Edit sale':'Log a sale'}">
      <div class="picker-head"><div><h3>${existing?'Edit '+slEsc(s.refNo):'Log a sale'}</h3><div class="hint" style="margin:3px 0 0;">Fields marked * are required.</div></div>
        <button type="button" class="btn btn-ghost btn-sm" data-x="cancel" aria-label="Close">✕</button></div>
      <div class="sl-form">
        <div class="field"><label>Quotation ref no. *</label><input data-f="refNo" value="${slEsc(s.refNo)}"></div>
        <div class="field"><label>Status</label>${`<select data-f="status">${SALES_STATUSES.map(v=>`<option ${v===s.status?'selected':''}>${v}</option>`).join('')}</select>`}</div>
        <div class="field wide"><label>Client *</label><input data-f="client" value="${slEsc(s.client)}"></div>
        <div class="field wide"><label>Project title</label><input data-f="project" value="${slEsc(s.project)}" placeholder="e.g. 30ft Dive Boat, Apple Series, single 150hp"></div>
        <div class="field"><label>Client type</label>${sel('clientType',SALES_CLIENT_TYPES)}</div>
        <div class="field"><label>Location</label><input data-f="location" value="${slEsc(s.location)}"></div>
        <div class="field"><label>Boat model</label><input data-f="boatModel" list="slModels" value="${slEsc(s.boatModel)}"></div>
        <div class="field"><label>Application</label><input data-f="application" list="slApps" value="${slEsc(s.application)}"></div>
        <div class="field"><label>Build type</label>${sel('buildType',SALES_BUILD_TYPES)}</div>
        <div class="field"><label>Length overall (ft)</label><input type="number" min="0" step="0.5" data-f="loa" value="${slEsc(s.loa)}"></div>
        <div class="field"><label>Number of boats</label><input type="number" min="1" step="1" data-f="boats" value="${slEsc(s.boats)}"></div>
        <div class="field"><label>Quoted value (₱)</label><input type="number" min="0" step="any" data-f="value" value="${slEsc(s.value)}"></div>
        <div class="field"><label>Quotation in-charge</label><input data-f="incharge" list="slPeople" value="${slEsc(s.incharge)}"></div>
        <div class="field"><label>Date of inquiry</label><input type="date" data-f="inquiryDate" value="${slEsc(s.inquiryDate)}"></div>
        <div class="field"><label>Drafting started</label><input type="date" data-f="draftDate" value="${slEsc(s.draftDate)}"></div>
        <div class="field"><label>Quotation submitted</label><input type="date" data-f="submitDate" value="${slEsc(s.submitDate)}"></div>
        <div class="field wide"><label>Notes</label><textarea data-f="notes" rows="2">${slEsc(s.notes)}</textarea></div>
      </div>
      ${dl('slModels',models)}${dl('slApps',apps)}${dl('slPeople',people)}
      <div class="picker-foot"><span class="picker-count" id="slErr" style="color:var(--danger);"></span>
        <div style="display:flex;gap:8px;"><button type="button" class="btn btn-ghost" data-x="cancel">Cancel</button><button type="button" class="btn btn-primary" data-x="ok">${existing?'Save changes':'Log sale'}</button></div></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = ()=>{ overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e=>{ if(e.key==='Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e=>{ if(e.target===overlay) close(); });
  overlay.querySelectorAll('[data-x="cancel"]').forEach(b=>b.onclick=close);
  overlay.querySelector('[data-f="client"]').focus();
  overlay.querySelector('[data-x="ok"]').onclick = ()=>{
    const out = { ...s };
    overlay.querySelectorAll('[data-f]').forEach(el=>{ out[el.dataset.f] = el.value.trim(); });
    const err = document.getElementById('slErr');
    if(!out.refNo){ err.textContent='Enter a quotation ref no.'; return; }
    if(!out.client){ err.textContent='Enter the client name.'; return; }
    if(SALES.some(x=>x.id!==out.id && (x.refNo||'').toLowerCase()===out.refNo.toLowerCase()) && !confirm(`${out.refNo} is already logged. Save anyway?`)) return;
    out.value = Number(out.value)||0; out.boats = Math.max(1, Number(out.boats)||1);
    out.loa = out.loa===''? '' : Number(out.loa)||'';
    out.updatedAt = Date.now();
    if(existing) Object.assign(existing, out); else { out.createdAt = Date.now(); SALES.push(out); }
    save(DB_KEYS.sales, SALES); close(); toast(existing?'Sale updated':'Sale logged'); renderAll();
  };
}

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */
const SL_COLS = [['refNo','Ref No.'],['client','Client'],['project','Project Title'],['location','Location'],['clientType','Client Type'],['boatModel','Boat Model'],['application','Boat Application'],['buildType','Type of Project'],['loa','Length Over-All (ft)'],['boats','Number of Boats'],['value','Potential Value'],['status','Status'],['incharge','Quotation In-charge'],['inquiryDate','Date of Inquiry'],['draftDate','Drafting Date'],['submitDate','Submission Date'],['notes','Notes']];
function slExportCSV(){
  const q = v => { v = v==null?'':String(v); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; };
  const lines = [SL_COLS.map(c=>q(c[1])).join(',')].concat(SALES.map(s=>SL_COLS.map(c=>q(s[c[0]])).join(',')));
  const blob = new Blob(['\ufeff'+lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `TBSC-sales-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  toast('Exported '+SALES.length+' sales');
}

function slOpenImport(){
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.innerHTML = `
    <div class="picker" role="dialog" aria-modal="true" aria-label="Import sales" style="width:min(480px,100%);">
      <div class="picker-head"><div><h3>Import sales</h3><div class="hint" style="margin:3px 0 0;">Rows whose ref no. is already logged are skipped, so it is safe to re-import.</div></div>
        <button type="button" class="btn btn-ghost btn-sm" data-x="cancel" aria-label="Close">✕</button></div>
      <div class="quick" style="padding-top:10px;">
        <button class="btn" id="slImpQ">Add from existing quotations</button>
        <label class="btn" style="cursor:pointer;justify-content:flex-start;">Choose an Excel or CSV file…<input type="file" id="slImpFile" accept=".xlsx,.xls,.csv" style="display:none;"></label>
        <div class="hint" style="margin:2px 4px 0;">Excel files should use the same columns as your “Quotation Master Data” sheet (Client, Boat Model, Potential Value, Status, Inquiry Month/Day/Year…). A CSV exported from this page also works.</div>
      </div>
      <div class="picker-foot"><span class="picker-count" id="slImpMsg"></span><button type="button" class="btn btn-ghost" data-x="cancel">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = ()=>overlay.remove();
  overlay.addEventListener('mousedown', e=>{ if(e.target===overlay) close(); });
  overlay.querySelectorAll('[data-x="cancel"]').forEach(b=>b.onclick=close);
  document.getElementById('slImpQ').onclick = ()=>{ close(); slImportFromQuotes(); };
  document.getElementById('slImpFile').onchange = async e=>{
    const f = e.target.files[0]; if(!f) return;
    const msg = document.getElementById('slImpMsg'); msg.textContent = 'Reading file…';
    try{
      const n = await slImportFile(f);
      close();
      if(n!=null){ renderAll(); }
    }catch(err){ console.error(err); msg.style.color='var(--danger)'; msg.textContent = 'Could not read that file. '+(err.message||''); }
  };
}

function slLoadSheetJS(){
  if(window.XLSX) return Promise.resolve();
  return new Promise((res,rej)=>{
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    sc.onload = res; sc.onerror = ()=>rej(new Error('Could not load the spreadsheet reader. Check your connection.'));
    document.head.appendChild(sc);
  });
}

async function slImportFile(file){
  await slLoadSheetJS();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type:'array' });
  // prefer the master-data sheet, otherwise the first sheet that has a Client + Status header
  let rows = null;
  const names = [...wb.SheetNames].sort((a,b)=> (/master/i.test(b)?1:0)-(/master/i.test(a)?1:0));
  for(const n of names){
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header:1, defval:'', raw:true });
    const hi = aoa.findIndex(r=>r.some(c=>/^client$/i.test(String(c).trim())) && r.some(c=>/^status$/i.test(String(c).trim())));
    if(hi>=0){ rows = { hdr:aoa[hi].map(c=>String(c).trim()), data:aoa.slice(hi+1) }; break; }
  }
  if(!rows) throw new Error('No sheet with “Client” and “Status” columns was found.');
  const idx = (...names) => { for(const nm of names){ const i = rows.hdr.findIndex(h=>h.toLowerCase()===nm.toLowerCase()); if(i>=0) return i; } return -1; };
  const col = { ref:idx('Sequence No.','Ref No.','Ref No'), client:idx('Client'), project:idx('PROJECT TITLE','Project Title'), loc:idx('Location'), ctype:idx('Client Type'), model:idx('Boat Model'), app:idx('Boat Application'), build:idx('Type of Project'), loa:idx('Length Over-All (ft)'), boats:idx('Number of boats','Number of Boats'), val:idx('Potential Value'), status:idx('Status'), who:idx('Quotation In-charge'), inqM:idx('Inquiry Month'), inqD:idx('Inquiry Day'), inqY:idx('Inquiry Year'), drM:idx('Drafting Month'), drD:idx('Drafting Day'), drY:idx('Drafting Year'), suM:idx('Submission Month'), suD:idx('Submission Day'), suY:idx('Submission Year'), inq:idx('Date of Inquiry'), dr:idx('Drafting Date'), su:idx('Submission Date'), notes:idx('Notes') };
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const get = (r,i) => i<0 ? '' : r[i];
  const text = v => String(v==null?'':v).trim();
  const isoFromParts = (m,d,y) => { const mi = typeof m==='number'? m-1 : MONTHS.indexOf(text(m).toLowerCase()); if(mi<0||!d) return ''; let yr = Number(y)||new Date().getFullYear(); return `${yr}-${String(mi+1).padStart(2,'0')}-${String(Number(d)).padStart(2,'0')}`; };
  const isoFromCell = v => { if(v==null||v==='') return ''; if(typeof v==='number'){ const dt = new Date(Math.round((v-25569)*86400000)); return dt.toISOString().slice(0,10); } const t=text(v); return /^\d{4}-\d{2}-\d{2}/.test(t)? t.slice(0,10) : ''; };
  const norm = s => text(s).toLowerCase().replace(/\s+/g,'');
  const have = new Set(SALES.map(s=>norm(s.refNo)));
  const fresh = [];
  let skippedDup = 0, skippedBlank = 0;
  rows.data.forEach(r=>{
    const client = text(get(r,col.client)), value = Number(get(r,col.val))||0;
    let ref = text(get(r,col.ref)).replace(/^(Q\d+)\s+(\d)/i,'$1-$2');
    if(!client && !value){ skippedBlank++; return; }
    if(!ref){ skippedBlank++; return; }
    if(have.has(norm(ref))){ skippedDup++; return; }
    have.add(norm(ref));
    const st = text(get(r,col.status)).toLowerCase();
    const rec = {
      id: uid('s'), refNo: ref, client, project:text(get(r,col.project)), location:text(get(r,col.loc)), clientType:text(get(r,col.ctype)),
      boatModel:text(get(r,col.model)).replace(/Emabassy/i,'Embassy'), application:text(get(r,col.app)), buildType:text(get(r,col.build)),
      loa: Number(get(r,col.loa))||'', boats: Math.max(1, Number(get(r,col.boats))||1), value,
      status: st.startsWith('approv') ? 'Approved' : (st.startsWith('not') || st.startsWith('lost') || st.startsWith('declin') ? 'Not Approved' : 'Pending'),
      incharge:text(get(r,col.who)),
      inquiryDate: col.inq>=0 ? isoFromCell(get(r,col.inq)) : isoFromParts(get(r,col.inqM),get(r,col.inqD),get(r,col.inqY)),
      draftDate:   col.dr>=0  ? isoFromCell(get(r,col.dr))  : isoFromParts(get(r,col.drM),get(r,col.drD),get(r,col.drY)),
      submitDate:  col.su>=0  ? isoFromCell(get(r,col.su))  : isoFromParts(get(r,col.suM),get(r,col.suD),get(r,col.suY)),
      notes:text(get(r,col.notes)), createdAt:Date.now(), updatedAt:Date.now()
    };
    fresh.push(rec);
  });
  if(!fresh.length){ toast(`Nothing new to import (${skippedDup} already logged${skippedBlank?`, ${skippedBlank} blank`:''})`); return null; }
  if(!confirm(`Import ${fresh.length} new sale${fresh.length===1?'':'s'}?\n${skippedDup} already logged and ${skippedBlank} blank rows will be skipped.`)) return null;
  fresh.forEach(s=>SALES.push(s));
  save(DB_KEYS.sales, SALES);
  toast(`Imported ${fresh.length} sales`);
  return fresh.length;
}

function slImportFromQuotes(){
  const norm = s => String(s||'').trim().toLowerCase();
  const have = new Set(SALES.map(s=>norm(s.refNo)));
  const fresh = QUOTES.filter(q=>q.refNo && !have.has(norm(q.refNo)));
  if(!fresh.length){ toast('Every quotation is already in the Sales Tracker'); return; }
  if(!confirm(`Add ${fresh.length} quotation${fresh.length===1?'':'s'} to the Sales Tracker?\nApproved quotations become “Approved”; everything else starts as “Pending”.`)) return;
  fresh.forEach(q=>{
    const who = profileByEmail(q.createdByEmail);
    SALES.push({
      id: uid('s'), refNo:q.refNo, client:customerDisplayName(q.customerSnap)||'', project:'', location:'', clientType:'',
      boatModel:(q.project&&q.project.boatModel)||'', application:(q.project&&q.project.boatApplication)||'',
      buildType:(q.hull&&q.hull.boatType)||'', loa:Number(q.hull&&q.hull.loa)||'', boats:1,
      value: Math.round((computeAll(q).finalTotal||0)*100)/100,
      status: q.status==='approved' ? 'Approved' : 'Pending',
      incharge:(who&&who.full_name)||q.createdByEmail||'', inquiryDate:q.date||'', draftDate:'', submitDate:'', notes:'',
      createdAt:Date.now(), updatedAt:Date.now()
    });
  });
  save(DB_KEYS.sales, SALES);
  toast(`Added ${fresh.length} from quotations`);
  renderAll();
}
