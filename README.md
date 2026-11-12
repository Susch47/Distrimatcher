# Distrimatcher

## Schnellstart: eine einzige HTML-Datei, ohne Installation

**[Distrimatcher.html herunterladen](https://github.com/Susch47/Distrimatcher/releases/download/html/Distrimatcher.html)**, in einen beliebigen Ordner speichern und per Doppelklick in Edge oder Chrome öffnen. Es ist keine `.exe`, kein Server und kein Python nötig.

* Alles läuft im Browser auf dem eigenen PC: PDF lesen, OCR (Deutsch/Englisch, eingebettet), Extraktion, Abgleich, Watchlist und E-Mail-Entwurf.
* Daten bleiben in diesem Browser (IndexedDB). **Save project** schreibt alles in eine Projektdatei, z. B. neben die HTML-Datei; **Open project** lädt sie wieder.
* Online ist nur die optionale GLEIF-Abfrage. Den SEC-Datensatz lädt man einmal als CSV herunter und importiert ihn.
* Quellcode der HTML-Version: `web/`. Bauen mit `cd web && npm install && npm test && npm run build`, Ergebnis `web/dist/Distrimatcher.html`.
  Ein Browser-Test der kompletten User Journey über `file://` läuft mit `node tools/e2e.js`.

Die Python-/`.exe`-Variante (`distrimatcher/`) bleibt als Alternative erhalten. Beide nutzen dieselbe Logik; die JS-Tests prüfen, dass die Ergebnisse identisch sind.

---

Lokale Desktop-Anwendung zur Auswertung von **Distribution Agreements** und zum Abgleich mit öffentlichen Fondsdaten:

1. **Agreements einlesen:** ZIP oder PDFs hochladen. Text wird ausgelesen, gescannte Seiten per OCR. Danach werden Vertragsparteien, Datum, Recht, Territorium, Gebühren, Kündigungsfrist, Funds, Share Classes und ISINs strukturiert erfasst.
2. **Übersicht und Delta:** Funds (mit Fund-ID) und darunter ihre Share Classes (Class-ID, ISIN oder Ticker) werden aus öffentlichen Quellen geladen. Danach wird markiert, welche Klassen durch ein Agreement abgedeckt sind und welche nicht (**Delta**).

## Warum lokal und nicht Web?

Distribution Agreements sind vertraulich. Distrimatcher läuft deshalb als **lokales Programm**:

* Der Server lauscht nur auf `127.0.0.1` und ist im Netzwerk nicht erreichbar. Die Oberfläche ist eine lokale Webseite, im eigenen Fenster (`pywebview`) oder im Browser.
* PDFs, OCR-Text und Datenbank (SQLite) liegen nur auf dem PC, unter `%LOCALAPPDATA%\Distrimatcher` bzw. `DISTRIMATCHER_DATA`.
* Online abgefragt werden nur **öffentliche Referenzdaten**, also Fund-Namen und ISINs bei SEC, GLEIF und OpenFIGI, **nie Vertragsinhalte**. Mit `DISTRIMATCHER_OFFLINE=1` ist alles abgeschaltet; dann wird das Universum per CSV/Excel importiert.
* Verteilung als **Windows-.exe** über PyInstaller (siehe unten). Die Technik (Python + HTML-Oberfläche) erlaubt später trotzdem einen Betrieb auf einem internen Server, falls gewünscht.

## Start (Entwicklung)

```bash
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
python -m distrimatcher            # öffnet Fenster/Browser auf http://127.0.0.1:8765
python -m pytest                   # Tests
```

**OCR** benötigt [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki) (Windows-Installer, Sprachpaket *Deutsch* mit auswählen). Der Pfad wird automatisch gefunden oder über `TESSERACT_CMD` gesetzt. Ohne Tesseract funktionieren alle PDFs mit Textlayer; gescannte Seiten werden dann als Hinweis markiert.

## Windows-.exe bauen

```bat
packaging\build_windows.bat
```

Ergebnis: `dist\Distrimatcher\Distrimatcher.exe` (Ordner kann so verteilt werden). Um Tesseract mitzuliefern, den Tesseract-Installationsordner nach `packaging\tesseract\` kopieren (mit `tesseract.exe` und `tessdata\`). Er wird dann automatisch eingebunden.

## Ablauf in der App (Oberfläche auf Englisch, JB-Layout)

Die App startet leer und führt durch fünf Schritte: **Agreements → Overview → Watchlist → Provider e-mail → Activity log**.
Das Handbuch (Info-Button bzw. „Manual“) ist die Datei `distrimatcher/manual.md`. Beim ersten Start wird sie nach
`%LOCALAPPDATA%\Distrimatcher\manual.md` kopiert und kann dort oder direkt in der App bearbeitet werden.

* **Watchlist:** jede nicht abgedeckte Share Class mit Merkmalen (Heuristik), Fundstelle, Erstfund-Datum („new“) und
  Aktionen *Confirm*, *Dismiss*, *Add to agreement* und *Open agreement*.
* **Overview:** Wasserfalldiagramm Fund IDs → ISINs → in Verträgen gefunden → abgedeckt → Lücken; Sortierung nach
  Name, Fund-ID, meisten Lücken oder geringster Abdeckung.
* **Provider e-mail:** vorformulierte E-Mail (EN/DE) mit den nicht abgedeckten ISINs je Anbieter, als `.eml` für Outlook.
* **Activity log:** Protokoll aller Schritte, plus „Reset all data“.
* Schrift: Verlag, falls lokal installiert; sonst die mitgelieferte Montserrat Light (OFL-Lizenz).

### Details (Stand vor dem Redesign)

**1 · Agreements**
* ZIP per Drag & Drop hochladen. Verschachtelte ZIPs werden entpackt, Duplikate über einen SHA-256-Hash erkannt.
* OCR-Modus: *automatisch* (nur Seiten ohne Textlayer), *immer* oder *aus*.
* Ein Klick auf ein Dokument zeigt alle erkannten Felder, Parteien, Funds und Klassen, Gebühren, Hinweise und den Volltext. Fehler lassen sich direkt im JSON korrigieren und speichern.
* Export als CSV (Excel, `;`) oder JSON.

**2 · Übersicht & Delta**
* **SEC** (US-Fonds): „Vorschläge aus Verträgen“ findet die passenden Registranten, auch über Fund-Namen und bei umbenannten Trusts. Fund-ID = SEC Series ID, Share Class = Class ID plus Ticker.
* **GLEIF**: sucht zu jedem erkannten Fund die LEI (als Fund-ID) und lädt die dort gemeldeten ISINs. Das funktioniert weltweit, ist aber lückenhaft.
* **CSV/Excel-Import**: eigene oder lizenzierte Fondslisten, z. B. der KVG/ManCo oder ein WM-, fundinfo- oder Bloomberg-Export. Spalten werden automatisch erkannt (`Umbrella`, `Fund ID`, `Fund Name`, `Share Class`, `ISIN`, `Currency` …, auch auf Deutsch).
* Baumansicht Umbrella → Fund → Share Class mit Status:
  * **abgedeckt:** per ISIN, über „alle Klassen“ oder über den Klassennamen
  * **nicht abgedeckt (Delta)**
  * **prüfen:** Fund wird im Vertrag genannt, die Klassen aber nicht
* Zusätzlich gibt es eine Liste der Funds, die in Verträgen stehen, aber im Universum fehlen (z. B. liquidiert oder umbenannt).
* Export „Delta als CSV“ und „Übersicht als CSV“.

## Was wird extrahiert?

| Feld | Beispiele |
|---|---|
| Dokumenttyp | Distribution Agreement, Nachtrag/Amendment, Schedule |
| Parteien und Rollen | Fondsgesellschaft/Umbrella (SICAV, ICAV, Trust), Distributor, Verwaltungsgesellschaft, Adviser |
| Datum | „dated as of …“, „vom 1. Oktober 2025“, Wirksamkeitsdatum |
| Recht / Gerichtsstand | „governed by the laws of …“, „unterliegt irischem Recht“ |
| Territorium | Vertriebsländer (DE/EN) |
| Exklusivität, Laufzeit, Kündigungsfrist | „ninety (90) days' prior written notice“, „Kündigungsfrist von 3 Monaten“ |
| Gebühren | Trail/Bestandsprovision, 12b-1, Retrozessionen (Textstellen mit %) |
| Funds und Share Classes | aus Tabellen (Schedule/Anhang) und Fließtext, inkl. „All Share Classes“ |
| IDs | ISINs und LEIs (mit Prüfziffer validiert), SEC Series/Class IDs |

OCR-Korrektur: Typische Verwechslungen (`16…` statt `IE…`, `I`/`1`, `Class!`) werden korrigiert. Eine korrigierte ISIN wird **nur übernommen, wenn die Prüfziffer stimmt**, und als Hinweis am Dokument angezeigt.

Die Extraktion ist regelbasiert und läuft komplett offline. Unsichere Stellen werden als Hinweis markiert und lassen sich korrigieren.

## Testdaten (`samples/`)

* `agreements/sec_public/`: **echte, öffentliche** Distribution Agreements und Schedules aus SEC EDGAR (Exhibit 99.(e)) von Artisan, Carillon, JNL, NexPoint/Highland und AXA Premier VIP, als PDF.
* `agreements/synthetic_eu/`: **fiktive** EU/UCITS-Verträge (Alpenblick Invest SICAV, Nordlicht Funds ICAV) mit gültigen Test-ISINs/LEIs, inkl. deutschem Nachtrag und einem **gescannten** Vertrag für den OCR-Test. Echte europäische Agreements sind öffentlich praktisch nicht verfügbar.
* `public_data/synthetic_fund_universe.csv`: passendes Fondsuniversum (mehr Klassen als vertraglich abgedeckt, für die Delta-Demo).
* `demo_agreements.zip`: alle Muster-PDFs als ZIP zum direkten Hochladen.
* `generate_samples.py` erzeugt die synthetischen Daten neu.

Demo: App starten → `samples/demo_agreements.zip` hochladen → Tab 2 → „Vorschläge aus Verträgen“ → „Auswahl laden“ → `synthetic_fund_universe.csv` importieren.

## Projektstruktur

```
distrimatcher/
  __main__.py     Start (lokaler Server + Fenster/Browser)
  app.py          REST-API (FastAPI)
  ingest.py       ZIP/PDF, Textlayer, OCR (Tesseract), OCR-Korrektur
  extract.py      Feld-, Fund- und Share-Class-Extraktion
  identifiers.py  ISIN/LEI-Validierung und -Reparatur
  universe.py     SEC, GLEIF, OpenFIGI, CSV/Excel-Import
  delta.py        Abgleich Vertrag ↔ Universum
  db.py           lokale SQLite-Ablage
  static/         Oberfläche (HTML/CSS/JS, ohne externe Abhängigkeiten)
packaging/        PyInstaller-Build für Windows
samples/          Testdaten
tests/            pytest
```

## Nächste Schritte (Vorschläge)

* Manuelle Zuordnung „Vertrags-Fund ↔ Universums-Fund“ speichern, z. B. bei Umbenennungen.
* Optional lokales LLM (z. B. über Ollama) für freie Klauseln wie Gebührenmodelle oder Sonderkündigungsrechte, weiterhin ohne Datenabfluss.
* Weitere Quellen für ISIN-Universen: ESMA FIRDS, nationale Register (CSSF, CBI, BaFin), Fondsdaten-Anbieter.
* Versionierung: Nachträge automatisch dem Hauptvertrag zuordnen und eine „gültige Fassung“ berechnen.
