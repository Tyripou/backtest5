// marches.js
//
// Dashboard macro "Or & Crypto" piloté par une date de backtest.
//
// ANTI LOOK-AHEAD BIAS (voir aussi les commentaires dans les fonctions serverless Vercel) :
// - Les séries macro viennent de /macro-context, qui interroge FRED avec les
//   paramètres realtime_start/realtime_end = date sélectionnée : on reçoit donc les
//   valeurs telles que publiées/connues à cette date, pas les révisions ultérieures.
// - Le calendrier vient de /calendar-context (dates réelles de publication FRED +
//   listes statiques FOMC / événements crypto documentés).
// - Les news (GDELT) sont bornées par enddatetime = 23:59:59 de la date sélectionnée :
//   aucun article postérieur ne peut apparaître.
// - Les prix crypto (CoinGecko) sont bornés à la même date de fin.

const MACRO_FN_URL = '/api/macro-context';
const CALENDAR_FN_URL = '/api/calendar-context';
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3';

// ---------- Config des indicateurs ----------
// mode 'level'  -> variations affichées en points/unités absolues (ex: taux, VIX)
// mode 'index'  -> variations affichées en % (ex: indices de prix, indices boursiers)
const INDICATORS = {
  fedFunds:      { label: 'Fed Funds Rate',            unit: '%',    mode: 'level', freq: 'd', group: 'rates' },
  us2y:          { label: 'Taux US 2 ans',              unit: '%',    mode: 'level', freq: 'd', group: 'rates' },
  us10y:         { label: 'Taux US 10 ans',             unit: '%',    mode: 'level', freq: 'd', group: 'rates' },
  realYield10y:  { label: 'Rendement réel 10 ans (TIPS)', unit: '%',  mode: 'level', freq: 'd', group: 'rates' },
  fedBalanceSheet:{ label: 'Bilan de la Fed (proxy liquidité)', unit: ' T$', mode: 'index', freq: 'w', group: 'rates', scale: 1e-6 },

  cpi:           { label: 'CPI (glissement annuel)',    unit: '%',    mode: 'yoy',   freq: 'm', group: 'inflation' },
  coreCpi:       { label: 'Core CPI (glissement annuel)', unit: '%',  mode: 'yoy',   freq: 'm', group: 'inflation' },
  pce:           { label: 'PCE (glissement annuel)',    unit: '%',    mode: 'yoy',   freq: 'm', group: 'inflation' },
  corePce:       { label: 'Core PCE (glissement annuel)', unit: '%',  mode: 'yoy',   freq: 'm', group: 'inflation' },
  unemployment:  { label: 'Taux de chômage',            unit: '%',    mode: 'level', freq: 'm', group: 'inflation' },
  nfp:           { label: 'Créations d\'emplois (NFP, mensuel)', unit: 'k', mode: 'diffLevel', freq: 'm', group: 'inflation' },
  retailSales:   { label: 'Ventes au détail (mensuel)',  unit: '%',   mode: 'mom',   freq: 'm', group: 'inflation' },

  dxy:           { label: 'DXY (indice dollar)',        unit: '',     mode: 'index', freq: 'd', group: 'cross' },
  vix:           { label: 'VIX',                        unit: '',     mode: 'index', freq: 'd', group: 'cross' },
  sp500:         { label: 'S&P 500',                    unit: '',     mode: 'index', freq: 'd', group: 'cross' },
  nasdaq:        { label: 'Nasdaq Composite',            unit: '',    mode: 'index', freq: 'd', group: 'cross' },
  wti:           { label: 'Pétrole WTI',                 unit: '$',   mode: 'index', freq: 'd', group: 'cross' },
  copper:        { label: 'Cuivre (mensuel, FMI)',       unit: '$',   mode: 'index', freq: 'm', group: 'cross' },
  gold:          { label: 'Or (fixing LBMA, historique)', unit: '$',  mode: 'index', freq: 'd', group: 'gold' }
};

const dateInput = document.getElementById('dateInput');
const loadBtn = document.getElementById('loadBtn');
const asOfMeta = document.getElementById('asOfMeta');
const statusEl = document.getElementById('status');

const today = new Date().toISOString().split('T')[0];
dateInput.max = today;
dateInput.value = today;

loadBtn.addEventListener('click', () => loadAll(dateInput.value));

let currentCalendarEvents = [];
let currentFilter = 'all';
document.getElementById('calendarFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filters__chip');
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  [...document.querySelectorAll('.filters__chip')].forEach(c => c.classList.toggle('is-active', c === btn));
  renderCalendar(currentCalendarEvents, currentFilter);
});

// ---------- Orchestration ----------

async function loadAll(date) {
  if (!date) return;
  setStatus('Chargement du contexte macro…');
  asOfMeta.textContent = `Reconstitution pour le ${formatDateFr(date)} — chargement…`;

  const [macroResult, calendarResult, goldNewsResult, btcResult, ethResult, solResult] = await Promise.allSettled([
    fetchMacro(date),
    fetchCalendar(date),
    fetchNews('(gold OR bullion OR "gold price" OR XAU) sourcelang:eng', date),
    fetchCrypto('bitcoin', date),
    fetchCrypto('ethereum', date),
    fetchCrypto('solana', date)
  ]);

  let macro = null;
  if (macroResult.status === 'fulfilled') {
    macro = macroResult.value;
    hideError();
  } else {
    console.error('macro-context error:', macroResult.reason);
    macro = { series: {}, notes: {} }; // structure vide : les cartes afficheront "Non disponible" au lieu de rester blanches
    showError(
      `Impossible de charger les données macro (fonction <code>/api/macro-context</code>). ` +
      `${macroResult.reason.message}. Vérifie que <code>FRED_API_KEY</code> est bien configurée sur Vercel ` +
      `(Site settings → Environment variables) et qu'un redéploiement a eu lieu depuis.`
    );
  }
  renderIndicatorGroup('ratesCards', macro, 'rates', date);
  renderIndicatorGroup('inflationCards', macro, 'inflation', date);
  renderIndicatorGroup('crossCards', macro, 'cross', date);
  renderIndicatorGroup('goldCards', macro, 'gold', date);
  renderRegime(macro);
  renderGoldSynthesis(macro, date);

  if (calendarResult.status === 'fulfilled') {
    currentCalendarEvents = calendarResult.value.events || [];
    renderCalendar(currentCalendarEvents, currentFilter);
  } else {
    document.getElementById('calendarList').innerHTML = '<li class="calendar-item">Calendrier indisponible.</li>';
  }

  renderNews(document.getElementById('goldNewsList'), goldNewsResult);

  renderCryptoCard('BTC', btcResult, macro, currentCalendarEvents, date);
  renderCryptoCard('ETH', ethResult, macro, currentCalendarEvents, date);
  renderCryptoCard('SOL', solResult, macro, currentCalendarEvents, date);

  asOfMeta.textContent = `Contexte reconstitué pour le ${formatDateFr(date)} · dernière mise à jour de cette page : ${new Date().toLocaleString('fr-FR')}`;
  setStatus('');
}

function setStatus(msg) { statusEl.textContent = msg; }

// ---------- Fetchers ----------

async function fetchMacro(date) {
  const res = await fetch(`${MACRO_FN_URL}?date=${date}`);
  if (!res.ok) throw new Error(await describeFunctionError(res));
  return res.json();
}

async function fetchCalendar(date) {
  const res = await fetch(`${CALENDAR_FN_URL}?date=${date}`);
  if (!res.ok) throw new Error(await describeFunctionError(res));
  return res.json();
}

// Essaie de récupérer le message d'erreur renvoyé par la fonction Vercel (JSON {error: "..."}),
// sinon retombe sur le code HTTP brut. Aide beaucoup à diagnostiquer (clé manquante, 404, etc.)
async function describeFunctionError(res) {
  try {
    const body = await res.json();
    if (body && body.error) return `HTTP ${res.status} — ${body.error}`;
  } catch (_) { /* réponse non-JSON (ex: 404 HTML de Vercel) */ }
  return `HTTP ${res.status}`;
}

function showError(html) {
  const el = document.getElementById('errorBanner');
  el.innerHTML = `<strong>Erreur de chargement.</strong> ${html}`;
  el.hidden = false;
}
function hideError() {
  document.getElementById('errorBanner').hidden = true;
}

async function fetchNews(query, date) {
  // Fenêtre élargie à 14 jours avant la date choisie : GDELT indexe parfois peu
  // d'articles sur une fenêtre courte, surtout pour des dates plus anciennes.
  const start = shiftDate(date, -14).replaceAll('-', '') + '000000';
  const end = date.replaceAll('-', '') + '235959'; // borne dure : rien après la date choisie
  const url = `${GDELT_URL}?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=8&sort=hybridrel&startdatetime=${start}&enddatetime=${end}`;

  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    // GDELT renvoie parfois une page d'erreur HTML (quota, requête mal formée) au lieu de JSON
    throw new Error('GDELT a renvoyé une réponse invalide (probablement une limite de requêtes atteinte)');
  }
  return data.articles || [];
}

// CoinGecko : un seul appel range par actif, borné à la date choisie (aucun point après).
async function fetchCrypto(id, date) {
  const to = Math.floor(new Date(date + 'T23:59:59Z').getTime() / 1000);
  const from = to - 35 * 86400;
  const url = `${COINGECKO_URL}/coins/${id}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${id}: ${res.status}`);
  const data = await res.json();
  return dailyCloses(data.prices || []);
}

// Réduit la série de prix (parfois horaire) à un point par jour calendaire (dernier connu ce jour-là).
function dailyCloses(prices) {
  const byDay = new Map();
  for (const [ts, price] of prices) {
    const day = new Date(ts).toISOString().split('T')[0];
    byDay.set(day, price); // écrase avec le plus récent de la journée
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

// ---------- Calculs (transparents, visibles dans ce fichier) ----------

function computeStats(points, indicator) {
  if (!points || !points.length) return null;
  const latest = points[points.length - 1];
  const n = points.length;

  const back = indicator.freq === 'd' ? { short: 1, mid: 5, long: 21 }
             : indicator.freq === 'w' ? { short: 1, mid: 4, long: 12 }
             : { short: 1, mid: 3, long: 12 }; // monthly: mom, 1 trimestre, yoy

  const prevAt = (offset) => (n - 1 - offset >= 0 ? points[n - 1 - offset] : null);

  return {
    latest,
    prevShort: prevAt(back.short),
    prevMid: prevAt(back.mid),
    prevLong: prevAt(back.long),
    sparkPoints: points.slice(-15)
  };
}

function pctDiff(a, b) { return b ? ((a - b) / Math.abs(b)) * 100 : null; }
function absDiff(a, b) { return a - b; }

// ---------- Rendu des cartes macro ----------

function renderIndicatorGroup(containerId, macro, group, date) {
  const container = document.getElementById(containerId);
  const ids = Object.entries(INDICATORS).filter(([, cfg]) => cfg.group === group).map(([id]) => id);
  container.innerHTML = ids.map(id => renderCard(id, macro.series[id], macro.notes)).join('');
}

function renderCard(id, points, notes) {
  const cfg = INDICATORS[id];
  const stats = computeStats(points, cfg);

  if (!stats) {
    const note = notes && notes[id] ? `<p class="card__meta">${notes[id]}</p>` : '';
    return `<div class="card status-neutral"><p class="card__label">${cfg.label}</p><p class="card__na">Non disponible</p>${note}</div>`;
  }

  const scale = cfg.scale || 1;
  const displayValue = (stats.latest.value * scale).toFixed(cfg.unit === '%' || scale !== 1 ? 2 : 1);

  let changeShort = null, changeLabel = 'vs période préc.';
  if (cfg.mode === 'level' || cfg.mode === 'diffLevel') {
    changeShort = stats.prevShort ? absDiff(stats.latest.value, stats.prevShort.value) : null;
  } else if (cfg.mode === 'yoy') {
    const yoyNow = stats.prevLong ? pctDiff(stats.latest.value, stats.prevLong.value) : null;
    changeShort = yoyNow;
    changeLabel = 'glissement annuel';
  } else if (cfg.mode === 'mom') {
    changeShort = stats.prevShort ? pctDiff(stats.latest.value, stats.prevShort.value) : null;
    changeLabel = 'vs mois préc.';
  } else {
    changeShort = stats.prevShort ? pctDiff(stats.latest.value, stats.prevShort.value) : null;
  }

  const statusClass = classifyChange(id, changeShort);
  const changeText = changeShort === null ? '—' :
    (cfg.mode === 'level' || cfg.mode === 'diffLevel'
      ? `${changeShort >= 0 ? '+' : ''}${changeShort.toFixed(cfg.mode === 'diffLevel' ? 0 : 2)}${cfg.mode === 'diffLevel' ? 'k' : 'pt'}`
      : `${changeShort >= 0 ? '+' : ''}${changeShort.toFixed(1)}%`);

  const spark = buildSparkline(stats.sparkPoints);
  const note = notes && notes[id] ? `<p class="card__meta">${notes[id]}</p>` : '';

  return `
    <div class="card ${statusClass}">
      <p class="card__label">${cfg.label}</p>
      <p class="card__value">${displayValue}${cfg.unit}</p>
      <div class="card__row">
        <span class="card__change">${changeText} <small>(${changeLabel})</small></span>
      </div>
      ${spark}
      <p class="card__meta">Publié / connu au ${formatDateFr(stats.latest.date)}</p>
      ${note}
    </div>`;
}

// Classification purement indicative (voir la logique explicite dans renderRegime)
function classifyChange(id, change) {
  if (change === null || change === undefined) return 'status-neutral';
  const risingIsBad = ['fedFunds', 'us2y', 'us10y', 'realYield10y', 'dxy', 'vix', 'cpi', 'coreCpi'];
  const risingIsGood = ['sp500', 'nasdaq', 'nfp', 'retailSales'];
  if (Math.abs(change) < (id === 'vix' ? 1 : 0.05)) return 'status-neutral';
  if (risingIsBad.includes(id)) return change > 0 ? 'status-bad' : 'status-good';
  if (risingIsGood.includes(id)) return change > 0 ? 'status-good' : 'status-bad';
  return 'status-info';
}

function buildSparkline(points) {
  if (!points || points.length < 2) return '';
  const w = 160, h = 32, pad = 2;
  const values = points.map(p => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = values.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="card__spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.75"/>
  </svg>`;
}

// ---------- Régime de marché (règles explicites, non opaques) ----------

function renderRegime(macro) {
  const s = {};
  Object.keys(INDICATORS).forEach(id => { s[id] = computeStats(macro.series[id], INDICATORS[id]); });

  const factors = [];
  let riskScore = 0;

  // 1. Pente 2s10s
  if (s.us10y && s.us2y) {
    const spread = s.us10y.latest.value - s.us2y.latest.value;
    const ok = spread > 0;
    riskScore += ok ? 1 : -1;
    factors.push(factor('Pente 2 ans / 10 ans', `${spread >= 0 ? '+' : ''}${spread.toFixed(2)} pt`, ok,
      ok ? 'Courbe normale — pas de signal de récession via l\'inversion.' : 'Courbe inversée — signal de prudence historique.'));
  }

  // 2. VIX
  if (s.vix) {
    const v = s.vix.latest.value;
    const status = v < 15 ? 'good' : v > 25 ? 'bad' : 'neutral';
    riskScore += status === 'good' ? 1 : status === 'bad' ? -1 : 0;
    factors.push(factor('Niveau du VIX', v.toFixed(1), status,
      status === 'good' ? 'Volatilité basse — appétit pour le risque.' : status === 'bad' ? 'Volatilité élevée — aversion au risque.' : 'Volatilité modérée.'));
  }

  // 3. Rendement réel 10 ans (tendance 1 mois)
  if (s.realYield10y && s.realYield10y.prevMid) {
    const d = s.realYield10y.latest.value - s.realYield10y.prevMid.value;
    const ok = d < 0; // baisse des rendements réels = plus accommodant
    riskScore += ok ? 1 : -1;
    factors.push(factor('Rendement réel 10 ans (1 mois)', `${d >= 0 ? '+' : ''}${d.toFixed(2)} pt`, ok,
      ok ? 'Conditions financières qui se détendent.' : 'Conditions financières qui se resserrent.'));
  }

  // 4. Tendance Fed Funds (~6 mois)
  let monetaryTag = 'Neutre';
  if (s.fedFunds && s.fedFunds.sparkPoints.length > 1) {
    const first = s.fedFunds.sparkPoints[0].value;
    const last = s.fedFunds.latest.value;
    const d = last - first;
    monetaryTag = d > 0.1 ? 'Resserrement monétaire' : d < -0.1 ? 'Assouplissement monétaire' : 'Taux stables';
    factors.push(factor('Tendance du taux directeur', `${d >= 0 ? '+' : ''}${d.toFixed(2)} pt (fenêtre affichée)`, d <= 0,
      monetaryTag));
  }

  // 5. Tendance CPI (inflation vs désinflation)
  let inflationTag = 'Stable';
  if (s.cpi && s.cpi.prevLong) {
    const yoyNow = pctDiff(s.cpi.latest.value, s.cpi.prevLong.value);
    inflationTag = yoyNow > 3 ? 'Inflation élevée' : yoyNow < 2 ? 'Proche de la cible' : 'Inflation modérée';
    factors.push(factor('CPI (glissement annuel)', `${yoyNow.toFixed(1)}%`, yoyNow < 3,
      inflationTag));
  }

  // 6. Tendance DXY (1 mois)
  if (s.dxy && s.dxy.prevMid) {
    const d = pctDiff(s.dxy.latest.value, s.dxy.prevMid.value);
    const ok = d < 0; // dollar plus faible = plus favorable au risque / à l'or / à la crypto
    riskScore += ok ? 1 : -1;
    factors.push(factor('Dollar (DXY, 1 mois)', `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`, ok,
      ok ? 'Dollar en repli — favorable aux actifs risqués et à l\'or.' : 'Dollar en hausse — vent contraire pour l\'or et le risque.'));
  }

  const badge = document.getElementById('regimeBadge');
  let label, cls;
  if (riskScore >= 2) { label = 'Risk-On'; cls = 'status-good'; }
  else if (riskScore <= -2) { label = 'Risk-Off'; cls = 'status-bad'; }
  else { label = 'Neutre'; cls = 'status-neutral'; }

  badge.className = `regime__badge ${cls}`;
  badge.textContent = `${label} · ${monetaryTag} · ${inflationTag}`;

  document.getElementById('regimeFactors').innerHTML = factors.join('');
}

function factor(label, value, okOrStatus, text) {
  const cls = okOrStatus === 'bad' ? 'status-bad' : okOrStatus === 'neutral' ? 'status-neutral' : okOrStatus ? 'status-good' : 'status-bad';
  return `<li><span class="factor-tag ${cls}">${value}</span><span><strong>${label}</strong> — ${text}</span></li>`;
}

// ---------- Synthèse or ----------

function renderGoldSynthesis(macro, date) {
  const s = {};
  ['realYield10y', 'dxy', 'vix', 'us10y'].forEach(id => { s[id] = computeStats(macro.series[id], INDICATORS[id]); });

  const pos = [], neg = [];

  if (s.realYield10y && s.realYield10y.prevMid) {
    const d = s.realYield10y.latest.value - s.realYield10y.prevMid.value;
    (d < 0 ? pos : neg).push(`Rendement réel 10 ans ${d < 0 ? 'en baisse' : 'en hausse'} sur le mois (coût d'opportunité de détenir de l'or ${d < 0 ? 'réduit' : 'accru'}).`);
  }
  if (s.dxy && s.dxy.prevMid) {
    const d = pctDiff(s.dxy.latest.value, s.dxy.prevMid.value);
    (d < 0 ? pos : neg).push(`Dollar ${d < 0 ? 'en repli' : 'en hausse'} sur le mois (${d.toFixed(1)}%).`);
  }
  if (s.vix) {
    (s.vix.latest.value > 20 ? pos : neg).push(`VIX à ${s.vix.latest.value.toFixed(1)} — ${s.vix.latest.value > 20 ? 'demande de valeur refuge possible' : 'faible demande de couverture'}.`);
  }

  const el = document.getElementById('goldSynthesis');
  el.innerHTML = `
    <h4>Facteurs favorables — au ${formatDateFr(date)}</h4>
    <ul>${pos.map(t => `<li class="pos">${t}</li>`).join('') || '<li>Aucun facteur favorable net identifié.</li>'}</ul>
    <h4>Facteurs défavorables</h4>
    <ul>${neg.map(t => `<li class="neg">${t}</li>`).join('') || '<li>Aucun facteur défavorable net identifié.</li>'}</ul>
    <p class="card__meta">Synthèse automatique basée sur des règles simples et documentées (voir marches.js) — ne constitue pas un conseil d'investissement.</p>
  `;
}

// ---------- Crypto ----------

function renderCryptoCard(symbol, result, macro, calendarEvents, date) {
  const containerId = { BTC: 'cryptoGrid', ETH: 'cryptoGrid', SOL: 'cryptoGrid' }[symbol];
  const grid = document.getElementById(containerId);
  let card = document.getElementById(`crypto-${symbol}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `crypto-${symbol}`;
    card.className = 'crypto-card';
    grid.appendChild(card);
  }

  if (result.status !== 'fulfilled' || !result.value.length) {
    card.innerHTML = `<div class="crypto-card__head"><span class="crypto-card__symbol">${symbol}</span></div><p class="card__na">Données indisponibles (CoinGecko)</p>`;
    return;
  }

  const points = result.value;
  const n = points.length;
  const latest = points[n - 1];
  const at = (daysBack) => points.find(p => p.date === shiftDate(date, -daysBack)) || points[Math.max(0, n - 1 - daysBack)];

  const d1 = at(1), d7 = at(7), d30 = at(30);
  const chg1 = d1 ? pctDiff(latest.value, d1.value) : null;
  const chg7 = d7 ? pctDiff(latest.value, d7.value) : null;
  const chg30 = d30 ? pctDiff(latest.value, d30.value) : null;

  // Volatilité (écart-type des rendements log journaliers, annualisée) et drawdown max sur la fenêtre
  const returns = [];
  let peak = points[0].value, maxDD = 0;
  for (let i = 1; i < n; i++) {
    returns.push(Math.log(points[i].value / points[i - 1].value));
    peak = Math.max(peak, points[i].value);
    maxDD = Math.min(maxDD, (points[i].value - peak) / peak);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length || 1);
  const annualVol = Math.sqrt(variance) * Math.sqrt(365) * 100;

  const events = calendarEvents.filter(e => e.category === 'crypto' && e.label.includes(symbol) && withinDays(e.date, date, 15));

  const monetaryBias = macro ? biasFromMacro(macro) : 'Non disponible';

  card.innerHTML = `
    <div class="crypto-card__head">
      <span class="crypto-card__symbol">${symbol}</span>
      <span class="card__meta">au ${formatDateFr(latest.date)}</span>
    </div>
    <p class="crypto-card__price">$${formatUsd(latest.value)}</p>
    <div class="crypto-card__stats">
      <div class="stat"><span>24h</span><span class="${chgClass(chg1)}">${fmtPct(chg1)}</span></div>
      <div class="stat"><span>7j</span><span class="${chgClass(chg7)}">${fmtPct(chg7)}</span></div>
      <div class="stat"><span>30j</span><span class="${chgClass(chg30)}">${fmtPct(chg30)}</span></div>
      <div class="stat"><span>Volatilité ann. (30j)</span><span>${annualVol.toFixed(0)}%</span></div>
      <div class="stat"><span>Drawdown max (35j)</span><span class="status-bad">${(maxDD * 100).toFixed(1)}%</span></div>
    </div>
    <div class="crypto-card__bias">
      <strong>Biais macro :</strong> ${monetaryBias}<br>
      <strong>Biais risque :</strong> ${annualVol > 80 ? 'Volatilité élevée' : annualVol > 40 ? 'Volatilité modérée' : 'Volatilité contenue'}
    </div>
    ${events.length ? `<ul class="crypto-card__events">${events.map(e => `<li>${formatDateFr(e.date)} — ${e.label}</li>`).join('')}</ul>` : ''}
  `;
}

function biasFromMacro(macro) {
  const dxy = computeStats(macro.series.dxy, INDICATORS.dxy);
  const vix = computeStats(macro.series.vix, INDICATORS.vix);
  if (!dxy || !vix) return 'Non disponible';
  const dxyTrend = dxy.prevMid ? pctDiff(dxy.latest.value, dxy.prevMid.value) : 0;
  if (vix.latest.value > 25) return 'Risk-off (VIX élevé) — vent contraire pour les actifs risqués.';
  if (dxyTrend < 0 && vix.latest.value < 20) return 'Risk-on (dollar faible, volatilité basse) — favorable.';
  return 'Neutre — signaux macro mixtes.';
}

// ---------- Calendrier ----------

function renderCalendar(events, filter) {
  const list = document.getElementById('calendarList');
  const filtered = filter === 'all' ? events : events.filter(e => e.category === filter);

  if (filter === 'europe') {
    list.innerHTML = '<li class="calendar-item">Calendrier BCE non couvert pour l\'instant dans cette version.</li>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<li class="calendar-item">Aucun événement dans cette fenêtre.</li>';
    return;
  }

  list.innerHTML = filtered.map(e => `
    <li class="calendar-item">
      <span class="calendar-item__date">${formatDateFr(e.date)}</span>
      <span class="calendar-item__body">
        ${e.label} <span class="factor-tag ${e.impact === 'high' ? 'status-bad' : 'status-neutral'}">${e.impact === 'high' ? 'fort impact' : 'impact modéré'}</span>
        <span class="calendar-item__timing">${timingFor(e.label)}</span>
      </span>
    </li>
  `).join('');
}

function timingFor(label) {
  if (/FOMC/i.test(label)) return 'Pendant la séance (~14h00 ET)';
  if (/CPI|NFP|emploi|PIB|PCE/i.test(label)) return 'Avant l\'ouverture (pré-marché, ~8h30 ET)';
  return 'Horaire variable (marché crypto 24/7)';
}

// ---------- News ----------

function renderNews(container, result) {
  if (result.status === 'rejected') {
    console.error('GDELT error:', result.reason);
    container.innerHTML = `<li class="news-item">Actualités indisponibles pour le moment (${escapeHtml(result.reason.message)}). Réessaie dans quelques secondes.</li>`;
    return;
  }
  if (!result.value.length) {
    container.innerHTML = '<li class="news-item">Aucun article trouvé pour cette fenêtre de dates.</li>';
    return;
  }
  container.innerHTML = result.value.slice(0, 6).map(a => `
    <li class="news-item">
      <a href="${a.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title || 'Article sans titre')}</a>
      <span class="news-meta">${escapeHtml(a.domain || '')} · ${formatSeenDate(a.seendate)}</span>
    </li>
  `).join('');
}

function formatSeenDate(seendate) {
  if (!seendate) return '';
  // Format GDELT: YYYYMMDDTHHMMSSZ
  const iso = `${seendate.slice(0,4)}-${seendate.slice(4,6)}-${seendate.slice(6,8)}`;
  return formatDateFr(iso);
}

// ---------- Utilitaires ----------

function formatDateFr(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}
function withinDays(dateA, dateB, days) {
  const diff = Math.abs(new Date(dateA) - new Date(dateB)) / 86400000;
  return diff <= days;
}
function fmtPct(v) { return v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
function chgClass(v) { return v === null || v === undefined ? '' : v >= 0 ? 'status-good' : 'status-bad'; }
function formatUsd(v) { return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2); }
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Chargement initial (aujourd'hui)
loadAll(dateInput.value);
