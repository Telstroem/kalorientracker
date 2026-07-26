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
  const FIBER_GOAL_G = 30;

  // Akzeptiert deutsche ("12,5", "1.234,5") und punktdezimale ("12.5") Eingaben,
  // weist alles andere strikt ab (kein stiller Teil-Parse).
  function parseGermanFloat(str) {
    let s = String(str).trim();
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return parseFloat(s);
  }

  function fmtQty(n) {
    return String(Math.round(n * 10) / 10).replace('.', ',');
  }

  // Zahlen aus ANGEZEIGTEN Texten (Mengenangaben, Importzeilen). Anders als
  // parseGermanFloat wird hier "1.200" als Tausendergruppe gelesen – die App
  // formatiert Mengen selbst so, und "1.200 g" darf nicht als 1,2 g zurückkommen.
  function parseDisplayNumber(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10);
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return parseGermanFloat(s);
  }

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

  // Untergrenze: nie unter den Ruheumsatz. Ohne diese Kopplung konnte das Ziel über
  // eine tief kalibrierte Basis plus Watch-Abzug plus Defizit rechnerisch bei 1.000 kcal
  // landen – bei Franks BMR von rund 1.850 wäre das keine Diät mehr.
  function calorieGoal(tdeeValue, deficit, bmrValue) {
    const floor = (typeof bmrValue === 'number' && isFinite(bmrValue) && bmrValue > 0)
      ? Math.max(1200, Math.round(bmrValue))
      : 1000;
    return Math.max(floor, tdeeValue - deficit);
  }

  function proteinGoal(weightKg, gramsPerKg) {
    return Math.round(weightKg * gramsPerKg);
  }

  function dayDeficit(tdeeValue, eatenKcal) {
    return Math.round(tdeeValue - eatenKcal);
  }

  // entries: [{ key: 'YYYY-MM-DD', weight: number }] aufsteigend sortiert.
  // Liefert pro Eintrag den gleitenden Schnitt der Wiegewerte der letzten 7 Kalendertage.
  // Abgrenzung über Datumsschlüssel statt über Millisekunden: die Nacht der
  // Zeitumstellung hat 25 Stunden, wodurch das Fenster sonst sechs Tage lang
  // einen Messwert zu wenig enthielte.
  function weightTrend(entries) {
    const sorted = entries.slice().sort((a, b) => a.key < b.key ? -1 : 1);
    return sorted.map((entry, i) => {
      const startKey = keyShift(entry.key, -6);
      let sum = 0, count = 0;
      for (let j = i; j >= 0; j--) {
        if (sorted[j].key < startKey) break;
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

  // Prognose aus der gemessenen Trendsteigung statt aus dem Kalorienmittel.
  // slopePerDay: kg/Tag, negativ = Abnahme (aus trendSlope()).
  function forecastFromSlope(trendWeight, targetWeight, slopePerDay) {
    if (!isFinite(trendWeight) || !isFinite(slopePerDay) || slopePerDay >= 0) return null;
    const kgToLose = trendWeight - targetWeight;
    if (kgToLose <= 0) return null;
    const days = Math.round(kgToLose / -slopePerDay);
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

  // ---------- Körpermaße (reine Anzeige, ohne Einfluss aufs Kalorienziel) ----------

  function bmi(weightKg, heightCm) {
    if (!(weightKg > 0) || !(heightCm > 0)) return null;
    const value = weightKg / Math.pow(heightCm / 100, 2);
    if (!isFinite(value)) return null;
    return Math.round(value * 10) / 10;
  }

  function bmiCategory(value) {
    if (value == null || !isFinite(value)) return '';
    if (value < 18.5) return 'Untergewicht';
    if (value < 25) return 'Normalgewicht';
    if (value < 30) return 'Übergewicht';
    return 'Adipositas';
  }

  // Waist-to-Height-Ratio: Taillenumfang geteilt durch Körpergröße.
  // Ungerundet, damit die Einordnung nicht an der auf 2 Stellen gerundeten Anzeige hängt
  // (0,4996 wäre sonst „0,50" und damit erhöht, obwohl der Richtwert eingehalten ist).
  function whtr(waistCm, heightCm) {
    if (!(waistCm > 0) || !(heightCm > 0)) return null;
    const value = waistCm / heightCm;
    if (!isFinite(value)) return null;
    return value;
  }

  function whtrCategory(value) {
    if (value == null || !isFinite(value)) return '';
    if (value < 0.5) return 'unauffällig';
    if (value < 0.6) return 'erhöht';
    return 'deutlich erhöht';
  }

  // Wünschenswerter BMI nach Altersgruppe (NRC-Tabelle, in Deutschland über die
  // DGE verbreitet). Die WHO-Klassen (18,5/25/30) gelten altersunabhängig und
  // bleiben in bmiCategory() erhalten – hier steht die altersgerechte Einordnung.
  const BMI_AGE_RANGES = [
    { maxAge: 24, min: 19, max: 24 },
    { maxAge: 34, min: 20, max: 25 },
    { maxAge: 44, min: 21, max: 26 },
    { maxAge: 54, min: 22, max: 27 },
    { maxAge: 64, min: 23, max: 28 },
    { maxAge: Infinity, min: 24, max: 29 }
  ];

  function bmiRangeForAge(age) {
    if (age == null || !isFinite(age)) return null;
    const row = BMI_AGE_RANGES.find(r => age <= r.maxAge) || BMI_AGE_RANGES[BMI_AGE_RANGES.length - 1];
    return { min: row.min, max: row.max };
  }

  function bmiCategoryForAge(value, age) {
    const range = bmiRangeForAge(age);
    if (value == null || !isFinite(value) || !range) return null;
    if (value < range.min) return { level: 'below', text: 'unter dem Wunschbereich', range };
    if (value <= range.max) return { level: 'in', text: 'im Wunschbereich', range };
    if (value <= range.max + 3) return { level: 'above', text: 'über dem Wunschbereich', range };
    return { level: 'far', text: 'deutlich über dem Wunschbereich', range };
  }

  // Altersangepasste WHtR-Schwelle (Ashwell): bis 40 Jahre 0,50, danach je
  // Lebensjahr +0,01, ab 50 Jahre konstant 0,60.
  function whtrThreshold(age) {
    if (age == null || !isFinite(age)) return null;
    if (age <= 40) return 0.5;
    if (age >= 50) return 0.6;
    return 0.5 + 0.01 * (age - 40);
  }

  function whtrCategoryForAge(value, age) {
    const threshold = whtrThreshold(age);
    if (value == null || !isFinite(value) || threshold === null) return null;
    if (value < threshold) return { level: 'in', text: 'unauffällig', threshold };
    if (value < threshold + 0.1) return { level: 'above', text: 'erhöht', threshold };
    return { level: 'far', text: 'deutlich erhöht', threshold };
  }

  // ---------- Mengentexte (Mengen-Umrechner) ----------

  const UNIT_AFTER_RE = /^\s*(kg|g|ml|l)\b/i;

  // Alle Zahlen eines Mengentexts mit Position, Rohtext und ggf. folgender Einheit.
  // "1 Portion (30 g)" → [{value:1,…,unit:''},{value:30,…,unit:'g'}]
  function quantityNumbers(text) {
    const s = String(text == null ? '' : text);
    // Tausendergruppen zuerst, sonst würde "1.200" als "1" + ".200" zerfallen.
    const re = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      const value = parseDisplayNumber(m[0]);
      if (value === null) continue;
      const unitMatch = s.slice(m.index + m[0].length).match(UNIT_AFTER_RE);
      out.push({ value, index: m.index, raw: m[0], unit: unitMatch ? unitMatch[1].toLowerCase() : '' });
    }
    return out;
  }

  function qtyValue(n) {
    if (typeof n === 'number') return n;
    return n && typeof n.value === 'number' ? n.value : null;
  }

  // Hat sich beim Editieren GENAU eine Zahl geändert, gilt deren Verhältnis als Faktor.
  // Sonst null (kein Faktor ableitbar → keine stille Umrechnung).
  function diffFactor(oldList, newList) {
    if (!Array.isArray(oldList) || !Array.isArray(newList)) return null;
    if (oldList.length === 0 || oldList.length !== newList.length) return null;
    let changed = -1;
    for (let i = 0; i < oldList.length; i++) {
      const a = qtyValue(oldList[i]);
      const b = qtyValue(newList[i]);
      if (a === null || b === null) return null;
      if (a !== b) {
        if (changed >= 0) return null;
        changed = i;
      }
    }
    if (changed < 0) return null;
    const from = qtyValue(oldList[changed]);
    const to = qtyValue(newList[changed]);
    if (!(from > 0) || !(to > 0)) return null;
    const factor = to / from;
    return isFinite(factor) && factor > 0 ? factor : null;
  }

  // Skaliert die erste Zahl, auf die eine Massen-/Volumeneinheit folgt, sonst die erste Zahl.
  // "1 Portion (30 g)" ×½ → "1 Portion (15 g)"; "2 Stück" ×½ → "1 Stück". null ohne Zahl.
  function scaleAnchor(text, factor) {
    const s = String(text == null ? '' : text);
    if (!(factor > 0) || !isFinite(factor)) return null;
    const nums = quantityNumbers(s);
    if (nums.length === 0) return null;
    const target = nums.find(n => n.unit) || nums[0];
    if (!(target.value > 0)) return null;
    return s.slice(0, target.index) + fmtQty(target.value * factor) + s.slice(target.index + target.raw.length);
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

  // Least-Squares-Steigung des Gewichtstrends in kg/Tag über ALLE Punkte des Fensters
  // (unempfindlich gegen einen Wasser-Ausreißer am Fensterrand) samt Residuenstreuung.
  // trendEntries: [{ key, trend }] aufsteigend. Rückgabe { slope, … } | null.
  function trendSlope(trendEntries) {
    const pts = (trendEntries || []).filter(e =>
      e && typeof e.key === 'string' && typeof e.trend === 'number' && isFinite(e.trend));
    if (pts.length < 3) return null;
    const xs = pts.map(e => daysBetween(pts[0].key, e.key));
    const ys = pts.map(e => e.trend);
    const n = pts.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i] - mx) * (xs[i] - mx);
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (!(sxx > 0)) return null;
    const slope = sxy / sxx;               // negativ = Abnahme
    const intercept = my - slope * mx;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const r = ys[i] - (intercept + slope * xs[i]);
      sse += r * r;
    }
    const variance = n > 2 ? sse / (n - 2) : 0;
    return {
      slope,
      intercept,
      n,
      spanDays: xs[n - 1] - xs[0],
      residualSd: Math.sqrt(variance),
      slopeSe: Math.sqrt(variance / sxx)
    };
  }

  // Prüft das Kalibrierfenster und liefert die Diagnose (auch für den Statustext).
  // reason: null = brauchbar, sonst 'no-data' | 'few-days' | 'few-weighings' | 'short-span' | 'coverage'.
  function calibrationWindow(trendEntries, dayIntakes, endKey) {
    const out = { reason: 'no-data', trackedDays: 0, spanDays: 0, windowDays: 0, trackedInSpan: 0, coverage: 0 };
    if (!Array.isArray(trendEntries) || !Array.isArray(dayIntakes) || !endKey) return out;
    const startKey = keyShift(endKey, -27);
    const intakes = dayIntakes.filter(d => d.key >= startKey && d.key <= endKey);
    const trend = trendEntries.filter(t => t.key >= startKey && t.key <= endKey);
    out.trackedDays = intakes.length;
    if (intakes.length < 14) { out.reason = 'few-days'; return out; }
    if (trend.length < 4) { out.reason = 'few-weighings'; return out; }
    const first = trend[0];
    const last = trend[trend.length - 1];
    const spanDays = daysBetween(first.key, last.key);
    out.spanDays = spanDays;
    if (spanDays < 10) { out.reason = 'short-span'; return out; }
    if (trend.length < 2 * (spanDays / 7)) { out.reason = 'few-weighings'; return out; }
    const inSpan = intakes.filter(d => d.key >= first.key && d.key <= last.key);
    out.windowDays = spanDays + 1;
    out.trackedInSpan = inSpan.length;
    out.coverage = inSpan.length / out.windowDays;
    if (out.coverage < 0.75) { out.reason = 'coverage'; return out; }
    // Mindestens 14 Tage müssen INNERHALB der Wiege-Spanne liegen: nur dort ist die
    // Aufnahme durch eine gemessene Gewichtsänderung gedeckt.
    if (inSpan.length < 14) { out.reason = 'few-days'; return out; }
    out.reason = null;
    out.intakes = inSpan;
    out.trend = trend;
    return out;
  }

  // Realer Verbrauch aus Essprotokoll + Gewichtstrend.
  // Ø-Aufnahme und Gewichtssteigung müssen denselben Zeitraum abdecken – sonst geht
  // eine Phase, in der zwar gegessen, aber nicht gewogen wurde (Urlaub), voll in den
  // Verbrauch ein. Deshalb rechnet avgIntake über win.intakes = die Wiege-Spanne.
  // trendEntries: [{ key, trend }] aufsteigend, dayIntakes: [{ key, kcal }] getrackte Tage,
  // endKey: Fensterende (heute). Fenster: 28 Tage, min. 14 getrackte Tage in der Spanne,
  // >= 2 Wiegungen pro Woche, mindestens 75 % der Spanntage erfasst.
  // rawEntries: [{ key, weight }] – die ungeglätteten Wiegewerte. Sie liefern das
  // Unsicherheitsband: die Residuen der 7-Tage-Trendpunkte sind stark autokorreliert,
  // ihr Standardfehler fiele rund dreimal zu klein aus und würde eine Genauigkeit
  // vortäuschen, die nicht da ist. Steigung und TDEE kommen weiter aus dem Trend.
  // Rückgabe { tdee, uncertainty, coverage, … } | null.
  function calibratedTdee(trendEntries, dayIntakes, endKey, rawEntries) {
    const win = calibrationWindow(trendEntries, dayIntakes, endKey);
    if (win.reason) return null;
    const fit = trendSlope(win.trend);
    if (!fit) return null;
    const avgIntake = win.intakes.reduce((a, d) => a + d.kcal, 0) / win.intakes.length;
    const lossPerDay = -fit.slope; // positiv = Abnahme
    const tdee = Math.round(avgIntake + lossPerDay * KCAL_PER_KG_FAT);
    if (!isFinite(tdee) || tdee <= 0) return null;
    const firstKey = win.trend[0].key;
    const lastKey = win.trend[win.trend.length - 1].key;
    const rawFit = Array.isArray(rawEntries)
      ? trendSlope(rawEntries
        .filter(e => e && e.key >= firstKey && e.key <= lastKey)
        .map(e => ({ key: e.key, trend: e.weight })))
      : null;
    // Tagesgewichte sind stark autokorreliert (Wasser, Glykogen halten mehrere Tage).
    // Der iid-Standardfehler unterschätzt die Streuung dadurch etwa um die Hälfte;
    // Faktor 2 bringt das Band auf die tatsächlich beobachtete Schwankungsbreite.
    const AUTOCORR_FACTOR = 2;
    const band = (rawFit || fit).slopeSe * KCAL_PER_KG_FAT * AUTOCORR_FACTOR;
    return {
      tdee,
      confidence: Math.min(win.intakes.length / 28, 1),
      days: win.intakes.length,
      avgIntake: Math.round(avgIntake),
      lossKg: Math.round(lossPerDay * fit.spanDays * 10) / 10,
      spanDays: fit.spanDays,
      coverage: win.coverage,
      trackedInSpan: win.trackedInSpan,
      windowDays: win.windowDays,
      uncertainty: isFinite(band) ? Math.round(band / 10) * 10 : null
    };
  }

  // Effektiver TDEE: gedämpfte Mischung aus Formel und Beobachtung.
  // Beobachtungsgewicht wächst mit Datenmenge (days/28, max. 0,75),
  // Ergebnis hart auf ±25 % um den Formel-TDEE begrenzt.
  // days ist die Zahl getrackter Tage im 28-Tage-Fenster und damit <= 28: der Nenner
  // muss 28 sein, damit der Deckel von 0,75 überhaupt erreichbar ist — mit dem
  // ursprünglichen /56 lag das Gewicht strukturell nie über 0,5 (Fix aus v1.5).
  function effectiveTdee(formulaTdee, calibration) {
    if (!calibration || !isFinite(formulaTdee) || formulaTdee <= 0) {
      return { tdee: Math.round(formulaTdee), blended: false, weight: 0 };
    }
    const weight = Math.min(calibration.days / 28, 0.75);
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

  // ---------- Apple-Watch-Aktivkalorien ----------

  // Ø der zuletzt erfassten (max. 28) Tage bis einschließlich endKey.
  function activeEnergyStats(map, endKey) {
    const source = map || {};
    const keys = Object.keys(source)
      .filter(k => (!endKey || k <= endKey) && typeof source[k] === 'number' && isFinite(source[k]))
      .sort()
      .slice(-28);
    if (keys.length === 0) return { avg: null, count: 0 };
    return { avg: keys.reduce((a, k) => a + source[k], 0) / keys.length, count: keys.length };
  }

  // Nur die ABWEICHUNG vom eigenen Durchschnitt zählt (die mittlere Aktivität steckt
  // bereits im Aktivitätsfaktor bzw. in der Kalibrierung – sonst Doppelzählung).
  // Halbe Gewichtung, hart auf ±400 kcal gedeckelt, erst ab 7 erfassten Tagen aktiv.
  function activityAdjustment(activeToday, avgActive, sampleCount) {
    if (typeof activeToday !== 'number' || !isFinite(activeToday)) return 0;
    if (typeof avgActive !== 'number' || !isFinite(avgActive)) return 0;
    if (!(sampleCount >= 7)) return 0;
    const raw = 0.5 * (activeToday - avgActive);
    return Math.round(Math.max(-400, Math.min(400, raw)));
  }

  function padNum(n) { return String(n).padStart(2, '0'); }

  function validDateKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    if (!(y >= 1900 && y <= 2999) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return key;
  }

  // '2026-07-25', '25.07.2026', '25.07.' / '25.07' (Jahr aus refKey, sonst Vorjahr).
  function parseDateToken(token, refKey) {
    const t = String(token).trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return validDateKey(`${m[1]}-${padNum(Number(m[2]))}-${padNum(Number(m[3]))}`);
    m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return validDateKey(`${m[3]}-${padNum(Number(m[2]))}-${padNum(Number(m[1]))}`);
    m = t.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (m && refKey) {
      const year = Number(refKey.slice(0, 4));
      const mmdd = `${padNum(Number(m[2]))}-${padNum(Number(m[1]))}`;
      let key = `${year}-${mmdd}`;
      // Ein Datum knapp in der Zukunft ist ein Tippfehler oder eine Zeitzonenkante,
      // kein Eintrag vom Vorjahr – nur deutlich spätere Daten aufs Vorjahr ziehen.
      if (key > refKey && daysBetween(refKey, key) > 3) key = `${year - 1}-${mmdd}`;
      return validDateKey(key);
    }
    return null;
  }

  function parseKcalToken(token) {
    return parseDisplayNumber(token);
  }

  // Zeilenparser für den Sammel-Import der Aktivkalorien.
  // Rückgabe { entries: [{ key, kcal }], unclear: [Zeile], duplicates } – nichts wird still verworfen.
  function parseActiveEnergyLines(text, refKey) {
    const byKey = new Map();
    const unclear = [];
    let duplicates = 0;
    String(text == null ? '' : text).split(/\r?\n/).forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) return;
      const parts = line.split(/[\t;]+|\s+/).filter(Boolean);
      if (parts.length < 2) { unclear.push(line); return; }
      const key = parseDateToken(parts[0], refKey);
      // Mehrdeutige Zeilen ("640 kcal von 700 kcal Ziel") lieber melden, als still
      // die falsche Zahl zu nehmen.
      const numbers = parts.slice(1).map(parseKcalToken).filter(n => n !== null);
      const kcal = numbers.length === 1 ? numbers[0] : null;
      if (key === null || kcal === null || kcal < 0 || kcal > 10000) { unclear.push(line); return; }
      if (byKey.has(key)) duplicates++;
      byKey.set(key, Math.round(kcal));
    });
    const entries = [...byKey.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([key, kcal]) => ({ key, kcal }));
    return { entries, unclear, duplicates };
  }

  function keyShift(key, delta) {
    const d = dateFromKey(key);
    d.setDate(d.getDate() + delta);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  return {
    ACTIVITY_FACTORS, ACTIVITY_LABELS, KCAL_PER_KG_FAT, FIBER_GOAL_G,
    parseGermanFloat, parseDisplayNumber, fmtQty,
    ageFromBirthYear, bmr, tdee, calorieGoal, proteinGoal,
    dayDeficit, weightTrend, forecast, forecastFromSlope, milestones, nextMilestone,
    bmi, bmiCategory, whtr, whtrCategory,
    bmiRangeForAge, bmiCategoryForAge, whtrThreshold, whtrCategoryForAge,
    quantityNumbers, diffFactor, scaleAnchor,
    isoWeek, weeklyStats, trendSlope, calibrationWindow, calibratedTdee,
    effectiveTdee, limitDrift,
    activeEnergyStats, activityAdjustment, parseActiveEnergyLines, parseKcalToken
  };
})();
