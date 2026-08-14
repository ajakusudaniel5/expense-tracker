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

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
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
  return div.innerHTML;
}

async function deleteTransaction(id) {
  await api(`/api/transactions/${id}`, { method: 'DELETE' });
  await loadTransactions();
}

async function loadBudgets() {
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
    <button id="b-add" type="button">Set Budget</button>
  `;
  const sel = form.querySelector('#b-category');
  sel.innerHTML = state.categories
    .filter((c) => c.type === 'expense')
    .map((c) => `<option value="${c.id}" data-icon="${escapeHtml(c.icon)}">${escapeHtml(c.name)}</option>`)
    .join('');
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
  container.appendChild(form);
  wireSteppers(form);

  const list = document.createElement('div');
  list.className = 'budget-list';
  const spent = {};
  for (const t of state.transactions) {
    if (t.type === 'expense' && t.category_id) {
      spent[t.category_id] = (spent[t.category_id] || 0) + t.amount;
    }
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
      <span class="limit">/ ${money(b.limit_amount)}</span>
      <button class="delete" data-id="${b.id}" title="Delete">&times;</button>
    `;
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
      if (state.month === new Date().toISOString().slice(0, 7)) loadBudgets();
    } catch (err) {
      alert(err.message);
    }
  });

  $('#t-date').value = new Date().toISOString().slice(0, 10);
  wireSteppers();
  loadCategories().then(loadTransactions);
});
