const currencies = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'SGD', 'JPY', 'CHF', 'HKD', 'AED', 'SAR', 'QAR', 'OMR', 'BHD', 'KWD', 'INR'];
const assetTypes = ['FIXED_DEPOSIT', 'NRE_ACCOUNT', 'FCNR_ACCOUNT', 'SAVINGS_ACCOUNT', 'MUTUAL_FUND', 'EQUITY', 'OTHER'];
const liabilityTypes = ['HOME_LOAN', 'LOAN_AGAINST_PROPERTY', 'CAR_LOAN', 'PERSONAL_LOAN', 'CREDIT_CARD_OUTSTANDING', 'OTHER'];
let lastRecommendationId = null;

let ratesAbortController = null;
let historyAbortController = null;
let optimizeAbortController = null;

function getLocalDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function money(value, currency) {
  const n = Number(value || 0);
  return `${currency || ''} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function fillSelect(id, values) {
  document.getElementById(id).innerHTML = values.map(v => `<option value="${v}">${v}</option>`).join('');
}

function row(container, isAsset) {
  const typeOptions = (isAsset ? assetTypes : liabilityTypes).map(v => `<option value="${v}">${v.split('_').join(' ')}</option>`).join('');
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = `<select class="ccy">${currencies.map(c => `<option>${c}</option>`).join('')}</select><select class="kind">${typeOptions}</select><input class="amount" type="number" step="0.01" placeholder="Value"><button type="button">x</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  container.appendChild(el);
}

function collectPositions(selector, isAsset) {
  return [...document.querySelectorAll(selector)].map(el => {
    const amount = Number(el.querySelector('.amount').value || 0);
    return isAsset
      ? { currency: el.querySelector('.ccy').value, asset_type: el.querySelector('.kind').value, market_value: amount, source: 'MANUAL', valuation_date: getLocalDateString() }
      : { currency: el.querySelector('.ccy').value, liability_type: el.querySelector('.kind').value, outstanding_principal: amount, source: 'MANUAL', valuation_date: getLocalDateString() };
  }).filter(p => Number(isAsset ? p.market_value : p.outstanding_principal) > 0);
}

function apiHeaders() {
  // With HttpOnly cookies, the browser handles authentication automatically.
  // We no longer need to manually add Authorization headers.
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : String(Date.now())
  };
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch (e) {
    return {};
  }
}

async function updateAuthState() {
  try {
    // Check for a valid session by calling the /me endpoint.
    // The browser will automatically send the HttpOnly cookie.
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('Not authenticated');
    const user = await res.json();

    // User is logged in
    document.getElementById('view-login').classList.add('hidden');
    document.getElementById('sidebar').classList.remove('hidden');
    document.getElementById('topNav').classList.remove('hidden');
    document.getElementById('view-advice').classList.remove('hidden');

    const ratesBtn = document.querySelector('button[data-view="rates"]');
    if (ratesBtn) { // Hide rates view for RM role
      if (user.role === 'RM') { ratesBtn.classList.add('hidden'); } else {
        ratesBtn.classList.remove('hidden');
      }
    }

    loadRates().catch(() => { });
  } catch (err) {
    document.getElementById('view-login').classList.remove('hidden');
    document.getElementById('sidebar').classList.add('hidden'); // User is not logged in
    document.getElementById('topNav').classList.add('hidden');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-login').classList.remove('hidden');
  }
}

async function loadRates() {
  if (ratesAbortController) ratesAbortController.abort();
  ratesAbortController = new AbortController();
  try {
    const res = await fetch('/api/rates', { headers: apiHeaders(), signal: ratesAbortController.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.title || 'Failed to load rates');
    document.getElementById('ratesJson').textContent = JSON.stringify(data, null, 2);
    document.getElementById('feedStatus').textContent = `Rates: ${data.feed_status || 'unknown'} (${data.provider || 'provider unknown'})`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    document.getElementById('ratesJson').textContent = `Error: ${err.message}`;
    document.getElementById('feedStatus').textContent = 'Rates: ERROR';
  }
}

async function loadHistory() {
  if (historyAbortController) historyAbortController.abort();
  historyAbortController = new AbortController();
  try {
    const res = await fetch('/api/recent-suggestions?limit=50', { headers: apiHeaders(), signal: historyAbortController.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.title || 'Failed to load history');
    const items = data.logs || data.items || [];
    const rows = document.getElementById('historyRows');
    rows.innerHTML = items.length ? items.map(item => `
      <tr>
        <td>${escapeHtml(item.computed_at ? new Date(item.computed_at).toLocaleString() : '-')}</td>
        <td>${escapeHtml(item.customer_id || '-')}</td>
        <td><strong>${escapeHtml(item.recommended_product || '-')}</strong></td>
        <td>${escapeHtml(item.fcnr_yield || '-')}</td>
        <td>${escapeHtml(item.nre_yield || '-')}</td>
        <td><button class="secondary" type="button" data-report="${escapeHtml(item.recommendation_id)}">Report</button></td>
      </tr>`).join('') : '<tr><td colspan="6">No suggestions yet.</td></tr>';
    rows.querySelectorAll('[data-report]').forEach(btn => btn.addEventListener('click', () => { // Report buttons in history
      // The browser will send the auth cookie automatically. Never put tokens in URLs.
      window.open(`/api/reports/${btn.dataset.report}`);
    }));
  } catch (err) {
    if (err.name === 'AbortError') return;
    const rows = document.getElementById('historyRows');
    rows.innerHTML = `<tr><td colspan="6" class="error">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function showResult(data) {
  lastRecommendationId = data.metadata.recommendation_id;
  const p = data.advisory.projection;
  document.getElementById('resultPanel').classList.remove('hidden');
  document.getElementById('recProduct').textContent = data.advisory.recommended_product;
  document.getElementById('followedAmount').textContent = money(p.followed_advice.projected_amount, p.reporting_currency);
  document.getElementById('followedText').textContent = `${p.followed_advice.product} after ${p.horizon_months} months`;
  document.getElementById('notFollowedAmount').textContent = money(p.did_not_follow_advice.projected_amount, p.reporting_currency);
  document.getElementById('notFollowedText').textContent = `${p.did_not_follow_advice.product} after ${p.horizon_months} months`;
  document.getElementById('advantageAmount').textContent = `${money(p.advantage_amount, p.reporting_currency)} (${p.advantage_pct}%)`;
  document.getElementById('fcnrYield').textContent = `${data.decision_trace.fcnr_effective_yield_pct || '0.00'}%`;
  document.getElementById('nreYield').textContent = `${data.decision_trace.nre_effective_yield_pct || '0.00'}%`;
  document.getElementById('forwardUsed').textContent = data.decision_trace.product_forward_rate_used || 'N/A';
  document.getElementById('almPenalty').textContent = `${data.decision_trace.alm_penalty_pct}%`;
  document.getElementById('portfolioSource').textContent = data.metadata.portfolio_enrichment.source;
  document.getElementById('warnings').innerHTML = (data.advisory.compliance_warnings || []).map(w => `<div class="warn">${escapeHtml(w)}</div>`).join('');
}

document.querySelectorAll('.nav button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${btn.dataset.view}`).classList.remove('hidden');
  if (btn.dataset.view === 'history') loadHistory().catch(() => { });
  if (btn.dataset.view === 'rates') loadRates().catch(() => { });
}));

document.getElementById('addAssetBtn').addEventListener('click', () => row(document.getElementById('assetsList'), true));
document.getElementById('addLiabilityBtn').addEventListener('click', () => row(document.getElementById('liabilitiesList'), false));
document.getElementById('loadHistoryBtn').addEventListener('click', () => loadHistory());
document.getElementById('refreshHistoryBtn').addEventListener('click', () => loadHistory());
document.getElementById('loadRatesBtn').addEventListener('click', () => loadRates());
document.getElementById('downloadReportBtn').addEventListener('click', () => {
  // The browser will send the auth cookie automatically.
  if (lastRecommendationId) {
    window.open(`/api/reports/${lastRecommendationId}`);
  }
});
document.getElementById('downloadBulkPdfBtn').addEventListener('click', () => {
  // The browser will send the auth cookie automatically.
  const url = `/api/logs/pdf?limit=50`;
  window.open(url);
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    // Tell the backend to revoke the refresh token and clear the cookies.
    await fetch('/api/auth/logout', {
      method: 'POST',
    });
  } catch (err) { /* Ignore network errors on logout */ }
  // Update the UI to show the login page.
  updateAuthState();
});

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('loginStatus');
  status.textContent = 'Logging in...';
  status.className = 'status';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Placeholder for IAM integration:
        // bank_sso_token: "..."
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.title || 'Login failed');
    // No need to handle tokens in JS. The browser stores the HttpOnly cookie.
    await updateAuthState();
    status.textContent = '';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'status error';
  }
});

document.getElementById('adviceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('formStatus');
  status.textContent = 'Calculating...';
  status.className = 'status';
  const tenure = Number(document.getElementById('tenure_months').value);
  if (tenure < 12) {
    status.textContent = 'Regulatory constraint: FCNR/NRE requires a minimum tenure of 12 months.';
    status.className = 'status error';
    return;
  }
  const payload = {
    customer_id: document.getElementById('customer_id').value.trim(),
    principal_amount: Number(document.getElementById('principal_amount').value || 0).toFixed(2),
    base_currency: document.getElementById('base_currency').value,
    tenure_months: tenure,
    risk_profile: document.getElementById('risk_profile').value,
    value_date: getLocalDateString(),
    channel: 'RM_PORTAL',
    branch_code: 'GIFT-001',
    assets: collectPositions('#assetsList .row', true),
    liabilities: collectPositions('#liabilitiesList .row', false)
  };
  const indiaInflation = document.getElementById('india_inflation_rate').value;
  const foreignInflation = document.getElementById('foreign_inflation_rate').value;
  if (indiaInflation) payload.india_inflation_rate = Number(indiaInflation).toFixed(2);
  if (foreignInflation) payload.foreign_inflation_rate = Number(foreignInflation).toFixed(2);

  const spot = document.getElementById('spot_override').value;
  const forward = document.getElementById('forward_override').value;
  if (spot || forward) {
    payload.fx_rate_overrides = {};
    if (spot) payload.fx_rate_overrides.product_spot_rate = Number(spot);
    if (forward) payload.fx_rate_overrides.forward_rates = { [String(tenure)]: Number(forward) };
  }
  const fcnr = document.getElementById('fcnr_override').value;
  const nre = document.getElementById('nre_override').value;
  if (fcnr || nre) {
    payload.market_rates_override = { override_reason: document.getElementById('override_reason').value.trim() };
    if (fcnr) payload.market_rates_override.fcnr_rate_pct = Number(fcnr);
    if (nre) payload.market_rates_override.nre_rate_pct = Number(nre);
  }

  if (optimizeAbortController) optimizeAbortController.abort();
  optimizeAbortController = new AbortController();

  try {
    const res = await fetch('/api/optimize', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(payload),
      signal: optimizeAbortController.signal
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.title || 'Advice request failed');
    showResult(data);
    status.textContent = 'Advice ready.';
    await loadHistory().catch(() => { });
  } catch (err) {
    if (err.name === 'AbortError') return;
    status.textContent = err.message;
    status.className = 'status error';
  }
});

fillSelect('base_currency', currencies);
document.getElementById('base_currency').value = 'USD';
updateAuthState(); // Check auth state on initial load
