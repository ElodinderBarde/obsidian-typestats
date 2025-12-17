#  Tippstatistik – Obsidian Plugin

Ein leistungsfähiges Obsidian-Plugin zur **detaillierten Erfassung, Analyse und Archivierung deines Tippverhaltens**.
Es zeichnet Schreibaktivität in Echtzeit auf und erzeugt **tägliche, monatliche und jährliche Auswertungen** als JSON- und Markdown-Dateien innerhalb deines Vaults.

---

##  Hauptfunktionen

*  Erfassung von:

  * Zeichen & Wörter
  * Tippgeschwindigkeit (CPM / WPM)
  * Genauigkeit (Accuracy)
  * Fokus-Streaks & Sessions
  * Tastennutzung & Löschhäufigkeit
  * System- und Vim-Shortcuts
*  Automatische Ordner- & Dateistruktur
*  Recovery bei Abstürzen / Neustarts
*  Fokus- & Session-Logik mit Inaktivitätserkennung
*  Debug- & Tipp-Simulation
*  Vollständiger Hard-Reset mit Sicherheitsabfrage
*  Generierung von:

  * Tagesstatistiken
  * Monatsübersichten
  * Jahresübersichten

---

##  Architekturüberblick

Das Plugin basiert auf **TypeScript** und wird zu JavaScript kompiliert.
Die gesamte Logik ist bewusst **monolithisch**, aber klar segmentiert in:

* Editor-Event-Binding (KeyUp / KeyDown)
* Statistik-Aggregation
* Datei- & Ordnerverwaltung
* Recovery & Persistenz
* Markdown-Report-Builder
* Settings- & Command-Handling

Der Einstiegspunkt ist `main.ts` / `main.js` .

---

##  Ordnerstruktur im Vault

Standardmäßig wird folgende Struktur angelegt:

```
Vault Admin/
└── Allgemein/
    └── Statistik/
        └── 2025/
            └── November/
                ├── Metadata/
                │   └── 2025-11-10.json
                ├── Tippstatistik/
                │   └── Tippstatistik-2025-11-10.md
                └── Tippstatistik-Monat-November-2025.md
```

Zusätzlich existiert immer:

```
Vault Admin/Allgemein/Statistik/currentStats.json
```

Diese Datei dient als **Live-Arbeitsstand mit Recovery-Funktion** .

---

##  Installation

### Manuell (empfohlen für Entwicklung)

1. Repository klonen oder herunterladen
2. Ordner nach

   ```
   <Vault>/.obsidian/plugins/Tippstatistik/
   ```

   kopieren
3. Abhängigkeiten installieren:

   ```bash
   npm install
   ```
4. Plugin bauen:

   ```bash
   npm run build
   ```
5. Obsidian neu starten
6. Plugin aktivieren

Benötigte Metadaten sind in `manifest.json` definiert .

---

##  Konfiguration

### Plugin-Settings

Aktuell konfigurierbar:

*  **Auto-Save-Intervall**
*  **Getrackte Ordner**

Die Settings werden über `loadData()` / `saveData()` persistiert.

```ts
autoSaveInterval: 60000 // ms
trackedFolders: [{ path: "...", keywords: [] }]
```

---

## ⌨️ Commands (Command Palette)

| Command                      | Beschreibung                      |
| ---------------------------- | --------------------------------- |
| 👁 Sichtbare Tipp-Simulation | Simuliert reales Tippen im Editor |
| 🧨 Hard Reset                | Löscht alle Statistikdaten        |
| 🧭 Fokus-Streak beenden      | Beendet aktuelle Fokus-Session    |
| 🔄 Settings neu laden        | Lädt Plugin-Settings neu          |

---

## 🧪 Debug & Simulation

Das Plugin enthält zwei Simulationen:

* **Statistische Simulation** (ohne Editor)
* **Echte Editor-Simulation** mit:

  * Tippfehlern
  * Backspace-Korrekturen
  * Verzögerungen
  * Fokus-Streak-Berechnung

Ideal zum Testen der gesamten Pipeline.

---

## 🛠️ Technische Details

* **Editor-Binding:**
  CM6-kompatibel über `contentDOM`
* **Inaktivität:**
  Neue Session nach > 2 Minuten Pause
* **Recovery:**
  Erkennt Tageswechsel & defekte JSON-Dateien
* **Aggregationen:**
  Alphabet, Sonderzeichen, Löschstatistik, Shortcuts

TypeScript-Konfiguration siehe `tsconfig.json` .

---

## 🚧 Bekannte Einschränkungen

* Fokus ausschließlich auf Markdown-Editor
* Keine UI-Visualisierung (bewusst Markdown-basiert)
* Monolithische Hauptklasse (noch kein Modul-Split)

---

## 🔮 Mögliche Erweiterungen

* Diagramme (z. B. Heatmaps, Trends)
* Export (CSV / JSON)
* UI-Dashboard
* Mehrere Profile
* Vergleichsmodi (Wochen / Monate)

---

##  Autor

**Elodin**

---


