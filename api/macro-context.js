// api/macro-context.js  (Vercel Serverless Function — Node.js runtime)
//
// Renvoie l'historique récent (jusqu'à la date demandée) de chaque série macro/marché
// utilisée par le dashboard "Or & Crypto".
//
// ANTI-LOOK-AHEAD BIAS — POINT CRITIQUE :
// FRED conserve un historique des "vintages" de publication (projet ALFRED). Par défaut,
// l'API /fred/series/observations renvoie la valeur RÉVISÉE la plus récente pour chaque
// période, ce qui provoquerait une fuite d'information future dans un backtest (ex : le
// CPI de janvier tel que révisé aujourd'hui, au lieu du chiffre tel qu'il a été publié
// à l'époque). Pour l'éviter, on fixe explicitement :
//   realtime_start = date demandée
//   realtime_end   = date demandée
// Ce paramètre indique à FRED : "donne-moi les données telles qu'elles étaient
// connues/publiées à cette date précise", ce qui reconstitue fidèlement l'information
// réellement disponible ce jour-là. On ajoute aussi observation_end=date par sécurité.
//
// La clé API reste ici, côté serveur — jamais exposée au navigateur.

const SERIES_MAP = {
  // Taux & liquidité
  fedFunds: 'DFF',
  us2y: 'DGS2',
  us10y: 'DGS10',
  realYield10y: 'DFII10',
  fedBalanceSheet: 'WALCL',

  // Inflation & croissance
  cpi: 'CPIAUCSL',
  coreCpi: 'CPILFESL',
  pce: 'PCEPI',
  corePce: 'PCEPILFE',
  unemployment: 'UNRATE',
  nfp: 'PAYEMS',
  retailSales: 'RSXFS',

  // Marchés transversaux
  dxy: 'DTWEXBGS',
  vix: 'VIXCLS',
  sp500: 'SP500',
  nasdaq: 'NASDAQCOM',
  wti: 'DCOILWTICO',
  copper: 'PCOPPUSDM',
  gold: 'GOLDPMGBD228NLBM' // Série interrompue par la BoE/LBMA en 2015 — voir note renvoyée
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
    const entries = await Promise.all(
      Object.entries(SERIES_MAP).map(async ([id, seriesId]) => {
        const points = await fetchSeries(seriesId, date, apiKey);
        return [id, points];
      })
    );

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      asOf: date,
      series: Object.fromEntries(entries),
      notes: {
        gold: 'Série GOLDPMGBD228NLBM interrompue depuis le 30/03/2015 (fixing LBMA). Non disponible au-delà de cette date via FRED.',
        copper: 'Série mensuelle (FMI, PCOPPUSDM) — pas de fréquence quotidienne fiable gratuite trouvée.',
        sp500: 'Série FRED "SP500" ne remonte qu\'à 2015 — historique plus ancien non disponible sur cette source.'
      }
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};

async function fetchSeries(seriesId, date, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${seriesId}&api_key=${apiKey}&file_type=json` +
    `&realtime_start=${date}&realtime_end=${date}` + // vintage connue à "date" — anti look-ahead
    `&observation_end=${date}&sort_order=desc&limit=40`;

  const r = await fetch(url);
  if (!r.ok) return [];

  const data = await r.json();
  const obs = (data.observations || [])
    .filter(o => o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse(); // ordre chronologique croissant, plus pratique côté client

  return obs;
}
