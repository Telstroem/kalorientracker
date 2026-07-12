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

  function daysBetween(keyA, keyB) {
    return Math.round((dateFromKey(keyB) - dateFromKey(keyA)) / 86400000);
  }

  // ISO-Kalenderwoche zu einem Datums-Key.
  function isoWeek(key) {
    const d = dateFromKey(key);
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3); // Donnerstag der Woche
    const isoYear = t.getFullYear();
    const jan4 = new Date(isoYear, 0, 4);
    const week = 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return { year: isoYear, week };
  }

  // Wochenstatistik. dayStats: [{ key, kcal, protein, goal }] getrackte Tage aufsteigend,
  // trendEntries: [{ key, trend }] aufsteigend. Liefert Wochen absteigend (neueste zuerst):
  // { year, week, label, days, avgKcal, avgProtein, adherence, weightDelta|null }.
  function weeklyStats(dayStats, trendEntries) {
    const weeks = new Map();
    const wk = key => {
      const { year, week } = isoWeek(key);
      return `${year}-${String(week).padStart(2, '0')}`;
    };
    (dayStats || []).forEach(d => {
      const id = wk(d.key);
      if (!weeks.has(id)) {
        const { year, week } = isoWeek(d.key);
        weeks.set(id, { year, week, label: `KW ${week}`, kcal: 0, protein: 0, within: 0, days: 0, trend: [] });
      }
      const w = weeks.get(id);
      w.days++;
      w.kcal += d.kcal;
      w.protein += d.protein;
      if (d.kcal <= d.goal) w.within++;
    });
    (trendEntries || []).forEach(t => {
      const w = weeks.get(wk(t.key));
      if (w) w.trend.push(t);
    });
    return [...weeks.entries()]
      .sort((a, b) => a[0] < b[0] ? 1 : -1)
      .map(([, w]) => ({
        year: w.year,
        week: w.week,
        label: w.label,
        days: w.days,
        avgKcal: Math.round(w.kcal / w.days),
        avgProtein: Math.round(w.protein / w.days),
        adherence: w.within / w.days,
        weightDelta: w.trend.length >= 2
          ? Math.round((w.trend[w.trend.length - 1].trend - w.trend[0].trend) * 10) / 10
          : null
      }));
  }

  // Realer Verbrauch aus Essprotokoll + Gewichtstrend.
  // trendEntries: [{ key, trend }] aufsteigend, dayIntakes: [{ key, kcal }] getrackte Tage,
  // endKey: Fensterende (heute). Fenster: 28 Tage, min. 14 getrackte Tage,
  // >= 2 Wiegungen pro Woche über die Trendspanne. Rückgabe { tdee, confidence, days } | null.
  function calibratedTdee(trendEntries, dayIntakes, endKey) {
    if (!Array.isArray(trendEntries) || !Array.isArray(dayIntakes) || !endKey) return null;
    const startKey = keyShift(endKey, -27);
    const intakes = dayIntakes.filter(d => d.key >= startKey && d.key <= endKey);
    if (intakes.length < 14) return null;
    const trend = trendEntries.filter(t => t.key >= startKey && t.key <= endKey);
    if (trend.length < 4) return null;
    const first = trend[0];
    const last = trend[trend.length - 1];
    const spanDays = daysBetween(first.key, last.key);
    if (spanDays < 10) return null; // Trend muss einen relevanten Teil des Fensters abdecken
    if (trend.length < 2 * (spanDays / 7)) return null; // >= 2 Wiegungen/Woche
    const avgIntake = intakes.reduce((a, d) => a + d.kcal, 0) / intakes.length;
    const lossKg = first.trend - last.trend; // positiv = Abnahme
    const tdee = Math.round(avgIntake + lossKg * KCAL_PER_KG_FAT / spanDays);
    if (!isFinite(tdee) || tdee <= 0) return null;
    return {
      tdee,
      confidence: Math.min(intakes.length / 28, 1),
      days: intakes.length,
      avgIntake: Math.round(avgIntake),
      lossKg: Math.round(lossKg * 10) / 10
    };
  }

  // Effektiver TDEE: gedämpfte Mischung aus Formel und Beobachtung.
  // Beobachtungsgewicht wächst mit Datenmenge (days/56, max. 0,75),
  // Ergebnis hart auf ±25 % um den Formel-TDEE begrenzt.
  function effectiveTdee(formulaTdee, calibration) {
    if (!calibration || !isFinite(formulaTdee) || formulaTdee <= 0) {
      return { tdee: Math.round(formulaTdee), blended: false, weight: 0 };
    }
    const weight = Math.min(calibration.days / 56, 0.75);
    let mixed = formulaTdee * (1 - weight) + calibration.tdee * weight;
    mixed = Math.min(formulaTdee * 1.25, Math.max(formulaTdee * 0.75, mixed));
    return { tdee: Math.round(mixed), blended: true, weight };
  }

  // Begrenzte Drift: Zieländerung max. maxPerDay kcal je vergangenem Tag.
  function limitDrift(previous, next, daysElapsed, maxPerDay = 50) {
    if (previous == null || !isFinite(previous)) return Math.round(next);
    const maxDelta = Math.max(0, daysElapsed) * maxPerDay;
    return Math.round(Math.min(previous + maxDelta, Math.max(previous - maxDelta, next)));
  }

  function keyShift(key, delta) {
    const d = dateFromKey(key);
    d.setDate(d.getDate() + delta);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  return {
    ACTIVITY_FACTORS, ACTIVITY_LABELS, KCAL_PER_KG_FAT,
    ageFromBirthYear, bmr, tdee, calorieGoal, proteinGoal,
    dayDeficit, weightTrend, forecast, milestones, nextMilestone,
    isoWeek, weeklyStats, calibratedTdee, effectiveTdee, limitDrift
  };
})();
