'use strict';

// Open-Food-Facts-Produktsuche. Es wird ausschließlich der Suchbegriff übertragen.
const OFF = (() => {

  const API_URL = 'https://world.openfoodfacts.org/cgi/search.pl';

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  function round1(v) {
    const n = num(v);
    return n === null ? 0 : Math.max(0, Math.round(n * 10) / 10);
  }

  // Produkt → { name, brand, kcal, p, f, kh, serving } (Werte pro 100 g/ml) oder null.
  function normalize(product) {
    if (!product || typeof product !== 'object') return null;
    const n = product.nutriments || {};
    let kcal = num(n['energy-kcal_100g']);
    if (kcal === null) {
      const kj = num(n.energy_100g); // OFF liefert energy_100g in kJ
      if (kj !== null) kcal = kj / 4.184;
    }
    if (kcal === null || kcal <= 0 || kcal > 950) return null;
    const name = String(product.product_name_de || product.product_name || '').trim();
    if (!name) return null;
    return {
      name: name.slice(0, 60),
      brand: String(product.brands || '').split(',')[0].trim().slice(0, 40),
      kcal: Math.round(kcal),
      p: round1(n.proteins_100g),
      f: round1(n.fat_100g),
      kh: round1(n.carbohydrates_100g),
      serving: String(product.serving_size || '').trim().slice(0, 30)
    };
  }

  // Liefert normalisierte Produkte oder wirft Error mit deutscher Meldung.
  async function search(query) {
    if (!navigator.onLine) throw new Error('Die Online-Suche braucht eine Internetverbindung.');
    const params = new URLSearchParams({
      search_terms: query,
      search_simple: '1',
      action: 'process',
      json: '1',
      page_size: '15',
      lc: 'de',
      fields: 'product_name,product_name_de,brands,nutriments,serving_size'
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(`${API_URL}?${params}`, { signal: controller.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('Zeitüberschreitung bei der Online-Suche – bitte erneut versuchen.');
      }
      throw new Error('Online-Suche fehlgeschlagen. Bitte Netzwerk prüfen.');
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      throw new Error(`Online-Suche fehlgeschlagen (HTTP ${response.status}).`);
    }
    let json;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error('Die Antwort der Online-Suche war nicht lesbar.');
    }
    return (Array.isArray(json.products) ? json.products : [])
      .map(normalize)
      .filter(Boolean);
  }

  return { search };
})();
