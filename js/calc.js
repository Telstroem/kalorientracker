'use strict';

const Calc = (() => {

  const ACTIVITY_FACTORS = [1.2, 1.375, 1.55, 1.725, 1.9];

  const ACTIVITY_LABELS = [
    { name: 'Kaum aktiv', desc: 'Sitzende Tätigkeit, wenig oder kein Sport' },
    { name: 'Leicht aktiv', desc: 'Überwiegend sitzend, 1–2× Sport pro Woche' },
    { name: 'Mäßig aktiv', desc: 'Teils stehend/gehend, 2–3× Sport pro Woche' },
    { name: 'Sehr aktiv', desc: 'Körperlich fordernder Alltag oder 4–5× Sport' },
    { name: 'Extrem aktiv', desc: 'Schwere körperliche Arbeit oder tägliches Training' }
  ];

  const KCAL_PER_KG_FAT = 7700;

  function ageFromBirthYear(birthYear, refDate) {
    const now = refDate || new Date();
    return Math.max(10, Math.min(120, now.getFullYear() - birthYear));
  }

  function bmr(sex, weightKg, heightCm, age) {
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    return Math.round(sex === 'm' ? base + 5 : base - 161);
  }

  function tdee(bmrValue, activityIndex) {
    const factor = ACTIVITY_FACTORS[activityIndex] || ACTIVITY_FACTORS[0];
    return Math.round(bmrValue * factor);
  }

  function calorieGoal(tdeeValue, deficit) {
    return Math.max(1000, tdeeValue - deficit);
  }

  function proteinGoal(weightKg, gramsPerKg) {
    return Math.round(weightKg * gramsPerKg);
  }

  function dayDeficit(tdeeValue, eatenKcal) {
    return Math.round(tdeeValue - eatenKcal);
  }

  // entries: [{ key: 'YYYY-MM-DD', weight: number }] aufsteigend sortiert.
  // Liefert pro Eintrag den gleitenden Schnitt der Wiegewerte der letzten 7 Kalendertage.
  function weightTrend(entries) {
    const sorted = entries.slice().sort((a, b) => a.key < b.key ? -1 : 1);
    return sorted.map((entry, i) => {
      const end = dateFromKey(entry.key).getTime();
      const start = end - 6 * 86400000;
      let sum = 0, count = 0;
      for (let j = i; j >= 0; j--) {
        const t = dateFromKey(sorted[j].key).getTime();
        if (t < start) break;
        sum += sorted[j].weight;
        count++;
      }
      return { key: entry.key, weight: entry.weight, trend: sum / count };
    });
  }

  // Prognose: wann ist das Zielgewicht erreicht?
  // trendWeight: aktueller 7-Tage-Trend, avgDeficit: Ø-Defizit der letzten getrackten Tage,
  // trackedDays: Anzahl der einbezogenen Tage.
  function forecast(trendWeight, targetWeight, avgDeficit, trackedDays) {
    if (trackedDays < 5 || avgDeficit <= 0) return null;
    const kgToLose = trendWeight - targetWeight;
    if (kgToLose <= 0) return null;
    const days = Math.round(kgToLose * KCAL_PER_KG_FAT / avgDeficit);
    if (!isFinite(days) || days <= 0 || days > 3650) return null;
    const date = new Date();
    date.setDate(date.getDate() + days);
    return { days, date };
  }

  // Meilensteine: volle kg-Schwellen zwischen Start- und Zielgewicht (nur Abnahme).
  // Erreicht am ersten Tag, an dem der 7-Tage-Trend die Schwelle unterschreitet.
  // trendEntries: [{ key, weight, trend }] aufsteigend (aus weightTrend()).
  // Liefert [{ threshold, key, trend }] absteigend nach Schwelle.
  function milestones(trendEntries, startWeight, targetWeight) {
    const result = [];
    if (!Array.isArray(trendEntries) || trendEntries.length === 0) return result;
    if (!(startWeight > targetWeight)) return result;
    let threshold = Math.floor(startWeight);
    if (threshold >= startWeight) threshold -= 1;
    for (; threshold >= targetWeight; threshold--) {
      const hit = trendEntries.find(e => e.trend < threshold);
      if (!hit) break; // tiefere Schwellen können dann auch nicht erreicht sein
      result.push({ threshold, key: hit.key, trend: hit.trend });
    }
    return result;
  }

  // Nächste volle kg-Schwelle unterhalb des aktuellen Trends (Untergrenze: Zielgewicht).
  function nextMilestone(currentTrend, targetWeight) {
    if (currentTrend == null || !isFinite(currentTrend)) return null;
    if (currentTrend <= targetWeight) return { reached: true };
    let threshold = Math.floor(currentTrend);
    if (threshold >= currentTrend) threshold -= 1;
    if (threshold < targetWeight) threshold = targetWeight;
    return { reached: false, threshold, remaining: currentTrend - threshold };
  }

  function dateFromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  return {
    ACTIVITY_FACTORS, ACTIVITY_LABELS, KCAL_PER_KG_FAT,
    ageFromBirthYear, bmr, tdee, calorieGoal, proteinGoal,
    dayDeficit, weightTrend, forecast, milestones, nextMilestone
  };
})();
