'use strict';

const Storage = (() => {

  const KEY = 'kt-data';
  const CURRENT_VERSION = 1;

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

  function migrate(data) {
    if (!data || typeof data !== 'object') return defaults();
    const base = defaults();
    const merged = Object.assign(base, data);
    merged.settings = Object.assign({ theme: 'system', apiKey: '' }, data.settings || {});
    merged.days = data.days || {};
    merged.weights = numberMap(data.weights, -Infinity, Infinity);
    merged.waist = numberMap(data.waist, 20, 300);
    merged.activeEnergy = numberMap(data.activeEnergy, 0, 10000);
    merged.favorites = Array.isArray(data.favorites) ? data.favorites : [];
    merged.recents = Array.isArray(data.recents) ? data.recents : [];
    merged.dishes = Array.isArray(data.dishes)
      ? data.dishes.filter(d => d && typeof d.name === 'string' && Array.isArray(d.items))
      : [];
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
