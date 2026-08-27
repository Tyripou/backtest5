// contexte-economique.js
// Récupère un instantané macro + sentiment (via la fonction Netlify /economic-context,
// proxy vers FRED) et les actualités du jour (via GDELT, appelé directement en client).

const FRED_FN_URL = '/api/economic-context';
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

const form = document.getElementById('lookupForm');
const dateInput = document.getElementById('dateInput');
const hint = document.getElementById('lookupHint');
const panels = document.getElementById('panels');
const macroList = document.getElementById('macroList');
const sentimentList = document.getElementById('sentimentList');
const newsList = document.getElementById('newsList');
const statusEl = document.getElementById('status');
const tapeTrack = document.getElementById('tapeTrack');

dateInput.max = new Date().toISOString().split('T')[0];

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = dateInput.value;
  if (!date) return;

  setStatus('Récupération du contexte…');
  panels.hidden = true;

  const [macroResult, newsResult] = await Promise.allSettled([
    fetchMacro(date),
    fetchNews(date)
  ]);

  if (macroResult.status === 'fulfilled') {
    renderMacro(macroResult.value, date);
  } else {
    console.error(macroResult.reason);
    macroList.innerHTML = errorRow();
    sentimentList.innerHTML = errorRow();
  }

  if (newsResult.status === 'fulfilled') {
    renderNews(newsResult.value);
  } else {
    console.error(newsResult.reason);
    newsList.innerHTML = '<li class="news-item">Actualités indisponibles pour cette date.</li>';
  }

  panels.hidden = false;
  setStatus('');
});

function setStatus(msg) {
  statusEl.textContent = msg;
}

function errorRow() {
  return '<div class="stat-row"><dt>Erreur</dt><dd>Donnée indisponible</dd></div>';
}

// ---------- FRED (via fonction Netlify) ----------

async function fetchMacro(date) {
  const res = await fetch(`${FRED_FN_URL}?date=${date}`);
  if (!res.ok) throw new Error(`Fonction economic-context: ${res.status}`);
  return res.json();
}

function renderMacro(data, requestedDate) {
  const macroSeries = [
    { key: 'fedFunds', label: 'Taux directeur (Fed Funds)', suffix: '%' },
    { key: 'cpi', label: 'CPI (indice, glissement annuel)', suffix: '%' },
    { key: 'ppi', label: 'PPI (indice, glissement annuel)', suffix: '%' },
    { key: 'nfp', label: 'Créations d\'emplois non-agricoles', suffix: 'k' }
  ];
  const sentimentSeries = [
    { key: 'vix', label: 'VIX (volatilité implicite)', suffix: '' }
  ];

  macroList.innerHTML = macroSeries.map(s => statRow(s, data[s.key])).join('');
  sentimentList.innerHTML = sentimentSeries.map(s => statRow(s, data[s.key])).join('')
    || '<div class="stat-row"><dt>Info</dt><dd>Pas de séance ce jour</dd></div>';

  updateTape(data, requestedDate);
}

function statRow(config, point) {
  if (!point || point.value === null || point.value === undefined) {
    return `<div class="stat-row"><dt>${config.label}</dt><dd>N/D</dd></div>`;
  }
  const asOf = point.date ? `<small>au ${formatDate(point.date)}</small>` : '';
  return `<div class="stat-row"><dt>${config.label}</dt><dd>${point.value}${config.suffix}${asOf}</dd></div>`;
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function updateTape(data, date) {
  const items = [];
  if (data.fedFunds?.value != null) items.push(`FED FUNDS <b>${data.fedFunds.value}%</b>`);
  if (data.cpi?.value != null) items.push(`CPI <b>${data.cpi.value}%</b>`);
  if (data.vix?.value != null) items.push(`VIX <b>${data.vix.value}</b>`);
  if (data.nfp?.value != null) items.push(`NFP <b>${data.nfp.value}k</b>`);
  if (!items.length) return;
  tapeTrack.innerHTML = items
    .concat(items) // duplicate for seamless loop
    .map(t => `<span class="tape__item">${date} — ${t}</span>`)
    .join('');
}

// ---------- GDELT (appel direct, pas de clé requise) ----------

async function fetchNews(date) {
  const d = date.replaceAll('-', '');
  const start = `${d}000000`;
  const end = `${d}235959`;
  const query = encodeURIComponent('(economy OR markets OR "federal reserve" OR inflation OR earnings) sourcelang:eng');
  const url = `${GDELT_URL}?query=${query}&mode=artlist&format=json&maxrecords=6&sort=hybridrel&startdatetime=${start}&enddatetime=${end}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GDELT: ${res.status}`);
  const data = await res.json();
  return data.articles || [];
}

function renderNews(articles) {
  if (!articles.length) {
    newsList.innerHTML = '<li class="news-item">Aucun article marquant trouvé pour cette date.</li>';
    return;
  }
  newsList.innerHTML = articles.slice(0, 6).map(a => `
    <li class="news-item">
      <a href="${a.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title || 'Article sans titre')}</a>
      <span class="news-meta">${escapeHtml(a.domain || '')}</span>
    </li>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
