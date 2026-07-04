'use strict';

(() => {

  // ---------- Helfer ----------

  const $ = sel => document.querySelector(sel);
  const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  const NF1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const NFx = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

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
  let sheet = null;   // { meal, tab, query, food, editing, ai: {...} }
  let ob = null;      // Onboarding: { step, values }

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
  function dayTotals(key) {
    const day = getDay(key);
    const t = { kcal: 0, p: 0, f: 0, kh: 0 };
    MEALS.forEach(m => (day.meals[m.id] || []).forEach(e => {
      t.kcal += e.kcal; t.p += e.p || 0; t.f += e.f || 0; t.kh += e.kh || 0;
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

  function metricsFor(key) {
    const p = data.profile;
    const weight = weightOnOrBefore(key) ?? currentWeight();
    const age = Calc.ageFromBirthYear(p.birthYear);
    const bmr = Calc.bmr(p.sex, weight, p.heightCm, age);
    const tdee = Calc.tdee(bmr, p.activity);
    return {
      weight, bmr, tdee,
      goal: Calc.calorieGoal(tdee, p.deficit),
      proteinGoal: Calc.proteinGoal(weight, p.proteinPerKg)
    };
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

  function pushRecent(entry) {
    const item = { name: entry.name, amount: entry.amount, kcal: entry.kcal, p: entry.p, f: entry.f, kh: entry.kh };
    data.recents = data.recents.filter(r => itemKey(r) !== itemKey(item));
    data.recents.unshift(item);
    data.recents = data.recents.slice(0, 20);
  }

  function addEntry(dayKey, mealId, values) {
    const entry = {
      id: newId(),
      name: values.name,
      amount: values.amount || '',
      kcal: Math.round(values.kcal),
      p: Math.round((values.p || 0) * 10) / 10,
      f: Math.round((values.f || 0) * 10) / 10,
      kh: Math.round((values.kh || 0) * 10) / 10
    };
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
    else data.favorites.unshift({ name: item.name, amount: item.amount, kcal: item.kcal, p: item.p, f: item.f, kh: item.kh });
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
        ${Charts.ring(totals.kcal, m.goal)}
        <div class="stat-row">
          <div class="stat"><div class="stat-value">${fmtKcal(m.tdee)}</div><div class="stat-label">Verbrauch</div></div>
          <div class="stat"><div class="stat-value">${fmtKcal(totals.kcal)}</div><div class="stat-label">Gegessen</div></div>
          <div class="stat stat-accent"><div class="stat-value ${deficit < 0 ? 'neg' : ''}">${deficit < 0 ? '+' + fmtKcal(-deficit) : fmtKcal(deficit)}</div><div class="stat-label">${deficit < 0 ? 'Überschuss' : 'Defizit'}</div></div>
        </div>
      </div>

      <div class="card">
        ${macroBar('Protein', totals.p, m.proteinGoal, true)}
        ${macroBar('Fett', totals.f, fatRef, false)}
        ${macroBar('Kohlenhydrate', totals.kh, khRef, false)}
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

  function macroBar(label, value, goal, showGoal) {
    const pct = Math.min(value / Math.max(goal, 1) * 100, 100);
    const over = value > goal;
    return `
      <div class="macro ${showGoal ? 'macro-protein' : ''}">
        <div class="macro-head">
          <span class="macro-label">${label}</span>
          <span class="macro-values">${fmtG(value)}${showGoal ? ` / ${fmtG(goal)}` : ''} g</span>
        </div>
        <div class="macro-track"><div class="macro-fill ${over && showGoal ? 'done' : ''}" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
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

    const todaysWeight = data.weights[todayKey()];

    let html = `
      <h1 class="view-title">Gewicht</h1>

      <div class="card">
        <label class="field-label" for="weight-input">Gewicht heute (kg)</label>
        <div class="inline-form">
          <input id="weight-input" type="text" inputmode="decimal" placeholder="z. B. 82,4"
            value="${todaysWeight != null ? esc(NF1.format(todaysWeight)) : ''}">
          <button class="btn primary" data-action="save-weight">Speichern</button>
        </div>
      </div>

      <div class="card">
        <div class="segmented" data-role="weight-range">
          ${['1m', '3m', '1y', 'all'].map(r =>
            `<button class="${weightRange === r ? 'active' : ''}" data-action="weight-range" data-range="${r}">${{ '1m': '1 M', '3m': '3 M', '1y': '1 J', 'all': 'Alles' }[r]}</button>`
          ).join('')}
        </div>
        ${Charts.weightChart(visible, p.targetWeightKg)}
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
          <div class="tile-value">${fc ? esc(fc.date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })) : '–'}</div>
          <div class="tile-label">${fc ? 'Ziel voraussichtlich erreicht' : 'Prognose: noch nicht genug Daten'}</div>
        </div>
      </div>
      ${!fc ? `<p class="hint">Für eine Prognose braucht es mindestens 5 getrackte Tage mit einem durchschnittlichen Kaloriendefizit und einen Trend oberhalb des Zielgewichts.</p>` : ''}`;

    $('#view-weight').innerHTML = html;
  }

  function signedKg(diff) {
    const r = Math.round(diff * 10) / 10;
    if (r > 0) return `+${fmtKg(r)} kg`;
    if (r < 0) return `−${fmtKg(Math.abs(r))} kg`;
    return `±0,0 kg`;
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
      </div>

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
        <div class="calc-preview">
          <div><span>Grundumsatz (BMR)</span><strong>${fmtKcal(m.bmr)} kcal</strong></div>
          <div><span>Gesamtumsatz (TDEE)</span><strong>${fmtKcal(m.tdee)} kcal</strong></div>
          <div><span>Kalorienziel</span><strong>${fmtKcal(m.goal)} kcal</strong></div>
          <div><span>Proteinziel</span><strong>${fmtG(m.proteinGoal)} g</strong></div>
        </div>
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
        <p class="hint">Mit hinterlegtem Key erscheint beim Eintragen der Reiter „KI“: Mahlzeiten
        per Foto oder Freitext schätzen lassen. Der Key wird nur lokal auf diesem Gerät gespeichert.
        Jede Anfrage kostet wenige Cent; Fotos und Texte werden dafür an Anthropic übertragen.</p>
      </div>

      <div class="card">
        <div class="card-title">Datensicherung</div>
        <p class="hint important">Alle Daten liegen nur in diesem Browser. Bitte regelmäßig
        exportieren – beim Löschen der Website-Daten wäre sonst alles weg.</p>
        <div class="btn-row">
          <button class="btn primary" data-action="export">Daten exportieren</button>
          <button class="btn" data-action="import">Daten importieren …</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Gefahrenzone</div>
        <button class="btn danger" data-action="delete-all">Alle Daten löschen</button>
      </div>

      <p class="hint center">Kalorientracker · Version 1.0 · Daten bleiben auf dem Gerät</p>`;

    $('#view-settings').innerHTML = html;

    document.querySelectorAll('#view-settings [data-setting]').forEach(el => {
      el.addEventListener('change', onSettingChange);
    });
  }

  // Akzeptiert deutsche ("12,5", "1.234,5") und punktdezimale ("12.5") Eingaben,
  // weist alles andere strikt ab (kein stiller Teil-Parse).
  function parseGermanFloat(str) {
    let s = String(str).trim();
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return parseFloat(s);
  }

  function onSettingChange(e) {
    const el = e.target;
    const key = el.dataset.setting;
    const p = data.profile;
    switch (key) {
      case 'sex': p.sex = el.value === 'f' ? 'f' : 'm'; break;
      case 'birthYear': {
        const v = parseInt(el.value, 10);
        if (v >= 1920 && v <= 2020) p.birthYear = v; break;
      }
      case 'heightCm': {
        const v = parseInt(el.value, 10);
        if (v >= 120 && v <= 230) p.heightCm = v; break;
      }
      case 'targetWeightKg': {
        const v = parseGermanFloat(el.value);
        if (v !== null && v >= 30 && v <= 300) p.targetWeightKg = Math.round(v * 10) / 10;
        break;
      }
      case 'activity': p.activity = Math.min(4, Math.max(0, parseInt(el.value, 10) || 0)); break;
      case 'deficit': p.deficit = parseInt(el.value, 10) || 0; break;
      case 'proteinPerKg': {
        const v = parseGermanFloat(el.value);
        if (v === null) {
          toast('Ungültige Eingabe – bitte eine Zahl wie 1,6 angeben.');
          break;
        }
        if (v >= 1 && v <= 2.5) p.proteinPerKg = Math.round(v * 10) / 10;
        else toast('Proteinziel bitte zwischen 1,0 und 2,5 g/kg wählen.');
        break;
      }
      case 'theme': data.settings.theme = el.value; break;
      case 'apiKey': data.settings.apiKey = el.value.trim(); break;
    }
    persist();
    renderAll();
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
    sheet = { meal: mealId, tab: 'search', query: '', food: null, amount: null, editing: null, ai: { text: '', image: null, items: null, busy: false, error: '' } };
    renderSheet();
    showSheet(true);
  }

  function openEditSheet(mealId, entry) {
    sheet = { meal: mealId, tab: 'edit', editing: entry, ai: {} };
    renderSheet();
    showSheet(true);
  }

  function showSheet(visible) {
    $('#sheet').classList.toggle('hidden', !visible);
    $('#sheet-backdrop').classList.toggle('hidden', !visible);
    if (!visible) sheet = null;
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

  function foodResultsHtml(query) {
    const results = searchFoods(query);
    if (results.length === 0) {
      return '<p class="hint">Nichts gefunden. Tipp: Reiter „Schnell“ für freie Eingabe.</p>';
    }
    return results.map(f => {
      const idx = FOODS.indexOf(f);
      const per = f.unit === 'stk' ? 'pro Stück' : `pro 100 ${f.unit === 'ml' ? 'ml' : 'g'}`;
      return `
        <button class="list-row" data-action="pick-food" data-idx="${idx}">
          <span class="list-name">${esc(f.name)}</span>
          <span class="list-info">${fmtKcal(f.kcal)} kcal ${per}</span>
        </button>`;
    }).join('');
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
        <div class="chip-row">
          ${isStk
            ? ['0,5', '1', '2'].map(c => `<button class="chip" data-action="set-amount" data-amount="${c}">${c} Stück</button>`).join('')
            : `${f.portion ? `<button class="chip" data-action="set-amount" data-amount="${f.portion}">${esc(f.portionName || 'Portion')}</button>` : ''}
               <button class="chip" data-action="set-amount" data-amount="100">100 ${unitLabel}</button>`}
        </div>
        <div class="preview-grid" id="food-preview">
          <div><strong>${fmtKcal(vals.kcal)}</strong><span>kcal</span></div>
          <div><strong>${NFx.format(vals.p)} g</strong><span>Protein</span></div>
          <div><strong>${NFx.format(vals.f)} g</strong><span>Fett</span></div>
          <div><strong>${NFx.format(vals.kh)} g</strong><span>KH</span></div>
        </div>
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

    let html = '';
    if (data.favorites.length) {
      html += `<div class="list-section">Favoriten</div><div class="list">${favHtml(data.favorites)}</div>`;
    }
    const recentOnly = data.recents.filter(r => !isFavorite(r));
    if (recentOnly.length) {
      html += `<div class="list-section">Zuletzt verwendet</div><div class="list">${favHtml(recentOnly)}</div>`;
    }
    if (!html) {
      html = '<p class="hint">Noch nichts vorhanden. Einträge erscheinen hier automatisch – mit ☆ markierst du Favoriten.</p>';
    }
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
      </div>
      <button class="btn primary full" data-action="add-quick">Hinzufügen</button>`;
  }

  // --- Reiter: KI ---

  function sheetAiBody() {
    const ai = sheet.ai;
    let html = `
      <p class="hint">Mahlzeit fotografieren oder beschreiben – Claude schätzt die Nährwerte.
      Vorschläge lassen sich vor dem Speichern anpassen.</p>
      <textarea id="ai-text" rows="2" placeholder="z. B. 2 Brötchen mit Käse und ein Cappuccino">${esc(ai.text || '')}</textarea>
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
      html += '<div class="list-section">Vorschläge – prüfen und anpassen</div><div class="ai-items">';
      ai.items.forEach((it, i) => {
        html += `
        <div class="ai-item" data-ai-idx="${i}">
          <label class="ai-check"><input type="checkbox" class="ai-use" checked></label>
          <div class="ai-fields">
            <input type="text" class="ai-name" value="${esc(it.name)}" placeholder="Name">
            <input type="text" class="ai-menge" value="${esc(it.menge)}" placeholder="Menge">
            <div class="ai-macros">
              <label>kcal<input type="number" class="ai-kcal" inputmode="numeric" value="${it.kcal}"></label>
              <label>P (g)<input type="text" class="ai-p" inputmode="decimal" value="${esc(String(it.p).replace('.', ','))}"></label>
              <label>F (g)<input type="text" class="ai-f" inputmode="decimal" value="${esc(String(it.f).replace('.', ','))}"></label>
              <label>KH (g)<input type="text" class="ai-kh" inputmode="decimal" value="${esc(String(it.kh).replace('.', ','))}"></label>
            </div>
          </div>
        </div>`;
      });
      html += `</div><button class="btn primary full" data-action="ai-accept">Ausgewählte übernehmen</button>`;
    }
    return html;
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
          <input type="text" id="edit-amount" value="${esc(e.amount || '')}" placeholder="z. B. 150 g">
        </label>
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
        const v = parseGermanFloat(amount.value);
        if (v !== null && v > 0 && v < 100000) {
          sheet.amount = v;
          updateFoodPreview();
        }
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
  }

  function updateFoodPreview() {
    const box = $('#food-preview');
    if (!box || !sheet || !sheet.food) return;
    const vals = computeFood(sheet.food, sheet.amount);
    box.innerHTML = `
      <div><strong>${fmtKcal(vals.kcal)}</strong><span>kcal</span></div>
      <div><strong>${NFx.format(vals.p)} g</strong><span>Protein</span></div>
      <div><strong>${NFx.format(vals.f)} g</strong><span>Fett</span></div>
      <div><strong>${NFx.format(vals.kh)} g</strong><span>KH</span></div>`;
  }

  async function runAiAnalyze() {
    const ai = sheet.ai;
    if (ai.busy) return;
    if (!ai.text.trim() && !ai.image) {
      ai.error = 'Bitte ein Foto wählen oder die Mahlzeit beschreiben.';
      renderSheet();
      return;
    }
    ai.busy = true;
    ai.error = '';
    ai.items = null;
    renderSheet();
    try {
      const items = await AI.analyze({ apiKey: data.settings.apiKey, text: ai.text, image: ai.image });
      if (!sheet || !sheet.ai) return;
      sheet.ai.items = items;
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
      if (!row.querySelector('.ai-use').checked) return;
      const name = row.querySelector('.ai-name').value.trim();
      const menge = row.querySelector('.ai-menge').value.trim();
      const kcal = parseFloat(row.querySelector('.ai-kcal').value) || 0;
      const p = parseGermanFloat(row.querySelector('.ai-p').value) || 0;
      const f = parseGermanFloat(row.querySelector('.ai-f').value) || 0;
      const kh = parseGermanFloat(row.querySelector('.ai-kh').value) || 0;
      if (!name || kcal <= 0) return;
      addEntry(currentDay, sheet.meal, { name, amount: menge, kcal, p, f, kh });
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
        renderToday();
        break;
      case 'day-next':
        if (currentDay < todayKey()) {
          currentDay = addDays(currentDay, 1);
          renderToday();
        }
        break;
      case 'day-today':
        currentDay = todayKey();
        renderToday();
        break;
      case 'open-day':
        currentDay = target.dataset.day;
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
        const vals = computeFood(sheet.food, sheet.amount);
        addEntry(currentDay, sheet.meal, {
          name: sheet.food.name, amount: vals.label,
          kcal: vals.kcal, p: vals.p, f: vals.f, kh: vals.kh
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
      case 'add-quick': {
        const name = $('#quick-name').value.trim();
        const kcal = parseFloat($('#quick-kcal').value) || 0;
        if (!name) { toast('Bitte eine Bezeichnung angeben.'); break; }
        if (kcal <= 0) { toast('Bitte Kalorien angeben.'); break; }
        addEntry(currentDay, sheet.meal, {
          name, amount: '',
          kcal,
          p: parseGermanFloat($('#quick-p').value) || 0,
          f: parseGermanFloat($('#quick-f').value) || 0,
          kh: parseGermanFloat($('#quick-kh').value) || 0
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
        data.weights[todayKey()] = Math.round(v * 10) / 10;
        persist();
        renderAll();
        toast('Gewicht gespeichert');
        break;
      }
      case 'weight-range':
        weightRange = target.dataset.range;
        renderWeight();
        break;

      // Einstellungen
      case 'export':
        Storage.exportJson(data);
        toast('Export gestartet');
        break;
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

  renderAll();
})();
