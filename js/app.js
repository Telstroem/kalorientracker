'use strict';

(() => {

  // ---------- Helfer ----------

  const $ = sel => document.querySelector(sel);
  const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const NFx = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const NF2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const esc = s => String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const fmtKcal = n => NF0.format(Math.round(n));
  const fmtKg = n => NF1.format(n);
  const fmtG = n => NF0.format(Math.round(n));

  function keyFromDate(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const todayKey = () => keyFromDate(new Date());
  function dateFromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(key, n) {
    const d = dateFromKey(key);
    d.setDate(d.getDate() + n);
    return keyFromDate(d);
  }
  function fmtDayLabel(key) {
    const t = todayKey();
    const date = dateFromKey(key);
    const dm = date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
    if (key === t) return `Heute, ${dm}`;
    if (key === addDays(t, -1)) return `Gestern, ${dm}`;
    return date.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'long' });
  }
  function fmtDateShort(key) {
    return dateFromKey(key).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  }

  // ---------- Zustand ----------

  let data = Storage.load();
  let currentDay = todayKey();
  let activeTab = 'today';
  let weightRange = '3m';
  let weightDate = todayKey();
  let sheet = null;   // { meal, tab, query, food, editing, ai: {...} }
  let ob = null;      // Onboarding: { step, values }
  let activeEdit = false;             // Inline-Feld für Aktivkalorien im Heute-Tab
  let watchImport = { text: '', result: null }; // Sammel-Import Aktivkalorien

  const MEALS = [
    { id: 'breakfast', label: 'Frühstück' },
    { id: 'lunch', label: 'Mittagessen' },
    { id: 'dinner', label: 'Abendessen' },
    { id: 'snacks', label: 'Snacks' }
  ];
  const DEFICITS = [
    { value: 0, label: 'Gewicht halten', desc: 'Kein Defizit' },
    { value: 250, label: '−250 kcal/Tag', desc: '≈ 0,25 kg pro Woche' },
    { value: 500, label: '−500 kcal/Tag', desc: '≈ 0,5 kg pro Woche' },
    { value: 750, label: '−750 kcal/Tag', desc: '≈ 0,75 kg pro Woche' }
  ];

  // ---------- Abgeleitete Daten ----------

  function persist() { Storage.save(data); }

  function emptyMeals() {
    return { breakfast: [], lunch: [], dinner: [], snacks: [] };
  }
  function getDay(key) {
    return data.days[key] || { meals: emptyMeals() };
  }
  function ensureDay(key) {
    if (!data.days[key]) data.days[key] = { meals: emptyMeals() };
    if (!data.days[key].meals) data.days[key].meals = emptyMeals();
    MEALS.forEach(m => { if (!data.days[key].meals[m.id]) data.days[key].meals[m.id] = []; });
    return data.days[key];
  }
  // fib summiert nur bekannte Angaben; fibUnknown zählt Einträge ohne Angabe
  // (undefined = unbekannt, 0 = bewusst null – der Unterschied trägt die Anzeige).
  function dayTotals(key) {
    const day = getDay(key);
    const t = { kcal: 0, p: 0, f: 0, kh: 0, fib: 0, fibUnknown: 0 };
    MEALS.forEach(m => (day.meals[m.id] || []).forEach(e => {
      t.kcal += e.kcal; t.p += e.p || 0; t.f += e.f || 0; t.kh += e.kh || 0;
      if (typeof e.fib === 'number' && isFinite(e.fib)) t.fib += e.fib;
      else t.fibUnknown++;
    }));
    return t;
  }
  function isTracked(key) {
    const day = data.days[key];
    return !!day && MEALS.some(m => (day.meals[m.id] || []).length > 0);
  }
  function trackedKeys() {
    return Object.keys(data.days).filter(isTracked).sort();
  }

  function weightEntries() {
    return Object.keys(data.weights).sort().map(key => ({ key, weight: data.weights[key] }));
  }
  // Bauchumfang in derselben Struktur wie Gewichte, damit Trend und Chart wiederverwendbar sind.
  function waistEntries() {
    return Object.keys(data.waist || {}).sort().map(key => ({ key, weight: data.waist[key] }));
  }
  function weightOnOrBefore(key) {
    const entries = weightEntries();
    let found = null;
    for (const e of entries) {
      if (e.key <= key) found = e.weight; else break;
    }
    return found !== null ? found : (entries.length ? entries[0].weight : null);
  }
  function currentWeight() {
    const entries = weightEntries();
    if (entries.length) return entries[entries.length - 1].weight;
    return data.profile ? data.profile.startWeightKg : 80;
  }

  // Zentrale Kennzahlen. Bei aktiver Kalibrierung gilt der gedämpfte, einmal
  // täglich fortgeschriebene effektive TDEE (settings.appliedTdee) einheitlich
  // für Ziel, Defizit, Ring und Prognose. Der Aktivkalorien-Zuschlag der Watch
  // kommt danach obendrauf und lässt die Kalibrierung selbst unberührt.
  function metricsFor(key) {
    const p = data.profile;
    const weight = weightOnOrBefore(key) ?? currentWeight();
    const age = Calc.ageFromBirthYear(p.birthYear);
    const bmr = Calc.bmr(p.sex, weight, p.heightCm, age);
    const formulaTdee = Calc.tdee(bmr, p.activity);
    const s = data.settings;
    const baseTdee = (s.useCalibratedTdee && typeof s.appliedTdee === 'number' && isFinite(s.appliedTdee))
      ? s.appliedTdee
      : formulaTdee;
    const activityAdj = activityAdjustmentFor(key);
    const tdee = Math.max(1, baseTdee + activityAdj);
    return {
      weight, bmr, formulaTdee, baseTdee, activityAdj, tdee,
      goal: Calc.calorieGoal(tdee, p.deficit),
      proteinGoal: Calc.proteinGoal(weight, p.proteinPerKg)
    };
  }

  function activeEnergyStats(endKey) {
    return Calc.activeEnergyStats(data.activeEnergy, endKey || todayKey());
  }

  // Der Zuschlag eines Tages misst sich am Durchschnitt BIS zu diesem Tag. Sonst
  // änderte ein heute nachgetragener Wert rückwirkend die Defizite vergangener
  // Tage – und damit Verlauf, kumuliertes Defizit und CSV.
  function activityAdjustmentFor(key) {
    if (!data.settings.useActiveEnergy) return 0;
    const value = (data.activeEnergy || {})[key];
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    const stats = activeEnergyStats(key);
    return Calc.activityAdjustment(value, stats.avg, stats.count);
  }

  // ---------- Verbrauchs-Kalibrierung ----------

  function daysBetweenKeys(a, b) {
    return Math.round((dateFromKey(b) - dateFromKey(a)) / 86400000);
  }

  function computeCalibration() {
    const raw = weightEntries();
    const trend = Calc.weightTrend(raw);
    const intakes = trackedKeys()
      .filter(k => k <= todayKey())
      .map(k => ({ key: k, kcal: dayTotals(k).kcal }));
    return Calc.calibratedTdee(trend, intakes, todayKey(), raw);
  }

  function formulaTdeeToday() {
    const p = data.profile;
    const bmr = Calc.bmr(p.sex, currentWeight(), p.heightCm, Calc.ageFromBirthYear(p.birthYear));
    return Calc.tdee(bmr, p.activity);
  }

  // Einmal pro Tag: effektiven TDEE neu bestimmen, Drift auf 50 kcal/Tag begrenzt.
  function refreshAppliedTdee() {
    const s = data.settings;
    if (!s.useCalibratedTdee || !data.profile) return;
    const today = todayKey();
    if (s.appliedTdeeDate === today) return;
    const eff = Calc.effectiveTdee(formulaTdeeToday(), computeCalibration());
    const elapsed = s.appliedTdeeDate ? Math.max(1, daysBetweenKeys(s.appliedTdeeDate, today)) : 1;
    s.appliedTdee = (typeof s.appliedTdee === 'number')
      ? Calc.limitDrift(s.appliedTdee, eff.tdee, elapsed)
      : eff.tdee;
    s.appliedTdeeDate = today;
    persist();
  }

  function avgDeficit(lastN) {
    const keys = trackedKeys().filter(k => k <= todayKey()).slice(-lastN);
    if (keys.length === 0) return { avg: 0, count: 0 };
    const sum = keys.reduce((acc, k) => acc + (metricsFor(k).tdee - dayTotals(k).kcal), 0);
    return { avg: sum / keys.length, count: keys.length };
  }

  // ---------- Mutationen ----------

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function itemKey(item) { return `${item.name}|${item.amount}`; }

  // Ballaststoffe: gültige Zahl → auf 1 Dezimale gerundet, sonst undefined (= unbekannt).
  function fibValue(raw) {
    if (typeof raw === 'number' && isFinite(raw) && raw >= 0) return Math.round(raw * 10) / 10;
    return undefined;
  }
  function withFib(target, raw) {
    const v = fibValue(raw);
    if (v !== undefined) target.fib = v;
    return target;
  }

  function pushRecent(entry) {
    const item = withFib(
      { name: entry.name, amount: entry.amount, kcal: entry.kcal, p: entry.p, f: entry.f, kh: entry.kh },
      entry.fib
    );
    data.recents = data.recents.filter(r => itemKey(r) !== itemKey(item));
    data.recents.unshift(item);
    data.recents = data.recents.slice(0, 50);
  }

  function addEntry(dayKey, mealId, values) {
    const entry = withFib({
      id: newId(),
      name: values.name,
      amount: values.amount || '',
      kcal: Math.round(values.kcal),
      p: Math.round((values.p || 0) * 10) / 10,
      f: Math.round((values.f || 0) * 10) / 10,
      kh: Math.round((values.kh || 0) * 10) / 10
    }, values.fib);
    ensureDay(dayKey).meals[mealId].push(entry);
    pushRecent(entry);
    persist();
  }

  function deleteEntry(dayKey, mealId, id) {
    const day = data.days[dayKey];
    if (!day) return;
    day.meals[mealId] = (day.meals[mealId] || []).filter(e => e.id !== id);
    if (!isTracked(dayKey)) delete data.days[dayKey];
    persist();
  }

  function findEntry(dayKey, mealId, id) {
    return (getDay(dayKey).meals[mealId] || []).find(e => e.id === id) || null;
  }

  function toggleFavorite(item) {
    const k = itemKey(item);
    const idx = data.favorites.findIndex(f => itemKey(f) === k);
    if (idx >= 0) data.favorites.splice(idx, 1);
    else data.favorites.unshift(withFib(
      { name: item.name, amount: item.amount, kcal: item.kcal, p: item.p, f: item.f, kh: item.kh },
      item.fib
    ));
    persist();
  }
  function isFavorite(item) {
    return data.favorites.some(f => itemKey(f) === itemKey(item));
  }

  // ---------- Toast ----------

  let toastTimer = null;
  function toast(msg, opts) {
    const el = $('#toast');
    el.textContent = msg;
    if (opts && opts.actionLabel) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', () => {
        clearTimeout(toastTimer);
        el.classList.remove('show');
        opts.onAction();
      });
      el.appendChild(btn);
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), (opts && opts.duration) || 2200);
  }

  // ---------- Theme ----------

  function applyTheme() {
    const theme = data.settings.theme || 'system';
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }

  // ---------- Rendering: Gerüst ----------

  function renderAll() {
    applyTheme();
    if (!data.profile) {
      if (!ob) startOnboarding();
      return;
    }
    $('#onboarding').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderToday();
    renderWeight();
    renderHistory();
    renderSettings();
    updateTabbar();
  }

  function updateTabbar() {
    document.querySelectorAll('#tabbar button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });
    ['today', 'weight', 'history', 'settings'].forEach(tab => {
      $(`#view-${tab}`).classList.toggle('hidden', tab !== activeTab);
    });
  }

  // ---------- Rendering: Heute ----------

  function renderToday() {
    const m = metricsFor(currentDay);
    const totals = dayTotals(currentDay);
    const deficit = Math.round(m.tdee - totals.kcal);
    const day = getDay(currentDay);
    const isToday = currentDay === todayKey();

    const fatRef = Math.max(Math.round(m.goal * 0.30 / 9), 1);
    const khRef = Math.max(Math.round(m.goal * 0.45 / 4), 1);

    let html = `
      <div class="date-nav">
        <button class="icon-btn" data-action="day-prev" aria-label="Vorheriger Tag">‹</button>
        <button class="date-label" data-action="day-today">${esc(fmtDayLabel(currentDay))}</button>
        <button class="icon-btn" data-action="day-next" aria-label="Nächster Tag" ${isToday ? 'disabled' : ''}>›</button>
      </div>

      <div class="today-grid">
      <div class="today-col">
      <div class="card ring-card">
        ${Charts.ring(totals.kcal, m.goal, m.tdee)}
        <div class="stat-row">
          <div class="stat"><div class="stat-value">${fmtKcal(m.tdee)}</div><div class="stat-label">Verbrauch${m.activityAdj !== 0 ? ` (${m.activityAdj > 0 ? '+' : '−'}${fmtKcal(Math.abs(m.activityAdj))} Aktivität)` : ''}</div></div>
          <div class="stat"><div class="stat-value">${fmtKcal(totals.kcal)}</div><div class="stat-label">Gegessen</div></div>
          <div class="stat stat-accent"><div class="stat-value ${deficit < 0 ? 'neg' : ''}">${deficit < 0 ? '+' + fmtKcal(-deficit) : fmtKcal(deficit)}</div><div class="stat-label">${deficit < 0 ? 'Überschuss' : 'Defizit'}</div></div>
        </div>
        ${activeEnergyRow()}
      </div>

      <div class="card">
        ${macroBar('Protein', totals.p, m.proteinGoal, true)}
        ${macroBar('Fett', totals.f, fatRef, false)}
        ${macroBar('Kohlenhydrate', totals.kh, khRef, false)}
        ${macroBar('Ballaststoffe', totals.fib, Calc.FIBER_GOAL_G, true, {
          atLeast: totals.fibUnknown > 0,
          note: totals.fibUnknown > 0
            ? `${NF0.format(totals.fibUnknown)} ${totals.fibUnknown === 1 ? 'Eintrag' : 'Einträge'} ohne Angabe`
            : ''
        })}
      </div>
      </div>
      <div class="today-col">`;

    MEALS.forEach(meal => {
      const entries = day.meals[meal.id] || [];
      const sum = entries.reduce((a, e) => a + e.kcal, 0);
      html += `
      <div class="card meal-card">
        <div class="meal-head">
          <div class="meal-title">${meal.label}</div>
          <div class="meal-sum">${entries.length ? fmtKcal(sum) + ' kcal' : ''}</div>
          <button class="add-btn" data-action="open-sheet" data-meal="${meal.id}" aria-label="${meal.label}: Eintrag hinzufügen">+</button>
        </div>`;
      if (entries.length) {
        html += '<div class="entry-list">';
        entries.forEach(e => {
          html += `
          <div class="entry" data-action="edit-entry" data-meal="${meal.id}" data-id="${esc(e.id)}" role="button">
            <div class="entry-main">
              <div class="entry-name">${esc(e.name)}</div>
              <div class="entry-sub">${esc(e.amount || '')}${e.amount && e.p ? ' · ' : ''}${e.p ? `${NFx.format(e.p)} g Protein` : ''}</div>
            </div>
            <div class="entry-kcal">${fmtKcal(e.kcal)}</div>
            <button class="entry-del" data-action="del-entry" data-meal="${meal.id}" data-id="${esc(e.id)}" aria-label="Löschen">×</button>
          </div>`;
        });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '</div></div>';

    $('#view-today').innerHTML = html;
  }

  function macroBar(label, value, goal, showGoal, opts) {
    const o = opts || {};
    const pct = Math.min(value / Math.max(goal, 1) * 100, 100);
    const over = value > goal;
    return `
      <div class="macro ${showGoal ? 'macro-protein' : ''}">
        <div class="macro-head">
          <span class="macro-label">${label}</span>
          <span class="macro-values">${o.atLeast ? '≥ ' : ''}${fmtG(value)}${showGoal ? ` / ${fmtG(goal)}` : ''} g</span>
        </div>
        <div class="macro-track"><div class="macro-fill ${over && showGoal ? 'done' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
        ${o.note ? `<div class="macro-note">${esc(o.note)}</div>` : ''}
      </div>`;
  }

  // Dezente Zeile unter dem Ring: Aktivkalorien des angezeigten Tages, Tap öffnet ein Inline-Feld.
  function activeEnergyRow() {
    if (!data.settings.useActiveEnergy) return '';
    const value = (data.activeEnergy || {})[currentDay];
    if (activeEdit) {
      return `
        <div class="active-row">
          <span class="active-label">Aktivkalorien</span>
          <input type="text" inputmode="numeric" id="active-input" placeholder="z. B. 640"
            value="${value != null ? esc(NF0.format(value)) : ''}">
          <button class="btn primary" data-action="save-active">OK</button>
        </div>`;
    }
    return `
      <button class="active-row tap" data-action="edit-active">
        <span class="active-label">Aktivkalorien (Watch)</span>
        <span class="active-value">${value != null ? `${fmtKcal(value)} kcal` : '–'}</span>
      </button>`;
  }

  // ---------- Rendering: Gewicht ----------

  function renderWeight() {
    const p = data.profile;
    const entries = weightEntries();
    const trend = Calc.weightTrend(entries);
    const latestTrend = trend.length ? trend[trend.length - 1].trend : null;
    const start = p.startWeightKg;
    const dEficit = avgDeficit(14);
    const fc = latestTrend !== null
      ? Calc.forecast(latestTrend, p.targetWeightKg, dEficit.avg, dEficit.count)
      : null;

    const rangeDays = { '1m': 30, '3m': 91, '1y': 365, 'all': Infinity }[weightRange];
    const cutoff = rangeDays === Infinity ? '' : addDays(todayKey(), -rangeDays);
    const visible = trend.filter(t => t.key >= cutoff);

    const marks = Calc.milestones(trend, start, p.targetWeightKg);
    const next = Calc.nextMilestone(latestTrend, p.targetWeightKg);

    const cal = computeCalibration();
    const mToday = metricsFor(todayKey());
    let calTile = '';
    if (data.settings.useCalibratedTdee) {
      calTile = `
        <div class="card tile wide">
          <div class="tile-value">${fmtKcal(mToday.baseTdee)} kcal${cal ? calBandLabel(cal) : ''}</div>
          <div class="tile-label">Verbrauchsbasis: automatisch kalibriert (Formel: ${fmtKcal(mToday.formulaTdee)} kcal)${cal ? ` · ${calCoverageLabel(cal)}` : ' · Datenlage aktuell dünn, Wert bleibt stabil'} – umstellbar in den Einstellungen</div>
          ${cal ? `<div class="tile-label">${esc(calExplainText())}</div>` : ''}
          ${watchCrossCheck(cal)}
        </div>`;
    } else if (cal) {
      const higher = cal.tdee > mToday.formulaTdee + 25;
      const lower = cal.tdee < mToday.formulaTdee - 25;
      const note = higher
        ? 'Dein realer Verbrauch liegt über der Formel.'
        : (lower ? 'Dein realer Verbrauch liegt etwas unter der Formel.' : 'Beobachtung und Formel stimmen gut überein.');
      calTile = `
        <div class="card tile wide">
          <div class="tile-value">Realer Verbrauch ≈ ${fmtKcal(cal.tdee)} kcal${calBandLabel(cal)}</div>
          <div class="tile-label">${note} Formel: ${fmtKcal(mToday.formulaTdee)} kcal · ${calCoverageLabel(cal)}. Übernahme wirkt gedämpft und begrenzt aufs Tagesziel.</div>
          <div class="tile-label">${esc(calExplainText())}</div>
          ${watchCrossCheck(cal)}
          <button class="btn primary cal-btn" data-action="use-calibrated">Als Basis übernehmen</button>
        </div>`;
    }

    const waist = waistEntries();
    const waistTrend = Calc.weightTrend(waist);
    const waistNow = waist.length ? waist[waist.length - 1].weight : null;
    const waistStart = waist.length ? waist[0].weight : null;
    const bmiValue = Calc.bmi(latestTrend !== null ? latestTrend : currentWeight(), p.heightCm);
    const whtrValue = Calc.whtr(waistNow, p.heightCm);
    const dateWaist = (data.waist || {})[weightDate];

    const waistCard = waist.length ? `
      <div class="card">
        <div class="card-title">Bauchumfang</div>
        ${Charts.weightChart(waistTrend.filter(t => t.key >= cutoff), null, null,
          { label: 'Bauchumfang-Verlauf', emptyText: 'Keine Messung im gewählten Zeitraum' })}
        <div class="legend">
          <span><i class="dot-accent"></i> 7-Tage-Trend</span>
          <span><i class="dot-raw"></i> Messwerte (cm)</span>
        </div>
      </div>` : '';

    const bodyTiles = `
      <div class="tile-grid">
        <div class="card tile">
          <div class="tile-value">${waistNow !== null ? `${NFx.format(waistNow)} cm` : '–'}</div>
          <div class="tile-label">${waistNow !== null && waistStart !== null && waist.length > 1
            ? `Bauchumfang · ${signedCm(waistNow - waistStart)} seit Start`
            : 'Bauchumfang'}</div>
        </div>
        <div class="card tile">
          <div class="tile-value">${whtrValue !== null ? NF2.format(whtrValue) : '–'}</div>
          <div class="tile-label">${whtrValue !== null
            ? `Taille/Größe – ${esc(Calc.whtrCategory(whtrValue))} (Richtwert &lt; 0,50)`
            : 'Taille/Größe – Bauchumfang eintragen'}</div>
        </div>
        <div class="card tile wide">
          <div class="tile-value">${bmiValue !== null ? `BMI ${NFx.format(bmiValue)}` : '–'}</div>
          <div class="tile-label">${bmiValue !== null ? esc(Calc.bmiCategory(bmiValue)) : 'BMI'} · Orientierungswerte, keine medizinische Bewertung</div>
        </div>
      </div>`;

    const dateWeight = data.weights[weightDate];
    const dateLabel = weightDate === todayKey() ? 'Heute'
      : weightDate === addDays(todayKey(), -1) ? 'Gestern'
      : fmtDateShort(weightDate);

    let html = `
      <h1 class="view-title">Gewicht</h1>

      <div class="card">
        <label class="field-label" for="weight-input">Gewicht (kg)</label>
        <div class="inline-form">
          <input id="weight-input" type="text" inputmode="decimal" placeholder="z. B. 82,4"
            value="${dateWeight != null ? esc(NF1.format(dateWeight)) : ''}">
          <button class="btn primary" data-action="save-weight">Speichern</button>
        </div>
        <label class="field-label waist-label" for="waist-input">Bauchumfang (cm) – optional</label>
        <div class="inline-form">
          <input id="waist-input" type="text" inputmode="decimal" placeholder="z. B. 96,5"
            value="${dateWaist != null ? esc(NFx.format(dateWaist)) : ''}">
          <button class="btn" data-action="save-waist">Speichern</button>
        </div>
        <div class="weight-date">für
          <label class="date-tap">${esc(dateLabel)}
            <input type="date" id="weight-date" value="${weightDate}"
              max="${todayKey()}" min="${addDays(todayKey(), -365)}">
          </label>
        </div>
      </div>

      <div class="card">
        <div class="segmented" data-role="weight-range">
          ${['1m', '3m', '1y', 'all'].map(r =>
            `<button class="${weightRange === r ? 'active' : ''}" data-action="weight-range" data-range="${r}">${{ '1m': '1 M', '3m': '3 M', '1y': '1 J', 'all': 'Alles' }[r]}</button>`
          ).join('')}
        </div>
        ${Charts.weightChart(visible, p.targetWeightKg, marks)}
        <div class="legend">
          <span><i class="dot-accent"></i> 7-Tage-Trend</span>
          <span><i class="dot-raw"></i> Messwerte</span>
          <span><i class="dot-target"></i> Ziel ${fmtKg(p.targetWeightKg)} kg</span>
        </div>
      </div>

      <div class="tile-grid">
        <div class="card tile">
          <div class="tile-value">${latestTrend !== null ? fmtKg(latestTrend) + ' kg' : '–'}</div>
          <div class="tile-label">Trend aktuell</div>
        </div>
        <div class="card tile">
          <div class="tile-value">${latestTrend !== null ? signedKg(latestTrend - start) : '–'}</div>
          <div class="tile-label">Seit Start (${fmtKg(start)} kg)</div>
        </div>
        <div class="card tile">
          <div class="tile-value">${latestTrend !== null ? signedKg(latestTrend - p.targetWeightKg) : '–'}</div>
          <div class="tile-label">Bis Ziel</div>
        </div>
        <div class="card tile">
          <div class="tile-value">${next ? (next.reached ? 'Ziel erreicht 🎉' : `&lt; ${fmtKg(next.threshold)} kg`) : '–'}</div>
          <div class="tile-label">${next && !next.reached ? `Nächstes Ziel – noch ${fmtKg(next.remaining)} kg` : 'Nächstes Ziel'}</div>
        </div>
        <div class="card tile wide">
          <div class="tile-value">${fc ? esc(fc.date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })) : '–'}</div>
          <div class="tile-label">${fc ? 'Ziel voraussichtlich erreicht' : 'Prognose: noch nicht genug Daten'}</div>
        </div>
        ${calTile}
      </div>
      ${!fc ? `<p class="hint">Für eine Prognose braucht es mindestens 5 getrackte Tage mit einem durchschnittlichen Kaloriendefizit und einen Trend oberhalb des Zielgewichts.</p>` : ''}
      ${waistCard}
      ${bodyTiles}`;

    $('#view-weight').innerHTML = html;

    $('#weight-date').addEventListener('change', () => {
      const v = $('#weight-date').value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= todayKey()) {
        weightDate = v;
        renderWeight();
      }
    });
  }

  function signedKg(diff) {
    const r = Math.round(diff * 10) / 10;
    if (r > 0) return `+${fmtKg(r)} kg`;
    if (r < 0) return `−${fmtKg(Math.abs(r))} kg`;
    return `±0,0 kg`;
  }

  function signedCm(diff) {
    const r = Math.round(diff * 10) / 10;
    if (r > 0) return `+${NFx.format(r)} cm`;
    if (r < 0) return `−${NFx.format(Math.abs(r))} cm`;
    return '±0 cm';
  }

  // „(± 130)“ – Unsicherheitsband aus der Streuung der Trendpunkte.
  function calBandLabel(cal) {
    return cal && cal.uncertainty ? ` (± ${fmtKcal(cal.uncertainty)})` : '';
  }

  function calCoverageLabel(cal) {
    if (!cal || !cal.windowDays) return `${NF0.format(cal ? cal.days : 0)} getrackte Tage`;
    return `${NF0.format(cal.trackedInSpan)} von ${NF0.format(cal.windowDays)} Tagen erfasst`;
  }

  function calExplainText() {
    return 'Der Wert hängt an deiner Erfassungsweise: Wer Portionen großzügig schätzt, hebt ihn mit an. ' +
      'Fürs Tagesziel bleibt er trotzdem stimmig, weil Aufnahme und Verbrauch in denselben Einheiten rechnen – ' +
      'zum Vergleich mit fremden Rechnern taugt er nicht.';
  }

  // Gegenprobe mit der Watch: Ruheumsatz (Formel) + Ø Aktivkalorien gegen den beobachteten Verbrauch.
  function watchCrossCheck(cal) {
    if (!cal || !data.settings.useActiveEnergy) return '';
    const stats = activeEnergyStats();
    if (stats.avg === null || stats.count < 7) return '';
    const watchTotal = Math.round(metricsFor(todayKey()).bmr + stats.avg);
    return `<div class="tile-label">Watch Ø ${fmtKcal(watchTotal)} (Ruhe + Aktiv) · beobachtet ${fmtKcal(cal.tdee)} kcal</div>`;
  }

  // ---------- Rendering: Verlauf ----------

  function renderHistory() {
    const t = todayKey();
    const bars = [];
    for (let i = 13; i >= 0; i--) {
      const key = addDays(t, -i);
      const m = metricsFor(key);
      bars.push({ key, kcal: isTracked(key) ? dayTotals(key).kcal : 0, goal: m.goal });
    }

    const last7 = trackedKeys().filter(k => k <= t && k >= addDays(t, -6));
    const avgKcal7 = last7.length ? last7.reduce((a, k) => a + dayTotals(k).kcal, 0) / last7.length : null;
    const avgDef7 = last7.length ? last7.reduce((a, k) => a + (metricsFor(k).tdee - dayTotals(k).kcal), 0) / last7.length : null;

    const allTracked = trackedKeys().filter(k => k <= t);
    const cumDeficit = allTracked.reduce((a, k) => a + (metricsFor(k).tdee - dayTotals(k).kcal), 0);
    const kgFat = cumDeficit / Calc.KCAL_PER_KG_FAT;

    let html = `
      <h1 class="view-title">Verlauf</h1>

      <div class="card">
        <div class="card-title">Kalorien – letzte 14 Tage</div>
        ${Charts.barChart(bars)}
        <div class="legend"><span><i class="dot-target"></i> Kalorienziel</span></div>
      </div>

      <div class="tile-grid">
        <div class="card tile">
          <div class="tile-value">${avgKcal7 !== null ? fmtKcal(avgKcal7) : '–'}</div>
          <div class="tile-label">Ø kcal (7 Tage)</div>
        </div>
        <div class="card tile">
          <div class="tile-value ${avgDef7 !== null && avgDef7 < 0 ? 'neg' : ''}">${avgDef7 !== null ? (avgDef7 < 0 ? '+' + fmtKcal(-avgDef7) : fmtKcal(avgDef7)) : '–'}</div>
          <div class="tile-label">${avgDef7 !== null && avgDef7 < 0 ? 'Ø Überschuss (7 Tage)' : 'Ø Defizit (7 Tage)'}</div>
        </div>
        <div class="card tile wide">
          <div class="tile-value ${cumDeficit < 0 ? 'neg' : ''}">${cumDeficit < 0 ? '+' : ''}${fmtKcal(Math.abs(cumDeficit))} kcal</div>
          <div class="tile-label">Kumuliertes ${cumDeficit < 0 ? 'Plus' : 'Defizit'} gesamt · ≈ ${NF1.format(Math.abs(kgFat))} kg Fett</div>
        </div>
      </div>`;

    const dayStats = allTracked.map(k => {
      const tot = dayTotals(k);
      return { key: k, kcal: tot.kcal, protein: tot.p, goal: metricsFor(k).goal };
    });
    const weeks = Calc.weeklyStats(dayStats, Calc.weightTrend(weightEntries())).slice(0, 8);
    if (weeks.length) {
      html += `
      <div class="card">
        <div class="card-title">Wochen</div>
        ${weeks.map(w => `
        <div class="week-row">
          <div class="week-head">
            <span class="week-label">${esc(w.label)}</span>
            <span class="week-days">${NF0.format(w.days)} ${w.days === 1 ? 'Tag' : 'Tage'}</span>
          </div>
          <div class="week-stats">
            <span>Ø ${fmtKcal(w.avgKcal)} kcal</span>
            <span>Ø ${fmtG(w.avgProtein)} g P</span>
            <span>${NF0.format(Math.round(w.adherence * 100))} % im Ziel</span>
            <span>${w.weightDelta !== null ? signedKg(w.weightDelta) : '– kg'}</span>
          </div>
        </div>`).join('')}
      </div>`;
    }

    html += `
      <div class="card">
        <div class="card-title">Getrackte Tage</div>`;

    const listKeys = allTracked.slice().reverse().slice(0, 60);
    if (listKeys.length === 0) {
      html += '<p class="hint">Noch keine Einträge vorhanden.</p>';
    } else {
      html += '<div class="history-list">';
      listKeys.forEach(k => {
        const tot = dayTotals(k);
        const def = Math.round(metricsFor(k).tdee - tot.kcal);
        html += `
        <div class="history-row" data-action="open-day" data-day="${k}" role="button">
          <div class="history-date">${esc(fmtDateShort(k))}</div>
          <div class="history-kcal">${fmtKcal(tot.kcal)} kcal</div>
          <div class="history-p">${fmtG(tot.p)} g P</div>
          <div class="history-def ${def < 0 ? 'neg' : 'pos'}">${def < 0 ? '+' : '−'}${fmtKcal(Math.abs(def))}</div>
        </div>`;
      });
      html += '</div>';
    }
    html += '</div>';

    $('#view-history').innerHTML = html;
  }

  // ---------- Rendering: Einstellungen ----------

  function renderSettings() {
    const p = data.profile;
    const m = metricsFor(todayKey());

    const html = `
      <h1 class="view-title">Einstellungen</h1>

      <div class="card">
        <div class="card-title">Körperdaten &amp; Ziele</div>
        <div class="form-grid">
          <label>Geschlecht
            <select data-setting="sex">
              <option value="m" ${p.sex === 'm' ? 'selected' : ''}>Männlich</option>
              <option value="f" ${p.sex === 'f' ? 'selected' : ''}>Weiblich</option>
            </select>
          </label>
          <label>Geburtsjahr
            <input type="number" inputmode="numeric" data-setting="birthYear" value="${p.birthYear}" min="1920" max="2020">
          </label>
          <label>Größe (cm)
            <input type="number" inputmode="numeric" data-setting="heightCm" value="${p.heightCm}" min="120" max="230">
          </label>
          <label>Zielgewicht (kg)
            <input type="text" inputmode="decimal" data-setting="targetWeightKg" value="${esc(NF1.format(p.targetWeightKg))}">
          </label>
          <label class="span2">Aktivitätslevel
            <select data-setting="activity">
              ${Calc.ACTIVITY_LABELS.map((a, i) =>
                `<option value="${i}" ${p.activity === i ? 'selected' : ''}>${a.name} – ${a.desc}</option>`).join('')}
            </select>
          </label>
          <label class="span2">Tagesdefizit
            <select data-setting="deficit">
              ${DEFICITS.map(d =>
                `<option value="${d.value}" ${p.deficit === d.value ? 'selected' : ''}>${d.label} (${d.desc})</option>`).join('')}
            </select>
          </label>
          <label class="span2">Proteinziel (g pro kg Körpergewicht)
            <input type="text" inputmode="decimal" data-setting="proteinPerKg" value="${esc(String(p.proteinPerKg).replace('.', ','))}">
          </label>
        </div>
        <div class="calc-preview" id="settings-calc">${calcPreviewRows(m)}</div>
      </div>

      <div class="card">
        <div class="card-title">Verbrauchsbasis</div>
        <label class="row-label">Berechnung
          <select data-setting="tdeeBasis">
            <option value="formula" ${!data.settings.useCalibratedTdee ? 'selected' : ''}>Formel</option>
            <option value="calibrated" ${data.settings.useCalibratedTdee ? 'selected' : ''}>Automatisch kalibriert</option>
          </select>
        </label>
        <p class="hint" id="tdee-status">${tdeeBasisStatus()}</p>
      </div>

      <div class="card">
        <div class="card-title">Aktivkalorien (Apple Watch)</div>
        <label class="row-label">Tagesziel mit Aktivkalorien anpassen
          <input type="checkbox" data-setting="useActiveEnergy" ${data.settings.useActiveEnergy ? 'checked' : ''}>
        </label>
        <p class="hint" id="watch-status">${activeEnergyStatus()}</p>
        <label class="field-label" for="watch-import" style="margin-top:10px">Werte sammeln eintragen (eine Zeile je Tag)</label>
        <textarea id="watch-import" rows="4" placeholder="25.07. 640&#10;24.07.2026 512&#10;2026-07-23;705">${esc(watchImport.text)}</textarea>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" data-action="watch-check">Prüfen</button>
          <button class="btn primary" data-action="watch-apply" ${watchImport.result && watchImport.result.entries.length ? '' : 'disabled'}>Übernehmen</button>
        </div>
        <p class="hint" id="watch-preview">${esc(watchImportPreview())}</p>
        <p class="hint">Gemeint sind die <strong>Aktiv</strong>kalorien (Bewegung), nicht die Gesamtkalorien.
        Angerechnet wird nur die Abweichung vom eigenen Durchschnitt, zur Hälfte und höchstens
        ±400 kcal – die mittlere Aktivität steckt bereits im Aktivitätslevel bzw. in der
        Kalibrierung und würde sonst doppelt zählen. Der Energieverbrauch am Handgelenk ist
        die schwächste Messgröße der Uhr (oft 20–30 % Abweichung pro Tag); die Werte
        modulieren das Tagesziel, sie ersetzen die Verbrauchsbasis nicht.</p>
      </div>

      <div class="card">
        <div class="card-title">Darstellung</div>
        <label class="row-label">Farbschema
          <select data-setting="theme">
            <option value="system" ${data.settings.theme === 'system' ? 'selected' : ''}>System</option>
            <option value="light" ${data.settings.theme === 'light' ? 'selected' : ''}>Hell</option>
            <option value="dark" ${data.settings.theme === 'dark' ? 'selected' : ''}>Dunkel</option>
          </select>
        </label>
      </div>

      <div class="card">
        <div class="card-title">KI-Erkennung (optional)</div>
        <label class="field-label" for="api-key-input">Anthropic-API-Key</label>
        <input id="api-key-input" type="password" autocomplete="off" placeholder="sk-ant-…"
          value="${esc(data.settings.apiKey || '')}" data-setting="apiKey">
        <label class="row-label" style="margin-top:10px">Online-Recherche bei Markenprodukten
          <input type="checkbox" data-setting="aiWebSearch" ${data.settings.aiWebSearch !== false ? 'checked' : ''}>
        </label>
        <p class="hint">Mit hinterlegtem Key erscheint beim Eintragen der Reiter „KI“: Mahlzeiten
        oder Nährwert-Etiketten per Foto bzw. Freitext auswerten lassen. Der Key wird nur lokal
        auf diesem Gerät gespeichert. Jede Anfrage kostet wenige Cent; Fotos und Texte werden
        dafür an Anthropic übertragen. Bei aktivierter Online-Recherche darf Claude zusätzlich
        Nährwerte von Markenprodukten bei fddb nachschlagen (kostet etwas mehr als eine reine
        Analyse). Sonst verlässt kein Datum das Gerät.</p>
      </div>

      <div class="card">
        <div class="card-title">Datensicherung</div>
        <p class="hint important">Alle Daten liegen nur in diesem Browser. Bitte regelmäßig
        exportieren – beim Löschen der Website-Daten wäre sonst alles weg.</p>
        <div class="btn-row">
          <button class="btn primary" data-action="export">Daten exportieren</button>
          <button class="btn" data-action="import">Daten importieren …</button>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" data-action="export-csv">Tage als CSV exportieren</button>
        </div>
        <p class="hint" id="export-status">${lastExportLabel()} Die CSV enthält je getracktem Tag kcal,
        Makros inkl. Ballaststoffen, Verbrauch, Defizit, Gewicht, Bauchumfang und Aktivkalorien
        (Semikolon-getrennt, für Excel).</p>
      </div>

      <div class="card">
        <div class="card-title">Gefahrenzone</div>
        <button class="btn danger" data-action="delete-all">Alle Daten löschen</button>
      </div>

      <p class="hint center">Kalorientracker · Version 1.5 · Daten bleiben auf dem Gerät</p>`;

    $('#view-settings').innerHTML = html;

    document.querySelectorAll('#view-settings [data-setting]').forEach(el => {
      el.addEventListener('change', onSettingChange);
    });
    const watchBox = $('#watch-import');
    if (watchBox) {
      watchBox.addEventListener('input', () => {
        watchImport.text = watchBox.value;
        watchImport.result = null; // geänderter Text → erst wieder prüfen, dann übernehmen
        refreshSettingsDerived();
      });
    }
  }

  function calcPreviewRows(m) {
    return `
      <div><span>Grundumsatz (BMR)</span><strong>${fmtKcal(m.bmr)} kcal</strong></div>
      <div><span>Gesamtumsatz (TDEE)${data.settings.useCalibratedTdee ? ' – kalibriert' : ''}</span><strong>${fmtKcal(m.tdee)} kcal</strong></div>
      <div><span>Kalorienziel</span><strong>${fmtKcal(m.goal)} kcal</strong></div>
      <div><span>Proteinziel</span><strong>${fmtG(m.proteinGoal)} g</strong></div>`;
  }

  // Aktualisiert nur die abgeleiteten Anzeigen der Einstellungen – der Rest der View
  // (und damit Fokus und Scrollposition, auch bei offener Tastatur) bleibt stehen.
  function refreshSettingsDerived() {
    const calcBox = $('#settings-calc');
    if (calcBox) calcBox.innerHTML = calcPreviewRows(metricsFor(todayKey()));
    const tdeeBox = $('#tdee-status');
    if (tdeeBox) tdeeBox.textContent = tdeeBasisStatus();
    const watchBox = $('#watch-status');
    if (watchBox) watchBox.textContent = activeEnergyStatus();
    const previewBox = $('#watch-preview');
    if (previewBox) previewBox.textContent = watchImportPreview();
    const applyBtn = document.querySelector('[data-action="watch-apply"]');
    if (applyBtn) applyBtn.disabled = !(watchImport.result && watchImport.result.entries.length);
    const exportBox = $('#export-status');
    if (exportBox) {
      exportBox.textContent = `${lastExportLabel()} Die CSV enthält je getracktem Tag kcal, ` +
        'Makros inkl. Ballaststoffen, Verbrauch, Defizit, Gewicht, Bauchumfang und Aktivkalorien ' +
        '(Semikolon-getrennt, für Excel).';
    }
  }

  function activeEnergyStatus() {
    const stats = activeEnergyStats();
    const days = Object.keys(data.activeEnergy || {}).length;
    if (days === 0) return 'Noch keine Aktivkalorien erfasst. Der Zuschlag greift ab 7 erfassten Tagen.';
    if (stats.count < 7) {
      return `${NF0.format(days)} ${days === 1 ? 'Tag' : 'Tage'} erfasst – der Zuschlag greift ab 7 Tagen.`;
    }
    const todayValue = (data.activeEnergy || {})[todayKey()];
    const adj = activityAdjustmentFor(todayKey());
    const base = `Ø ${fmtKcal(stats.avg)} kcal aus ${NF0.format(stats.count)} Tagen (${NF0.format(days)} insgesamt erfasst).`;
    if (!data.settings.useActiveEnergy) return `${base} Zuschlag ist ausgeschaltet.`;
    if (todayValue == null) return `${base} Für heute liegt noch kein Wert vor.`;
    return `${base} Heute ${fmtKcal(todayValue)} kcal → Zuschlag ${adj >= 0 ? '+' : '−'}${fmtKcal(Math.abs(adj))} kcal.`;
  }

  function watchImportPreview() {
    const r = watchImport.result;
    if (!r) return 'Formate: „25.07. 640“, „25.07.2026 640“ oder „2026-07-25;640“.';
    const parts = [`${NF0.format(r.entries.length)} ${r.entries.length === 1 ? 'Tag' : 'Tage'} erkannt`];
    if (r.duplicates > 0) parts.push(`${NF0.format(r.duplicates)} doppelte ${r.duplicates === 1 ? 'Zeile' : 'Zeilen'} (jeweils der letzte Wert zählt)`);
    if (r.unclear.length > 0) {
      const shown = r.unclear.slice(0, 5).map(line => line.slice(0, 40));
      const rest = r.unclear.length - shown.length;
      parts.push(`${NF0.format(r.unclear.length)} ${r.unclear.length === 1 ? 'Zeile' : 'Zeilen'} unklar: ` +
        shown.join(' | ') + (rest > 0 ? ` … (+${NF0.format(rest)})` : ''));
    }
    return parts.join(' · ') + '.';
  }

  function tdeeBasisStatus() {
    const s = data.settings;
    const cal = computeCalibration();
    if (s.useCalibratedTdee) {
      const m = metricsFor(todayKey());
      const detail = cal ? ` Beobachtung: ≈ ${fmtKcal(cal.tdee)} kcal${calBandLabel(cal)} · ${calCoverageLabel(cal)}.` : '';
      return `Aktiv: Verbrauchsbasis heute ${fmtKcal(m.baseTdee)} kcal (Formel: ${fmtKcal(m.formulaTdee)} kcal).${detail} ` +
        'Der Wert folgt der Beobachtung gedämpft (max. 50 kcal Änderung pro Tag, ±25 % um die Formel).';
    }
    if (cal) {
      return `Beobachtung verfügbar: realer Verbrauch ≈ ${fmtKcal(cal.tdee)} kcal${calBandLabel(cal)} · ${calCoverageLabel(cal)}. ` +
        'Umschalten übernimmt ihn gedämpft als Basis für Ziel und Defizit.';
    }
    return calibrationReasonText();
  }

  // Erklärt, woran die Kalibrierung gerade scheitert (statt pauschal „zu wenig Daten“).
  function calibrationReasonText() {
    const win = Calc.calibrationWindow(
      Calc.weightTrend(weightEntries()),
      trackedKeys().filter(k => k <= todayKey()).map(k => ({ key: k, kcal: dayTotals(k).kcal })),
      todayKey()
    );
    switch (win.reason) {
      case 'few-days':
        return `Noch zu wenig Daten: ${NF0.format(win.trackedDays)} von mindestens 14 getrackten Tagen innerhalb der letzten 28 Tage.`;
      case 'few-weighings':
        return 'Für eine Kalibrierung fehlen Wiegungen – nötig sind mindestens zwei pro Woche innerhalb der letzten 28 Tage.';
      case 'short-span':
        return 'Die Wiegungen liegen zeitlich zu dicht beieinander (nötig sind mindestens 10 Tage zwischen erster und letzter Wiegung).';
      case 'coverage':
        return `Zu viele Lückentage: nur ${NF0.format(win.trackedInSpan)} von ${NF0.format(win.windowDays)} Tagen erfasst ` +
          '(mindestens 75 % nötig, sonst verzerren die nicht getrackten Tage das Ergebnis).';
      default:
        return 'Noch zu wenig Daten für eine Kalibrierung (mindestens 14 getrackte Tage und regelmäßige Wiegungen innerhalb von 28 Tagen).';
    }
  }

  function lastExportLabel() {
    const ts = data.settings.lastExport ? Date.parse(data.settings.lastExport) : null;
    if (!ts || !isFinite(ts)) return 'Noch kein Export erstellt.';
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'Letzter Export: heute.';
    if (days === 1) return 'Letzter Export: gestern.';
    return `Letzter Export: vor ${NF0.format(days)} Tagen.`;
  }

  function markExported() {
    data.settings.lastExport = new Date().toISOString();
    persist();
  }

  // CSV: Semikolon, Komma-Dezimal. Ballaststoffe = Summe der bekannten Angaben.
  function buildCsv() {
    const de1 = n => String(Math.round(n * 10) / 10).replace('.', ',');
    const lines = ['Datum;kcal;Protein_g;Fett_g;KH_g;Ballaststoffe_g;TDEE;Defizit;Gewicht;Bauchumfang_cm;Aktivkalorien'];
    trackedKeys().filter(k => k <= todayKey()).forEach(k => {
      const tot = dayTotals(k);
      const m = metricsFor(k);
      const [y, mo, d] = k.split('-');
      const weight = data.weights[k];
      const waist = (data.waist || {})[k];
      const active = (data.activeEnergy || {})[k];
      lines.push([
        `${d}.${mo}.${y}`,
        String(Math.round(tot.kcal)),
        de1(tot.p),
        de1(tot.f),
        de1(tot.kh),
        de1(tot.fib),
        String(m.tdee),
        String(Math.round(m.tdee - tot.kcal)),
        weight != null ? de1(weight) : '',
        waist != null ? de1(waist) : '',
        active != null ? String(Math.round(active)) : ''
      ].join(';'));
    });
    return lines.join('\r\n') + '\r\n';
  }

  // Backup-Erinnerung: >14 Tage kein Export bei >=7 getrackten Tagen, max. 1× pro Tag.
  function maybeBackupHint() {
    const s = data.settings;
    if (trackedKeys().length < 7) return;
    if (s.lastBackupHint === todayKey()) return;
    const ts = s.lastExport ? Date.parse(s.lastExport) : null;
    const days = ts && isFinite(ts) ? Math.floor((Date.now() - ts) / 86400000) : null;
    if (days !== null && days <= 14) return;
    s.lastBackupHint = todayKey();
    persist();
    toast(days !== null ? `Letztes Backup vor ${NF0.format(days)} Tagen – jetzt exportieren?` : 'Noch kein Backup erstellt – jetzt exportieren?', {
      actionLabel: 'Exportieren',
      duration: 6000,
      onAction: () => {
        activeTab = 'settings';
        updateTabbar();
        window.scrollTo(0, 0);
      }
    });
  }

  // Akzeptiert deutsche ("12,5", "1.234,5") und punktdezimale ("12.5") Eingaben,
  // weist alles andere strikt ab (kein stiller Teil-Parse). Definition in calc.js,
  // damit Formularparser und Mengen-Umrechner garantiert dieselbe Regel benutzen.
  const parseGermanFloat = Calc.parseGermanFloat;

  // Weist ein Formularfeld ab: Meldung zeigen und den gespeicherten Wert wieder
  // eintragen. Nötig, seit die Einstellungen nicht mehr komplett neu gezeichnet
  // werden – sonst bliebe eine ungültige Eingabe stehen, obwohl die App weiter
  // mit dem alten Wert rechnet.
  function rejectSetting(el, value, msg) {
    el.value = value;
    toast(msg);
  }

  function onSettingChange(e) {
    const el = e.target;
    const key = el.dataset.setting;
    const p = data.profile;
    switch (key) {
      case 'sex': p.sex = el.value === 'f' ? 'f' : 'm'; break;
      case 'birthYear': {
        const v = parseInt(el.value, 10);
        if (v >= 1920 && v <= 2020) p.birthYear = v;
        else rejectSetting(el, String(p.birthYear), 'Bitte ein Geburtsjahr zwischen 1920 und 2020 angeben.');
        break;
      }
      case 'heightCm': {
        const v = parseInt(el.value, 10);
        if (v >= 120 && v <= 230) p.heightCm = v;
        else rejectSetting(el, String(p.heightCm), 'Bitte eine Größe zwischen 120 und 230 cm angeben.');
        break;
      }
      case 'targetWeightKg': {
        const v = parseGermanFloat(el.value);
        if (v !== null && v >= 30 && v <= 300) p.targetWeightKg = Math.round(v * 10) / 10;
        else rejectSetting(el, NF1.format(p.targetWeightKg), 'Bitte ein Zielgewicht zwischen 30 und 300 kg angeben.');
        break;
      }
      case 'activity': p.activity = Math.min(4, Math.max(0, parseInt(el.value, 10) || 0)); break;
      case 'deficit': p.deficit = parseInt(el.value, 10) || 0; break;
      case 'proteinPerKg': {
        const v = parseGermanFloat(el.value);
        if (v !== null && v >= 1 && v <= 2.5) p.proteinPerKg = Math.round(v * 10) / 10;
        else rejectSetting(el, String(p.proteinPerKg).replace('.', ','),
          v === null ? 'Ungültige Eingabe – bitte eine Zahl wie 1,6 angeben.' : 'Proteinziel bitte zwischen 1,0 und 2,5 g/kg wählen.');
        break;
      }
      case 'theme': data.settings.theme = el.value; break;
      case 'apiKey': data.settings.apiKey = el.value.trim(); break;
      case 'aiWebSearch': data.settings.aiWebSearch = el.checked; break;
      case 'useActiveEnergy':
        data.settings.useActiveEnergy = el.checked;
        toast(el.checked ? 'Aktivkalorien wirken jetzt aufs Tagesziel' : 'Aktivkalorien wirken nicht mehr aufs Tagesziel');
        break;
      case 'tdeeBasis': {
        const s = data.settings;
        if (el.value === 'calibrated') {
          s.useCalibratedTdee = true;
          s.appliedTdee = Calc.effectiveTdee(formulaTdeeToday(), computeCalibration()).tdee;
          s.appliedTdeeDate = todayKey();
          toast('Verbrauchsbasis: automatisch kalibriert');
        } else {
          s.useCalibratedTdee = false;
          s.appliedTdee = null;
          s.appliedTdeeDate = null;
          toast('Verbrauchsbasis: Formel');
        }
        break;
      }
    }
    persist();
    // Kein renderAll(): #view-settings darf nicht ersetzt werden, sonst gehen Fokus und
    // Scrollposition verloren (bei offener Tastatur „verschwindet“ sonst die Ansicht).
    applyTheme();
    refreshSettingsDerived();
    renderToday();
    renderWeight();
    renderHistory();
  }

  // ---------- Onboarding ----------

  function startOnboarding() {
    ob = {
      step: 0,
      values: { sex: 'm', birthYear: 1985, heightCm: 180, weightKg: 85, activity: 1, targetWeightKg: 78, deficit: 500 }
    };
    $('#app').classList.add('hidden');
    $('#onboarding').classList.remove('hidden');
    renderOnboarding();
  }

  function renderOnboarding() {
    const v = ob.values;
    const steps = 8;
    let body = '';

    switch (ob.step) {
      case 0:
        body = `
          <h2>Willkommen!</h2>
          <p>Ein paar Angaben, dann berechnet die App deinen Kalorienbedarf.<br>Zuerst: Geschlecht (für die Formel).</p>
          <div class="choice-grid">
            <button class="choice ${v.sex === 'm' ? 'active' : ''}" data-ob="sex" data-value="m">Männlich</button>
            <button class="choice ${v.sex === 'f' ? 'active' : ''}" data-ob="sex" data-value="f">Weiblich</button>
          </div>`;
        break;
      case 1:
        body = `
          <h2>Geburtsjahr</h2>
          <p>Für die Berechnung des Grundumsatzes.</p>
          <input type="number" inputmode="numeric" id="ob-input" value="${v.birthYear}" min="1920" max="2020">`;
        break;
      case 2:
        body = `
          <h2>Größe</h2>
          <p>In Zentimetern.</p>
          <input type="number" inputmode="numeric" id="ob-input" value="${v.heightCm}" min="120" max="230"> <span class="unit">cm</span>`;
        break;
      case 3:
        body = `
          <h2>Aktuelles Gewicht</h2>
          <p>Morgens, ohne Kleidung – Komma ist erlaubt.</p>
          <input type="text" inputmode="decimal" id="ob-input" value="${esc(NF1.format(v.weightKg))}"> <span class="unit">kg</span>`;
        break;
      case 4:
        body = `
          <h2>Aktivitätslevel</h2>
          <p>Wie aktiv ist dein Alltag insgesamt?</p>
          <div class="choice-list">
            ${Calc.ACTIVITY_LABELS.map((a, i) => `
              <button class="choice ${v.activity === i ? 'active' : ''}" data-ob="activity" data-value="${i}">
                <strong>${a.name}</strong><span>${a.desc}</span>
              </button>`).join('')}
          </div>`;
        break;
      case 5:
        body = `
          <h2>Zielgewicht</h2>
          <p>Wo soll es hingehen?</p>
          <input type="text" inputmode="decimal" id="ob-input" value="${esc(NF1.format(v.targetWeightKg))}"> <span class="unit">kg</span>`;
        break;
      case 6:
        body = `
          <h2>Tempo</h2>
          <p>Welches tägliche Kaloriendefizit möchtest du anpeilen?</p>
          <div class="choice-list">
            ${DEFICITS.map(d => `
              <button class="choice ${v.deficit === d.value ? 'active' : ''}" data-ob="deficit" data-value="${d.value}">
                <strong>${d.label}</strong><span>${d.desc}</span>
              </button>`).join('')}
          </div>`;
        break;
      case 7: {
        const age = Calc.ageFromBirthYear(v.birthYear);
        const bmr = Calc.bmr(v.sex, v.weightKg, v.heightCm, age);
        const tdee = Calc.tdee(bmr, v.activity);
        const goal = Calc.calorieGoal(tdee, v.deficit);
        const protein = Calc.proteinGoal(v.weightKg, 1.6);
        body = `
          <h2>Deine Werte</h2>
          <div class="calc-preview big">
            <div><span>Grundumsatz (BMR)</span><strong>${fmtKcal(bmr)} kcal</strong></div>
            <div><span>Gesamtumsatz (TDEE)</span><strong>${fmtKcal(tdee)} kcal</strong></div>
            <div><span>Dein Kalorienziel</span><strong>${fmtKcal(goal)} kcal</strong></div>
            <div><span>Dein Proteinziel</span><strong>${fmtG(protein)} g</strong></div>
          </div>
          <p class="hint">Der Grundumsatz ist der Verbrauch in völliger Ruhe (Mifflin-St-Jeor-Formel),
          der Gesamtumsatz rechnet deine Aktivität ein. Isst du täglich dein Kalorienziel, entsteht
          das gewählte Defizit – rund 7.700 kcal entsprechen etwa 1 kg Körperfett.
          Alles lässt sich später in den Einstellungen ändern.</p>`;
        break;
      }
    }

    $('#onboarding').innerHTML = `
      <div class="ob-inner">
        <div class="ob-progress">${Array.from({ length: steps }, (_, i) =>
          `<i class="${i <= ob.step ? 'on' : ''}"></i>`).join('')}</div>
        <div class="ob-body">${body}</div>
        <div class="ob-nav">
          ${ob.step > 0 ? '<button class="btn" data-action="ob-back">Zurück</button>' : '<span></span>'}
          <button class="btn primary" data-action="ob-next">${ob.step === steps - 1 ? 'Los geht’s' : 'Weiter'}</button>
        </div>
      </div>`;

    const input = $('#ob-input');
    if (input) setTimeout(() => input.focus(), 50);
  }

  function obReadInput() {
    const input = $('#ob-input');
    const v = ob.values;
    if (!input) return true;
    switch (ob.step) {
      case 1: {
        const n = parseInt(input.value, 10);
        if (!(n >= 1920 && n <= 2020)) return failOb('Bitte ein Geburtsjahr zwischen 1920 und 2020 angeben.');
        v.birthYear = n; return true;
      }
      case 2: {
        const n = parseInt(input.value, 10);
        if (!(n >= 120 && n <= 230)) return failOb('Bitte eine Größe zwischen 120 und 230 cm angeben.');
        v.heightCm = n; return true;
      }
      case 3: {
        const n = parseGermanFloat(input.value);
        if (n === null || n < 30 || n > 300) return failOb('Bitte ein Gewicht zwischen 30 und 300 kg angeben.');
        v.weightKg = Math.round(n * 10) / 10; return true;
      }
      case 5: {
        const n = parseGermanFloat(input.value);
        if (n === null || n < 30 || n > 300) return failOb('Bitte ein Zielgewicht zwischen 30 und 300 kg angeben.');
        v.targetWeightKg = Math.round(n * 10) / 10; return true;
      }
    }
    return true;
  }
  function failOb(msg) { toast(msg); return false; }

  function finishOnboarding() {
    const v = ob.values;
    data.profile = {
      sex: v.sex,
      birthYear: v.birthYear,
      heightCm: v.heightCm,
      activity: v.activity,
      targetWeightKg: v.targetWeightKg,
      deficit: v.deficit,
      proteinPerKg: 1.6,
      startWeightKg: v.weightKg,
      startDate: todayKey()
    };
    data.weights[todayKey()] = v.weightKg;
    persist();
    ob = null;
    renderAll();
  }

  // ---------- Eintrags-Sheet ----------

  function openSheet(mealId) {
    sheet = {
      meal: mealId, tab: 'search', query: '', food: null, amount: null, editing: null,
      favMode: null, dishMeal: null,
      ai: { text: '', image: null, items: null, busy: false, error: '', mode: 'meal', webSearchUsed: false }
    };
    renderSheet();
    showSheet(true);
  }

  function openEditSheet(mealId, entry) {
    sheet = { meal: mealId, tab: 'edit', editing: entry, ai: {} };
    renderSheet();
    showSheet(true);
  }

  // Hält das Sheet über der iOS-Bildschirmtastatur: das CSS verankert es am
  // Layout-Viewport (bottom:0), den die Tastatur nicht verkleinert – der
  // visualViewport liefert die tatsächlich sichtbare Höhe.
  let sheetViewportCleanup = null;

  function keyboardInset() {
    const vv = window.visualViewport;
    if (!vv || !vv.height) return 0;
    return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  }

  function attachSheetViewport() {
    const vv = window.visualViewport;
    if (!vv || sheetViewportCleanup) return;
    const el = $('#sheet');
    const update = () => {
      if (!vv.height) {
        // Unplausibler Messwert → beim CSS-Fallback (bottom:0, max-height:88vh) bleiben
        el.style.bottom = '';
        el.style.maxHeight = '';
        return;
      }
      el.style.bottom = keyboardInset() + 'px';
      el.style.maxHeight = Math.round(vv.height * 0.88) + 'px';
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    sheetViewportCleanup = () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      el.style.bottom = '';
      el.style.maxHeight = '';
      sheetViewportCleanup = null;
    };
  }

  // ---------- Tastatur-Robustheit ----------
  // Die iOS-Tastatur verkleinert nur den visualViewport. Wir spiegeln ihre Höhe in
  // --kb-inset (fürs Scroll-Padding), blenden die Tabbar aus und halten das gerade
  // fokussierte Feld im sichtbaren Rest – im Sheet UND in den normalen Views.

  let focusedField = null;
  let focusScrollTimer = null;

  function isFormField(el) {
    return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'hidden';
  }

  function ensureFieldVisible(el) {
    if (!el || !document.contains(el) || document.activeElement !== el) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (e) {
      el.scrollIntoView();
    }
  }

  function updateKeyboardState() {
    const inset = keyboardInset();
    document.documentElement.style.setProperty('--kb-inset', inset + 'px');
    document.documentElement.classList.toggle('kb-open', inset > 80);
  }

  function attachViewportTracking() {
    const vv = window.visualViewport;
    if (!vv) return;
    const onChange = () => {
      updateKeyboardState();
      // Erst im nächsten Frame scrollen: attachSheetViewport() setzt seine Höhe im
      // selben resize-Ereignis, aber als später registrierter Listener. Ohne den
      // Aufschub rechnete ensureFieldVisible() mit der alten Sheet-Geometrie.
      if (focusedField) requestAnimationFrame(() => ensureFieldVisible(focusedField));
    };
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', updateKeyboardState);
    updateKeyboardState();
  }

  document.addEventListener('focusin', e => {
    if (!isFormField(e.target)) return;
    focusedField = e.target;
    clearTimeout(focusScrollTimer);
    focusScrollTimer = setTimeout(() => ensureFieldVisible(focusedField), 150);
  });

  document.addEventListener('focusout', e => {
    if (focusedField === e.target) focusedField = null;
    clearTimeout(focusScrollTimer);
    setTimeout(updateKeyboardState, 100);
  });

  function showSheet(visible) {
    $('#sheet').classList.toggle('hidden', !visible);
    $('#sheet-backdrop').classList.toggle('hidden', !visible);
    if (visible) {
      attachSheetViewport();
    } else {
      if (sheetViewportCleanup) sheetViewportCleanup();
      sheet = null;
    }
  }

  function mealLabel(id) {
    const m = MEALS.find(x => x.id === id);
    return m ? m.label : '';
  }

  function renderSheet() {
    if (!sheet) return;
    const hasKey = !!data.settings.apiKey;
    const isEdit = sheet.tab === 'edit';

    const tabs = isEdit ? '' : `
      <div class="sheet-tabs">
        <button class="${sheet.tab === 'search' ? 'active' : ''}" data-action="sheet-tab" data-tab="search">Suche</button>
        <button class="${sheet.tab === 'fav' ? 'active' : ''}" data-action="sheet-tab" data-tab="fav">Favoriten</button>
        <button class="${sheet.tab === 'quick' ? 'active' : ''}" data-action="sheet-tab" data-tab="quick">Schnell</button>
        ${hasKey ? `<button class="${sheet.tab === 'ai' ? 'active' : ''}" data-action="sheet-tab" data-tab="ai">KI</button>` : ''}
      </div>`;

    let body = '';
    if (isEdit) body = sheetEditBody();
    else if (sheet.tab === 'search') body = sheetSearchBody();
    else if (sheet.tab === 'fav') body = sheetFavBody();
    else if (sheet.tab === 'quick') body = sheetQuickBody();
    else if (sheet.tab === 'ai') body = sheetAiBody();

    $('#sheet').innerHTML = `
      <div class="sheet-header">
        <div class="sheet-title">${isEdit ? 'Eintrag bearbeiten' : mealLabel(sheet.meal)}</div>
        <button class="icon-btn" data-action="close-sheet" aria-label="Schließen">×</button>
      </div>
      ${tabs}
      <div class="sheet-body">${body}</div>`;

    bindSheetEvents();
  }

  // --- Reiter: Suche ---

  function searchFoods(query) {
    const q = query.trim().toLowerCase();
    if (!q) return FOODS.slice(0, 30);
    return FOODS.filter(f => f.name.toLowerCase().includes(q)).slice(0, 30);
  }

  // Eigene Einträge (Favoriten + Letzte, ohne Duplikate), deren Name die Query enthält.
  function searchOwnItems(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set();
    const out = [];
    data.favorites.concat(data.recents).forEach(item => {
      const key = itemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      if (item.name.toLowerCase().includes(q)) out.push(item);
    });
    return out.slice(0, 20);
  }

  function dishKcal(dish) {
    return dish.items.reduce((a, it) => a + (it.kcal || 0), 0);
  }

  function searchDishes(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return data.dishes
      .map((dish, idx) => ({ dish, idx }))
      .filter(x => x.dish.name.toLowerCase().includes(q))
      .slice(0, 10);
  }

  function foodResultsHtml(query) {
    const own = searchOwnItems(query);
    const dishes = searchDishes(query);
    const results = searchFoods(query);
    let html = '';

    if (own.length === 0 && dishes.length === 0 && results.length === 0) {
      html += '<p class="hint">Nichts gefunden. Tipp: Reiter „Schnell“ für freie Eingabe.</p>';
    } else {
      if (own.length || dishes.length) {
        html += '<div class="list-section">Meine Einträge</div>';
        html += dishes.map(x => `
        <button class="list-row" data-action="add-dish" data-idx="${x.idx}">
          <span class="list-name">Gericht · ${esc(x.dish.name)}</span>
          <span class="list-info">${NF0.format(x.dish.items.length)} Komponenten · ${fmtKcal(dishKcal(x.dish))} kcal</span>
        </button>`).join('');
        html += own.map(item => `
        <button class="list-row" data-action="add-saved" data-key="${esc(itemKey(item))}">
          <span class="list-name">${esc(item.name)}</span>
          <span class="list-info">${esc(item.amount || '')}${item.amount ? ' · ' : ''}${fmtKcal(item.kcal)} kcal</span>
        </button>`).join('');
      }
      if (results.length) {
        if (own.length || dishes.length) html += '<div class="list-section">Datenbank</div>';
        html += results.map(f => {
          const idx = FOODS.indexOf(f);
          const per = f.unit === 'stk' ? 'pro Stück' : `pro 100 ${f.unit === 'ml' ? 'ml' : 'g'}`;
          return `
        <button class="list-row" data-action="pick-food" data-idx="${idx}">
          <span class="list-name">${esc(f.name)}</span>
          <span class="list-info">${fmtKcal(f.kcal)} kcal ${per}</span>
        </button>`;
        }).join('');
      }
    }
    return html;
  }

  function computeFood(food, amount) {
    let factor, label;
    if (food.unit === 'stk') {
      factor = amount;
      label = `${NFx.format(amount)} Stück`;
    } else {
      factor = amount / 100;
      label = `${fmtG(amount)} ${food.unit === 'ml' ? 'ml' : 'g'}`;
    }
    return {
      kcal: food.kcal * factor,
      p: food.p * factor,
      f: food.f * factor,
      kh: food.kh * factor,
      fib: typeof food.fib === 'number' ? food.fib * factor : undefined,
      label
    };
  }

  function sheetSearchBody() {
    if (!sheet.food) {
      return `
        <input type="search" id="food-search" placeholder="Lebensmittel suchen …" value="${esc(sheet.query)}" autocomplete="off">
        <div class="list" id="food-results">${foodResultsHtml(sheet.query)}</div>`;
    }
    const f = sheet.food;
    const isStk = f.unit === 'stk';
    if (sheet.amount === null) sheet.amount = isStk ? 1 : (f.portion || 100);
    const vals = computeFood(f, sheet.amount);
    const unitLabel = isStk ? 'Stück' : (f.unit === 'ml' ? 'ml' : 'g');
    return `
      <button class="back-link" data-action="unpick-food">‹ Zur Suche</button>
      <div class="food-detail">
        <div class="food-name">${esc(f.name)}</div>
        <div class="food-portion-hint">${esc(f.portionName || '')}</div>
        <div class="amount-row">
          <input type="text" inputmode="decimal" id="amount-input" value="${esc(NFx.format(sheet.amount))}">
          <span class="unit">${unitLabel}</span>
        </div>
        <p class="error-msg amount-error hidden" id="amount-error">Menge nicht erkannt – bitte als Zahl angeben, z. B. „150“.</p>
        <div class="chip-row">
          ${isStk
            ? ['0,5', '1', '2'].map(c => `<button class="chip" data-action="set-amount" data-amount="${c}">${c} Stück</button>`).join('')
            : `${f.portion ? `<button class="chip" data-action="set-amount" data-amount="${f.portion}">${esc(f.portionName || 'Portion')}</button>` : ''}
               <button class="chip" data-action="set-amount" data-amount="100">100 ${unitLabel}</button>`}
        </div>
        <div class="preview-grid" id="food-preview">${foodPreviewRows(vals)}</div>
        <button class="btn primary full" data-action="add-food">Hinzufügen</button>
      </div>`;
  }

  // --- Reiter: Favoriten & Letzte ---

  function sheetFavBody() {
    const favHtml = list => list.map(item => {
      const fav = isFavorite(item);
      return `
      <div class="list-row split">
        <button class="list-tap" data-action="add-saved" data-key="${esc(itemKey(item))}">
          <span class="list-name">${esc(item.name)}</span>
          <span class="list-info">${esc(item.amount || '')}${item.amount ? ' · ' : ''}${fmtKcal(item.kcal)} kcal</span>
        </button>
        <button class="star ${fav ? 'on' : ''}" data-action="toggle-fav" data-key="${esc(itemKey(item))}" aria-label="Favorit">${fav ? '★' : '☆'}</button>
      </div>`;
    }).join('');

    let html = dishesSectionHtml();
    if (data.favorites.length) {
      html += `<div class="list-section">Favoriten</div><div class="list">${favHtml(data.favorites)}</div>`;
    }
    const recentOnly = data.recents.filter(r => !isFavorite(r));
    if (recentOnly.length) {
      html += `<div class="list-section">Zuletzt verwendet</div><div class="list">${favHtml(recentOnly)}</div>`;
    }
    if (!data.favorites.length && !recentOnly.length && !data.dishes.length && !sheet.favMode) {
      html += '<p class="hint">Noch nichts vorhanden. Einträge erscheinen hier automatisch – mit ☆ markierst du Favoriten.</p>';
    }
    return html;
  }

  // --- Meine Gerichte ---

  function dishesSectionHtml() {
    let html = '<div class="list-section">Meine Gerichte</div>';

    if (sheet.favMode === 'pick') {
      html += `<p class="hint dish-hint">Welche Mahlzeit von ${esc(fmtDayLabel(currentDay))} soll als Vorlage dienen?</p>
        <div class="choice-list">`;
      MEALS.forEach(meal => {
        const entries = getDay(currentDay).meals[meal.id] || [];
        const sum = entries.reduce((a, e) => a + e.kcal, 0);
        html += `
          <button class="choice" data-action="dish-pick" data-meal="${meal.id}" ${entries.length === 0 ? 'disabled' : ''}>
            <strong>${meal.label}</strong>
            <span>${entries.length === 0 ? 'keine Einträge' : `${NF0.format(entries.length)} ${entries.length === 1 ? 'Eintrag' : 'Einträge'} · ${fmtKcal(sum)} kcal`}</span>
          </button>`;
      });
      html += `</div><button class="btn full" data-action="dish-cancel">Abbrechen</button>`;
      return html;
    }

    if (sheet.favMode === 'name') {
      const entries = getDay(currentDay).meals[sheet.dishMeal] || [];
      const sum = entries.reduce((a, e) => a + e.kcal, 0);
      html += `
        <p class="hint dish-hint">${NF0.format(entries.length)} Komponenten aus „${esc(mealLabel(sheet.dishMeal))}“ · ${fmtKcal(sum)} kcal</p>
        <input type="text" id="dish-name" placeholder="Name des Gerichts, z. B. Mein Frühstück" autocomplete="off">
        <div class="btn-row dish-btns">
          <button class="btn" data-action="dish-cancel">Abbrechen</button>
          <button class="btn primary" data-action="dish-save">Speichern</button>
        </div>`;
      return html;
    }

    if (data.dishes.length) {
      html += `<div class="list">${data.dishes.map((dish, idx) => `
        <div class="list-row split">
          <button class="list-tap" data-action="add-dish" data-idx="${idx}">
            <span class="list-name">${esc(dish.name)}</span>
            <span class="list-info">${NF0.format(dish.items.length)} Komponenten · ${fmtKcal(dishKcal(dish))} kcal</span>
          </button>
          <button class="entry-del" data-action="del-dish" data-idx="${idx}" aria-label="Gericht löschen">×</button>
        </div>`).join('')}</div>`;
    }
    html += `<button class="btn dish-create-btn" data-action="dish-create">Gericht aus Tag erstellen</button>`;
    return html;
  }

  function findSaved(key) {
    return data.favorites.find(f => itemKey(f) === key) || data.recents.find(r => itemKey(r) === key) || null;
  }

  // --- Reiter: Schnell ---

  function sheetQuickBody() {
    return `
      <div class="form-grid">
        <label class="span2">Bezeichnung
          <input type="text" id="quick-name" placeholder="z. B. Kantinen-Essen" autocomplete="off">
        </label>
        <label>Kalorien (kcal)
          <input type="number" inputmode="numeric" id="quick-kcal" min="0" max="10000" placeholder="0">
        </label>
        <label>Protein (g)
          <input type="text" inputmode="decimal" id="quick-p" placeholder="optional">
        </label>
        <label>Fett (g)
          <input type="text" inputmode="decimal" id="quick-f" placeholder="optional">
        </label>
        <label>Kohlenhydrate (g)
          <input type="text" inputmode="decimal" id="quick-kh" placeholder="optional">
        </label>
        <label>Ballaststoffe (g)
          <input type="text" inputmode="decimal" id="quick-fib" placeholder="optional">
        </label>
      </div>
      <button class="btn primary full" data-action="add-quick">Hinzufügen</button>`;
  }

  // --- Reiter: KI ---

  function sheetAiBody() {
    const ai = sheet.ai;
    const isLabel = ai.mode === 'label';
    let html = `
      <div class="segmented ai-mode-seg">
        <button class="${!isLabel ? 'active' : ''}" data-action="ai-mode" data-mode="meal">Mahlzeit</button>
        <button class="${isLabel ? 'active' : ''}" data-action="ai-mode" data-mode="label">Etikett</button>
      </div>
      <p class="hint">${isLabel
        ? 'Nährwerttabelle der Packung fotografieren – die Werte werden exakt abgelesen (pro 100 g und, falls angegeben, pro Portion).'
        : 'Mahlzeit fotografieren oder beschreiben – Claude schätzt die Nährwerte. Vorschläge lassen sich vor dem Speichern anpassen.'}</p>
      <textarea id="ai-text" rows="2" placeholder="${isLabel
        ? 'optional: Produktname'
        : 'z. B. 2 Brötchen mit Käse und ein Cappuccino'}">${esc(ai.text || '')}</textarea>
      <div class="btn-row">
        <label class="btn file-btn">
          ${ai.image ? 'Anderes Foto' : 'Foto aufnehmen/wählen'}
          <input type="file" id="ai-photo" accept="image/*" capture="environment" hidden>
        </label>
        <button class="btn primary" data-action="ai-analyze" ${ai.busy ? 'disabled' : ''}>
          ${ai.busy ? 'Analysiere …' : 'Analysieren'}
        </button>
      </div>`;

    if (ai.image) {
      html += `<div class="ai-thumb"><img src="${ai.image.previewUrl}" alt="Foto der Mahlzeit">
        <button class="icon-btn" data-action="ai-remove-photo" aria-label="Foto entfernen">×</button></div>`;
    }
    if (ai.error) {
      html += `<p class="error-msg">${esc(ai.error)}</p>`;
    }
    if (ai.items) {
      if (ai.webSearchUsed) {
        html += '<p class="hint">Online recherchiert (fddb)</p>';
      }
      html += '<div class="list-section">Vorschläge – prüfen und anpassen</div><div class="ai-items">';
      ai.items.forEach((it, i) => {
        const sel = it.selected !== false;
        html += `
        <div class="ai-item ${sel ? '' : 'ai-off'}" data-ai-idx="${i}" data-qty="${esc(qtySignature(it.menge))}">
          <button type="button" class="ai-toggle ${sel ? 'on' : ''}" data-action="ai-toggle" data-idx="${i}"
            aria-pressed="${sel}" aria-label="Vorschlag ${sel ? 'abwählen' : 'auswählen'}">✓</button>
          <div class="ai-fields">
            <input type="text" class="ai-name" value="${esc(it.name)}" placeholder="Name">
            <div class="ai-menge-row">
              <input type="text" class="ai-menge" value="${esc(it.menge)}" placeholder="Menge">
              ${scaleChips('ai-scale')}
            </div>
            <div class="ai-macros">
              <label>kcal<input type="number" class="ai-kcal" inputmode="numeric" value="${it.kcal}"></label>
              <label>P (g)<input type="text" class="ai-p" inputmode="decimal" value="${esc(String(it.p).replace('.', ','))}"></label>
              <label>F (g)<input type="text" class="ai-f" inputmode="decimal" value="${esc(String(it.f).replace('.', ','))}"></label>
              <label>KH (g)<input type="text" class="ai-kh" inputmode="decimal" value="${esc(String(it.kh).replace('.', ','))}"></label>
              <label>BS (g)<input type="text" class="ai-fib" inputmode="decimal" placeholder="?"
                value="${it.fib !== undefined ? esc(String(it.fib).replace('.', ',')) : ''}"></label>
            </div>
          </div>
        </div>`;
      });
      const count = ai.items.filter(it => it.selected !== false).length;
      html += `</div><button class="btn primary full" data-action="ai-accept" ${count === 0 ? 'disabled' : ''}>${aiAcceptLabel(count)}</button>`;
    }
    return html;
  }

  function aiAcceptLabel(count) {
    if (count === 0) return 'Nichts ausgewählt';
    return `${NF0.format(count)} ${count === 1 ? 'Eintrag' : 'Einträge'} übernehmen`;
  }

  function updateAiAcceptButton() {
    const btn = document.querySelector('[data-action="ai-accept"]');
    if (!btn || !sheet || !sheet.ai || !sheet.ai.items) return;
    const count = sheet.ai.items.filter(it => it.selected !== false).length;
    btn.disabled = count === 0;
    btn.textContent = aiAcceptLabel(count);
  }

  // --- Mengen-Umrechner ---

  const SCALE_FACTORS = [
    { factor: '0.3333333333', label: '× ⅓' },
    { factor: '0.5', label: '× ½' },
    { factor: '2', label: '× 2' }
  ];

  function scaleChips(action) {
    return SCALE_FACTORS.map(s =>
      `<button type="button" class="chip" data-action="${action}" data-factor="${s.factor}">${s.label}</button>`
    ).join('');
  }

  function formatQtyNumber(n) {
    return Calc.fmtQty(n);
  }

  // Alle Zahlen des Mengentexts als Signatur „1|30“ – Grundlage für diffFactor().
  function qtySignature(text) {
    return Calc.quantityNumbers(text).map(n => n.value).join('|');
  }
  function qtySignatureToList(sig) {
    if (!sig) return [];
    return String(sig).split('|').map(Number).filter(n => isFinite(n));
  }

  // Skaliert kcal/P/F/KH/Ballaststoffe proportional von ihren AKTUELLEN Werten aus.
  // Ein leeres Ballaststoff-Feld bleibt leer (unbekannt bleibt unbekannt).
  function scaleNutrientInputs(fields, factor) {
    const kcalEl = fields.kcal;
    kcalEl.value = String(Math.max(0, Math.round((parseFloat(kcalEl.value) || 0) * factor)));
    [fields.p, fields.f, fields.kh].forEach(el => {
      if (!el) return;
      const v = parseGermanFloat(el.value) || 0;
      el.value = formatQtyNumber(Math.max(0, v * factor));
    });
    if (fields.fib && fields.fib.value.trim() !== '') {
      const v = parseGermanFloat(fields.fib.value);
      if (v !== null) fields.fib.value = formatQtyNumber(Math.max(0, v * factor));
    }
  }

  function aiRowFields(row) {
    return {
      kcal: row.querySelector('.ai-kcal'),
      p: row.querySelector('.ai-p'),
      f: row.querySelector('.ai-f'),
      kh: row.querySelector('.ai-kh'),
      fib: row.querySelector('.ai-fib')
    };
  }

  function editFields() {
    return { kcal: $('#edit-kcal'), p: $('#edit-p'), f: $('#edit-f'), kh: $('#edit-kh'), fib: $('#edit-fib') };
  }

  // Chip-Skalierung: Nährwerte und Ankerzahl im Mengentext.
  function scaleRow(fields, textEl, factor) {
    scaleNutrientInputs(fields, factor);
    if (!textEl) return;
    const scaled = Calc.scaleAnchor(textEl.value, factor);
    if (scaled !== null) textEl.value = scaled;
    textEl.dataset.qty = qtySignature(textEl.value);
  }

  // Mengentext von Hand geändert: genau eine geänderte Zahl ergibt den Faktor.
  function applyQuantityEdit(fields, textEl) {
    const oldList = qtySignatureToList(textEl.dataset.qty);
    const newList = Calc.quantityNumbers(textEl.value).map(n => n.value);
    const factor = Calc.diffFactor(oldList, newList);
    if (factor !== null) scaleNutrientInputs(fields, factor);
    textEl.dataset.qty = newList.join('|');
  }

  // Tolerantes Parsen der Mengenangabe in der DB-Detailansicht: führende Zahl,
  // optional gefolgt von einer Einheit („150 g“, „1,5 Stück“). Sonst null.
  // „1 kg“ bzw. „0,5 l“ werden in die Basiseinheit des Lebensmittels umgerechnet,
  // statt sie als 1 g bzw. 0,5 ml zu buchen. Bei Stück-Lebensmitteln bleibt die Zahl.
  function parseAmountInput(value, foodUnit) {
    const s = String(value == null ? '' : value).trim();
    const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|stk\.?|stück|st\.?)?$/i);
    if (!m) return null;
    const n = parseGermanFloat(m[1]);
    if (n === null) return null;
    const unit = (m[2] || '').toLowerCase();
    const scalable = foodUnit === 'g' || foodUnit === 'ml';
    return (scalable && (unit === 'kg' || unit === 'l')) ? n * 1000 : n;
  }

  function setAmountError(invalid) {
    const input = $('#amount-input');
    const msg = $('#amount-error');
    const btn = document.querySelector('[data-action="add-food"]');
    if (input) input.classList.toggle('input-error', invalid);
    if (msg) msg.classList.toggle('hidden', !invalid);
    if (btn) btn.disabled = invalid;
  }

  // --- Bearbeiten ---

  function sheetEditBody() {
    const e = sheet.editing;
    return `
      <div class="form-grid">
        <label class="span2">Bezeichnung
          <input type="text" id="edit-name" value="${esc(e.name)}">
        </label>
        <label class="span2">Menge (Anzeige)
          <input type="text" id="edit-amount" value="${esc(e.amount || '')}" placeholder="z. B. 150 g"
            data-qty="${esc(qtySignature(e.amount || ''))}">
        </label>
        <div class="span2 scale-row">
          <span class="scale-label">Menge anpassen:</span>
          ${scaleChips('edit-scale')}
        </div>
        <label>Kalorien (kcal)
          <input type="number" inputmode="numeric" id="edit-kcal" min="0" value="${e.kcal}">
        </label>
        <label>Protein (g)
          <input type="text" inputmode="decimal" id="edit-p" value="${esc(String(e.p || 0).replace('.', ','))}">
        </label>
        <label>Fett (g)
          <input type="text" inputmode="decimal" id="edit-f" value="${esc(String(e.f || 0).replace('.', ','))}">
        </label>
        <label>Kohlenhydrate (g)
          <input type="text" inputmode="decimal" id="edit-kh" value="${esc(String(e.kh || 0).replace('.', ','))}">
        </label>
        <label>Ballaststoffe (g)
          <input type="text" inputmode="decimal" id="edit-fib" placeholder="unbekannt"
            value="${e.fib !== undefined ? esc(String(e.fib).replace('.', ',')) : ''}">
        </label>
      </div>
      <button class="btn primary full" data-action="save-edit">Speichern</button>`;
  }

  // --- Sheet-Events ---

  function bindSheetEvents() {
    const search = $('#food-search');
    if (search) {
      search.addEventListener('input', () => {
        sheet.query = search.value;
        $('#food-results').innerHTML = foodResultsHtml(sheet.query);
      });
      if (document.activeElement !== search && !sheet.query) {
        // Fokus nur beim ersten Aufbau, nicht bei jedem Rerender aufzwingen
      }
    }
    const amount = $('#amount-input');
    if (amount) {
      amount.addEventListener('input', () => {
        const v = parseAmountInput(amount.value, sheet.food && sheet.food.unit);
        const valid = v !== null && v > 0 && v < 100000;
        if (valid) {
          sheet.amount = v;
          updateFoodPreview();
        }
        setAmountError(!valid);
      });
    }
    const photo = $('#ai-photo');
    if (photo) {
      photo.addEventListener('change', async () => {
        const file = photo.files && photo.files[0];
        if (!file) return;
        try {
          sheet.ai.image = await AI.resizeImage(file);
          sheet.ai.error = '';
        } catch (err) {
          sheet.ai.error = err.message;
        }
        renderSheet();
      });
    }
    const aiText = $('#ai-text');
    if (aiText) {
      aiText.addEventListener('input', () => { sheet.ai.text = aiText.value; });
    }
    // Mengentext im KI-Vorschlag editiert → Nährwerte proportional mitrechnen
    document.querySelectorAll('.ai-item .ai-menge').forEach(mengeEl => {
      mengeEl.addEventListener('change', () => {
        const row = mengeEl.closest('.ai-item');
        mengeEl.dataset.qty = row.dataset.qty;
        applyQuantityEdit(aiRowFields(row), mengeEl);
        row.dataset.qty = mengeEl.dataset.qty;
      });
    });
    // Bearbeiten-Sheet: dieselbe Umrechnung wie in der KI-Liste
    const editAmount = $('#edit-amount');
    if (editAmount) {
      editAmount.addEventListener('change', () => applyQuantityEdit(editFields(), editAmount));
    }
  }

  function foodPreviewRows(vals) {
    return `
      <div><strong>${fmtKcal(vals.kcal)}</strong><span>kcal</span></div>
      <div><strong>${NFx.format(vals.p)} g</strong><span>Protein</span></div>
      <div><strong>${NFx.format(vals.f)} g</strong><span>Fett</span></div>
      <div><strong>${NFx.format(vals.kh)} g</strong><span>KH</span></div>
      <div><strong>${vals.fib !== undefined ? `${NFx.format(vals.fib)} g` : '–'}</strong><span>Ballastst.</span></div>`;
  }

  function updateFoodPreview() {
    const box = $('#food-preview');
    if (!box || !sheet || !sheet.food) return;
    box.innerHTML = foodPreviewRows(computeFood(sheet.food, sheet.amount));
  }

  async function runAiAnalyze() {
    const ai = sheet.ai;
    if (ai.busy) return;
    if (ai.mode === 'label' && !ai.image) {
      ai.error = 'Bitte ein Foto der Nährwerttabelle wählen.';
      renderSheet();
      return;
    }
    if (!ai.text.trim() && !ai.image) {
      ai.error = 'Bitte ein Foto wählen oder die Mahlzeit beschreiben.';
      renderSheet();
      return;
    }
    ai.busy = true;
    ai.error = '';
    ai.items = null;
    ai.webSearchUsed = false;
    renderSheet();
    try {
      const res = await AI.analyze({
        apiKey: data.settings.apiKey, text: ai.text, image: ai.image, mode: ai.mode,
        webSearch: data.settings.aiWebSearch !== false
      });
      if (!sheet || !sheet.ai) return;
      res.items.forEach(it => { it.selected = true; });
      sheet.ai.items = res.items;
      sheet.ai.webSearchUsed = res.webSearchUsed;
    } catch (err) {
      if (!sheet || !sheet.ai) return;
      sheet.ai.error = err.message;
    }
    sheet.ai.busy = false;
    renderSheet();
  }

  function acceptAiItems() {
    const rows = document.querySelectorAll('.ai-item');
    let added = 0;
    rows.forEach(row => {
      const idx = parseInt(row.dataset.aiIdx, 10);
      const item = sheet.ai.items[idx];
      if (!item || item.selected === false) return;
      const name = row.querySelector('.ai-name').value.trim();
      const menge = row.querySelector('.ai-menge').value.trim();
      const kcal = parseFloat(row.querySelector('.ai-kcal').value) || 0;
      const p = parseGermanFloat(row.querySelector('.ai-p').value) || 0;
      const f = parseGermanFloat(row.querySelector('.ai-f').value) || 0;
      const kh = parseGermanFloat(row.querySelector('.ai-kh').value) || 0;
      const fibRaw = row.querySelector('.ai-fib').value.trim();
      const fib = fibRaw === '' ? undefined : (parseGermanFloat(fibRaw) ?? undefined);
      if (!name || kcal <= 0) return;
      addEntry(currentDay, sheet.meal, { name, amount: menge, kcal, p, f, kh, fib });
      added++;
    });
    if (added > 0) {
      showSheet(false);
      renderAll();
      toast(`${NF0.format(added)} ${added === 1 ? 'Eintrag' : 'Einträge'} hinzugefügt`);
    } else {
      toast('Nichts ausgewählt oder Angaben unvollständig.');
    }
  }

  // ---------- Aktionen (delegiert) ----------

  document.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    switch (action) {
      // Navigation
      case 'tab':
        activeTab = target.dataset.tab;
        updateTabbar();
        window.scrollTo(0, 0);
        break;
      case 'day-prev':
        currentDay = addDays(currentDay, -1);
        activeEdit = false;
        renderToday();
        break;
      case 'day-next':
        if (currentDay < todayKey()) {
          currentDay = addDays(currentDay, 1);
          activeEdit = false;
          renderToday();
        }
        break;
      case 'day-today':
        currentDay = todayKey();
        activeEdit = false;
        renderToday();
        break;
      case 'open-day':
        currentDay = target.dataset.day;
        activeEdit = false;
        activeTab = 'today';
        renderToday();
        updateTabbar();
        window.scrollTo(0, 0);
        break;

      // Sheet
      case 'open-sheet': openSheet(target.dataset.meal); break;
      case 'close-sheet': showSheet(false); break;
      case 'sheet-tab':
        sheet.tab = target.dataset.tab;
        sheet.food = null;
        sheet.amount = null;
        sheet.favMode = null;
        renderSheet();
        break;
      case 'pick-food':
        sheet.food = FOODS[parseInt(target.dataset.idx, 10)];
        sheet.amount = null;
        renderSheet();
        break;
      case 'unpick-food':
        sheet.food = null;
        sheet.amount = null;
        renderSheet();
        break;
      case 'set-amount':
        sheet.amount = parseGermanFloat(target.dataset.amount);
        renderSheet();
        break;
      case 'add-food': {
        // Feldwert beim Klick erneut lesen – nie still die alte Menge buchen
        const raw = $('#amount-input')
          ? parseAmountInput($('#amount-input').value, sheet.food && sheet.food.unit)
          : sheet.amount;
        if (raw === null || !(raw > 0) || raw >= 100000) {
          setAmountError(true);
          toast('Menge nicht erkannt – bitte als Zahl angeben, z. B. „150“.');
          break;
        }
        sheet.amount = raw;
        const vals = computeFood(sheet.food, sheet.amount);
        addEntry(currentDay, sheet.meal, {
          name: sheet.food.name, amount: vals.label,
          kcal: vals.kcal, p: vals.p, f: vals.f, kh: vals.kh, fib: vals.fib
        });
        showSheet(false);
        renderAll();
        toast('Eintrag hinzugefügt');
        break;
      }
      case 'add-saved': {
        const item = findSaved(target.dataset.key);
        if (item) {
          addEntry(currentDay, sheet.meal, item);
          showSheet(false);
          renderAll();
          toast('Eintrag hinzugefügt');
        }
        break;
      }
      case 'toggle-fav': {
        const item = findSaved(target.dataset.key);
        if (item) {
          toggleFavorite(item);
          renderSheet();
        }
        break;
      }
      case 'dish-create':
        sheet.favMode = 'pick';
        renderSheet();
        break;
      case 'dish-pick': {
        const entries = getDay(currentDay).meals[target.dataset.meal] || [];
        if (entries.length === 0) break;
        sheet.dishMeal = target.dataset.meal;
        sheet.favMode = 'name';
        renderSheet();
        const nameInput = $('#dish-name');
        if (nameInput) setTimeout(() => nameInput.focus(), 50);
        break;
      }
      case 'dish-cancel':
        sheet.favMode = null;
        sheet.dishMeal = null;
        renderSheet();
        break;
      case 'dish-save': {
        const name = $('#dish-name').value.trim();
        if (!name) { toast('Bitte einen Namen für das Gericht angeben.'); break; }
        const entries = getDay(currentDay).meals[sheet.dishMeal] || [];
        if (entries.length === 0) { toast('Die gewählte Mahlzeit hat keine Einträge.'); break; }
        data.dishes.unshift({
          name: name.slice(0, 60),
          items: entries.map(e => withFib(
            { name: e.name, amount: e.amount || '', kcal: e.kcal, p: e.p || 0, f: e.f || 0, kh: e.kh || 0 },
            e.fib
          ))
        });
        persist();
        sheet.favMode = null;
        sheet.dishMeal = null;
        renderSheet();
        toast('Gericht gespeichert');
        break;
      }
      case 'add-dish': {
        const dish = data.dishes[parseInt(target.dataset.idx, 10)];
        if (!dish) break;
        dish.items.forEach(it => addEntry(currentDay, sheet.meal, it));
        showSheet(false);
        renderAll();
        toast(`„${dish.name}“ gebucht (${NF0.format(dish.items.length)} ${dish.items.length === 1 ? 'Eintrag' : 'Einträge'})`);
        break;
      }
      case 'del-dish': {
        const idx = parseInt(target.dataset.idx, 10);
        const removed = data.dishes[idx];
        if (!removed) break;
        data.dishes.splice(idx, 1);
        persist();
        renderSheet();
        toast('Gericht gelöscht', {
          actionLabel: 'Rückgängig',
          duration: 5000,
          onAction: () => {
            data.dishes.splice(Math.min(idx, data.dishes.length), 0, removed);
            persist();
            if (sheet && sheet.tab === 'fav') renderSheet();
          }
        });
        break;
      }
      case 'ai-mode':
        sheet.ai.mode = target.dataset.mode === 'label' ? 'label' : 'meal';
        sheet.ai.items = null;
        sheet.ai.error = '';
        renderSheet();
        break;
      case 'add-quick': {
        const name = $('#quick-name').value.trim();
        const kcal = parseFloat($('#quick-kcal').value) || 0;
        if (!name) { toast('Bitte eine Bezeichnung angeben.'); break; }
        if (kcal <= 0) { toast('Bitte Kalorien angeben.'); break; }
        const fibRaw = $('#quick-fib').value.trim();
        addEntry(currentDay, sheet.meal, {
          name, amount: '',
          kcal,
          p: parseGermanFloat($('#quick-p').value) || 0,
          f: parseGermanFloat($('#quick-f').value) || 0,
          kh: parseGermanFloat($('#quick-kh').value) || 0,
          fib: fibRaw === '' ? undefined : (parseGermanFloat(fibRaw) ?? undefined)
        });
        showSheet(false);
        renderAll();
        toast('Eintrag hinzugefügt');
        break;
      }
      case 'ai-analyze': runAiAnalyze(); break;
      case 'ai-remove-photo':
        sheet.ai.image = null;
        renderSheet();
        break;
      case 'ai-toggle': {
        const idx = parseInt(target.dataset.idx, 10);
        const item = sheet.ai.items[idx];
        if (!item) break;
        item.selected = item.selected === false;
        const row = target.closest('.ai-item');
        row.classList.toggle('ai-off', !item.selected);
        target.classList.toggle('on', item.selected);
        target.setAttribute('aria-pressed', String(item.selected));
        target.setAttribute('aria-label', `Vorschlag ${item.selected ? 'abwählen' : 'auswählen'}`);
        updateAiAcceptButton();
        break;
      }
      case 'ai-scale': {
        const row = target.closest('.ai-item');
        if (!row) break;
        const mengeEl = row.querySelector('.ai-menge');
        scaleRow(aiRowFields(row), mengeEl, parseFloat(target.dataset.factor));
        row.dataset.qty = mengeEl.dataset.qty;
        break;
      }
      case 'edit-scale':
        scaleRow(editFields(), $('#edit-amount'), parseFloat(target.dataset.factor));
        break;
      case 'ai-accept': acceptAiItems(); break;

      // Einträge
      case 'edit-entry': {
        const entry = findEntry(currentDay, target.dataset.meal, target.dataset.id);
        if (entry) openEditSheet(target.dataset.meal, entry);
        break;
      }
      case 'del-entry': {
        const dayKey = currentDay;
        const mealId = target.dataset.meal;
        const list = getDay(dayKey).meals[mealId] || [];
        const index = list.findIndex(en => en.id === target.dataset.id);
        if (index === -1) break;
        const removed = list[index];
        deleteEntry(dayKey, mealId, removed.id);
        renderAll();
        toast('Eintrag gelöscht', {
          actionLabel: 'Rückgängig',
          duration: 5000,
          onAction: () => {
            const meals = ensureDay(dayKey).meals[mealId];
            meals.splice(Math.min(index, meals.length), 0, removed);
            persist();
            renderAll();
          }
        });
        break;
      }
      case 'save-edit': {
        const entry = sheet.editing;
        const name = $('#edit-name').value.trim();
        const kcal = parseFloat($('#edit-kcal').value) || 0;
        if (!name) { toast('Bitte eine Bezeichnung angeben.'); break; }
        if (kcal <= 0) { toast('Bitte Kalorien angeben.'); break; }
        entry.name = name;
        entry.amount = $('#edit-amount').value.trim();
        entry.kcal = Math.round(kcal);
        entry.p = Math.round((parseGermanFloat($('#edit-p').value) || 0) * 10) / 10;
        entry.f = Math.round((parseGermanFloat($('#edit-f').value) || 0) * 10) / 10;
        entry.kh = Math.round((parseGermanFloat($('#edit-kh').value) || 0) * 10) / 10;
        const fibRaw = $('#edit-fib').value.trim();
        const fibParsed = fibRaw === '' ? undefined : parseGermanFloat(fibRaw);
        if (fibRaw !== '' && fibParsed === null) {
          toast('Ballaststoffe nicht erkannt – bitte eine Zahl wie 4,5 angeben.');
          break;
        }
        const fibNew = fibValue(fibParsed ?? undefined);
        if (fibNew === undefined) delete entry.fib; else entry.fib = fibNew;
        persist();
        showSheet(false);
        renderAll();
        toast('Gespeichert');
        break;
      }

      // Gewicht
      case 'save-weight': {
        const v = parseGermanFloat($('#weight-input').value);
        if (v === null || v < 30 || v > 300) { toast('Bitte ein Gewicht zwischen 30 und 300 kg angeben.'); break; }
        const savedFor = weightDate;
        data.weights[savedFor] = Math.round(v * 10) / 10;
        weightDate = todayKey();
        persist();
        renderAll();
        toast(savedFor === todayKey() ? 'Gewicht gespeichert' : `Gewicht für ${fmtDateShort(savedFor)} gespeichert`);
        break;
      }
      case 'save-waist': {
        const v = parseGermanFloat($('#waist-input').value);
        if (v === null || v < 40 || v > 250) { toast('Bitte einen Bauchumfang zwischen 40 und 250 cm angeben.'); break; }
        const savedFor = weightDate;
        data.waist[savedFor] = Math.round(v * 10) / 10;
        weightDate = todayKey();
        persist();
        renderWeight();
        toast(savedFor === todayKey() ? 'Bauchumfang gespeichert' : `Bauchumfang für ${fmtDateShort(savedFor)} gespeichert`);
        break;
      }
      case 'weight-range':
        weightRange = target.dataset.range;
        renderWeight();
        break;

      // Aktivkalorien (Apple Watch)
      case 'edit-active':
        activeEdit = true;
        renderToday();
        {
          const input = $('#active-input');
          if (input) setTimeout(() => input.focus(), 50);
        }
        break;
      case 'save-active': {
        const raw = $('#active-input').value.trim();
        if (raw === '') {
          delete data.activeEnergy[currentDay];
        } else {
          // parseKcalToken statt parseGermanFloat: das Feld zeigt den Wert mit
          // Tausenderpunkt an ("3.000"), der sonst als Dezimalpunkt gelesen würde.
          const v = Calc.parseKcalToken(raw);
          if (v === null || v < 0 || v > 10000) { toast('Bitte Aktivkalorien zwischen 0 und 10.000 angeben.'); break; }
          data.activeEnergy[currentDay] = Math.round(v);
        }
        activeEdit = false;
        persist();
        renderAll();
        toast(raw === '' ? 'Aktivkalorien entfernt' : 'Aktivkalorien gespeichert');
        break;
      }
      case 'watch-check': {
        watchImport.text = $('#watch-import').value;
        watchImport.result = Calc.parseActiveEnergyLines(watchImport.text, todayKey());
        refreshSettingsDerived();
        break;
      }
      case 'watch-apply': {
        // Immer den aktuellen Feldinhalt parsen – sonst würde ein nach dem Prüfen
        // geänderter Text stillschweigend mit dem alten Ergebnis übernommen.
        const box = $('#watch-import');
        if (box) watchImport.text = box.value;
        const res = Calc.parseActiveEnergyLines(watchImport.text, todayKey());
        if (res.entries.length === 0) {
          watchImport.result = res;
          refreshSettingsDerived();
          toast('Keine übernehmbare Zeile erkannt.');
          break;
        }
        res.entries.forEach(e => { data.activeEnergy[e.key] = e.kcal; });
        const count = res.entries.length;
        // Unklare Zeilen bleiben stehen, damit sie nachgebessert werden können.
        watchImport = { text: res.unclear.join('\n'), result: null };
        persist();
        renderAll();
        toast(res.unclear.length > 0
          ? `${NF0.format(count)} ${count === 1 ? 'Tag' : 'Tage'} übernommen · ${NF0.format(res.unclear.length)} unklare ${res.unclear.length === 1 ? 'Zeile bleibt' : 'Zeilen bleiben'} stehen`
          : `${NF0.format(count)} ${count === 1 ? 'Tag' : 'Tage'} übernommen`);
        break;
      }

      // Einstellungen
      case 'export':
        markExported();
        Storage.exportJson(data);
        renderSettings();
        toast('Export gestartet');
        break;
      case 'export-csv':
        markExported();
        Storage.exportCsv(buildCsv());
        renderSettings();
        toast('CSV-Export gestartet');
        break;
      case 'use-calibrated': {
        const s = data.settings;
        s.useCalibratedTdee = true;
        s.appliedTdee = Calc.effectiveTdee(formulaTdeeToday(), computeCalibration()).tdee;
        s.appliedTdeeDate = todayKey();
        persist();
        renderAll();
        toast('Kalibrierter Verbrauch übernommen');
        break;
      }
      case 'import':
        $('#import-file').click();
        break;
      case 'delete-all':
        if (confirm('Wirklich ALLE Daten löschen? Ein Export vorher ist dringend empfohlen.') &&
            confirm('Letzte Sicherheitsfrage: Alle Einträge, Gewichte und Einstellungen unwiderruflich löschen?')) {
          Storage.clearAll();
          data = Storage.load();
          currentDay = todayKey();
          activeTab = 'today';
          renderAll();
        }
        break;

      // Onboarding
      case 'ob-back':
        ob.step = Math.max(0, ob.step - 1);
        renderOnboarding();
        break;
      case 'ob-next':
        if (!obReadInput()) break;
        if (ob.step === 7) finishOnboarding();
        else { ob.step++; renderOnboarding(); }
        break;
    }
  });

  // Onboarding-Auswahlfelder (data-ob ohne data-action)
  document.addEventListener('click', e => {
    const choice = e.target.closest('[data-ob]');
    if (!choice || !ob) return;
    const field = choice.dataset.ob;
    ob.values[field] = field === 'sex' ? choice.dataset.value : parseInt(choice.dataset.value, 10);
    renderOnboarding();
  });

  // Import-Datei
  $('#import-file').addEventListener('change', () => {
    const input = $('#import-file');
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = Storage.parseImport(reader.result);
        const days = Object.keys(imported.days).length;
        const weights = Object.keys(imported.weights).length;
        if (confirm(`Import ersetzt alle vorhandenen Daten durch den Export ` +
            `(${NF0.format(days)} Tage, ${NF0.format(weights)} Wiegeeinträge). Fortfahren?`)) {
          data = imported;
          persist();
          currentDay = todayKey();
          renderAll();
          toast('Import erfolgreich');
        }
      } catch (err) {
        alert(`Import fehlgeschlagen: ${err.message}`);
      }
    };
    reader.readAsText(file);
  });

  // ---------- Service Worker ----------

  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW-Registrierung fehlgeschlagen:', err));
    });
  }

  // ---------- Start ----------

  if (data.profile) refreshAppliedTdee();
  attachViewportTracking();
  renderAll();
  if (data.profile) maybeBackupHint();
})();
