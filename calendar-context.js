// api/calendar-context.js  (Vercel Serverless Function — Node.js runtime)
//
// Calendrier économique autour d'une date donnée.
//
// - CPI, NFP (Employment Situation), PCE, PIB (GDP) : dates de publication RÉELLES,
//   récupérées dynamiquement via l'API FRED (on résout d'abord le release_id associé à
//   chaque série avec /fred/series/release, puis on liste ses dates réelles avec
//   /fred/release/dates). Ce sont les vraies dates historiques de publication, pas des
//   estimations.
// - FOMC (décisions de taux) : liste statique — les dates de réunion du FOMC sont un
//   calendrier public fixé à l'avance par la Fed, non disponible via une API FRED
//   dédiée. Source : calendrier officiel federalreserve.gov. À mettre à jour à la main
//   si tu veux couvrir des dates plus anciennes ou plus récentes.
// - Événements crypto (halving, ETF, mises à jour de protocole, incidents réseau) :
//   liste statique et volontairement limitée à des faits publics et datés. Aucune
//   invention : si un événement n'y figure pas, il n'apparaîtra simplement pas.
// - BCE : non couvert dans cette première version (voir note renvoyée par la fonction).

const FRED_SERIES_FOR_CALENDAR = {
  CPI: 'CPIAUCSL',
  NFP: 'PAYEMS',
  PCE: 'PCEPI',
  PIB: 'GDP'
};

// Réunions FOMC (date d'annonce de la décision, jour 2 du meeting). À compléter au besoin.
const FOMC_DATES = [
  '2023-02-01','2023-03-22','2023-05-03','2023-06-14','2023-07-26','2023-09-20','2023-11-01','2023-12-13',
  '2024-01-31','2024-03-20','2024-05-01','2024-06-12','2024-07-31','2024-09-18','2024-11-07','2024-12-18',
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30','2025-09-17','2025-10-29','2025-12-10',
  '2026-01-28','2026-03-18'
];

// Événements crypto publics et documentés (à titre indicatif, liste non exhaustive).
const CRYPTO_EVENTS = [
  { date: '2022-09-15', label: 'Ethereum "The Merge" (passage au Proof-of-Stake)', asset: 'ETH', impact: 'high' },
  { date: '2022-11-11', label: 'Faillite de FTX (dépôt de bilan)', asset: 'BTC', impact: 'high' },
  { date: '2024-01-10', label: 'Approbation des ETF Bitcoin spot par la SEC', asset: 'BTC', impact: 'high' },
  { date: '2024-02-06', label: 'Panne réseau Solana (~5h)', asset: 'SOL', impact: 'medium' },
  { date: '2024-04-20', label: 'Bitcoin Halving (4e)', asset: 'BTC', impact: 'high' },
  { date: '2024-07-23', label: 'Lancement des ETF Ethereum spot aux États-Unis', asset: 'ETH', impact: 'high' }
];

module.exports = async function handler(req, res) {
  const date = req.query.date;
  const apiKey = process.env.FRED_API_KEY;

  if (!date) {
    return res.status(400).json({ error: 'Paramètre "date" manquant.' });
  }
  if (!apiKey) {
    return res.status(500).json({ error: 'FRED_API_KEY non configurée sur Vercel.' });
  }

  const windowStart = shiftDate(date, -21);
  const windowEnd = shiftDate(date, 21);

  try {
    const usReleases = await Promise.all(
      Object.entries(FRED_SERIES_FOR_CALENDAR).map(async ([label, seriesId]) => {
        const dates = await fetchReleaseDatesForSeries(seriesId, windowStart, windowEnd, apiKey);
        return dates.map(d => ({ date: d, label: releaseLabel(label), category: 'us', impact: 'high', source: 'FRED' }));
      })
    );

    const fomcEvents = FOMC_DATES
      .filter(d => d >= windowStart && d <= windowEnd)
      .map(d => ({ date: d, label: 'Décision de taux FOMC', category: 'us', impact: 'high', source: 'statique' }));

    const cryptoEvents = CRYPTO_EVENTS
      .filter(e => e.date >= windowStart && e.date <= windowEnd)
      .map(e => ({ date: e.date, label: `${e.label} (${e.asset})`, category: 'crypto', impact: e.impact, source: 'statique' }));

    const events = [...usReleases.flat(), ...fomcEvents, ...cryptoEvents]
      .sort((a, b) => a.date.localeCompare(b.date));

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      windowStart,
      windowEnd,
      events,
      notes: {
        europe: 'Calendrier BCE non couvert dans cette version.',
        fomc: 'Dates FOMC en liste statique, à jour jusqu\'à début 2026.',
        cryptoEvents: 'Liste d\'événements crypto non exhaustive, mise à jour manuelle.'
      }
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};

function releaseLabel(key) {
  return { CPI: 'Publication CPI', NFP: 'Rapport emploi (NFP)', PCE: 'Publication PCE', PIB: 'Publication PIB (GDP)' }[key] || key;
}

async function fetchReleaseDatesForSeries(seriesId, start, end, apiKey) {
  const relUrl = `https://api.stlouisfed.org/fred/series/release?series_id=${seriesId}&api_key=${apiKey}&file_type=json`;
  const relRes = await fetch(relUrl);
  if (!relRes.ok) return [];
  const relData = await relRes.json();
  const releaseId = relData.releases && relData.releases[0] && relData.releases[0].id;
  if (!releaseId) return [];

  const datesUrl = `https://api.stlouisfed.org/fred/release/dates?release_id=${releaseId}&api_key=${apiKey}&file_type=json` +
    `&realtime_start=${start}&realtime_end=${end}&include_release_dates_with_no_data=false`;
  const datesRes = await fetch(datesUrl);
  if (!datesRes.ok) return [];
  const datesData = await datesRes.json();
  return (datesData.release_dates || []).map(r => r.date);
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}
