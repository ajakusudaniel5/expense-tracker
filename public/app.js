const state = {
  user: null,
  categories: [],
  overview: null,
  token: localStorage.getItem('tracker_token') || '',
  tab: 'home',
  txFilter: 'all',
  txCategory: '',
  editing: null,
};

const CAT_COLORS = ['#7c6cf0', '#34d399', '#ff6b7a', '#fbbf24', '#60a5fa', '#f472b6', '#a3e635', '#22d3ee', '#fb923c', '#c084fc'];

const CURRENCIES = [
  ['GH₵', 'Ghana Cedi (GH₵)'],
  ['$', 'US Dollar ($)'],
  ['₦', 'Nigerian Naira (₦)'],
  ['KSh', 'Kenyan Shilling (KSh)'],
  ['R', 'South African Rand (R)'],
  ['£', 'British Pound (£)'],
  ['€', 'Euro (€)'],
];

const $ = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function catColor(id) {
  return CAT_COLORS[Number(id) % CAT_COLORS.length];
}

function money(n) {
  const sym = (state.user && state.user.currency) || 'GH₵';
  return sym + Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem('tracker_token');
    showAuth();
    throw new Error('You need to log in');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Something went wrong');
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ---------------- Toasts ---------------- */

function showToast(message, type = 'warn') {
  const root = $('#toast-root');
  const toast = document.createElement('div');
  const icon = type === 'danger' ? '🚨' : type === 'good' ? '🎉' : '⚠️';
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" aria-label="Dismiss">&times;</button>`;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  root.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

/* ---------------- Auth ---------------- */

function showAuth() {
  $('#app').style.display = 'none';
  $('#auth-screen').style.display = 'flex';
  $('#auth-msg').style.display = 'none';
}

function showApp() {
  $('#auth-screen').style.display = 'none';
  $('#onboarding-screen').style.display = 'none';
  $('#app').style.display = 'block';
  setAvatar();
}

function setAuthMode(mode) {
  const isSignup = mode === 'signup';
  $('#auth-name-field').style.display = isSignup ? 'block' : 'none';
  $('#auth-submit').textContent = isSignup ? 'Create account' : 'Log in';
  $('#auth-password').autocomplete = isSignup ? 'new-password' : 'current-password';
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.auth === mode));
}

async function submitAuth(e) {
  e.preventDefault();
  const mode = document.querySelector('.auth-tab.active').dataset.auth;
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const name = $('#auth-name').value.trim();
  const msg = $('#auth-msg');
  msg.style.display = 'none';
  const body = mode === 'signup' ? { email, password, name } : { email, password };
  try {
    const res = await api(`/api/auth/${mode === 'signup' ? 'register' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.token = res.token;
    localStorage.setItem('tracker_token', res.token);
    state.user = res.user;
    showApp();
    if (!res.user.onboarded) showOnboarding();
    else {
      switchTab('home');
      loadHome();
    }
  } catch (err) {
    msg.textContent = err.message;
    msg.style.display = 'block';
  }
}

function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = '';
  localStorage.removeItem('tracker_token');
  state.user = null;
  showAuth();
}

/* ---------------- Onboarding ---------------- */

let onboardStep = 0;
let onboardAnswers = {};

const ONBOARD_STEPS = [
  {
    title: 'What do you usually use the app for?',
    sub: 'This helps us set things up the right way.',
    key: 'income_type',
    options: ['Allowance', 'Salary', 'Freelance income', 'Other'],
  },
  {
    title: 'How often do you usually receive money?',
    sub: 'We’ll use this to make budgeting feel natural.',
    key: 'income_frequency',
    options: ['Weekly', 'Monthly', 'Irregularly'],
  },
];

function showOnboarding() {
  $('#app').style.display = 'none';
  $('#onboarding-screen').style.display = 'flex';
  onboardStep = 0;
  onboardAnswers = {};
  renderOnboardStep();
}

function renderOnboardStep() {
  const step = ONBOARD_STEPS[onboardStep];
  $('#onboard-title').textContent = step.title;
  $('#onboard-sub').textContent = step.sub;
  const box = $('#onboard-options');
  box.innerHTML = '';
  for (const opt of step.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'onboard-opt' + (onboardAnswers[step.key] === opt ? ' selected' : '');
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      onboardAnswers[step.key] = opt;
      renderOnboardStep();
    });
    box.appendChild(btn);
  }
  $('#onboard-next').textContent = onboardStep === ONBOARD_STEPS.length - 1 ? 'Finish' : 'Next';
}

async function finishOnboarding() {
  try {
    const res = await api('/api/onboarding', {
      method: 'PUT',
      body: JSON.stringify({
        income_type: onboardAnswers.income_type || '',
        income_frequency: onboardAnswers.income_frequency || '',
        onboarded: true,
      }),
    });
    state.user = res.user;
    showApp();
    switchTab('home');
    loadHome();
    showToast('Welcome! Let’s get your money set up. 🎉', 'good');
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

/* ---------------- Router ---------------- */

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.bn-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const page = $(`#page-${name}`);
  if (page) page.classList.add('active');
  window.scrollTo(0, 0);
  if (name === 'home') loadHome();
  else if (name === 'transactions') loadTransactions();
  else if (name === 'budget') loadBudget();
  else if (name === 'insights') loadInsights();
  else if (name === 'settings') loadSettings();
}

function setAvatar() {
  const name = (state.user && state.user.name) || (state.user && state.user.email) || '?';
  $('#avatar-btn').textContent = name.charAt(0).toUpperCase();
}

/* ---------------- Home / Dashboard ---------------- */

async function loadHome() {
  const page = $('#page-home');
  page.innerHTML = '<div class="empty">Loading…</div>';
  try {
    state.overview = await api('/api/overview');
  } catch (err) {
    page.innerHTML = `<div class="empty">Could not load your dashboard.</div>`;
    return;
  }
  state.user = state.overview.user;
  setAvatar();
  renderHome(page);
}

function renderHome(page) {
  const o = state.overview;
  page.innerHTML = '';

  const hero = document.createElement('div');
  const tone = o.status ? o.status.tone : 'none';
  hero.className = `status-hero status-${tone}`;
  if (o.period) {
    hero.innerHTML = `
      <div class="hero-tone">${tone === 'green' ? '🟢' : tone === 'yellow' ? '🟡' : '🔴'}</div>
      <div class="hero-title">${escapeHtml(o.status.title)}</div>
      <div class="hero-msg">${escapeHtml(o.status.message)}</div>
    `;
  } else if (o.hasTransactions) {
    hero.innerHTML = `
      <div class="hero-tone">🎯</div>
      <div class="hero-title">Set a budget period to plan your spending.</div>
      <div class="hero-msg">Add your most recent income and pick how long it should last.</div>
      <button type="button" class="btn-primary hero-cta" id="hero-add-income">+ Add income</button>
    `;
  } else {
    hero.innerHTML = `
      <div class="hero-tone">🙌</div>
      <div class="hero-title">Let’s get your money under control.</div>
      <div class="hero-msg">Start by adding the money you currently have or recently received.</div>
      <button type="button" class="btn-primary hero-cta" id="hero-add-income">+ Add income</button>
    `;
  }
  page.appendChild(hero);

  const chips = document.createElement('div');
  chips.className = 'summary-chips';
  const chip = (label, value, cls) => `<div class="chip-card ${cls}"><span class="cc-label">${label}</span><span class="cc-value">${value}</span></div>`;
  if (o.period) {
    chips.innerHTML =
      chip('Money available', money(o.moneyAvailable), 'ok') +
      chip('Income', money(o.totalIncome), 'income') +
      chip('Spent', money(o.totalExpense), 'expense') +
      chip('Days left', o.daysRemaining, '');
  } else if (o.hasTransactions) {
    chips.innerHTML =
      chip('Income', money(o.totalIncome), 'income') +
      chip('Spent', money(o.totalExpense), 'expense') +
      chip('Budget period', 'Not set', '');
  }
  page.appendChild(chips);

  const actions = document.createElement('div');
  actions.className = 'quick-actions';
  actions.innerHTML = `
    <button type="button" class="qa-btn qa-expense" id="qa-expense">+ Add expense</button>
    <button type="button" class="qa-btn qa-income" id="qa-income">+ Add income</button>
  `;
  page.appendChild(actions);

  if (o.period) {
    const glance = document.createElement('div');
    glance.className = 'card section-card';
    const budgets = o.budget.categories;
    let inner = `<div class="section-head"><h2>Budget at a glance</h2><a href="#" data-nav="budget">Manage →</a></div>`;
    if (!budgets.length) {
      inner += `<div class="empty">No category budgets yet. Give your money a purpose. <a href="#" data-nav="budget">Set budgets →</a></div>`;
    } else {
      inner += `<div class="glance-list">`;
      for (const b of budgets.slice(0, 4)) {
        const color = catColor(b.category_id);
        inner += `
          <div class="glance-item">
            <span class="cat-ic" style="background:${color}22">${escapeHtml(b.icon)}</span>
            <div class="glance-main">
              <div class="glance-top"><span class="glance-name">${escapeHtml(b.name)}</span><span class="glance-val">${money(b.spent)} / ${money(b.amount)}</span></div>
              <div class="bar"><div class="fill ${b.status}" style="width:${Math.min(100, b.pct)}%;background:${b.status === 'over' ? '#ff6b7a' : b.status === 'close' ? '#fbbf24' : color}"></div></div>
            </div>
            <span class="status-dot status-${b.status}" title="${b.status}"></span>
          </div>`;
      }
      inner += `</div>`;
      if (budgets.length > 4) inner += `<p class="muted link-more"><a href="#" data-nav="budget">See all ${budgets.length} budgets →</a></p>`;
    }
    glance.innerHTML = inner;
    page.appendChild(glance);
  }

  const insights = document.createElement('div');
  insights.className = 'card section-card';
  insights.innerHTML = `<div class="section-head"><h2>Your money, in plain words</h2><a href="#" data-nav="insights">View all →</a></div><div class="insight-teaser" id="home-insights"><div class="empty">Loading…</div></div>`;
  page.appendChild(insights);
  loadInsightTeasers();

  page.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab(el.dataset.nav);
  }));
  const qe = page.querySelector('#qa-expense');
  if (qe) qe.addEventListener('click', () => openExpenseModal());
  const qi = page.querySelector('#qa-income');
  if (qi) qi.addEventListener('click', () => openIncomeModal());
  const hci = page.querySelector('#hero-add-income');
  if (hci) hci.addEventListener('click', () => openIncomeModal());
}

async function loadInsightTeasers() {
  const box = $('#home-insights');
  if (!box) return;
  try {
    const list = await api('/api/insights');
    if (!list.length) {
      box.innerHTML = `<div class="empty">Your insights are coming. Keep adding income and expenses and we’ll start finding useful patterns.</div>`;
      return;
    }
    box.innerHTML = list.slice(0, 3).map((i) => `
      <div class="insight-row tone-${i.tone}"><span class="insight-ic">${escapeHtml(i.icon)}</span><span>${escapeHtml(i.text)}</span></div>
    `).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">Could not load insights.</div>`;
  }
}

/* ---------------- Transactions ---------------- */

let allTx = [];

async function loadTransactions() {
  const page = $('#page-transactions');
  page.innerHTML = '<div class="empty">Loading…</div>';
  try {
    allTx = await api('/api/transactions');
  } catch (err) {
    page.innerHTML = `<div class="empty">Could not load transactions.</div>`;
    return;
  }
  renderTransactions(page);
}

function renderTransactions(page) {
  page.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<h2>Transactions</h2>`;
  page.appendChild(head);

  const cats = state.categories.length ? state.categories : state.overview ? state.overview.categories : [];
  const expenseCats = cats.filter((c) => c.type === 'expense');

  const filters = document.createElement('div');
  filters.className = 'tx-filters';
  filters.innerHTML = `
    <div class="chip-row">
      <button type="button" class="chip ${state.txFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>
      <button type="button" class="chip ${state.txFilter === 'income' ? 'active' : ''}" data-filter="income">Income</button>
      <button type="button" class="chip ${state.txFilter === 'expense' ? 'active' : ''}" data-filter="expense">Expenses</button>
    </div>
    <select id="tx-cat-filter" class="cat-filter">
      <option value="">All categories</option>
      ${expenseCats.map((c) => `<option value="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`).join('')}
    </select>
  `;
  filters.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.txFilter = b.dataset.filter;
    renderTransactions(page);
  }));
  const catSel = filters.querySelector('#tx-cat-filter');
  catSel.value = state.txCategory;
  catSel.addEventListener('change', () => {
    state.txCategory = catSel.value;
    renderTransactions(page);
  });
  page.appendChild(filters);

  let list = allTx;
  if (state.txFilter === 'income') list = list.filter((t) => t.type === 'income');
  else if (state.txFilter === 'expense') list = list.filter((t) => t.type === 'expense');
  if (state.txCategory) list = list.filter((t) => String(t.category_id) === String(state.txCategory));

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<p>No transactions yet.</p><p>Add your first income or expense to start tracking your money.</p>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    btn.textContent = '+ Add transaction';
    btn.style.marginTop = '14px';
    btn.addEventListener('click', openTxTypeModal);
    empty.appendChild(btn);
    page.appendChild(empty);
    return;
  }

  const listEl = document.createElement('div');
  listEl.className = 'tx-list';
  for (const t of list) {
    const color = t.category_id ? catColor(t.category_id) : (t.type === 'income' ? '#34d399' : '#ff6b7a');
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <span class="icon" style="background:${color}22">${escapeHtml(t.category_icon) || (t.type === 'income' ? '💵' : '💸')}</span>
      <div class="info">
        <div class="name">${escapeHtml(t.category_name) || (t.type === 'income' ? 'Income' : 'Expense')}${t.note ? ' — ' + escapeHtml(t.note) : ''}</div>
        <div class="meta">${t.date}</div>
      </div>
      <div class="tx-actions">
        <span class="amount ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span>
        <button class="icon-btn sm" data-edit="${t.id}" title="Edit">✏️</button>
        <button class="icon-btn sm danger" data-del="${t.id}" title="Delete">&times;</button>
      </div>
    `;
    item.querySelector('[data-del]').addEventListener('click', () => deleteTransaction(t));
    item.querySelector('[data-edit]').addEventListener('click', () => editTransaction(t));
    listEl.appendChild(item);
  }
  page.appendChild(listEl);
}

async function deleteTransaction(t) {
  if (!confirm(`Delete this ${t.type} of ${money(t.amount)}?`)) return;
  try {
    await api(`/api/transactions/${t.id}`, { method: 'DELETE' });
    state.overview = null;
    showToast('Deleted.', 'good');
    loadTransactions();
    if (state.tab === 'home') loadHome();
    if (state.tab === 'budget') loadBudget();
    if (state.tab === 'insights') loadInsights();
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

function editTransaction(t) {
  if (t.type === 'income') {
    openIncomeModal(t);
  } else {
    state.editing = t;
    openExpenseModal();
  }
}

/* ---------------- Income modal ---------------- */

let incomePeriod = { kind: 'days', days: 7 };

async function categorySource() {
  const src = state.overview ? state.overview.categories : (state.categories.length ? state.categories : null);
  if (src) return src;
  try {
    const cats = await api('/api/categories');
    state.categories = cats;
    return cats;
  } catch (_) {
    return [];
  }
}

async function openIncomeModal(editing) {
  state.editing = editing || null;
  const isEdit = !!editing && editing.type === 'income';
  $('#income-modal h2').textContent = isEdit ? 'Edit income' : 'Add income';
  $('#in-amount').value = isEdit ? editing.amount : '';
  $('#in-date').value = isEdit ? editing.date : todayStr();
  $('#in-note').value = isEdit ? editing.note || '' : '';
  $('#in-end-date').style.display = 'none';
  incomePeriod = { kind: 'days', days: 7 };
  const cats = await categorySource();
  const sel = $('#in-source');
  sel.innerHTML = cats
    .filter((c) => c.type === 'income')
    .map((c) => `<option value="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`).join('');
  if (isEdit && editing.category_id) sel.value = String(editing.category_id);
  renderIncomeChips();
  $('#income-modal').style.display = 'flex';
  $('#in-amount').focus();
}

function renderIncomeChips() {
  document.querySelectorAll('#in-period-chips .chip').forEach((chip) => {
    const days = Number(chip.dataset.days);
    const active =
      (incomePeriod.kind === 'days' && incomePeriod.days === days) ||
      (incomePeriod.kind === 'date' && days === 0) ||
      (incomePeriod.kind === 'none' && days === -1);
    chip.classList.toggle('active', active);
  });
  $('#in-end-date').style.display = incomePeriod.kind === 'date' ? 'block' : 'none';
}

async function submitIncome(e) {
  e.preventDefault();
  const msg = $('#income-msg');
  msg.style.display = 'none';
  const amount = parseFloat($('#in-amount').value);
  const date = $('#in-date').value;
  const catVal = $('#in-source').value;
  const category_id = catVal ? Number(catVal) : null;
  if (!amount || amount <= 0) { msg.textContent = 'Please enter an amount.'; msg.style.display = 'block'; return; }

  const editing = state.editing && state.editing.type === 'income';
  if (editing) {
    try {
      await api(`/api/transactions/${state.editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ amount, date, category_id, type: 'income', note: $('#in-note').value.trim() || null }),
      });
      closeModal('income-modal');
      showToast('Income updated.', 'good');
      state.overview = null;
      loadHome();
      if (state.tab === 'budget') loadBudget();
      if (state.tab === 'transactions') loadTransactions();
      if (state.tab === 'insights') loadInsights();
    } catch (err) {
      msg.textContent = err.message;
      msg.style.display = 'block';
    }
    return;
  }

  const body = { amount, date, category_id, note: $('#in-note').value.trim() || null };
  if (incomePeriod.kind === 'days' && incomePeriod.days > 0) body.period_days = incomePeriod.days;
  else if (incomePeriod.kind === 'date') {
    const end = $('#in-end-date').value;
    if (!end || end <= date) { msg.textContent = 'Choose a date after the income date'; msg.style.display = 'block'; return; }
    body.end_date = end;
  }
  try {
    const res = await api('/api/income', { method: 'POST', body: JSON.stringify(body) });
    closeModal('income-modal');
    showToast(res.period ? 'Income added. Your money now has a plan! 🎯' : 'Income added.', 'good');
    state.overview = null;
    loadHome();
    if (state.tab === 'budget') loadBudget();
    if (state.tab === 'transactions') loadTransactions();
    if (state.tab === 'insights') loadInsights();
  } catch (err) {
    msg.textContent = err.message;
    msg.style.display = 'block';
  }
}

/* ---------------- Expense modal ---------------- */

function openTxTypeModal() {
  state.editing = null;
  $('#tx-type-modal').style.display = 'flex';
}

async function openExpenseModal() {
  const editing = state.editing && state.editing.type === 'expense' ? state.editing : null;
  $('#ex-amount').value = editing ? editing.amount : '';
  $('#ex-category').value = editing ? String(editing.category_id || '') : '';
  $('#ex-date').value = editing ? editing.date : todayStr();
  $('#ex-note').value = editing ? editing.note || '' : '';
  const cats = (await categorySource()).filter((c) => c.type === 'expense');
  const sel = $('#ex-category');
  sel.innerHTML = cats.map((c) => `<option value="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</option>`).join('');
  if (editing && !sel.value && cats.length) sel.value = String(editing.category_id);
  $('#expense-modal').style.display = 'flex';
  $('#ex-amount').focus();
}

async function submitExpense(e) {
  e.preventDefault();
  const msg = $('#expense-msg');
  msg.style.display = 'none';
  const amount = parseFloat($('#ex-amount').value);
  const category_id = Number($('#ex-category').value);
  const date = $('#ex-date').value;
  const note = $('#ex-note').value.trim() || null;
  if (!amount || amount <= 0) { msg.textContent = 'Please enter an amount.'; msg.style.display = 'block'; return; }
  if (!category_id) { msg.textContent = 'Please select a category.'; msg.style.display = 'block'; return; }
  const body = { amount, category_id, date, note };
  const editing = state.editing && state.editing.type === 'expense';
  try {
    if (editing) await api(`/api/transactions/${state.editing.id}`, { method: 'PUT', body: JSON.stringify({ ...body, type: 'expense' }) });
    else await api('/api/transactions', { method: 'POST', body: JSON.stringify({ ...body, type: 'expense' }) });
    state.editing = null;
    closeModal('expense-modal');
    showToast('Expense added.', 'good');
    loadHome();
    if (state.tab === 'transactions') loadTransactions();
    if (state.tab === 'budget') loadBudget();
    if (state.tab === 'insights') loadInsights();
  } catch (err) {
    msg.textContent = err.message;
    msg.style.display = 'block';
  }
}

function closeModal(id) {
  $(`#${id}`).style.display = 'none';
  state.editing = null;
}

/* ---------------- Budget page ---------------- */

async function loadBudget() {
  const page = $('#page-budget');
  page.innerHTML = '<div class="empty">Loading…</div>';
  if (!state.overview || !state.overview.period) {
    state.overview = await api('/api/overview');
  }
  renderBudget(page);
}

function renderBudget(page) {
  page.innerHTML = '';
  const o = state.overview;
  const period = o.period;

  if (!period) {
    page.innerHTML = `
      <div class="page-head"><h2>Budget</h2></div>
      <div class="card section-card">
        <div class="empty">
          <p class="empty-title">Give your money a plan.</p>
          <p>Set how long your money needs to last and create your first budget.</p>
          <button type="button" class="btn-primary" id="budget-create" style="margin-top:14px">Create budget</button>
        </div>
      </div>
    `;
    page.querySelector('#budget-create').addEventListener('click', () => openIncomeModal());
    return;
  }

  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<h2>Budget</h2>`;
  page.appendChild(head);

  const summary = document.createElement('div');
  summary.className = 'card section-card';
  const b = o.budget;
  const unbudgeted = Math.max(0, period.amount - b.totalBudgeted);
  summary.innerHTML = `
    <div class="section-head"><h2>${money(period.amount)} for this period</h2></div>
    <div class="budget-summary-grid">
      <div class="bs-item"><span class="label">Budgeted</span><span class="value">${money(b.totalBudgeted)}</span></div>
      <div class="bs-item"><span class="label">Unbudgeted</span><span class="value ok">${money(unbudgeted)}</span></div>
      <div class="bs-item"><span class="label">Spent</span><span class="value ${o.totalExpense > 0 ? 'expense' : ''}">${money(o.totalExpense)}</span></div>
      <div class="bs-item"><span class="label">Remaining</span><span class="value ${o.moneyAvailable >= 0 ? 'ok' : 'expense'}">${money(o.moneyAvailable)}</span></div>
    </div>
    <div class="alloc-bar"><div class="alloc-fill" style="width:${period.amount > 0 ? Math.min(100, (b.totalBudgeted / period.amount) * 100) : 0}%"></div></div>
    <div class="alloc-caption muted">${b.totalBudgeted >= period.amount ? '100% of your money has a purpose' : `${money(unbudgeted)} still needs a purpose.`}</div>
  `;
  page.appendChild(summary);

  const addCard = document.createElement('div');
  addCard.className = 'card section-card';
  addCard.innerHTML = `
    <div class="section-head"><h2>Set a category budget</h2></div>
    <div class="budget-form">
      <div class="field"><label>Category</label><select id="budget-cat"></select></div>
      <div class="field"><label>Amount</label><input type="number" id="budget-amount" step="0.01" min="0.01" placeholder="0.00"></div>
      <button type="button" class="btn-primary" id="budget-add">Set budget</button>
    </div>
    <p class="form-error" id="budget-msg" style="display:none"></p>
  `;
  const catSel = addCard.querySelector('#budget-cat');
  const budgetedIds = new Set(b.categories.map((c) => String(c.category_id)));
  catSel.innerHTML = (state.overview.categories || [])
    .filter((c) => c.type === 'expense')
    .map((c) => `<option value="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}${budgetedIds.has(String(c.id)) ? ' (set)' : ''}</option>`).join('');
  addCard.querySelector('#budget-add').addEventListener('click', async () => {
    const catId = Number(catSel.value);
    const amount = parseFloat(addCard.querySelector('#budget-amount').value);
    const msgEl = addCard.querySelector('#budget-msg');
    msgEl.style.display = 'none';
    if (!catId || !amount || amount <= 0) { msgEl.textContent = 'Choose a category and enter an amount'; msgEl.style.display = 'block'; return; }
    try {
      await api('/api/budgets', {
        method: 'POST',
        body: JSON.stringify({ category_id: catId, budget_period_id: period.id, amount }),
      });
      showToast('Budget set.', 'good');
      state.overview = null;
      loadBudget();
      loadHome();
    } catch (err) {
      msgEl.textContent = err.message;
      msgEl.style.display = 'block';
    }
  });
  page.appendChild(addCard);

  const listCard = document.createElement('div');
  listCard.className = 'card section-card';
  listCard.innerHTML = `<div class="section-head"><h2>Category budgets</h2></div>`;
  const list = document.createElement('div');
  list.className = 'budget-list';
  if (!b.categories.length) {
    list.innerHTML = `<div class="empty">No budgets yet. Start with your biggest categories like Food and Transport.</div>`;
  } else {
    for (const cb of b.categories) {
      const color = catColor(cb.category_id);
      const row = document.createElement('div');
      row.className = 'budget-row';
      row.innerHTML = `
        <span class="cat-ic" style="background:${color}22">${escapeHtml(cb.icon)}</span>
        <div class="budget-row-main">
          <div class="glance-top"><span class="glance-name">${escapeHtml(cb.name)}</span><span class="glance-val">${money(cb.spent)} / ${money(cb.amount)}</span></div>
          <div class="bar"><div class="fill ${cb.status}" style="width:${Math.min(100, cb.pct)}%;background:${cb.status === 'over' ? '#ff6b7a' : cb.status === 'close' ? '#fbbf24' : color}"></div></div>
          <div class="budget-sub">
            <span class="status-chip status-${cb.status}">${cb.status === 'safe' ? '🟢 On track' : cb.status === 'close' ? '🟡 Getting close' : '🔴 Over budget'}</span>
            <span class="muted">${cb.remaining >= 0 ? money(cb.remaining) + ' left' : money(Math.abs(cb.remaining)) + ' over'}</span>
          </div>
        </div>
        <div class="budget-row-actions">
          <button class="icon-btn sm" data-edit-budget="${cb.id}" title="Edit">✏️</button>
          <button class="icon-btn sm danger" data-del-budget="${cb.id}" title="Remove">&times;</button>
        </div>
      `;
      row.querySelector('[data-del-budget]').addEventListener('click', async () => {
        if (!confirm(`Remove the ${cb.name} budget?`)) return;
        await api(`/api/budgets/${cb.id}`, { method: 'DELETE' });
        showToast('Budget removed.', 'good');
        state.overview = null;
        loadBudget();
        loadHome();
      });
      row.querySelector('[data-edit-budget]').addEventListener('click', () => {
        const valEl = row.querySelector('.glance-val');
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.01';
        input.min = '0.01';
        input.value = cb.amount;
        input.className = 'limit-edit';
        valEl.replaceWith(input);
        let cancelled = false;
        input.focus();
        input.select();
        const save = async () => {
          if (cancelled) return;
          const next = parseFloat(input.value);
          if (!next || next <= 0) { input.replaceWith(valEl); return; }
          try {
            await api('/api/budgets', {
              method: 'POST',
              body: JSON.stringify({ category_id: cb.category_id, budget_period_id: period.id, amount: next }),
            });
            showToast('Budget updated.', 'good');
            state.overview = null;
            loadBudget();
            loadHome();
          } catch (err) {
            showToast(err.message, 'danger');
            loadBudget();
          }
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
        });
        input.addEventListener('blur', async () => {
          if (cancelled) {
            input.replaceWith(valEl);
            return;
          }
          await save();
        });
      });
      list.appendChild(row);
    }
  }
  listCard.appendChild(list);
  page.appendChild(listCard);
}

/* ---------------- Insights & Reports ---------------- */

async function loadInsights() {
  const page = $('#page-insights');
  page.innerHTML = '<div class="empty">Loading…</div>';
  let insights = [];
  let tx = [];
  try {
    [insights, tx] = await Promise.all([api('/api/insights'), api('/api/transactions')]);
  } catch (err) {
    page.innerHTML = `<div class="empty">Could not load insights.</div>`;
    return;
  }
  page.innerHTML = '';
  page.appendChild(pageHead('Insights'));
  const insightCard = document.createElement('div');
  insightCard.className = 'card section-card';
  insightCard.innerHTML = `<div class="section-head"><h2>What’s going on with your money</h2></div>`;
  if (!insights.length) {
    insightCard.innerHTML += `<div class="empty"><p class="empty-title">Your insights are coming.</p><p>Keep adding income and expenses and we’ll start finding useful patterns.</p></div>`;
  } else {
    const list = document.createElement('div');
    list.className = 'insight-list';
    for (const i of insights) {
      const row = document.createElement('div');
      row.className = `insight-row tone-${i.tone}`;
      row.innerHTML = `<span class="insight-ic">${escapeHtml(i.icon)}</span><span>${escapeHtml(i.text)}</span>`;
      list.appendChild(row);
    }
    insightCard.appendChild(list);
  }
  page.appendChild(insightCard);
  renderReports(page, tx);
}

function pageHead(title) {
  const head = document.createElement('div');
  head.className = 'page-head';
  head.innerHTML = `<h2>${title}</h2>`;
  return head;
}

function renderReports(page, allTx) {
  const reportsCard = document.createElement('div');
  reportsCard.className = 'card section-card';
  reportsCard.innerHTML = `<div class="section-head"><h2>Reports</h2></div>`;

  if (!allTx.length) {
    reportsCard.innerHTML += `<div class="empty">No data yet. Add transactions to see reports.</div>`;
    page.appendChild(reportsCard);
    return;
  }

  const { monthly, byCategory } = summarize(allTx);
  reportsCard.appendChild(renderTrend(monthly));
  reportsCard.appendChild(renderTopCategories(byCategory));
  reportsCard.appendChild(renderDonut(byCategory));
  page.appendChild(reportsCard);
}

function summarize(allTx) {
  const monthly = {};
  const byCategory = {};
  for (const t of allTx) {
    const m = t.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = { income: 0, expense: 0 };
    if (t.type === 'income') monthly[m].income += t.amount;
    else monthly[m].expense += t.amount;
    if (t.type === 'expense') {
      const key = t.category_id ? t.category_id : 0;
      if (!byCategory[key]) {
        byCategory[key] = { name: t.category_name || 'Uncategorized', icon: t.category_icon || '💸', amount: 0 };
      }
      byCategory[key].amount += t.amount;
    }
  }
  return { monthly, byCategory };
}

function renderTrend(monthly) {
  const months = Object.keys(monthly).sort();
  const section = document.createElement('div');
  section.className = 'report-block';
  const title = document.createElement('h3');
  title.textContent = 'Income vs expenses over time';
  section.appendChild(title);

  const max = Math.max(1, ...months.map((m) => Math.max(monthly[m].income, monthly[m].expense)));
  const chart = document.createElement('div');
  chart.className = 'trend-chart';
  for (const m of months) {
    const col = document.createElement('div');
    col.className = 'trend-col';
    const label = document.createElement('div');
    label.className = 'trend-label';
    label.textContent = m;
    const bars = document.createElement('div');
    bars.className = 'trend-bars';
    const inc = document.createElement('div');
    inc.className = 'trend-bar income';
    inc.style.height = `${Math.round((monthly[m].income / max) * 100)}%`;
    inc.title = `Income ${money(monthly[m].income)}`;
    const exp = document.createElement('div');
    exp.className = 'trend-bar expense';
    exp.style.height = `${Math.round((monthly[m].expense / max) * 100)}%`;
    exp.title = `Expenses ${money(monthly[m].expense)}`;
    bars.appendChild(inc);
    bars.appendChild(exp);
    col.appendChild(bars);
    col.appendChild(label);
    chart.appendChild(col);
  }
  section.appendChild(chart);
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = '<span class="legend-item"><span class="dot income-dot"></span> Income</span><span class="legend-item"><span class="dot expense-dot"></span> Expenses</span>';
  section.appendChild(legend);
  return section;
}

function renderTopCategories(byCategory) {
  const section = document.createElement('div');
  section.className = 'report-block';
  const title = document.createElement('h3');
  title.textContent = 'Where your money goes';
  section.appendChild(title);

  const entries = Object.entries(byCategory).sort((a, b) => b[1].amount - a[1].amount);
  if (!entries.length) {
    section.appendChild(document.createElement('div')).className = 'empty';
    section.lastChild.textContent = 'No expenses yet.';
    return section;
  }
  const total = entries.reduce((sum, [, c]) => sum + c.amount, 0);
  for (const [id, c] of entries.slice(0, 5)) {
    const row = document.createElement('div');
    row.className = 'cat-bar-row';
    const pct = Math.round((c.amount / total) * 100);
    const color = catColor(id);
    row.innerHTML = `
      <span class="cat-bar-icon">${escapeHtml(c.icon)}</span>
      <span class="cat-bar-name">${escapeHtml(c.name)}</span>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="cat-bar-pct">${pct}%</span>
      <span class="cat-bar-amount">${money(c.amount)}</span>
    `;
    section.appendChild(row);
  }
  return section;
}

function renderDonut(byCategory) {
  const section = document.createElement('div');
  section.className = 'report-block';
  const title = document.createElement('h3');
  title.textContent = 'Spending breakdown';
  section.appendChild(title);

  const entries = Object.entries(byCategory).sort((a, b) => b[1].amount - a[1].amount);
  if (!entries.length) {
    section.appendChild(document.createElement('div')).className = 'empty';
    section.lastChild.textContent = 'No expenses yet.';
    return section;
  }
  const total = entries.reduce((sum, [, c]) => sum + c.amount, 0);
  const donut = document.createElement('div');
  donut.className = 'donut';
  donut.style.background = conicGradient(entries);
  donut.innerHTML = `<div class="donut-hole"><strong>${money(total)}</strong><small>Total spent</small></div>`;
  section.appendChild(donut);
  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  for (const [id, c] of entries) {
    const item = document.createElement('div');
    item.className = 'donut-legend-item';
    item.innerHTML = `<span class="dot" style="background:${catColor(id)}"></span> ${escapeHtml(c.name)} <em>${money(c.amount)}</em>`;
    legend.appendChild(item);
  }
  section.appendChild(legend);
  return section;
}

function conicGradient(entries) {
  const total = entries.reduce((sum, [, c]) => sum + c.amount, 0);
  if (!total) return '';
  let acc = 0;
  const parts = entries.map(([id, c]) => {
    const from = (acc / total) * 360;
    acc += c.amount;
    const to = (acc / total) * 360;
    return `${catColor(id)} ${from}deg ${to}deg`;
  });
  return `conic-gradient(${parts.join(', ')})`;
}

/* ---------------- Settings ---------------- */

async function loadSettings() {
  const page = $('#page-settings');
  page.innerHTML = '<div class="empty">Loading…</div>';
  let cats = [];
  try {
    cats = await api('/api/categories');
  } catch (err) { /* ok */ }
  state.categories = cats;
  page.innerHTML = '';
  page.appendChild(pageHead('Profile'));
  page.appendChild(renderProfileCard());
  page.appendChild(renderCategoriesCard(cats));
  page.appendChild(renderAccountCard());
}

function renderProfileCard() {
  const card = document.createElement('div');
  card.className = 'card section-card';
  const cur = (state.user && state.user.currency) || 'GH₵';
  card.innerHTML = `
    <div class="section-head"><h2>Profile details</h2></div>
    <div class="field"><label for="p-name">Name</label><input type="text" id="p-name" value="${escapeHtml((state.user && state.user.name) || '')}" placeholder="Your name"></div>
    <div class="field"><label for="p-email">Email</label><input type="email" id="p-email" value="${escapeHtml((state.user && state.user.email) || '')}" disabled></div>
    <div class="field"><label for="p-currency">Currency</label>
      <select id="p-currency">${CURRENCIES.map(([s, label]) => `<option value="${s}" ${s === cur ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
    </div>
    <button type="button" class="btn-primary" id="p-save">Save profile</button>
    <span id="p-msg" class="muted"></span>
  `;
  card.querySelector('#p-save').addEventListener('click', async () => {
    const msg = card.querySelector('#p-msg');
    msg.textContent = 'Saving…';
    try {
      const res = await api('/api/me', {
        method: 'PUT',
        body: JSON.stringify({ name: card.querySelector('#p-name').value, currency: card.querySelector('#p-currency').value }),
      });
      state.user = res.user;
      msg.textContent = 'Saved.';
      setAvatar();
      state.overview = null;
      loadHome();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  return card;
}

function renderCategoriesCard(cats) {
  const card = document.createElement('div');
  card.className = 'card section-card';
  card.innerHTML = `
    <div class="section-head"><h2>Categories</h2></div>
    <div class="budget-form">
      <div class="field"><label for="c-name">Name</label><input type="text" id="c-name" placeholder="e.g. Shopping"></div>
      <div class="field"><label for="c-type">Type</label><select id="c-type"><option value="expense">Expense</option><option value="income">Income</option></select></div>
      <div class="field"><label for="c-icon">Icon</label><input type="text" id="c-icon" maxlength="4" placeholder="🛍️"></div>
      <button type="button" class="btn-primary" id="c-add">Add</button>
    </div>
    <p class="form-error" id="c-msg" style="display:none"></p>
    <div class="cat-groups" id="cat-groups"></div>
  `;
  card.querySelector('#c-add').addEventListener('click', async () => {
    const name = card.querySelector('#c-name').value.trim();
    const type = card.querySelector('#c-type').value;
    const icon = card.querySelector('#c-icon').value.trim();
    const msg = card.querySelector('#c-msg');
    msg.style.display = 'none';
    if (!name) { msg.textContent = 'Enter a category name'; msg.style.display = 'block'; return; }
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, type, icon: icon || null }) });
      showToast('Category added.', 'good');
      state.overview = null;
      loadSettings();
    } catch (err) {
      msg.textContent = err.message;
      msg.style.display = 'block';
    }
  });
  const groups = card.querySelector('#cat-groups');
  renderCatGroup(groups, 'Expense', cats.filter((c) => c.type === 'expense'));
  renderCatGroup(groups, 'Income', cats.filter((c) => c.type === 'income'));
  return card;
}

function renderCatGroup(container, title, cats) {
  const group = document.createElement('div');
  group.className = 'cat-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  if (!cats.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'None yet.';
    group.appendChild(empty);
    container.appendChild(group);
    return;
  }
  for (const c of cats) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const color = catColor(c.id);
    row.innerHTML = `
      <span class="cat-ic" style="background:${color}22">${escapeHtml(c.icon) || '🏷️'}</span>
      <span class="cat-name">${escapeHtml(c.name)}</span>
      <button class="icon-btn sm" data-edit-cat="${c.id}" title="Edit">✏️</button>
      <button class="icon-btn sm danger" data-del-cat="${c.id}" title="Delete">&times;</button>
    `;
    row.querySelector('[data-del-cat]').addEventListener('click', async () => {
      if (!confirm(`Delete category "${c.name}"?`)) return;
      try {
        await api(`/api/categories/${c.id}`, { method: 'DELETE' });
        showToast('Category deleted.', 'good');
        loadSettings();
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });
    row.querySelector('[data-edit-cat]').addEventListener('click', async () => {
      const name = prompt(`Rename "${c.name}":`, c.name);
      if (name === null) return;
      const icon = prompt('Icon (emoji):', c.icon || '');
      if (icon === null) return;
      try {
        await api(`/api/categories/${c.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim(), icon: icon.trim() || null }),
        });
        showToast('Category updated.', 'good');
        loadSettings();
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });
    group.appendChild(row);
  }
  container.appendChild(group);
}

function renderAccountCard() {
  const card = document.createElement('div');
  card.className = 'card section-card';
  card.innerHTML = `
    <div class="section-head"><h2>Account</h2></div>
    <div class="field"><label for="a-current">Current password</label><input type="password" id="a-current" autocomplete="current-password"></div>
    <div class="field"><label for="a-new">New password (6+ characters)</label><input type="password" id="a-new" autocomplete="new-password"></div>
    <div class="field"><label for="a-confirm">Confirm new password</label><input type="password" id="a-confirm" autocomplete="new-password"></div>
    <button type="button" class="btn-primary" id="a-change">Change password</button>
    <div class="btn-row">
      <button type="button" class="btn-ghost" id="a-logout">Log out</button>
      <button type="button" class="btn-ghost" id="a-lock">Lock app</button>
    </div>
    <p id="a-msg" class="muted"></p>
  `;
  card.querySelector('#a-change').addEventListener('click', async () => {
    const msg = card.querySelector('#a-msg');
    const cur = card.querySelector('#a-current').value;
    const next = card.querySelector('#a-new').value;
    const confirm = card.querySelector('#a-confirm').value;
    msg.textContent = '';
    if (!cur || !next) { msg.textContent = 'Fill in your current and new password.'; return; }
    if (next !== confirm) { msg.textContent = 'New passwords do not match.'; return; }
    try {
      const res = await api('/api/auth/password', { method: 'PUT', body: JSON.stringify({ current_password: cur, new_password: next }) });
      state.token = res.token;
      localStorage.setItem('tracker_token', res.token);
      msg.textContent = 'Password changed.';
      showToast('Password changed.', 'good');
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  card.querySelector('#a-logout').addEventListener('click', logout);
  card.querySelector('#a-lock').addEventListener('click', () => {
    logout();
  });

  const danger = document.createElement('div');
  danger.className = 'card section-card danger-zone';
  danger.innerHTML = `
    <div class="section-head"><h2>Delete account</h2></div>
    <p class="muted">This permanently removes all your transactions, budgets, categories, and settings. This cannot be undone.</p>
    <div class="field"><label for="a-del-password">Confirm with your current password</label><input type="password" id="a-del-password" autocomplete="current-password"></div>
    <button type="button" class="btn-danger" id="a-delete">Delete account</button>
    <p id="a-del-msg" class="muted"></p>
  `;
  danger.querySelector('#a-delete').addEventListener('click', async () => {
    const msg = danger.querySelector('#a-del-msg');
    const pw = danger.querySelector('#a-del-password').value;
    msg.textContent = '';
    if (!pw) { msg.textContent = 'Enter your password to confirm.'; return; }
    if (!confirm('Delete your account and all your data? This cannot be undone.')) return;
    try {
      await api('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ password: pw }) });
      state.token = '';
      localStorage.removeItem('tracker_token');
      showToast('Account deleted.', 'good');
      showAuth();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  card.appendChild(danger);
  return card;
}

/* ---------------- Init ---------------- */

function wireModals() {
  $('#fab').addEventListener('click', () => openTxTypeModal());
  $('#tx-type-income').addEventListener('click', () => { closeModal('tx-type-modal'); openIncomeModal(); });
  $('#tx-type-expense').addEventListener('click', () => { closeModal('tx-type-modal'); openExpenseModal(); });
  document.querySelectorAll('.modal-close').forEach((b) =>
    b.addEventListener('click', () => closeModal(b.dataset.close))
  );
  document.querySelectorAll('.modal').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); })
  );

  $('#income-form').addEventListener('submit', submitIncome);
  $('#expense-form').addEventListener('submit', submitExpense);

  $('#in-period-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const days = Number(chip.dataset.days);
    if (days === 0) incomePeriod = { kind: 'date' };
    else if (days === -1) incomePeriod = { kind: 'none' };
    else incomePeriod = { kind: 'days', days };
    renderIncomeChips();
  });
  const endDate = $('#in-end-date');
  endDate.min = todayStr();
}

function wireNav() {
  document.querySelectorAll('.tab, .bn-item').forEach((el) =>
    el.addEventListener('click', () => switchTab(el.dataset.tab))
  );
  $('#avatar-btn').addEventListener('click', () => switchTab('settings'));
  $('#lock-btn').addEventListener('click', () => logout());
  document.querySelectorAll('.auth-tab').forEach((t) =>
    t.addEventListener('click', () => setAuthMode(t.dataset.auth))
  );
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#onboard-skip').addEventListener('click', finishOnboarding);
  $('#onboard-next').addEventListener('click', () => {
    const step = ONBOARD_STEPS[onboardStep];
    if (!onboardAnswers[step.key]) {
      showToast('Pick an option, or skip.', 'warn');
      return;
    }
    if (onboardStep < ONBOARD_STEPS.length - 1) {
      onboardStep += 1;
      renderOnboardStep();
    } else {
      finishOnboarding();
    }
  });
}

async function boot() {
  wireNav();
  wireModals();
  if (state.token) {
    try {
      const res = await api('/api/auth/me');
      state.user = res.user;
      showApp();
      if (!res.user.onboarded) showOnboarding();
      else {
        switchTab('home');
      }
      return;
    } catch (err) {
      state.token = '';
      localStorage.removeItem('tracker_token');
    }
  }
  showAuth();
}

document.addEventListener('DOMContentLoaded', boot);