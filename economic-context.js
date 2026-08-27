// api/economic-context.js  (Vercel Serverless Function — Node.js runtime)
// Proxy serveur vers l'API FRED pour la page contexte-economique.html : la clé reste
// secrète (variable d'environnement Vercel), et FRED n'autorisant pas les appels CORS
// directs depuis le navigateur, ce passage par une fonction serverless est nécessaire.

const SERIES = {
  fedFunds: 'DFF',       // Taux des fed funds, quotidien
  cpi: 'CPIAUCSL',       // CPI, mensuel (indice — on calcule le glissement annuel)
  ppi: 'PPIACO',         // PPI, mensuel (indice — on calcule le glissement annuel)
  nfp: 'PAYEMS',         // Emploi non-agricole, mensuel (en milliers, on calcule la variation)
  vix: 'VIXCLS'          // VIX, quotidien (jours de bourse)
};

module.exports = async function handler(req, res) {
  const date = req.query.date;
  const apiKey = process.env.FRED_API_KEY;

  if (!date) {
    return res.status(400).json({ error: 'Paramètre "date" manquant.' });
  }
  if (!apiKey) {
    return res.status(500).json({ error: 'FRED_API_KEY non configurée sur Vercel.' });
  }

  try {
    const results = {};
    await Promise.all(Object.entries(SERIES).map(async ([key, seriesId]) => {
      results[key] = await fetchLatestPoint(seriesId, date, apiKey, key);
    }));

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(results);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};

// Récupère la dernière observation disponible à la date demandée (et la précédente,
// pour les séries mensuelles, afin de calculer une variation en glissement annuel simple).
async function fetchLatestPoint(seriesId, date, apiKey, key) {
  const url = `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}&api_key=${apiKey}&file_type=json` +
    `&observation_end=${date}&sort_order=desc&limit=13`;

  const r = await fetch(url);
  if (!r.ok) return { value: null, date: null };

  const data = await r.json();
  const obs = (data.observations || []).filter(o => o.value !== '.');
  if (!obs.length) return { value: null, date: null };

  const latest = obs[0];

  // CPI / PPI / NFP : on transforme l'indice/valeur brute en variation sur 12 mois
  if ((key === 'cpi' || key === 'ppi') && obs.length >= 13) {
    const yearAgo = obs[12];
    const pct = ((parseFloat(latest.value) - parseFloat(yearAgo.value)) / parseFloat(yearAgo.value)) * 100;
    return { value: pct.toFixed(1), date: latest.date };
  }
  if (key === 'nfp' && obs.length >= 2) {
    const prev = obs[1];
    const diffK = (parseFloat(latest.value) - parseFloat(prev.value));
    return { value: diffK.toFixed(0), date: latest.date };
  }

  return { value: parseFloat(latest.value).toFixed(2).replace(/\.00$/, ''), date: latest.date };
}
