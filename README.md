# Kalorientracker

Schlanke Kalorien- und Gewichts-Tracking-App als PWA — komplett offline, ohne Konto,
alle Daten bleiben auf dem Gerät.

**Live:** https://telstroem.github.io/kalorientracker/ — auf dem iPhone/iPad in
Safari öffnen → Teilen → „Zum Home-Bildschirm", dann startet die App im Vollbild.

## Was die App kann

- **Heute:** Kalorienring, Tagesdefizit, Makros (Proteinziel prominent) inklusive
  **Ballaststoffen** (Ziel 30 g/Tag nach DGE; fehlen bei einzelnen Einträgen die
  Angaben, zeigt der Balken ehrlich „≥ X g“ und wie viele Einträge ohne Angabe
  sind), vier Mahlzeiten mit Einträgen aus Datenbank (147 deutsche Lebensmittel,
  jeweils mit Ballaststoffwert), Favoriten, Schnelleingabe — auch für vergangene Tage.
- **KI-Erkennung (optional):** Mahlzeit fotografieren oder als Freitext beschreiben,
  Claude schätzt die Nährwerte; zweiter Modus **„Etikett“** liest die
  Nährwerttabelle einer Packung exakt ab (pro 100 g und pro Portion). Wird erst
  aktiv, wenn ein Anthropic-API-Key hinterlegt ist.
- **Meine Gerichte:** Einträge einer Mahlzeit als benanntes Gericht speichern
  und später mit einem Tap komplett buchen (Favoriten-Reiter).
- **KI-Webrecherche:** Bei Markenprodukten darf Claude optional die Nährwerte
  online bei fddb nachschlagen (abschaltbar in den Einstellungen); übliche
  Lebensmittel werden ohne Suche direkt geschätzt.
- **Gewicht:** Schnelleingabe (auch nachtragen), Diagramm mit 7-Tage-Trend,
  Ziellinie und Meilensteinen, Prognose fürs Zielgewicht; optionale
  **Verbrauchs-Kalibrierung** aus dem eigenen Ess- und Wiegeprotokoll
  (gedämpft und begrenzt, in den Einstellungen umschaltbar). Die Kalibrierung
  schätzt die Trendsteigung über alle Punkte des Fensters (Least Squares, damit
  ein einzelner Wassertag am Rand nichts verzerrt), verlangt mindestens 75 %
  erfasste Tage und weist Unsicherheit und Abdeckung offen aus
  („≈ 2.450 kcal (± 130) · 24 von 28 Tagen erfasst“).
- **Bauchumfang & BMI:** optionales zweites Maß im Gewicht-Tab (mit eigenem
  Verlaufsdiagramm), dazu Kacheln für Δ seit Start, **WHtR** (Taille/Größe,
  Richtwert < 0,50) und **BMI** mit neutraler Einordnung. Reine Anzeige — ohne
  Einfluss auf Kalorienziel oder Prognose, keine medizinische Bewertung.
- **Aktivkalorien der Apple Watch (optional, Standard aus):** Werte lassen sich
  einzeln im Heute-Tab oder gesammelt in den Einstellungen eintragen
  („25.07. 640“, „25.07.2026 640“, „2026-07-25;640“; vor dem Übernehmen zeigt
  eine Vorschau erkannte, doppelte und unklare Zeilen). Angerechnet wird nur die
  **Abweichung vom eigenen Durchschnitt**, zur Hälfte und höchstens ±400 kcal,
  erst ab 7 erfassten Tagen — die mittlere Aktivität steckt schon im
  Aktivitätslevel bzw. in der Kalibrierung und würde sonst doppelt zählen. Die
  Kalibrierung selbst bleibt davon unberührt.
- **Verlauf:** Kalorien der letzten 14 Tage, Ø-Werte, kumuliertes Defizit
  (umgerechnet in kg Fett), Wochenübersicht (Ø kcal, Ø Protein,
  Zieleinhaltung, Gewichtsveränderung).
- **Einstellungen:** Körperdaten und Ziele (BMR/TDEE nach Mifflin-St-Jeor),
  Farbschema, Export/Import als JSON, **CSV-Export** der Tageswerte für Excel
  (Semikolon-getrennt, deutsches Zahlenformat; Spalten `Datum`, `kcal`,
  `Protein_g`, `Fett_g`, `KH_g`, `Ballaststoffe_g`, `TDEE`, `Defizit`, `Gewicht`,
  `Bauchumfang_cm`, `Aktivkalorien` — `Ballaststoffe_g` ist die Summe der
  bekannten Angaben eines Tages). Hinweis: Bei aktiver
  Verbrauchs-Kalibrierung enthalten die Spalten TDEE/Defizit für alle Tage
  den aktuell kalibrierten Verbrauch (eine rückwirkende Tages-Historie der
  Kalibrierung gibt es bewusst nicht).

Kein Build-Step, keine Frameworks — reines HTML/CSS/JavaScript.

## Lokal testen

```bash
cd Kalorientracker
python3 -m http.server 8080
```

Dann im Browser `http://localhost:8080` öffnen. (Port 8000 ist auf diesem Mac
oft schon von Docker Desktop belegt; meldet auch 8080 „Address already in use",
einfach eine andere Zahl nehmen, z. B. 8888.)

(Direktes Öffnen der `index.html`
per Doppelklick funktioniert auch, nur der Service Worker/Offline-Modus braucht
`localhost` oder HTTPS.)

## Deployment auf GitHub Pages (Schritt für Schritt)

1. Auf <https://github.com> mit dem Account `Telstroem` anmelden.
2. Neues Repository anlegen: **New repository** → Name z. B. `kalorientracker`,
   Sichtbarkeit **Public** (nötig für Pages im Free-Plan), ohne README anlegen.
3. Im Terminal im Projektordner:
   ```bash
   cd ~/Documents/Claude/Projects/Kalorientracker
   git init
   git add index.html css js icons manifest.webmanifest sw.js README.md
   git commit -m "feat: Kalorientracker v1"
   git branch -M main
   git remote add origin https://github.com/Telstroem/kalorientracker.git
   git push -u origin main
   ```
   (Bewusst nur die App-Dateien committen — `CLAUDE.md`, `MEMORY.md`, `TODO.md`
   müssen nicht ins öffentliche Repo.)
4. Im Repo auf GitHub: **Settings → Pages** → unter *Build and deployment*
   Source **Deploy from a branch**, Branch **main**, Ordner **/ (root)** → **Save**.
5. Nach 1–2 Minuten ist die App unter
   `https://telstroem.github.io/kalorientracker/` erreichbar (URL steht oben auf
   der Pages-Seite).

Bei Updates: Dateien ändern, committen, pushen — und in `sw.js` die Konstante
`CACHE_VERSION` hochzählen (z. B. `kt-v2`), damit installierte Geräte die neue
Version laden.

## Installation auf iPhone/iPad

1. Die Pages-URL in **Safari** öffnen (wichtig: Safari, nicht Chrome).
2. **Teilen-Button** (Quadrat mit Pfeil) → **„Zum Home-Bildschirm“** → **Hinzufügen**.
3. Die App startet dann wie eine native App im Vollbild und funktioniert offline.
4. Beim ersten Start führt ein kurzes Onboarding durch Körperdaten und Ziele.

## KI-Erkennung einrichten (optional)

1. Auf <https://console.anthropic.com> ein Konto anlegen und unter **API Keys**
   einen Key erzeugen (beginnt mit `sk-ant-…`). Guthaben aufladen (Prepaid,
   5 $ reichen lange).
2. In der App: **Einstellungen → KI-Erkennung** → Key einfügen.
3. Beim Eintragen einer Mahlzeit erscheint jetzt der Reiter **„KI“**: Foto
   aufnehmen oder Text eingeben → Vorschläge prüfen → übernehmen.

**Kosten & Datenschutz:** Jede Analyse kostet typischerweise unter 1 Cent
(Modell Claude Haiku). Foto bzw. Text werden dafür an die Anthropic-API
übertragen. Bei aktivierter Online-Recherche darf Claude zusätzlich Nährwerte
von Markenprodukten bei fddb nachschlagen — eine solche Recherche kostet etwas
mehr als eine reine Analyse (Websuche ca. 1 Cent zzgl. Token) und wird per
Prompt auf unsichere Markenprodukte beschränkt. Sonst verlässt kein Datum das
Gerät. Der Key liegt nur im localStorage des Browsers.

## Datensicherung (wichtig!)

Alle Daten liegen ausschließlich im Browser-Speicher des Geräts. Safari kann
Website-Daten löschen (bei installierten Home-Bildschirm-Apps selten, aber
möglich — z. B. bei Speicherdruck oder manuellem Löschen).

- **Einstellungen → Daten exportieren**: lädt eine JSON-Datei
  (`kalorientracker-export-JJJJ-MM-TT.json`) herunter — am besten regelmäßig,
  z. B. wöchentlich, und in iCloud/Dateien ablegen.
- **Einstellungen → Daten importieren**: stellt einen Export vollständig wieder
  her (ersetzt die vorhandenen Daten nach Rückfrage).
