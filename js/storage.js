'use strict';

const Storage = (() => {

  const KEY = 'kt-data';
  // 2 seit v1.5: bis dahin trugen alle Schemastände die 1, ältere und neuere
  // Exporte waren dadurch nicht unterscheidbar.
  const CURRENT_VERSION = 2;
  const MEAL_IDS = ['breakfast', 'lunch', 'dinner', 'snacks'];

  function defaults() {
    return {
      version: CURRENT_VERSION,
      profile: null,
      settings: { theme: 'system', apiKey: '' },
      days: {},      // 'YYYY-MM-DD' → { meals: { breakfast:[], lunch:[], dinner:[], snacks:[] } }
      weights: {},   // 'YYYY-MM-DD' → kg (Zahl, 1 Dezimalstelle)
      waist: {},     // 'YYYY-MM-DD' → Bauchumfang in cm (Zahl)
      activeEnergy: {}, // 'YYYY-MM-DD' → Aktivkalorien (Apple Watch) in kcal
      favorites: [], // { name, amount, kcal, p, f, kh, fib? }
      recents: [],   // dito, max. 50
      dishes: []     // { name, items: [{ name, amount, kcal, p, f, kh, fib? }] }
    };
  }

  // Übernimmt nur endliche Zahlen im gültigen Bereich (greift beim Laden UND beim Import).
  function numberMap(source, min, max) {
    const out = {};
    Object.keys(source || {}).forEach(key => {
      const value = source[key];
      if (typeof value === 'number' && isFinite(value) && value >= min && value <= max) out[key] = value;
    });
    return out;
  }

  // Ein Eintrag ist nur brauchbar, wenn seine Nährwerte Zahlen sind – sonst würde er
  // still in jede Summe, den Ring, die Kalibrierung und die CSV einsickern.
  // fib fehlt bewusst häufig: kein Wert heißt „unbekannt“ und bleibt es auch.
  function sanitizeEntry(entry, keepId) {
    if (!entry || typeof entry !== 'object') return null;
    const num = (value, fallback) =>
      (typeof value === 'number' && isFinite(value)) ? value : fallback;
    const kcal = num(entry.kcal, null);
    if (kcal === null || kcal < 0) return null;
    const out = {
      name: String(entry.name == null ? 'Eintrag' : entry.name).slice(0, 120),
      amount: String(entry.amount == null ? '' : entry.amount).slice(0, 80),
      kcal,
      p: Math.max(0, num(entry.p, 0)),
      f: Math.max(0, num(entry.f, 0)),
      kh: Math.max(0, num(entry.kh, 0))
    };
    const fib = num(entry.fib, null);
    if (fib !== null && fib >= 0) out.fib = fib;
    if (keepId) {
      out.id = typeof entry.id === 'string' && entry.id
        ? entry.id
        : String(Date.now()) + Math.random().toString(36).slice(2, 7);
    }
    return out;
  }

  // Repariert, was reparabel ist (fehlende Mahlzeitenlisten), und verwirft nur
  // strukturell kaputte Tage bzw. Einträge. Ohne diese Prüfung legt ein
  // fehlerhafter Import die App bei jedem Start neu lahm.
  function sanitizeDays(source) {
    const out = {};
    if (!source || typeof source !== 'object') return out;
    Object.keys(source).forEach(key => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
      const day = source[key];
      if (!day || typeof day !== 'object') return;
      const meals = {};
      let count = 0;
      MEAL_IDS.forEach(id => {
        const list = day.meals && Array.isArray(day.meals[id]) ? day.meals[id] : [];
        meals[id] = list.map(e => sanitizeEntry(e, true)).filter(Boolean);
        count += meals[id].length;
      });
      if (count > 0) out[key] = { meals };
    });
    return out;
  }

  function migrate(data) {
    if (!data || typeof data !== 'object') return defaults();
    const base = defaults();
    const merged = Object.assign(base, data);
    merged.settings = Object.assign({ theme: 'system', apiKey: '' }, data.settings || {});
    merged.days = sanitizeDays(data.days);
    merged.weights = numberMap(data.weights, -Infinity, Infinity);
    merged.waist = numberMap(data.waist, 20, 300);
    merged.activeEnergy = numberMap(data.activeEnergy, 0, 10000);
    // Gespeicherte Elemente landen per 1-Tap direkt in einem Tag – hier gilt dieselbe
    // Prüfung wie für die Tageseinträge selbst.
    const savedList = list => (Array.isArray(list) ? list : [])
      .map(item => sanitizeEntry(item, false)).filter(Boolean);
    merged.favorites = savedList(data.favorites);
    merged.recents = savedList(data.recents).slice(0, 50);
    merged.dishes = (Array.isArray(data.dishes) ? data.dishes : [])
      .filter(d => d && typeof d.name === 'string' && Array.isArray(d.items))
      .map(d => ({ name: d.name.slice(0, 60), items: savedList(d.items) }))
      .filter(d => d.items.length > 0);
    merged.version = CURRENT_VERSION;
    return merged;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      return migrate(JSON.parse(raw));
    } catch (e) {
      console.error('Laden fehlgeschlagen:', e);
      return defaults();
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Speichern fehlgeschlagen:', e);
      return false;
    }
  }

  function clearAll() {
    localStorage.removeItem(KEY);
  }

  function dateStamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson(data) {
    download(`kalorientracker-export-${dateStamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  }

  function exportCsv(csvText) {
    download(`kalorientracker-tage-${dateStamp()}.csv`, csvText, 'text/csv;charset=utf-8');
  }

  // Wirft Error mit deutscher Meldung bei ungültigen Daten.
  function parseImport(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error('Die Datei ist kein gültiges JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number' ||
        typeof parsed.days !== 'object' || typeof parsed.weights !== 'object') {
      throw new Error('Die Datei ist kein Kalorientracker-Export.');
    }
    if (parsed.version > CURRENT_VERSION) {
      throw new Error('Der Export stammt aus einer neueren App-Version.');
    }
    return migrate(parsed);
  }

  return { load, save, clearAll, exportJson, exportCsv, parseImport, defaults };
})();
