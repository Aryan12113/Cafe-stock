// ---------- Setup ----------
const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// Unit table: f = family (weight / volume / count), m = how many "smallest units" it holds.
// 1 kg = 1000 g, 1 litre = 1000 ml. This is what makes g <-> kg conversion work.
const UNITS = { kg:{f:'w',m:1000}, g:{f:'w',m:1}, litre:{f:'v',m:1000}, ml:{f:'v',m:1}, pcs:{f:'c',m:1} };

const $ = s => document.querySelector(s);
const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fq = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 }); // stock quantity, e.g. 9.97
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isLow = i => Number(i.quantity) < Number(i.low_limit);
const timeStr = iso => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const dayTime = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
// Midnight today in the cafe's own time zone (the browser's clock)
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

// Convert an amount from one unit to another (e.g. 30 g -> 0.03 kg)
const convert = (qty, from, to) => qty * UNITS[from].m / UNITS[to].m;

let S = { ing: [], dishes: [], items: [], sales: [], buys: [] };
let view = 'home';

// ---------- Load & navigation ----------
async function load() {
  const [a, b, c, d, e] = await Promise.all([
    sb.from('ingredients').select('*').order('name'),
    sb.from('dishes').select('*').order('name'),
    sb.from('recipe_items').select('*'),
    sb.from('sales').select('*').gte('sold_at', todayStart()).order('sold_at', { ascending: false }),
    sb.from('purchases').select('*').order('bought_at', { ascending: false }).limit(15)
  ]);
  const err = a.error || b.error || c.error || d.error || e.error;
  if (err) {
    $('#app').innerHTML = `<div class="card warn">Could not load data: ${esc(err.message)}<br>Check config.js and that all four schema files were run.</div>`;
    return;
  }
  S = { ing: a.data, dishes: b.data, items: c.data, sales: d.data, buys: e.data };
  render();
}
function setView(v) {
  view = v;
  if (v === 'reports') R.loaded = null; // always fetch fresh numbers when opening Reports
  render();
}
function render() {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  const views = { inv: invView, menu: menuView, sales: salesView, reports: reportsView };
  $('#app').innerHTML = (views[view] || homeView)();
}
function openDlg(html) { $('#dlg').innerHTML = html; $('#dlg').showModal(); }
function closeDlg() { $('#dlg').close(); }

// ---------- Home ----------
function homeView() {
  const low = S.ing.filter(isLow);
  const alert = low.length
    ? `<div class="alert"><b>⚠️ Low stock (${low.length})</b>${low.map(i => `<div class="item lowrow"><span>${esc(i.name)}: ${fq(i.quantity)} ${i.unit} left (limit ${fq(i.low_limit)})</span><button class="btn small" onclick="restock('${i.id}')">Restock</button></div>`).join('')}</div>`
    : `<div class="card good">✅ All stock levels are fine.</div>`;
  const rows = S.ing.map(i => `<div class="item"><span>${esc(i.name)}</span><span>${fq(i.quantity)} ${i.unit} ${isLow(i) ? '<span class="badge">Low</span>' : ''}</span></div>`).join('<hr>');
  return `${todayCard()}${alert}<div class="card"><h2>Current stock</h2>${rows || '<p class="muted">No ingredients yet. Add some in Inventory.</p>'}</div>`;
}

// Totals for today's sales (price and cost were saved with each sale)
function todayTotals() {
  const t = { revenue: 0, cost: 0, count: 0, byDish: {} };
  S.sales.forEach(s => {
    t.revenue += s.qty * s.price;
    t.cost += s.qty * s.cost;
    t.count += s.qty;
    t.byDish[s.dish_name] = (t.byDish[s.dish_name] || 0) + s.qty;
  });
  return t;
}
function todayCard() {
  const t = todayTotals();
  if (!t.count) return `<div class="card"><h2>Today's sales</h2><p class="muted">No sales recorded yet today. Use the Sales tab.</p></div>`;
  const top = Object.entries(t.byDish).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, q]) => `${esc(n)} ×${q}`).join(' · ');
  return `<div class="card"><h2>Today's sales</h2>
    <div class="stats">
      <div><span class="muted">Sales</span><b>${inr(t.revenue)}</b></div>
      <div><span class="muted">Cost</span><b>${inr(t.cost)}</b></div>
      <div><span class="muted">Profit</span><b class="good">${inr(t.revenue - t.cost)}</b></div>
    </div>
    <div class="muted">${t.count} item${t.count === 1 ? '' : 's'} sold · Top: ${top}</div></div>`;
}

// ---------- Sales ----------
function salesView() {
  if (!S.dishes.length) return `<h2>Sales</h2><p class="muted">No dishes yet. Add them in Menu first.</p>`;
  const pick = S.dishes.map(d => `<div class="card sell">
      <div><b>${esc(d.name)}</b><div class="muted">${inr(d.price)}</div></div>
      <div class="stepper">
        <button class="x" onclick="step('${d.id}',-1)">−</button>
        <input id="q_${d.id}" type="number" min="1" step="1" value="1" inputmode="numeric">
        <button class="x" onclick="step('${d.id}',1)">+</button>
      </div>
      <button class="btn" onclick="sell('${d.id}', this)">Sold</button>
    </div>`).join('');
  const t = todayTotals();
  const log = S.sales.map(s => `<div class="item">
      <span>${timeStr(s.sold_at)} · ${s.qty} × ${esc(s.dish_name)}</span>
      <span>${inr(s.qty * s.price)} <button class="btn ghost small" onclick="undoSale('${s.id}')">Undo</button></span>
    </div>`).join('<hr>');
  return `<h2>Record a sale</h2>${pick}
    <div class="card"><h2>Today so far: ${inr(t.revenue)}</h2>${log || '<p class="muted">No sales yet today.</p>'}</div>`;
}
function step(id, n) {
  const el = $('#q_' + id);
  el.value = Math.max(1, (Math.floor(+el.value) || 1) + n);
}
// Which ingredients would run short if we sell this many?
function shortfalls(dishId, qty) {
  return S.items.filter(r => r.dish_id === dishId).map(r => {
    const ing = S.ing.find(i => i.id === r.ingredient_id);
    if (!ing) return null;
    const need = convert(r.qty, r.unit, ing.unit) * qty;
    return need > Number(ing.quantity) ? `${ing.name}: need ${fq(need)} ${ing.unit}, have ${fq(ing.quantity)}` : null;
  }).filter(Boolean);
}
async function sell(id, btn) {
  const qty = Math.floor(+$('#q_' + id).value);
  if (!(qty >= 1)) return alert('Enter how many were sold (1 or more).');
  const short = shortfalls(id, qty);
  if (short.length && !confirm(`Not enough stock:\n${short.join('\n')}\n\nRecord the sale anyway? Stock will go below zero.`)) return;
  btn.disabled = true;
  const { error } = await sb.rpc('record_sale', { p_dish: id, p_qty: qty });
  if (error) { btn.disabled = false; return alert(error.message); }
  load();
}
async function undoSale(id) {
  if (!confirm('Undo this sale? The ingredients will be put back into stock.')) return;
  const { error } = await sb.rpc('undo_sale', { p_sale: id });
  if (error) return alert(error.message);
  load();
}

// ---------- Reports ----------
const PERIODS = [['today', 'Today'], ['yday', 'Yesterday'], ['7d', 'Last 7 days'], ['month', 'This month'], ['30d', 'Last 30 days']];
let R = { period: '7d', loaded: null };
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const dayKey = d => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const dayLabel = k => new Date(k + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const daysTxt = d => d < 1 ? 'less than a day' : `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'}`;
const roundUp = n => Math.ceil(n * 10) / 10;

// Start (inclusive) and end (exclusive) of a period, in local time
function periodRange(p) {
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const e = new Date(s); e.setDate(e.getDate() + 1);
  if (p === 'yday') { s.setDate(s.getDate() - 1); e.setDate(e.getDate() - 1); }
  else if (p === '7d') s.setDate(s.getDate() - 6);
  else if (p === 'month') s.setDate(1);
  else if (p === '30d') s.setDate(s.getDate() - 29);
  return [s, e];
}
// Supabase returns at most 1000 rows per request, so fetch page by page
async function fetchAll(makeQuery) {
  let out = [], from = 0;
  while (true) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) return out;
    from += 1000;
  }
}
async function loadReport() {
  const p = R.period;
  const [s, e] = periodRange(p);
  const week = new Date(); week.setHours(0, 0, 0, 0); week.setDate(week.getDate() - 6);
  R.loaded = 'loading';
  try {
    const [sales, buys, usage] = await Promise.all([
      fetchAll(() => sb.from('sales').select('*').gte('sold_at', s.toISOString()).lt('sold_at', e.toISOString()).order('sold_at')),
      fetchAll(() => sb.from('purchases').select('*').gte('bought_at', s.toISOString()).lt('bought_at', e.toISOString()).order('bought_at')),
      // How much of each ingredient sales used in the last 7 days (for "What to buy")
      fetchAll(() => sb.from('sale_usage').select('ingredient_id, amount, sale_id, sales!inner(sold_at)').gte('sales.sold_at', week.toISOString()).order('sale_id'))
    ]);
    if (R.period !== p) return; // you picked another period meanwhile
    R = { period: p, loaded: p, sales, buys, usage, s, e, err: null };
  } catch (err) {
    if (R.period !== p) return;
    R = { period: p, loaded: p, err: err.message };
  }
  if (view === 'reports') render();
}
function setPeriod(p) { R.period = p; R.loaded = null; render(); }

function reportsView() {
  const chips = PERIODS.map(([k, l]) => `<button class="chip ${k === R.period ? 'on' : ''}" onclick="setPeriod('${k}')">${l}</button>`).join('');
  const head = `<h2>Reports</h2><div class="chips">${chips}</div>`;
  if (R.loaded !== R.period) {
    if (R.loaded !== 'loading') loadReport();
    return head + '<p class="muted">Loading…</p>';
  }
  if (R.err) return head + `<div class="card warn">Could not load the report: ${esc(R.err)}</div>`;
  return head + summaryCard() + buyListCard() + dailyCard() + bestCard();
}
function summaryCard() {
  const rev = sum(R.sales, s => s.qty * s.price);
  const cost = sum(R.sales, s => s.qty * s.cost);
  const items = sum(R.sales, s => s.qty);
  const spent = sum(R.buys, b => Number(b.total_cost));
  const days = Math.round((R.e - R.s) / 864e5);
  return `<div class="card">
    <div class="stats">
      <div><span class="muted">Sales</span><b>${inr(rev)}</b></div>
      <div><span class="muted">Ingredient cost</span><b>${inr(cost)}</b></div>
      <div><span class="muted">Profit</span><b class="good">${inr(rev - cost)}</b></div>
    </div>
    <div class="muted">${items} item${items === 1 ? '' : 's'} sold${rev ? ` · margin ${Math.round((rev - cost) / rev * 100)}%` : ''}${days > 1 && rev ? ` · average ${inr(rev / days)} a day` : ''}</div>
    <div class="muted">Spent on stock: ${inr(spent)} (${R.buys.length} purchase${R.buys.length === 1 ? '' : 's'})</div>
  </div>`;
}
// Shopping list: low items, or items that will run out within 3 days at last week's pace.
// Suggests enough for about a week, and at least twice the warning level.
function buyListCard() {
  const used = {};
  R.usage.forEach(u => used[u.ingredient_id] = (used[u.ingredient_id] || 0) + Number(u.amount));
  const need = S.ing.map(i => {
    const q = Number(i.quantity), perDay = (used[i.id] || 0) / 7;
    const daysLeft = perDay > 0 ? q / perDay : Infinity;
    const buy = Math.max(0, Math.max(Number(i.low_limit) * 2, perDay * 7) - q);
    return { i, perDay, daysLeft, buy };
  }).filter(r => (isLow(r.i) || r.daysLeft < 3) && r.buy > 0)
    .sort((a, b) => (a.daysLeft === b.daysLeft ? 0 : a.daysLeft < b.daysLeft ? -1 : 1));
  if (!need.length) return `<div class="card"><h2>What to buy</h2><p class="good">Nothing urgent. Stock should last at least 3 more days.</p></div>`;
  const rows = need.map(r => `<div class="item">
      <span><b>${esc(r.i.name)}</b><br><span class="muted">${fq(r.i.quantity)} ${r.i.unit} left${r.perDay > 0 ? ` · lasts about ${daysTxt(r.daysLeft)}` : ''}</span></span>
      <span>Buy about ${fq(roundUp(r.buy))} ${r.i.unit}<br><span class="muted">≈ ${inr(r.buy * r.i.price_per_unit)}</span></span>
    </div>`).join('<hr>');
  return `<div class="card"><h2>What to buy</h2><p class="muted">Based on the last 7 days of sales</p>${rows}
    <hr><div class="item"><b>Estimated total</b><b>${inr(sum(need, r => r.buy * r.i.price_per_unit))}</b></div></div>`;
}
function dailyCard() {
  const days = [];
  for (let d = new Date(R.s); d < R.e; d.setDate(d.getDate() + 1)) days.push(dayKey(d));
  if (days.length < 2) return '';
  const by = {};
  days.forEach(k => by[k] = { rev: 0, profit: 0 });
  R.sales.forEach(s => {
    const k = dayKey(new Date(s.sold_at));
    if (by[k]) { by[k].rev += s.qty * s.price; by[k].profit += s.qty * (s.price - s.cost); }
  });
  const max = Math.max(1, ...days.map(k => by[k].rev));
  const rows = days.slice().reverse().map(k => `<div class="drow">
      <span>${dayLabel(k)}</span>
      <div class="bar"><i style="width:${by[k].rev / max * 100}%"></i></div>
      <span class="num">${inr(by[k].rev)}<br><small class="good">${inr(by[k].profit)}</small></span>
    </div>`).join('');
  return `<div class="card"><h2>Day by day</h2><p class="muted">Sales, with profit in green</p>${rows}</div>`;
}
function bestCard() {
  const m = {};
  R.sales.forEach(s => {
    const x = m[s.dish_name] = m[s.dish_name] || { qty: 0, rev: 0, profit: 0 };
    x.qty += s.qty; x.rev += s.qty * s.price; x.profit += s.qty * (s.price - s.cost);
  });
  const list = Object.entries(m).sort((a, b) => b[1].qty - a[1].qty);
  if (!list.length) return `<div class="card"><h2>Best sellers</h2><p class="muted">No sales in this period.</p></div>`;
  return `<div class="card"><h2>Best sellers</h2><p class="muted">Sales · profit</p>${list.map(([n, x], i) => `<div class="item">
      <span>${i + 1}. ${esc(n)} <span class="muted">×${x.qty}</span></span>
      <span>${inr(x.rev)} · <span class="good">${inr(x.profit)}</span></span>
    </div>`).join('<hr>')}</div>`;
}

// ---------- Inventory ----------
function invView() {
  const list = S.ing.map(i => `
    <div class="card">
      <div class="item"><b>${esc(i.name)}</b> ${isLow(i) ? '<span class="badge">Low stock</span>' : ''}</div>
      <div class="muted">${fq(i.quantity)} ${i.unit} in stock · ${inr(i.price_per_unit)} per ${i.unit} · warn below ${fq(i.low_limit)}</div>
      <div class="row"><button class="btn" onclick="restock('${i.id}')">+ Restock</button><button class="btn ghost" onclick="editIng('${i.id}')">Edit</button><button class="btn red" onclick="delIng('${i.id}')">Delete</button></div>
    </div>`).join('');
  return `<div class="top"><h2>Inventory</h2><button class="btn" onclick="editIng()">+ Add</button></div>${list || '<p class="muted">No ingredients yet.</p>'}${buysCard()}`;
}
function editIng(id) {
  const i = S.ing.find(x => x.id === id) || { name:'', unit:'kg', quantity:'', price_per_unit:'', low_limit:'' };
  const used = id && S.items.some(r => r.ingredient_id === id); // unit locked if a recipe uses it
  openDlg(`<h2>${id ? 'Edit' : 'Add'} ingredient</h2>
    <label>Name<input id="f_name" value="${esc(i.name)}" placeholder="e.g. Milk"></label>
    <label>Unit<select id="f_unit" ${used ? 'disabled' : ''}>${Object.keys(UNITS).map(u => `<option ${u === i.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    <label>Quantity in stock<input id="f_qty" type="number" step="any" value="${i.quantity}"></label>
    <label>Price per unit (₹)<input id="f_price" type="number" step="any" min="0" value="${i.price_per_unit}"></label>
    <label>Warn me when stock falls below<input id="f_low" type="number" step="any" min="0" value="${i.low_limit}"></label>
    <div class="row"><button class="btn" onclick="saveIng('${id || ''}')">Save</button><button class="btn ghost" onclick="closeDlg()">Cancel</button></div>`);
}
async function saveIng(id) {
  const name = $('#f_name').value.trim();
  if (!name) return alert('Please enter a name.');
  const p = { name, unit: $('#f_unit').value, quantity: +$('#f_qty').value || 0, price_per_unit: +$('#f_price').value || 0, low_limit: +$('#f_low').value || 0 };
  const { error } = id ? await sb.from('ingredients').update(p).eq('id', id) : await sb.from('ingredients').insert(p);
  if (error) return alert(error.message);
  closeDlg(); load();
}
async function delIng(id) {
  if (!confirm('Delete this ingredient?')) return;
  const { error } = await sb.from('ingredients').delete().eq('id', id);
  if (error) return alert('This ingredient is used in a recipe. Remove it from the recipe first.');
  load();
}

// ---------- Restocking ----------
function restock(id) {
  const i = S.ing.find(x => x.id === id);
  openDlg(`<h2>Restock ${esc(i.name)}</h2>
    <p class="muted">In stock now: ${fq(i.quantity)} ${i.unit} · current price ${inr(i.price_per_unit)} per ${i.unit}</p>
    <div class="two">
      <label>Quantity bought<input id="p_qty" type="number" step="any" min="0" oninput="buyCalc('${id}')"></label>
      <label>Unit<select id="p_unit" onchange="buyCalc('${id}')">${unitOpts(i)}</select></label>
    </div>
    <label>Total amount paid (₹)<input id="p_total" type="number" step="any" min="0" oninput="buyCalc('${id}')"></label>
    <p id="p_info" class="muted"></p>
    <label class="check"><input id="p_setprice" type="checkbox" checked> Use this as the new price per ${i.unit}</label>
    <div class="row"><button class="btn" onclick="saveBuy('${id}', this)">Save</button><button class="btn ghost" onclick="closeDlg()">Cancel</button></div>`);
  $('#p_qty').focus();
}
// Live preview: new stock level and price per unit
function buyCalc(id) {
  const i = S.ing.find(x => x.id === id);
  const q = +$('#p_qty').value, t = +$('#p_total').value;
  if (!(q > 0)) { $('#p_info').textContent = ''; return; }
  const amt = convert(q, $('#p_unit').value, i.unit);
  let s = `Stock will be ${fq(Number(i.quantity) + amt)} ${i.unit}.`;
  if (t > 0) s += ` That works out to ${inr(t / amt)} per ${i.unit}.`;
  $('#p_info').textContent = s;
}
async function saveBuy(id, btn) {
  const qty = +$('#p_qty').value, total = +$('#p_total').value || 0;
  if (!(qty > 0)) return alert('Enter how much you bought.');
  btn.disabled = true;
  const { error } = await sb.rpc('record_purchase', {
    p_ing: id, p_qty: qty, p_unit: $('#p_unit').value, p_total: total, p_set_price: $('#p_setprice').checked
  });
  if (error) { btn.disabled = false; return alert(error.message); }
  closeDlg(); load();
}
function buysCard() {
  if (!S.buys.length) return '';
  const rows = S.buys.map(p => `<div class="item">
      <span>${dayTime(p.bought_at)} · ${fq(p.qty)} ${p.unit} ${esc(p.ingredient_name)}</span>
      <span>${inr(p.total_cost)} <button class="btn ghost small" onclick="undoBuy('${p.id}')">Undo</button></span>
    </div>`).join('<hr>');
  return `<div class="card"><h2>Recent purchases</h2>${rows}</div>`;
}
async function undoBuy(id) {
  if (!confirm('Undo this purchase? That amount will be taken back out of stock.')) return;
  const { error } = await sb.rpc('undo_purchase', { p_id: id });
  if (error) return alert(error.message);
  load();
}

// ---------- Menu & recipes ----------
// Cost of one dish = for each recipe line, (amount converted to the stock unit) x (price per stock unit)
function dishCost(dishId) {
  return S.items.filter(r => r.dish_id === dishId).reduce((sum, r) => {
    const ing = S.ing.find(i => i.id === r.ingredient_id);
    return ing ? sum + convert(r.qty, r.unit, ing.unit) * ing.price_per_unit : sum;
  }, 0);
}
function menuView() {
  const list = S.dishes.map(d => {
    const lines = S.items.filter(r => r.dish_id === d.id).map(r => {
      const ing = S.ing.find(i => i.id === r.ingredient_id);
      return `${r.qty} ${r.unit} ${ing ? esc(ing.name) : '?'}`;
    }).join(' + ');
    const cost = dishCost(d.id);
    return `<div class="card">
      <div class="item"><b>${esc(d.name)}</b><b>${inr(d.price)}</b></div>
      <div class="muted">${lines || 'No recipe'}</div>
      <div class="muted">Cost ${inr(cost)} · Profit per dish <span class="good">${inr(d.price - cost)}</span></div>
      <div class="row"><button class="btn" onclick="editDish('${d.id}')">Edit</button><button class="btn red" onclick="delDish('${d.id}')">Delete</button></div>
    </div>`;
  }).join('');
  return `<div class="top"><h2>Menu</h2><button class="btn" onclick="editDish()">+ Add</button></div>${list || '<p class="muted">No dishes yet.</p>'}`;
}

// One recipe row: ingredient + quantity + unit (unit choices follow the ingredient's family)
const unitOpts = (ing, sel) => Object.keys(UNITS).filter(u => UNITS[u].f === UNITS[ing.unit].f)
  .map(u => `<option ${u === (sel || ing.unit) ? 'selected' : ''}>${u}</option>`).join('');
function rowHtml(r = {}) {
  const ing = S.ing.find(x => x.id === r.ingredient_id) || S.ing[0];
  return `<div class="rrow">
    <select class="r_ing" onchange="fixUnits(this)">${S.ing.map(i => `<option value="${i.id}" ${i.id === ing.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select>
    <input class="r_qty" type="number" step="any" min="0" placeholder="Qty" value="${r.qty ?? ''}">
    <select class="r_unit">${unitOpts(ing, r.unit)}</select>
    <button class="x" onclick="this.parentNode.remove()">✕</button></div>`;
}
function fixUnits(el) {
  const ing = S.ing.find(x => x.id === el.value);
  el.parentNode.querySelector('.r_unit').innerHTML = unitOpts(ing);
}
function addRow() { $('#rows').insertAdjacentHTML('beforeend', rowHtml()); }

function editDish(id) {
  if (!S.ing.length) return alert('Add some ingredients in Inventory first.');
  const d = S.dishes.find(x => x.id === id) || { name: '', price: '' };
  const rows = S.items.filter(r => r.dish_id === id).map(rowHtml).join('') || rowHtml();
  openDlg(`<h2>${id ? 'Edit' : 'Add'} dish</h2>
    <label>Dish name<input id="d_name" value="${esc(d.name)}" placeholder="e.g. Cappuccino"></label>
    <label>Selling price (₹)<input id="d_price" type="number" step="any" min="0" value="${d.price}"></label>
    <b>Recipe</b><div id="rows" style="margin-top:6px">${rows}</div>
    <button class="btn ghost" onclick="addRow()">+ Add ingredient</button>
    <div class="row"><button class="btn" onclick="saveDish('${id || ''}')">Save</button><button class="btn ghost" onclick="closeDlg()">Cancel</button></div>`);
}
async function saveDish(id) {
  const name = $('#d_name').value.trim();
  if (!name) return alert('Please enter a dish name.');
  const lines = [...document.querySelectorAll('.rrow')].map(r => ({
    ingredient_id: r.querySelector('.r_ing').value,
    qty: +r.querySelector('.r_qty').value,
    unit: r.querySelector('.r_unit').value
  })).filter(l => l.qty > 0);
  if (!lines.length) return alert('Add at least one ingredient with a quantity.');
  const p = { name, price: +$('#d_price').value || 0 };
  let dishId = id;
  if (id) {
    const { error } = await sb.from('dishes').update(p).eq('id', id);
    if (error) return alert(error.message);
    await sb.from('recipe_items').delete().eq('dish_id', id); // replace the old recipe
  } else {
    const { data, error } = await sb.from('dishes').insert(p).select().single();
    if (error) return alert(error.message);
    dishId = data.id;
  }
  const { error } = await sb.from('recipe_items').insert(lines.map(l => ({ ...l, dish_id: dishId })));
  if (error) return alert(error.message);
  closeDlg(); load();
}
async function delDish(id) {
  if (!confirm('Delete this dish and its recipe? Past sales of it are kept.')) return;
  const { error } = await sb.from('dishes').delete().eq('id', id);
  if (error) return alert(error.message);
  load();
}

// ---------- Login ----------
// Anyone with the link can create an account. Each account gets its own cafe,
// and the database only ever shows people their own cafe's data.
let ME = null;            // { user, cafe } once logged in
let authMode = 'login';   // 'login' or 'signup'
// Opened from a "reset password" email? (checked before Supabase tidies the address bar)
let recovering = /type=recovery/.test(location.hash);
const appUrl = () => location.href.split('#')[0].split('?')[0];
// If Google login failed, Supabase sends the reason back in the address bar
const loginError = (() => {
  const h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
  return h.get('error_description') || q.get('error_description') || '';
})();

async function init() {
  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') showLogin();
    if (event === 'PASSWORD_RECOVERY') { recovering = true; showNewPassword(); }
  });
  if (recovering) return showNewPassword();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    if (loginError) history.replaceState(null, '', appUrl());
    return showLogin(loginError ? 'Google login did not work: ' + loginError : '');
  }
  afterLogin();
}

// ---- Google's own sign-in (One Tap popup + official Google button) ----
// Google gives us a signed token for the account the person picked;
// Supabase checks it with Google and logs them in. No page reload, no redirect.
let gNonce = '';
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function setupGoogle() {
  const box = $('#gbox');
  if (!box) return; // not on the login page any more
  if (location.protocol === 'file:') {
    box.innerHTML = '<p class="muted center">Google login works only from a web address (your hosted link, or http://localhost:5500 with Live Server), not by double-clicking the file.</p>';
    return;
  }
  if (!CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.startsWith('PASTE')) {
    box.innerHTML = '<p class="muted center">Google login is not set up yet: paste your Google Client ID into config.js.</p>';
    return;
  }
  if (!(window.google && google.accounts && google.accounts.id)) {
    window.onGoogleLibraryLoad = setupGoogle; // Google's script is still loading; try again when it's ready
    return;
  }
  gNonce = crypto.randomUUID() + crypto.randomUUID();
  google.accounts.id.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    callback: onGoogle,
    nonce: await sha256hex(gNonce),
    use_fedcm_for_prompt: true,
    itp_support: true,
    context: 'signin'
  });
  box.innerHTML = '';
  google.accounts.id.renderButton(box, {
    theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'center',
    width: Math.min(Math.max(box.clientWidth, 200), 400)
  });
  google.accounts.id.prompt(); // the "Continue as …" popup
}
async function onGoogle(resp) {
  $('#app').innerHTML = '<p class="center muted">Logging in with Google…</p>';
  const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce: gNonce });
  if (error) return showLogin('Google login did not work: ' + friendly(error.message));
  afterLogin();
}
function stopGoogle() {
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.cancel();
}

// After login: find this person's cafe, then open the app
async function afterLogin() {
  if (recovering) return;
  $('#app').innerHTML = 'Loading…';
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return showLogin();
  const { data, error } = await sb.from('members').select('cafes(id, name)').eq('user_id', user.id).maybeSingle();
  if (error) {
    $('#app').innerHTML = `<div class="card warn">Could not load your cafe: ${esc(error.message)}<br>Check that schema_part4.sql was run.</div>`;
    return;
  }
  if (!data || !data.cafes) return showSetup(user);
  stopGoogle();
  ME = { user, cafe: data.cafes };
  $('#cafeName').textContent = ME.cafe.name;
  document.body.classList.remove('out');
  view = 'home';
  load();
}

function showLogin(msg = '') {
  ME = null;
  S = { ing: [], dishes: [], items: [], sales: [], buys: [] };
  document.body.classList.add('out');
  $('#cafeName').textContent = 'Cafe Stock';
  if ($('#dlg').open) closeDlg();
  const login = authMode === 'login';
  $('#app').innerHTML = `<form class="card auth" onsubmit="doAuth(event)">
    <h2>${login ? 'Log in' : 'Create your account'}</h2>
    ${msg ? `<p class="${msg.startsWith('✅') ? 'good' : 'warn'}">${esc(msg)}</p>` : ''}
    <div id="gbox" class="gbox"></div>
    <div class="or"><span>or use email</span></div>
    ${login ? '' : `<label>Cafe name<input id="a_cafe" required placeholder="e.g. Brew House" autocomplete="organization"></label>`}
    <label>Email<input id="a_email" type="email" autocomplete="email" required></label>
    <label>Password${login ? '' : ' (at least 6 characters)'}<input id="a_pass" type="password" minlength="6" required autocomplete="${login ? 'current-password' : 'new-password'}"></label>
    <button id="a_btn" class="btn wide" type="submit">${login ? 'Log in' : 'Create account'}</button>
    ${login ? `<p class="center"><a href="#" onclick="forgot();return false">Forgot password?</a></p>` : ''}
    <p class="muted center">${login
      ? `New here? <a href="#" onclick="switchAuth('signup');return false">Create an account</a>`
      : `Already have an account? <a href="#" onclick="switchAuth('login');return false">Log in</a>`}</p>
    <p class="muted center small">By continuing you agree to our <a href="terms.html">Terms</a> and <a href="privacy.html">Privacy Policy</a>.</p>
  </form>`;
  setupGoogle();
}
function switchAuth(mode) { authMode = mode; showLogin(); }

// Turn Supabase's error messages into plain ones
function friendly(m) {
  if (/invalid login/i.test(m)) return 'Wrong email or password.';
  if (/already registered/i.test(m)) return 'This email already has an account. Log in instead.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox), then log in.';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Please wait a few minutes and try again.';
  return m;
}
async function doAuth(ev) {
  ev.preventDefault();
  const email = $('#a_email').value.trim(), password = $('#a_pass').value;
  const btn = $('#a_btn');
  btn.disabled = true;
  const res = authMode === 'login'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password, options: { data: { cafe_name: $('#a_cafe').value.trim() }, emailRedirectTo: appUrl() } });
  btn.disabled = false;
  if (res.error) return alert(friendly(res.error.message));
  if (!res.data.session) { // "Confirm email" is switched on in Supabase
    authMode = 'login';
    return showLogin('✅ Account created. Open the confirmation email, then log in here.');
  }
  afterLogin();
}

// Forgot password: Supabase emails a link that opens this page with a "set new password" form
async function forgot() {
  const email = $('#a_email').value.trim();
  if (!email) return alert('Type your email in the Email box first, then tap "Forgot password?" again.');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) return alert(friendly(error.message));
  showLogin('✅ If that email has an account, a reset link is on its way. Open it on this device.');
}
function showNewPassword() {
  if ($('#n_pass')) return; // already showing
  document.body.classList.add('out');
  if ($('#dlg').open) closeDlg();
  $('#app').innerHTML = `<form class="card auth" onsubmit="saveNewPassword(event)">
    <h2>Set a new password</h2>
    <label>New password (at least 6 characters)<input id="n_pass" type="password" minlength="6" required autocomplete="new-password"></label>
    <button id="n_btn" class="btn wide" type="submit">Save password</button>
  </form>`;
}
async function saveNewPassword(ev) {
  ev.preventDefault();
  const btn = $('#n_btn');
  btn.disabled = true;
  const { error } = await sb.auth.updateUser({ password: $('#n_pass').value });
  if (error) { btn.disabled = false; return alert(friendly(error.message) + '\n\nIf the link has expired, ask for a new one with "Forgot password?".'); }
  recovering = false;
  history.replaceState(null, '', appUrl());
  afterLogin();
}

// First Google login (or an older account): name the cafe once
function showSetup(user) {
  document.body.classList.add('out');
  $('#app').innerHTML = `<div class="card auth">
    <h2>Welcome! What's your cafe called?</h2>
    <p class="muted">Logged in as ${esc(user.email)}</p>
    <label>Cafe name<input id="c_name" placeholder="e.g. Brew House"></label>
    <button class="btn wide" onclick="makeCafe(this)">Continue</button>
    <p class="center"><a href="#" onclick="logout();return false">Log out</a></p>
  </div>`;
}
async function makeCafe(btn) {
  const name = $('#c_name').value.trim();
  if (!name) return alert('Enter your cafe name.');
  btn.disabled = true;
  const { error } = await sb.rpc('create_cafe', { p_name: name });
  if (error) { btn.disabled = false; return alert(error.message); }
  afterLogin();
}

// Account window (👤): rename the cafe, log out
function account() {
  if (!ME) return;
  openDlg(`<h2>Account</h2>
    <p class="muted">Logged in as ${esc(ME.user.email)}</p>
    <label>Cafe name<input id="acc_name" value="${esc(ME.cafe.name)}"></label>
    <div class="row">
      <button class="btn" onclick="renameCafe(this)">Save name</button>
      <button class="btn red" onclick="logout()">Log out</button>
      <button class="btn ghost" onclick="closeDlg()">Close</button>
    </div>`);
}
async function renameCafe(btn) {
  const name = $('#acc_name').value.trim();
  if (!name) return alert('Enter a cafe name.');
  btn.disabled = true;
  const { error } = await sb.from('cafes').update({ name }).eq('id', ME.cafe.id);
  btn.disabled = false;
  if (error) return alert(error.message);
  ME.cafe.name = name;
  $('#cafeName').textContent = name;
  closeDlg();
}
async function logout() {
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  await sb.auth.signOut();
  authMode = 'login';
  showLogin();
}

init();
