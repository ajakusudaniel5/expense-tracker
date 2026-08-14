const state = {
  month: new Date().toISOString().slice(0, 7),
  categories: [],
  transactions: [],
};

let categoryDropdown = null;

const CAT_COLORS = ['#7c6cf0', '#34d399', '#ff6b7a', '#fbbf24', '#60a5fa', '#f472b6', '#a3e635', '#22d3ee', '#fb923c', '#c084fc'];

function catColor(id) {
  return CAT_COLORS[Number(id) % CAT_COLORS.length];
}

function customSelect(selectEl) {
  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select';
  selectEl.parentNode.insertBefore(wrapper, selectEl);
  wrapper.appendChild(selectEl);
  selectEl.classList.add('hidden-select');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  wrapper.appendChild(trigger);

  const list = document.createElement('div');
  list.className = 'cs-list';
  wrapper.appendChild(list);

  function renderTrigger() {
    const opt = selectEl.options[selectEl.selectedIndex];
    if (!opt) {
      trigger.innerHTML = '<span class="cs-trigger-label"></span><span class="cs-arrow">▾</span>';
      return;
    }
    const icon = opt.dataset.icon ? `<span class="cs-opt-icon">${escapeHtml(opt.dataset.icon)}</span>` : '';
    trigger.innerHTML = `${icon}<span class="cs-trigger-label"></span><span class="cs-arrow">▾</span>`;
    trigger.querySelector('.cs-trigger-label').textContent = opt.textContent;
  }

  function buildOptions() {
    list.innerHTML = '';
    [...selectEl.options].forEach((opt) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cs-option';
      item.innerHTML = `<span class="cs-opt-icon">${escapeHtml(opt.dataset.icon) || ''}</span><span></span>`;
      item.querySelector('span:last-child').textContent = opt.textContent;
      item.addEventListener('click', () => {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        renderTrigger();
        closeList();
      });
      list.appendChild(item);
    });
  }

  function openList() { wrapper.classList.add('open'); }
  function closeList() { wrapper.classList.remove('open'); }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    wrapper.classList.contains('open') ? closeList() : openList();
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) closeList();
  });

  function refresh() {
    buildOptions();
    renderTrigger();
  }

  refresh();
  return { refresh, closeList };
}

const $ = (sel) => document.querySelector(sel);

function money(n) {
  return (
    'GH₵' +
    n.toLocaleString('en-GH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

const TOKEN_KEY = 'tracker_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    setToken(null);
    showLockScreen();
    throw new Error('App is locked');
  }
  if (res.status === 403) {
    setToken(null);
    showSetupScreen();
    throw new Error('setup required');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  const type = $('#t-type').value;
  const catSel = $('#t-category');
  catSel.innerHTML = state.categories
    .filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}" data-icon="${escapeHtml(c.icon)}">${escapeHtml(c.name)}</option>`)
    .join('');
  if (categoryDropdown) categoryDropdown.refresh();
}

async function loadTransactions() {
  state.transactions = await api(`/api/transactions?month=${state.month}`);
  renderSummary();
  renderTransactions();
}

function renderSummary() {
  let income = 0;
  let expense = 0;
  for (const t of state.transactions) {
    if (t.type === 'income') income += t.amount;
    else expense += t.amount;
  }
  const balance = income - expense;
  $('#sum-income').textContent = money(income);
  $('#sum-expense').textContent = money(expense);
  $('#sum-balance').textContent = money(balance);
  $('#sum-balance').style.color = balance >= 0 ? '#34d399' : '#ff6b7a';
}

function renderTransactions() {
  const list = $('#tx-list');
  const empty = $('#tx-empty');
  list.innerHTML = '';
  empty.style.display = state.transactions.length ? 'none' : 'block';
  for (const t of state.transactions) {
    const item = document.createElement('div');
    const color = t.category_id ? catColor(t.category_id) : (t.type === 'income' ? '#34d399' : '#ff6b7a');
    item.className = 'tx-item';
    item.style.borderLeftColor = color;
    item.innerHTML = `
      <span class="icon" style="background:${color}22;border-radius:8px;padding:4px 8px">${escapeHtml(t.category_icon) || (t.type === 'income' ? '💵' : '💸')}</span>
      <div class="info">
        <div class="name">${escapeHtml(t.category_name) || 'Uncategorized'}${t.note ? ' — ' + escapeHtml(t.note) : ''}</div>
        <div class="meta">${t.date}</div>
      </div>
      <span class="amount ${t.type}">${t.type === 'income' ? '+' : '-'}${money(t.amount)}</span>
      <button class="delete" data-id="${t.id}" title="Delete">&times;</button>
    `;
    item.querySelector('.delete').addEventListener('click', () => deleteTransaction(t.id));
    list.appendChild(item);
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function deleteTransaction(id) {
  await api(`/api/transactions/${id}`, { method: 'DELETE' });
  await loadTransactions();
}

async function loadBudgets(preferredCategoryId) {
  const budgets = await api(`/api/budgets?month=${state.month}`);
  const container = $('#budgets');
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'budget-form';
  form.innerHTML = `
    <div class="field">
      <label for="b-category">Category</label>
      <select id="b-category"></select>
    </div>
    <div class="field">
      <label for="b-limit">Monthly Limit</label>
      <div class="stepper">
        <button type="button" class="step-btn" data-step="-1" aria-label="Decrease">&minus;</button>
        <input type="number" id="b-limit" step="1" min="1" placeholder="0.00">
        <button type="button" class="step-btn" data-step="1" aria-label="Increase">+</button>
      </div>
    </div>
    <div class="budget-form-actions">
      <button id="b-add" type="button">Set Budget</button>
      <button id="b-newcat" type="button" class="btn-ghost">+ New Category</button>
    </div>
  `;
  const sel = form.querySelector('#b-category');
  sel.innerHTML = state.categories
    .filter((c) => c.type === 'expense')
    .map((c) => `<option value="${c.id}" data-icon="${escapeHtml(c.icon)}">${escapeHtml(c.name)}</option>`)
    .join('');
  if (preferredCategoryId) sel.value = String(preferredCategoryId);
  const budgetDropdown = customSelect(sel);
  form.querySelector('#b-add').addEventListener('click', async () => {
    const limit = parseFloat(form.querySelector('#b-limit').value);
    if (!limit || limit <= 0) return alert('Enter a valid limit');
    await api('/api/budgets', {
      method: 'POST',
      body: JSON.stringify({ category_id: Number(sel.value), month: state.month, limit_amount: limit }),
    });
    await loadBudgets();
  });

  const newCatForm = document.createElement('div');
  newCatForm.className = 'new-cat-form';
  newCatForm.style.display = 'none';
  newCatForm.innerHTML = `
    <div class="field">
      <label for="bc-name">New Category Name</label>
      <input type="text" id="bc-name" placeholder="e.g. Shopping" required>
    </div>
    <div class="field">
      <label for="bc-icon">Icon</label>
      <input type="text" id="bc-icon" maxlength="4" placeholder="🛍️">
    </div>
    <div class="budget-form-actions">
      <button id="bc-add" type="button" class="btn-primary">Create Category</button>
      <button id="bc-cancel" type="button" class="btn-ghost">Cancel</button>
    </div>
    <div id="bc-msg" class="form-error" style="display:none"></div>
  `;
  form.querySelector('#b-newcat').addEventListener('click', () => {
    const showing = newCatForm.style.display !== 'none';
    newCatForm.style.display = showing ? 'none' : 'grid';
    if (!showing) form.querySelector('#bc-name').focus();
  });
  newCatForm.querySelector('#bc-cancel').addEventListener('click', () => {
    newCatForm.style.display = 'none';
  });
  newCatForm.querySelector('#bc-add').addEventListener('click', async () => {
    const name = newCatForm.querySelector('#bc-name').value.trim();
    const icon = newCatForm.querySelector('#bc-icon').value.trim();
    const msg = newCatForm.querySelector('#bc-msg');
    msg.style.display = 'none';
    if (!name) {
      msg.textContent = 'Enter a category name';
      msg.style.display = 'block';
      return;
    }
    try {
      const created = await api('/api/categories', {
        method: 'POST',
        body: JSON.stringify({ name, type: 'expense', icon: icon || null }),
      });
      state.categories = await api('/api/categories');
      await loadCategories();
      await loadBudgets(created.id);
    } catch (err) {
      msg.textContent = err.message;
      msg.style.display = 'block';
    }
  });
  container.appendChild(form);
  container.appendChild(newCatForm);
  wireSteppers(form);

  const list = document.createElement('div');
  list.className = 'budget-list';
  const spent = {};
  for (const t of state.transactions) {
    if (t.type === 'expense' && t.category_id) {
      spent[t.category_id] = (spent[t.category_id] || 0) + t.amount;
    }
  }

  const alerts = computeBudgetAlerts(budgets, spent);
  const alertKey = alerts.map((a) => a.msg).join('|');
  if (alerts.length && alertKey !== lastAlertKey) {
    lastAlertKey = alertKey;
    alerts.forEach((a) => showAlert(a.msg, a.type));
  }

  for (const b of budgets) {
    const s = spent[b.category_id] || 0;
    const pct = b.limit_amount > 0 ? Math.min(100, (s / b.limit_amount) * 100) : 0;
    const over = s > b.limit_amount;
    const color = catColor(b.category_id);
    const card = document.createElement('div');
    card.className = 'budget-card';
    card.innerHTML = `
      <span style="font-weight:600;color:${color}">${escapeHtml(b.category_icon)} ${escapeHtml(b.category_name)}</span>
      <div class="budget-bar"><div class="fill ${over ? 'over' : ''}" style="width:${pct}%;background:${over ? '#ff6b7a' : color}"></div></div>
      <span class="spent ${over ? 'over' : 'ok'}">${money(s)}</span>
      <span class="limit">/ <span class="limit-val">${money(b.limit_amount)}</span></span>
      <button class="edit" data-id="${b.id}" title="Edit limit">✏️</button>
      <button class="delete" data-id="${b.id}" title="Delete">&times;</button>
    `;
    const limitSpan = card.querySelector('.limit-val');
    card.querySelector('.edit').addEventListener('click', () => {
      if (card.classList.contains('editing')) return;
      card.classList.add('editing');
      const current = b.limit_amount;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '1';
      input.min = '1';
      input.value = current;
      input.className = 'limit-edit';
      limitSpan.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        const next = parseFloat(input.value);
        if (!next || next <= 0) {
          alert('Enter a valid limit');
          input.focus();
          return;
        }
        await api('/api/budgets', {
          method: 'POST',
          body: JSON.stringify({ category_id: b.category_id, month: b.month, limit_amount: next }),
        });
        await loadBudgets();
      };
      const cancel = () => {
        const repl = document.createElement('span');
        repl.className = 'limit-val';
        repl.textContent = money(current);
        input.replaceWith(repl);
        card.classList.remove('editing');
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', save);
    });
    card.querySelector('.delete').addEventListener('click', async () => {
      await api(`/api/budgets/${b.id}`, { method: 'DELETE' });
      await loadBudgets();
    });
    list.appendChild(card);
  }
  container.appendChild(list);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'budgets') loadBudgets();
  if (name === 'categories') loadCategoriesPage();
  if (name === 'reports') loadReports();
  if (name === 'settings') loadSettingsPage();
}

let lastAlertKey = '';

function showAlert(message, type = 'warn') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${type === 'danger' ? '🚨' : '⚠️'}</span><span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close" aria-label="Dismiss">&times;</button>`;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-show'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

function computeBudgetAlerts(budgets, spent) {
  const alerts = [];
  for (const b of budgets) {
    const s = spent[b.category_id] || 0;
    const pct = b.limit_amount > 0 ? (s / b.limit_amount) * 100 : 0;
    const name = b.category_name || 'Category';
    if (s > b.limit_amount) {
      const over = s - b.limit_amount;
      alerts.push({ msg: `${name}: over budget by ${money(over)} (${Math.round(pct)}%)`, type: 'danger' });
    } else if (pct >= 80) {
      alerts.push({ msg: `${name}: ${Math.round(pct)}% of budget used (${money(s)} / ${money(b.limit_amount)})`, type: 'warn' });
    }
  }
  return alerts;
}

async function checkAlertsForAdded() {
  const budgets = await api(`/api/budgets?month=${state.month}`);
  if (!budgets.length) return;
  const spent = {};
  for (const t of state.transactions) {
    if (t.type === 'expense' && t.category_id) {
      spent[t.category_id] = (spent[t.category_id] || 0) + t.amount;
    }
  }
  computeBudgetAlerts(budgets, spent).forEach((a) => showAlert(a.msg, a.type));
}

async function loadCategoriesPage() {
  const cats = await api('/api/categories');
  const container = $('#categories');
  container.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'budget-form';
  form.innerHTML = `
    <div class="field">
      <label for="c-name">Name</label>
      <input type="text" id="c-name" placeholder="e.g. Shopping" required>
    </div>
    <div class="field">
      <label for="c-type">Type</label>
      <select id="c-type">
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
    </div>
    <div class="field">
      <label for="c-icon">Icon</label>
      <input type="text" id="c-icon" maxlength="4" placeholder="🛍️">
    </div>
    <div class="budget-form-actions">
      <button id="c-add" type="button">Add Category</button>
    </div>
    <div id="c-msg" class="form-error" style="display:none"></div>
  `;
  form.querySelector('#c-add').addEventListener('click', async () => {
    const name = form.querySelector('#c-name').value.trim();
    const type = form.querySelector('#c-type').value;
    const icon = form.querySelector('#c-icon').value.trim();
    const msg = form.querySelector('#c-msg');
    msg.style.display = 'none';
    if (!name) {
      msg.textContent = 'Enter a category name';
      msg.style.display = 'block';
      return;
    }
    try {
      await api('/api/categories', {
        method: 'POST',
        body: JSON.stringify({ name, type, icon: icon || null }),
      });
      await loadCategories();
      await loadCategoriesPage();
    } catch (err) {
      msg.textContent = err.message;
      msg.style.display = 'block';
    }
  });
  container.appendChild(form);
  wireSteppers(form);

  const list = document.createElement('div');
  list.className = 'category-list';
  const income = cats.filter((c) => c.type === 'income');
  const expense = cats.filter((c) => c.type === 'expense');
  list.appendChild(renderCategoryGroup('Expense Categories', expense));
  list.appendChild(renderCategoryGroup('Income Categories', income));
  container.appendChild(list);
}

function renderCategoryGroup(title, cats) {
  const group = document.createElement('div');
  group.className = 'category-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  if (!cats.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No categories';
    group.appendChild(empty);
    return group;
  }
  for (const c of cats) {
    const card = document.createElement('div');
    card.className = 'category-card';
    const color = catColor(c.id);
    card.innerHTML = `
      <span class="cat-icon" style="background:${color}22;color:${color}">${escapeHtml(c.icon) || '🏷️'}</span>
      <span class="cat-name">${escapeHtml(c.name)}</span>
      <button class="cat-edit" data-id="${c.id}" title="Edit">✏️</button>
      <button class="cat-delete" data-id="${c.id}" title="Delete">&times;</button>
    `;
    card.querySelector('.cat-edit').addEventListener('click', () => editCategory(c));
    card.querySelector('.cat-delete').addEventListener('click', () => deleteCategory(c));
    group.appendChild(card);
  }
  return group;
}

function editCategory(c) {
  const name = prompt(`Edit category name (${c.name}):`, c.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return alert('Name cannot be empty');
  const type = prompt('Type (income/expense):', c.type);
  if (type === null) return;
  if (!['income', 'expense'].includes(type)) return alert('Type must be income or expense');
  const icon = prompt('Icon (emoji):', c.icon || '');
  if (icon === null) return;
  (async () => {
    try {
      await api(`/api/categories/${c.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed, type, icon: icon.trim() || null }),
      });
      await loadCategories();
      await loadCategoriesPage();
    } catch (err) {
      alert(err.message);
    }
  })();
}

async function deleteCategory(c) {
  if (!confirm(`Delete category "${c.name}"?`)) return;
  try {
    await api(`/api/categories/${c.id}`, { method: 'DELETE' });
    await loadCategories();
    await loadCategoriesPage();
  } catch (err) {
    alert(err.message);
  }
}

async function loadReports() {
  const container = $('#reports');
  container.innerHTML = '<div class="empty">Loading...</div>';

  const allTx = await api('/api/transactions');
  container.innerHTML = '';

  if (!allTx.length) {
    container.innerHTML = '<div class="empty">No data yet. Add some transactions to see insights.</div>';
    return;
  }

  const { monthly, byCategory } = summarize(allTx);

  container.appendChild(renderTrend(monthly));
  container.appendChild(renderTopCategories(byCategory));
  container.appendChild(renderDonut(byCategory));
  container.appendChild(renderInsights(allTx));}

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
  const sortedMonths = Object.keys(monthly).sort();
  const sortedCats = Object.values(byCategory).sort((a, b) => b.amount - a.amount);
  return { monthly, byCategory, sortedMonths: sortedMonths, sortedCats };
}

function renderTrend(monthly) {
  const months = Object.keys(monthly).sort();
  const section = document.createElement('div');
  section.className = 'report-card';
  const title = document.createElement('h3');
  title.textContent = 'Monthly Income vs Expenses';
  section.appendChild(title);

  const max = Math.max(
    1,
    ...months.map((m) => Math.max(monthly[m].income, monthly[m].expense))
  );
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
  section.className = 'report-card';
  const title = document.createElement('h3');
  title.textContent = 'Top Spending Categories';
  section.appendChild(title);

  const withIds = Object.entries(byCategory).sort((a, b) => b[1].amount - a[1].amount);
  if (!withIds.length) {
    section.appendChild(document.createElement('div')).className = 'empty';
    section.lastChild.textContent = 'No expenses yet.';
    return section;
  }

  const total = withIds.reduce((sum, [, c]) => sum + c.amount, 0);
  const top = withIds.slice(0, 5);
  for (const [id, c] of top) {
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
  section.className = 'report-card';
  const title = document.createElement('h3');
  title.textContent = 'Spending Breakdown';
  section.appendChild(title);

  const withIds = Object.entries(byCategory).sort((a, b) => b[1].amount - a[1].amount);
  if (!withIds.length) {
    section.appendChild(document.createElement('div')).className = 'empty';
    section.lastChild.textContent = 'No expenses yet.';
    return section;
  }

  const total = withIds.reduce((sum, [, c]) => sum + c.amount, 0);
  const donut = document.createElement('div');
  donut.className = 'donut';
  donut.style.background = conicGradient(withIds);
  donut.innerHTML = `<div class="donut-hole"><strong>${money(total)}</strong><small>Total spent</small></div>`;

  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  for (const [id, c] of withIds) {
    const item = document.createElement('div');
    item.className = 'donut-legend-item';
    item.innerHTML = `<span class="dot" style="background:${catColor(id)}"></span> ${escapeHtml(c.name)} <em>${money(c.amount)}</em>`;
    legend.appendChild(item);
  }

  section.appendChild(donut);
  section.appendChild(legend);
  return section;
}

function renderInsights(allTx) {
  const section = document.createElement('div');
  section.className = 'report-card';
  const title = document.createElement('h3');
  title.textContent = 'Insights';
  section.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'insight-list';
  const months = {};
  for (const t of allTx) {
    const m = t.date.slice(0, 7);
    if (!months[m]) months[m] = { income: 0, expense: 0 };
    if (t.type === 'income') months[m].income += t.amount;
    else months[m].expense += t.amount;
  }
  const monthKeys = Object.keys(months).sort();
  const latest = months[monthKeys[monthKeys.length - 1]];

  const li = (text) => {
    const el = document.createElement('li');
    el.textContent = text;
    list.appendChild(el);
  };

  const totalIncome = allTx.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpense = allTx.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

  li(`Total income: ${money(totalIncome)}`);
  li(`Total expenses: ${money(totalExpense)}`);
  li(`Net savings: ${money(totalIncome - totalExpense)}`);

  const rate = totalIncome > 0 ? Math.round((totalExpense / totalIncome) * 100) : 0;
  if (rate > 100) li(`⚠️ You're spending ${rate - 100}% more than you earn.`);
  else li(`You're saving ${100 - rate}% of your income.`);

  if (monthKeys.length > 1) {
    const prev = months[monthKeys[monthKeys.length - 2]];
    const delta = prev.expense > 0 ? Math.round(((latest.expense - prev.expense) / prev.expense) * 100) : null;
    if (delta !== null) {
      if (delta > 0) li(`📈 Spending up ${delta}% vs previous month.`);
      else li(`📉 Spending down ${Math.abs(delta)}% vs previous month.`);
    }
  }

  section.appendChild(list);
  return section;
}

function conicGradient(withIds) {
  const total = withIds.reduce((sum, [, c]) => sum + c.amount, 0);
  if (!total) return '';
  let acc = 0;
  const parts = withIds.map(([id, c]) => {
    const from = (acc / total) * 360;
    acc += c.amount;
    const to = (acc / total) * 360;
    return `${catColor(id)} ${from}deg ${to}deg`;
  });
  return `conic-gradient(${parts.join(', ')})`;
}

function wireSteppers(root = document) {
  root.querySelectorAll('.stepper').forEach((stepper) => {
    const input = stepper.querySelector('input[type="number"]');
    if (!input) return;
    stepper.querySelectorAll('.step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = Number(btn.dataset.step);
        const min = input.min !== '' ? Number(input.min) : null;
        const current = input.value === '' ? 0 : Number(input.value);
        let next = current + step;
        if (min !== null && next < min) next = min;
        input.value = next;
      });
    });
  });
}

function showLockScreen() {
  const screen = $('#lock-screen');
  const pinInput = $('#lock-pin');
  const err = $('#lock-error');
  screen.style.display = 'flex';
  pinInput.value = '';
  err.style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  pinInput.focus();
}

function showSetupScreen() {
  const screen = $('#setup-screen');
  screen.style.display = 'flex';
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
}

async function setupPin() {
  const pin = $('#setup-pin').value;
  const pin2 = $('#setup-pin2').value;
  const err = $('#setup-error');
  if (!/^\d{4,8}$/.test(pin)) {
    err.textContent = 'PIN must be 4-8 digits';
    err.style.display = 'block';
    return;
  }
  if (pin !== pin2) {
    err.textContent = 'PINs do not match';
    err.style.display = 'block';
    return;
  }
  try {
    await api('/api/pin/set', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    $('#setup-screen').style.display = 'none';
    $('#lock-btn').style.display = '';
    const res = await fetch('/api/pin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const body = await res.json();
    setToken(body.token);
    document.querySelector('.tab[data-tab="dashboard"]').click();
    loadCategories().then(loadTransactions);
  } catch (e) {
    err.textContent = e.message || 'Could not set PIN';
    err.style.display = 'block';
  }
}

async function tryUnlock() {
  const pin = $('#lock-pin').value.trim();
  const err = $('#lock-error');
  if (!pin) {
    err.textContent = 'Enter your PIN';
    err.style.display = 'block';
    return;
  }
  try {
    const res = await fetch('/api/pin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = body.error || 'Incorrect PIN';
      err.style.display = 'block';
      if ($('#lock-pin').value.trim().length >= 8) {
        $('#lock-pin').value = '';
      }
      $('#lock-pin').focus();
      return;
    }
    setToken(body.token);
    $('#lock-screen').style.display = 'none';
    $('#lock-btn').style.display = '';
    document.querySelector('.tab[data-tab="dashboard"]').click();
    loadCategories().then(loadTransactions);
  } catch (e) {
    err.textContent = 'Something went wrong';
    err.style.display = 'block';
  }
}

function lockNow() {
  setToken(null);
  showLockScreen();
}

async function loadSettingsPage() {
  const container = $('#settings');
  container.innerHTML = '<div class="empty">Loading...</div>';
  let status;
  try {
    status = await api('/api/pin/status');
  } catch (err) {
    container.innerHTML = '<div class="empty">App is locked.</div>';
    return;
  }
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'settings-card';
  if (status.enabled) {
    const changeable = status.changeable !== false;
    card.innerHTML = `
      <h3>PIN Lock</h3>
      <span class="settings-status on">● Enabled</span>
      <p class="muted">Your app is protected by a PIN. Anyone without the PIN cannot view your data.</p>
      ${changeable ? `
      <div class="field">
        <label for="s-current">Current PIN</label>
        <input type="password" id="s-current" inputmode="numeric" maxlength="8" autocomplete="off">
      </div>
      <div class="field">
        <label for="s-new">New PIN (4-8 digits)</label>
        <input type="password" id="s-new" inputmode="numeric" maxlength="8" autocomplete="off">
      </div>
      <div class="field">
        <label for="s-confirm">Confirm New PIN</label>
        <input type="password" id="s-confirm" inputmode="numeric" maxlength="8" autocomplete="off">
      </div>
      <div class="btn-row">
        <button type="button" id="s-change" class="btn-primary">Change PIN</button>
      </div>
      ` : '<p class="muted">Your PIN is managed by the server and cannot be changed from the app.</p>'}
    `;
    if (changeable) {
      card.querySelector('#s-change').addEventListener('click', async () => {
        const cur = card.querySelector('#s-current').value;
        const next = card.querySelector('#s-new').value;
        const confirm = card.querySelector('#s-confirm').value;
        if (!/^\d{4,8}$/.test(next)) return alert('New PIN must be 4-8 digits');
        if (next !== confirm) return alert('PINs do not match');
        try {
          await api('/api/pin/change', {
            method: 'POST',
            body: JSON.stringify({ current_pin: cur, new_pin: next }),
          });
          alert('PIN changed successfully');
          await loadSettingsPage();
        } catch (err) {
          alert(err.message);
        }
      });
    }
  } else {
    card.innerHTML = `
      <h3>PIN Lock</h3>
      <span class="settings-status off">● Disabled</span>
      <p class="muted">Set a PIN to lock the app. You'll be asked for it each time you open the app.</p>
      <div class="field">
        <label for="s-pin">New PIN (4-8 digits)</label>
        <input type="password" id="s-pin" inputmode="numeric" maxlength="8" autocomplete="off">
      </div>
      <div class="field">
        <label for="s-pin2">Confirm PIN</label>
        <input type="password" id="s-pin2" inputmode="numeric" maxlength="8" autocomplete="off">
      </div>
      <button type="button" id="s-enable" class="btn-primary">Enable PIN</button>
    `;
    card.querySelector('#s-enable').addEventListener('click', async () => {
      const pin = card.querySelector('#s-pin').value;
      const pin2 = card.querySelector('#s-pin2').value;
      if (!/^\d{4,8}$/.test(pin)) return alert('PIN must be 4-8 digits');
      if (pin !== pin2) return alert('PINs do not match');
      try {
        await api('/api/pin/set', {
          method: 'POST',
          body: JSON.stringify({ pin }),
        });
        alert('PIN enabled. The app is now locked.');
        $('#lock-btn').style.display = '';
        lockNow();
      } catch (err) {
        alert(err.message);
      }
    });
  }
  container.appendChild(card);
  container.appendChild(await renderProfileCard());
  container.appendChild(await renderDeleteReportsCard());
}

async function renderProfileCard() {
  const card = document.createElement('div');
  card.className = 'settings-card';
  card.innerHTML = '<div class="empty">Loading profile...</div>';
  let profile;
  try {
    profile = await api('/api/profile');
  } catch (err) {
    card.innerHTML = '<div class="empty">Could not load profile.</div>';
    return card;
  }
  card.innerHTML = `
    <h3>My Profile</h3>
    <span class="settings-status on">● ${escapeHtml(profile.currency || 'GH₵')}</span>
    <div class="field">
      <label for="p-name">Name</label>
      <input type="text" id="p-name" value="${escapeHtml(profile.name || '')}" placeholder="Your name">
    </div>
    <div class="field">
      <label for="p-email">Email</label>
      <input type="text" id="p-email" value="${escapeHtml(profile.email || '')}" placeholder="you@example.com">
    </div>
    <button type="button" id="p-save" class="btn-primary">Save Profile</button>
    <span id="p-msg" class="muted"></span>
  `;
  card.querySelector('#p-save').addEventListener('click', async () => {
    const msg = card.querySelector('#p-msg');
    const name = card.querySelector('#p-name').value;
    const email = card.querySelector('#p-email').value;
    msg.textContent = 'Saving...';
    try {
      const res = await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ name, email }),
      });
      msg.textContent = 'Saved.';
      profile = res;
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  return card;
}

async function renderDeleteReportsCard() {
  const card = document.createElement('div');
  card.className = 'settings-card';
  card.innerHTML = '<div class="empty">Loading...</div>';
  let allTx;
  try {
    allTx = await api('/api/transactions');
  } catch (err) {
    card.innerHTML = '<div class="empty">Could not load data.</div>';
    return card;
  }
  const months = [...new Set(allTx.map((t) => t.date.slice(0, 7)))].sort().reverse();
  const total = allTx.length;
  card.innerHTML = `
    <h3>Delete Reports</h3>
    <p class="muted">Reports are generated from your transactions. Deleting a period's data removes it from the reports.</p>
    <div class="field">
      <label for="d-month">Delete a specific month</label>
      <select id="d-month">${months.length ? months.map((m) => `<option value="${m}">${m}</option>`).join('') : '<option value="">No months with data</option>'}</select>
    </div>
    <div class="btn-row">
      <button type="button" id="d-month-run" class="btn-danger" ${months.length ? '' : 'disabled'}>Delete selected month</button>
      <button type="button" id="d-all-run" class="btn-danger">Delete all transactions (${total})</button>
    </div>
    <span id="d-msg" class="muted"></span>
  `;
  card.querySelector('#d-month-run').addEventListener('click', async () => {
    const month = card.querySelector('#d-month').value;
    if (!month) return;
    if (!confirm(`Delete all transactions for ${month}? This cannot be undone.`)) return;
    await runDelete({ scope: 'month', month }, card);
  });
  card.querySelector('#d-all-run').addEventListener('click', async () => {
    if (!confirm(`Delete ALL ${total} transactions? This cannot be undone.`)) return;
    await runDelete({ scope: 'all' }, card);
  });
  return card;
}

async function runDelete(payload, card) {
  const msg = card.querySelector('#d-msg');
  msg.textContent = 'Deleting...';
  try {
    const res = await api('/api/reports/delete', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = `Deleted ${res.deleted} transaction(s).`;
    await loadSettingsPage();
    loadTransactions();
    loadBudgets();
  } catch (err) {
    msg.textContent = err.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const typeDropdown = customSelect($('#t-type'));
  categoryDropdown = customSelect($('#t-category'));
  typeDropdown.closeList();
  categoryDropdown.closeList();

  $('#month').value = state.month;
  $('#month').addEventListener('change', (e) => {
    state.month = e.target.value;
    loadTransactions();
  });
  $('#t-type').addEventListener('change', loadCategories);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          amount: parseFloat($('#t-amount').value),
          date: $('#t-date').value,
          type: $('#t-type').value,
          category_id: Number($('#t-category').value),
          note: $('#t-note').value || null,
        }),
      });
      e.target.reset();
      $('#t-date').value = new Date().toISOString().slice(0, 10);
      await loadTransactions();
      if (state.month === new Date().toISOString().slice(0, 7)) {
        loadBudgets();
        checkAlertsForAdded();
      }
    } catch (err) {
      alert(err.message);
    }
  });

  $('#t-date').value = new Date().toISOString().slice(0, 10);
  wireSteppers();

  $('#lock-btn').addEventListener('click', lockNow);
  $('#lock-unlock').addEventListener('click', tryUnlock);
  $('#lock-pin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryUnlock();
  });
  let lockDebounce = null;
  $('#lock-pin').addEventListener('input', () => {
    $('#lock-error').style.display = 'none';
    const len = $('#lock-pin').value.trim().length;
    if (len < 4) return;
    clearTimeout(lockDebounce);
    lockDebounce = setTimeout(() => {
      if ($('#lock-pin').value.trim().length >= 4) tryUnlock();
    }, 700);
  });
  $('#setup-run').addEventListener('click', setupPin);
  $('#setup-pin2').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setupPin();
  });

  (async () => {
    let status = { enabled: false };
    try {
      status = await api('/api/pin/status');
    } catch (e) {
      return;
    }
    if (status.enabled) {
      $('#lock-btn').style.display = '';
      if (getToken()) {
        try {
          await api('/api/categories');
          document.querySelector('.tab[data-tab="dashboard"]').click();
          loadCategories().then(loadTransactions);
          return;
        } catch (e) {
          return;
        }
      }
      showLockScreen();
    } else {
      showSetupScreen();
    }
  })();
});
