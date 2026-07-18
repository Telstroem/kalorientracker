'use strict';

const AI = (() => {

  const MODEL = 'claude-haiku-4-5-20251001';
  const API_URL = 'https://api.anthropic.com/v1/messages';

  const SYSTEM_PROMPT =
    'Du bist ein Ernährungsassistent. Der Nutzer beschreibt eine Mahlzeit als Text oder Foto. ' +
    'Schätze realistisch die Nährwerte für übliche deutsche Portionsgrößen. ' +
    'Antworte AUSSCHLIESSLICH mit JSON in genau diesem Format, ohne Erklärungen, ohne Markdown: ' +
    '{"items":[{"name":"…","menge":"…","kcal":0,"protein_g":0,"fett_g":0,"kh_g":0}]} ' +
    'Jedes erkennbare Lebensmittel wird ein eigenes Item. "menge" ist eine kurze deutsche ' +
    'Mengenangabe wie "1 Stück" oder "ca. 150 g". Alle Zahlen sind Ganzzahlen oder Dezimalzahlen mit Punkt.';

  // Wird nur angehängt, wenn das Web-Search-Tool mitgesendet wird (Mahlzeit-Modus + Einstellung aktiv).
  const WEB_SEARCH_INSTRUCTION =
    ' Du hast Zugriff auf eine Websuche (fddb.info). Nutze sie SPARSAM und NUR bei ' +
    'Markenprodukten oder Produkten von Restaurant-Ketten, deren Nährwerte du nicht mit ' +
    'hoher Sicherheit (mindestens ca. 85 %) aus deinem Wissen schätzen kannst – z. B. ' +
    '„Ehrmann High Protein Pudding“ oder ein spezieller Proteinriegel. Für übliche ' +
    'Lebensmittel und Gerichte (Obst, Gemüse, Brot, Reis, Hausmannskost, typische ' +
    'Portionen) schätze IMMER direkt ohne Suche. Höchstens eine kurze Suchanfrage pro ' +
    'Produkt. Antworte auch nach einer Suche AUSSCHLIESSLICH mit dem geforderten JSON, ' +
    'ohne Quellenangaben.';

  const LABEL_PROMPT =
    'Du liest Nährwerttabellen von Lebensmittelverpackungen. Der Nutzer schickt ein Foto ' +
    'eines Etiketts (Nährwerttabelle, ggf. mit Produktname). Lies die Werte EXAKT ab, ' +
    'nicht schätzen. Antworte AUSSCHLIESSLICH mit JSON in genau diesem Format, ohne ' +
    'Erklärungen, ohne Markdown: ' +
    '{"items":[{"name":"…","menge":"…","basis":"100g","kcal":0,"protein_g":0,"fett_g":0,"kh_g":0}]} ' +
    'Erzeuge ein Item mit basis "100g" für die Spalte pro 100 g bzw. 100 ml ' +
    '(menge dann "100 g" oder "100 ml"). Wenn die Tabelle zusätzlich eine Portionsspalte ' +
    'ausweist, erzeuge ein zweites Item mit basis "portion" und der Portionsgröße als menge ' +
    '(z. B. "1 Portion (30 g)"). "name" ist der Produktname, falls erkennbar, sonst eine kurze ' +
    'Beschreibung. Steht nur kJ auf dem Etikett, rechne in kcal um (kcal = kJ / 4,184). ' +
    'Alle Zahlen sind Ganzzahlen oder Dezimalzahlen mit Punkt.';

  // Verkleinert ein Bild clientseitig auf max. maxDim px Kantenlänge → JPEG base64.
  function resizeImage(file, maxDim = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve({ data: dataUrl.split(',')[1], mediaType: 'image/jpeg', previewUrl: dataUrl });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Das Bild konnte nicht gelesen werden.'));
      };
      img.src = url;
    });
  }

  function extractJson(text) {
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('parse');
    return JSON.parse(t.slice(start, end + 1));
  }

  function normalizeItems(parsed) {
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('parse');
    const items = parsed.items.map(it => ({
      name: String(it.name || 'Unbekannt').slice(0, 80),
      menge: String(it.menge || '').slice(0, 40),
      basis: it.basis === 'portion' ? 'portion' : (it.basis ? '100g' : undefined),
      kcal: Math.max(0, Math.round(Number(it.kcal) || 0)),
      p: Math.max(0, Math.round((Number(it.protein_g) || 0) * 10) / 10),
      f: Math.max(0, Math.round((Number(it.fett_g) || 0) * 10) / 10),
      kh: Math.max(0, Math.round((Number(it.kh_g) || 0) * 10) / 10)
    })).filter(it => it.kcal > 0 || it.name !== 'Unbekannt');
    if (items.length === 0) throw new Error('parse');
    return items;
  }

  // Ein Messages-Request mit Timeout und deutschen Fehlermeldungen; liefert das JSON-Ergebnis.
  async function postMessages(apiKey, body, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('Zeitüberschreitung – bitte erneut versuchen.');
      }
      throw new Error('Verbindung zur Anthropic-API fehlgeschlagen. Bitte Netzwerk prüfen.');
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Der API-Key wurde abgelehnt. Bitte in den Einstellungen prüfen.');
    }
    if (response.status === 429) {
      throw new Error('Zu viele Anfragen (Rate-Limit). Bitte kurz warten und erneut versuchen.');
    }
    if (!response.ok) {
      throw new Error(`Die Anfrage ist fehlgeschlagen (HTTP ${response.status}).`);
    }
    return response.json();
  }

  // mode: 'meal' (Standard) oder 'label' (Nährwerttabelle einer Packung).
  // webSearch: true erlaubt der KI im Mahlzeit-Modus die fddb-Recherche bei Markenprodukten.
  // Liefert {items: [{name, menge, basis?, kcal, p, f, kh}], webSearchUsed}
  // oder wirft Error mit deutscher Meldung.
  async function analyze({ apiKey, text, image, mode, webSearch }) {
    if (!apiKey) throw new Error('Kein API-Key hinterlegt. Bitte in den Einstellungen eintragen.');
    if (!navigator.onLine) throw new Error('Keine Internetverbindung. Die KI-Erkennung braucht Netz.');
    const isLabel = mode === 'label';
    if (isLabel && !image) throw new Error('Für den Etikett-Modus bitte ein Foto der Nährwerttabelle wählen.');
    const useSearch = !isLabel && webSearch === true;

    const content = [];
    if (image) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data }
      });
    }
    content.push({
      type: 'text',
      text: text && text.trim()
        ? text.trim()
        : (isLabel
          ? 'Lies die Nährwerttabelle auf dem Foto ab.'
          : 'Analysiere das Foto und schätze die Nährwerte der abgebildeten Mahlzeit.')
    });

    const body = {
      model: MODEL,
      max_tokens: useSearch ? 2048 : 1024,
      system: isLabel ? LABEL_PROMPT : (useSearch ? SYSTEM_PROMPT + WEB_SEARCH_INSTRUCTION : SYSTEM_PROMPT),
      messages: [{ role: 'user', content }]
    };
    if (useSearch) {
      body.tools = [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
        allowed_domains: ['fddb.info', 'fddb.mobi']
      }];
    }
    const timeoutMs = useSearch ? 60000 : 30000;

    let result = await postMessages(apiKey, body, timeoutMs);

    // Server-Tool-Schleife pausiert (kommt bei Websuche vor): genau EIN Fortsetzungsversuch.
    // Die API setzt am angehängten Assistant-Content selbst fort – kein extra User-Turn!
    if (result.stop_reason === 'pause_turn' && Array.isArray(result.content)) {
      body.messages = body.messages.concat([{ role: 'assistant', content: result.content }]);
      result = await postMessages(apiKey, body, timeoutMs);
    }

    const blocks = Array.isArray(result.content) ? result.content : [];
    const webSearchUsed = blocks.some(b => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
    const textBlocks = blocks.filter(b => b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length === 0) throw new Error('Die Antwort der KI war leer.');

    // Bei Websuche kann die Antwort aus mehreren Text-Blöcken (mit Zitat-Streutext) bestehen:
    // erst alle Blöcke zusammen versuchen, dann einzeln von hinten.
    let parsed = null;
    try {
      parsed = extractJson(textBlocks.map(b => b.text).join('\n'));
    } catch (e) {
      for (let i = textBlocks.length - 1; i >= 0 && !parsed; i--) {
        try { parsed = extractJson(textBlocks[i].text); } catch (e2) { /* nächster Block */ }
      }
    }
    try {
      return { items: normalizeItems(parsed), webSearchUsed };
    } catch (e) {
      throw new Error('Die KI-Antwort konnte nicht ausgewertet werden. Bitte erneut versuchen.');
    }
  }

  return { analyze, resizeImage };
})();
