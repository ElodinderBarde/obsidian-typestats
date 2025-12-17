// Bereinigte und korrigierte Version deines Tippstatistik-Plugins
import {
	App,
	Plugin,
	TFile,
	TFolder,
	Notice,
	MarkdownView,
	Modal,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";

interface TrackedFolder {
	path: string;
	keywords: string[];
}

interface TippstatistikSettings {
	trackedFolders: TrackedFolder[];
	autoSaveInterval: number;
	typingSimulation: {
		baseDelay: number;
		errorChance: number;
	};
}

const DEFAULT_SETTINGS: TippstatistikSettings = {
	trackedFolders: [{ path: "Vault Admin/Allgemein/Statistik", keywords: [] }],
	autoSaveInterval: 60000,
	typingSimulation: {
		baseDelay: 20,
		errorChance: 0.06,
	},
};

// ----------------------------------------------------
// Datentypen
// ----------------------------------------------------
interface DailyStats {
	date: string;
	sessionStart: string;
	sessionEnd: string | null;
	sessions: { start: string; end: string | null; durationMinutes: number }[];
	totals: {
		wordsTyped: number;
		charsTyped: number;
		wordsDeleted: number;
		charsDeleted: number;
	};
	speedHistory: { timestamp: string; wordsPerMinute: number; charsPerMinute: number }[];
	shortcutUsage: { vim: Record<string, number>; system: Record<string, number> };
	keyFrequency: Record<string, number>;
	deletedCharFrequency: Record<string, number>;
	focusStreaks: number[];
	currentFocusStreak: number;
	activeMinutes: number;
	accuracy: number;
	vimRatio: number;
	focusIndex: number;

	/** Marker, ob nach Reset ein Restart bevorsteht */
	restartPending?: boolean;
}

export default class TippstatistikPlugin extends Plugin {
	private stats!: DailyStats;
	private lastActivity!: number;
	private lastSnapshotTime!: Date;
	public intervalId: number | null = null;
	private file: TFile | null = null;
	private keyHandlerRef: (() => void) | null = null;
	private keydownHandlerRef: (() => void) | null = null;

	// Plugin Settings
	public settings: TippstatistikSettings = DEFAULT_SETTINGS;

	// Basisordner wie bei dir
	private readonly BASE_DIR = "Vault Admin/Allgemein/Statistik";

	// deutsche Monatsnamen
	private readonly MONTHS = [
		"Januar",
		"Februar",
		"März",
		"April",
		"Mai",
		"Juni",
		"Juli",
		"August",
		"September",
		"Oktober",
		"November",
		"Dezember",
	];

	// einige konstante Sets für Aggregation
	private readonly SWISS_ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");
	private readonly SWISS_SYMBOLS = [
		" ",
		"ä",
		"ö",
		"ü",
		"à",
		"è",
		"é",
		"ç",
		".",
		",",
		";",
		":",
		"!",
		"?",
		"'",
		'"',
		"-",
		"_",
		"(",
		")",
		"/",
		"+",
		"*",
		"@",
		"#",
		"§",
		"$",
		"%",
		"&",
		"=",
	];

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onload() {
		console.log("📈 Tippstatistik Plugin geladen");

		await this.loadSettings();

		this.addSettingTab(new TippstatistikSettingTab(this.app, this));

		this.addCommand({
			id: "simulate-visible-typing",
			name: "👁 Sichtbare Tipp-Simulation (Debug)",
			callback: async () => {
				await this.typeTestSimulation(300);
			},
		});

		this.addCommand({
			id: "wipe-all-stats",
			name: "🧨 Alle Statistikdateien löschen (Hard Reset)",
			callback: async () => {
				await this.wipeAllStatistics();
			},
		});

		this.addCommand({
			id: "end-current-focus-streak",
			name: "🧭 Fokus-Streak manuell beenden",
			callback: async () => {
				this.endCurrentFocusStreak();
				await this.saveStats();
				new Notice("🔹 Fokus-Streak manuell beendet & gespeichert");
			},
		});

		this.addCommand({
			id: "show-settings-info",
			name: "⚙️ Plugin Settings anzeigen (Info)",
			callback: async () => {
				new Notice(
					"Die Plugin-Einstellungen werden im Plugin-Datenspeicher abgelegt. Benutze den Settings-Tab für Änderungen."
				);
			},
		});

		this.app.workspace.onLayoutReady(async () => {
			this.lastActivity = Date.now();
			this.lastSnapshotTime = new Date();

			await this.ensureTodayStatsWithRecovery();
			this.bindToActiveEditor();
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.bindToActiveEditor()));
			this.startTracking();
		});

		this.addCommand({
			id: "reload-settings",
			name: "🔄 Plugin Settings neu laden",
			callback: async () => {
				await this.loadSettings();
				new Notice("Settings neu geladen.");
			},
		});
	}

	onunload() {
		console.log("📈 Tippstatistik Plugin entladen");
		if (this.intervalId) window.clearInterval(this.intervalId);
		this.saveStats();
		// Listener lösen
		if (this.keyHandlerRef) this.keyHandlerRef();
		if (this.keydownHandlerRef) this.keydownHandlerRef();
	}

	// ----------------------------------------------------
	// Hilfsfunktion: robustes Folder-Erstellen
	// ----------------------------------------------------
	private async ensureFolder(path: string): Promise<void> {
		try {
			if (!this.app.vault.getAbstractFileByPath(path)) {
				await this.app.vault.createFolder(path);
			}
		} catch (e: any) {
			// Falls der Ordner zwischenzeitlich doch erstellt wurde:
			if (!String(e?.message ?? "").includes("already exists")) {
				console.error("⚠️ Fehler beim Erstellen von Ordner:", path, e);
			}
		}
	}

	// ----------------------------------------------------
	// Initialisierung + Recovery
	// ----------------------------------------------------
	private async ensureTodayStatsWithRecovery() {
		await this.ensureBaseFolder();

		const today = this.getToday();
		const currentStatsPath = `${this.BASE_DIR}/currentStats.json`;

		// Stelle sicher, dass getrackte Ordner existieren
		for (const folder of this.settings.trackedFolders) {
			await this.ensureFolder(folder.path);
		}

		const existing = this.app.vault.getAbstractFileByPath(currentStatsPath);
		if (existing instanceof TFile) {
			// laden
			const data = await this.app.vault.read(existing);
			try {
				const parsed = JSON.parse(data) as DailyStats;

				// Recovery: Datei ist von gestern -> erst gestern abschließen
				if (parsed.date !== today) {
					console.log("🛠 Recovery: alter Tag gefunden, schließe ihn ab:", parsed.date);
					await this.writeDailyOutputs(parsed); // schreibt .md + Tages-json + index
					// neuen Tag anlegen
					this.stats = this.createEmptyStats(today);
					this.file = existing;
					await this.saveStats();
				} else {
					this.stats = parsed;
					this.file = existing;
				}
			} catch (e) {
				console.warn("⚠️ currentStats.json war defekt, neu erzeugt");
				this.stats = this.createEmptyStats(today);
				// Persist the newly created stats into the already existing file.
				// Await the modify call to ensure the write completes, but don't try to cast its return value.
				await this.app.vault.modify(existing, JSON.stringify(this.stats, null, 2));
				// Use the known existing TFile reference for `this.file`.
				this.file = existing as TFile;
			}
		} else {
			// keine Datei: neu
			this.stats = this.createEmptyStats(today);
			this.file = await this.app.vault.create(currentStatsPath, JSON.stringify(this.stats, null, 2));
		}
		// Stelle sicher, dass Jahres- und Monatsordner existieren
		const d = new Date(this.stats.date);
		const year = d.getFullYear();
		const monthName = this.MONTHS[d.getMonth()];
		await this.ensureFolder(`${this.BASE_DIR}/${year}`);
		await this.ensureFolder(`${this.BASE_DIR}/${year}/${monthName}`);

		await this.writeDailyOutputs(this.stats);
	}

	private async ensureBaseFolder() {
		// root
		if (!this.app.vault.getAbstractFileByPath(this.BASE_DIR)) {
			await this.app.vault.createFolder(this.BASE_DIR);
		}
	}

	// ----------------------------------------------------
	// Editor-Binding (ohne globalen document-Listener)
	// ----------------------------------------------------
	private bindToActiveEditor() {
		if (this.keyHandlerRef) this.keyHandlerRef();
		if (this.keydownHandlerRef) this.keydownHandlerRef();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const editor: any = view.editor;

		// CM6-sichere Variante: Zugriff auf contentDOM
		const cm = (editor as any)?.cm;
		const el: HTMLElement | null =
			cm?.contentDOM ?? cm?.dom?.content ?? cm?.getWrapperElement?.() ?? null;

		if (!el) {
			console.warn("⚠️ Kein valides Editor-DOM gefunden für Eventbindung");
			return;
		}

		const keyUp = this.handleKeyUp.bind(this);
		const keyDown = this.handleKeyDown.bind(this);

		el.addEventListener("keyup", keyUp);
		el.addEventListener("keydown", keyDown);

		this.keyHandlerRef = () => el.removeEventListener("keyup", keyUp);
		this.keydownHandlerRef = () => el.removeEventListener("keydown", keyDown);

		console.log("🔗 Tippstatistik Listener aktiv über", el.className);
	}

	// ----------------------------------------------------
	// Keydown: hier holen wir uns gelöschte Zeichen
	// ----------------------------------------------------
	private handleKeyDown(evt: KeyboardEvent) {
		if (evt.key !== "Backspace") return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor: any = view?.editor;
		if (!editor) return;

		// Cursor vor dem Löschen
		const cursor = editor.getCursor();
		const lineText: string = editor.getLine(cursor.line) ?? "";

		if (cursor.ch > 0) {
			const deletedChar = lineText.charAt(cursor.ch - 1);
			if (deletedChar) {
				this.stats.deletedCharFrequency[deletedChar] =
					(this.stats.deletedCharFrequency[deletedChar] || 0) + 1;
			}
		} else {
			// Zeilenanfang -> wir wissen nicht genau, was gelöscht wird (Zeilenumbruch)
			this.stats.deletedCharFrequency["⏎"] =
				(this.stats.deletedCharFrequency["⏎"] || 0) + 1;
		}
	}

	// ----------------------------------------------------
	// Keyup: hier zählen wir alle Eingaben
	// ----------------------------------------------------
	private async handleKeyUp(evt: KeyboardEvent) {
		const key = evt.key;
		const now = Date.now();

		// Session-Wechsel bei Inaktivität > 2min
		if (now - this.lastActivity > 120000) await this.newSession();
		this.lastActivity = now;

		// System-Shortcuts
		if (evt.ctrlKey || evt.metaKey) {
			const combo = `${evt.ctrlKey ? "ctrl+" : ""}${evt.metaKey ? "meta+" : ""}${key}`;
			this.stats.shortcutUsage.system[combo] =
				(this.stats.shortcutUsage.system[combo] || 0) + 1;
		} else {
			// reguläres Tippen
			this.stats.keyFrequency[key] = (this.stats.keyFrequency[key] || 0) + 1;

			if (key === "Backspace") {
				this.stats.totals.charsDeleted++;
			} else if (key.length === 1) {
				this.stats.totals.charsTyped++;
				if (key === " ") this.stats.totals.wordsTyped++;
			}
		}

		// Minütliche Auswertung
		if (now - this.lastSnapshotTime.getTime() >= 60000) {
			this.stats.activeMinutes++;
			this.stats.currentFocusStreak++;
			this.lastSnapshotTime = new Date();


			// FORMEL (Kommentar):
			// wordsPerMinute = totalWords / activeMinutes
			// charsPerMinute = totalChars / activeMinutes
			const wordsPerMinute =
				this.stats.totals.wordsTyped / Math.max(this.stats.activeMinutes, 1);
			const charsPerMinute =
				this.stats.totals.charsTyped / Math.max(this.stats.activeMinutes, 1);

			this.stats.speedHistory.push({
				timestamp: this.nowLocalISO(),
				wordsPerMinute,
				charsPerMinute,
			});

			// FORMEL (Kommentar):
			// focusIndex = (activeMinutes * charsPerMinute) / totalSessionMinutes
			const totalMinutes = this.getTotalSessionMinutes();
			this.stats.focusIndex =
				(this.stats.activeMinutes * charsPerMinute) / Math.max(totalMinutes, 1);
		}

		// abgeleitete Werte
		this.updateDerivedStats();
	}

	// ----------------------------------------------------
	// Derived
	// ----------------------------------------------------
	private updateDerivedStats() {
		const { charsTyped, charsDeleted } = this.stats.totals;

		// FORMEL (Kommentar):
		// accuracy = 1 - (charsDeleted / charsTyped)
		this.stats.accuracy = charsTyped > 0 ? 1 - charsDeleted / charsTyped : 1;

		// Vim benutzen wir gerade nicht aktiv, aber Berechnung lassen wir drin
		const vimCount = Object.values(this.stats.shortcutUsage.vim).reduce((a, b) => a + b, 0);
		const sysCount = Object.values(this.stats.shortcutUsage.system).reduce((a, b) => a + b, 0);
		const totalKeys = vimCount + sysCount + this.stats.totals.charsTyped;
		this.stats.vimRatio = totalKeys > 0 ? vimCount / totalKeys : 0;
	}

	// ----------------------------------------------------
	// Sessions
	// ----------------------------------------------------
	private getTotalSessionMinutes(): number {
		const now = Date.now();
		return Math.round((now - new Date(this.stats.sessionStart).getTime()) / 60000);
	}
	private nowLocalISO(): string {
		const date = new Date();
		const tzOffset = date.getTimezoneOffset() * 60000; // Minuten -> ms
		const localISO = new Date(date.getTime() - tzOffset).toISOString().slice(0, -1);
		return localISO;
	}

	private async newSession() {
		const now = this.nowLocalISO();
		const last = this.stats.sessions[this.stats.sessions.length - 1];
		if (last && !last.end) {
			last.end = now;
			const endTime = new Date(last.end);
			const startTime = new Date(last.start);
			last.durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000);
		}
		this.stats.sessions.push({ start: now, end: null, durationMinutes: 0 });

		this.stats.focusStreaks.push(this.stats.currentFocusStreak);
		this.stats.currentFocusStreak = 0;

		if (this.stats.restartPending) {
			console.log("🆕 Restart erkannt – beginne neuen Tag.");
			this.stats.restartPending = false;
			await this.ensureTodayStatsWithRecovery();
			await this.saveStats();
		}
	}

	private async endCurrentFocusStreak() {
		this.stats.focusStreaks.push(this.stats.currentFocusStreak);
		this.stats.currentFocusStreak = 0;

		const now = this.nowLocalISO();
		const lastSession = this.stats.sessions[this.stats.sessions.length - 1];
		if (lastSession && !lastSession.end) {
			lastSession.end = now;
			const startTime = new Date(lastSession.start);
			lastSession.durationMinutes = Math.round((Date.now() - startTime.getTime()) / 60000);
		}

		this.stats.sessionEnd = now;
		console.log("💾 Speichere Stats:", this.stats.date, this.stats.totals);

		try {
			await this.writeDailyOutputs(this.stats);
			await this.saveStats();
			console.log("📚 Alle Statistikdateien nach Streak-Ende aktualisiert.");
		} catch (e) {
			console.error("⚠️ Fehler beim Aktualisieren aller Statistikdateien:", e);
		}
	}

	/**
	 * Simuliert eine zufällige Tipp-Session, um das Statistiksystem zu testen.
	 */
	private simulateTypingSession(durationMinutes = 5, avgSpeedWPM = 40, errorRate = 0.1): void {
		const alphabet = "abcdefghijklmnopqrstuvwxyz ";
		const commonTypos = { e: "r", r: "t", i: "o", a: "s", n: "m", " ": "" } as Record<string, string>; // realistische Vertipper
		const now = Date.now();

		// Beginn einer neuen Session
		this.newSession();

		for (let i = 0; i < durationMinutes; i++) {
			const wordsThisMinute = Math.floor(avgSpeedWPM * (0.8 + Math.random() * 0.4)); // ±20% Varianz

			for (let w = 0; w < wordsThisMinute; w++) {
				const wordLength = 3 + Math.floor(Math.random() * 6);
				for (let c = 0; c < wordLength; c++) {
					const char = alphabet[Math.floor(Math.random() * 26)];

					// Fehler einbauen?
					if (Math.random() < errorRate) {
						const typo = commonTypos[char] ?? "";
						// Falsches Zeichen (gezählt als typed + deleted)
						this.stats.totals.charsTyped++;
						this.stats.totals.charsDeleted++;
						this.stats.deletedCharFrequency[char] = (this.stats.deletedCharFrequency[char] || 0) + 1;
					} else {
						this.stats.keyFrequency[char] = (this.stats.keyFrequency[char] || 0) + 1;
						this.stats.totals.charsTyped++;
					}
				}
				this.stats.totals.wordsTyped++;
			}

			this.stats.speedHistory.push({
				timestamp: new Date(now + i * 60000).toISOString(),
				wordsPerMinute: wordsThisMinute,
				charsPerMinute: wordsThisMinute * 5,
			});
			this.stats.activeMinutes++;
		}

		this.stats.sessionEnd = new Date(now + durationMinutes * 60000).toISOString();

		// abgeleitete Werte
		this.updateDerivedStats();

		console.log(
			`🧠 Simulation beendet: ${this.stats.totals.wordsTyped} Wörter, ${this.stats.totals.charsTyped} Zeichen`
		);
	}

	private async typeTestSimulation(loremSize = 300): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("⚠️ Kein aktives Editor-Fenster gefunden.");
			return;
		}
		const editor = view.editor;

		// Textquelle (gleichmäßig wiederholt, um stabile Länge zu haben)
		const lorem =
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
			"Vestibulum vulputate, nunc sit amet laoreet malesuada, " +
			"risus mauris fermentum est, nec gravida justo erat sed nunc. ";
		const text = lorem.repeat(Math.ceil(loremSize / lorem.length)).slice(0, loremSize);

		// Leeres Dokument für sauberen Start
		editor.setValue("");

		this.newSession();
		let index = 0;
		let errorCount = 0;
		let correctionCount = 0;

		// Steuerparameter
		const baseDelay = this.settings.typingSimulation.baseDelay ?? 20;
		const errorChance = this.settings.typingSimulation.errorChance ?? 0.06;
		const correctionDelay = 250; // Pause nach Fehler, bevor korrigiert wird

		// Simuliere Tippverhalten (rekursive Sequenz)
		const typeNext = () => {
			if (index >= text.length) {
				this.endCurrentFocusStreak();
				this.saveStats();
				new Notice(`🧠 Simulation beendet (${errorCount} Fehler, ${correctionCount} Korrekturen)`);
				return;
			}

			const correctChar = text[index++];
			const makeError = Math.random() < errorChance && /[a-zA-Z]/.test(correctChar);

			if (makeError) {
				// Tippfehler
				const wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
				editor.replaceRange(wrongChar, { line: 0, ch: editor.getValue().length });
				this.stats.totals.charsTyped++;
				this.stats.keyFrequency[wrongChar] = (this.stats.keyFrequency[wrongChar] || 0) + 1;
				errorCount++;

				// Nach kurzer Pause Fehler korrigieren
				setTimeout(() => {
					const currentLength = editor.getValue().length;
					const from = { line: 0, ch: currentLength - 1 };
					const to = { line: 0, ch: currentLength };
					editor.replaceRange("", from, to); // Backspace
					this.stats.totals.charsDeleted++;
					this.stats.deletedCharFrequency[wrongChar] =
						(this.stats.deletedCharFrequency[wrongChar] || 0) + 1;
					correctionCount++;

					// Danach richtiges Zeichen schreiben
					setTimeout(() => {
						editor.replaceRange(correctChar, { line: 0, ch: editor.getValue().length });
						this.stats.totals.charsTyped++;
						this.stats.keyFrequency[correctChar] =
							(this.stats.keyFrequency[correctChar] || 0) + 1;
						if (correctChar === " ") this.stats.totals.wordsTyped++;
						setTimeout(typeNext, baseDelay + Math.random() * baseDelay);
					}, baseDelay + Math.random() * 100);
				}, correctionDelay + Math.random() * 100);
			} else {
				// Normales Schreiben
				editor.replaceRange(correctChar, { line: 0, ch: editor.getValue().length });
				this.stats.totals.charsTyped++;
				this.stats.keyFrequency[correctChar] =
					(this.stats.keyFrequency[correctChar] || 0) + 1;
				if (correctChar === " ") this.stats.totals.wordsTyped++;
				setTimeout(typeNext, baseDelay + Math.random() * baseDelay);
			}
		};

		typeNext();
	}

	// ----------------------------------------------------
	// Auto-Save
	// ----------------------------------------------------
	public startTracking() {
		const interval = Math.max(1000, this.settings.autoSaveInterval ?? 60000);
		this.intervalId = window.setInterval(() => this.saveStats(), interval);
	}

	public async saveStats() {
		if (!this.file) return;
		this.stats.sessionEnd = this.nowLocalISO();
		await this.app.vault.modify(this.file, JSON.stringify(this.stats, null, 2));
	}

	// ----------------------------------------------------
	// Reset & Purge
	// ----------------------------------------------------
	/**
	 * Vollständiger Reset aller Statistikdaten.
	 */
	private async wipeAllStatistics(): Promise<void> {
		const confirmed = await new Promise<boolean>((resolve) => {
			const modal = new ConfirmDeleteModal(
				this.app,
				"⚠️ Vollständiger Statistik-Reset",
				"Dieser Vorgang löscht ALLE Statistikdateien dauerhaft. Um fortzufahren, gib bitte 'LÖSCHEN' ein.",
				() => resolve(true),
				() => resolve(false)
			);
			modal.open();
		});

		if (!confirmed) {
			new Notice("❎ Abgebrochen – keine Dateien gelöscht.");
			return;
		}

		new Notice("🧹 Lösche alle Statistikdateien...");

		const basePath = this.BASE_DIR;
		const allFiles = this.app.vault.getFiles().filter((f) => f.path.startsWith(basePath));

		// 1️⃣ Dateien löschen
		for (const f of allFiles) {
			try {
				await this.app.vault.delete(f);
				console.log("🗑️ Datei gelöscht:", f.path);
			} catch (e) {
				console.warn("⚠️ Fehler beim Löschen von", f.path, e);
			}
		}

		// 2️⃣ Leere Ordner löschen
		await this.cleanupEmptyFolders(basePath);

		// 3️⃣ Neuaufbau
		await this.ensureBaseFolder();
		await this.restartFilesAndFolders();

		new Notice("✅ Hard Reset abgeschlossen. Neuer Tag wird beim nächsten Fokus gestartet.");
	}

	/**
	 * Erstellt nach einem Reset alle Basisdateien und startet frischen Statistik-Tag.
	 */
	private async restartFilesAndFolders(): Promise<void> {
		console.log("🔄 Erstelle neue Statistikstruktur...");

		this.stats = this.createEmptyStats(this.getToday());
		await this.ensureBaseFolder();

		const currentStatsPath = `${this.BASE_DIR}/currentStats.json`;
		this.file = await this.app.vault.create(currentStatsPath, JSON.stringify(this.stats, null, 2));

		// Marker für Restart-Zustand
		this.stats.restartPending = true;
		await this.saveStats();

		new Notice("📊 Neue Statistikstruktur initialisiert.");
	}

	/**
	 * Löscht alle leeren Unterordner rekursiv ab dem angegebenen Pfad.
	 */
	private async cleanupEmptyFolders(folderPath: string): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return;

		for (const child of folder.children) {
			if (child instanceof TFolder) {
				await this.cleanupEmptyFolders(child.path);
			}
		}

		// Wenn Ordner jetzt leer ist -> löschen
		const refreshed = this.app.vault.getAbstractFileByPath(folder.path);
		if (refreshed instanceof TFolder && refreshed.children.length === 0) {
			try {
				await this.app.vault.delete(refreshed);
				console.log("📁 Leerer Ordner gelöscht:", refreshed.path);
			} catch (e) {
				console.warn("⚠️ Konnte Ordner nicht löschen:", refreshed.path, e);
			}
		}
	}

	private async purgeVimInFile() {
		const currentStatsPath = `${this.BASE_DIR}/currentStats.json`;
		const f = this.app.vault.getAbstractFileByPath(currentStatsPath);
		if (!(f instanceof TFile)) {
			new Notice("❌ Statistikdatei nicht gefunden");
			return;
		}
		const data = await this.app.vault.read(f);
		let json: any;
		try {
			json = JSON.parse(data);
		} catch {
			new Notice("⚠️ Datei konnte nicht gelesen werden (ungültiges JSON).");
			return;
		}
		if (json.shortcutUsage?.vim) {
			json.shortcutUsage.vim = {};
			json.vimRatio = 0;
			await this.app.vault.modify(f, JSON.stringify(json, null, 2));
			new Notice("✅ Vim-Daten in der Datei erfolgreich gelöscht.");
		} else {
			new Notice("ℹ️ Keine Vim-Daten gefunden oder bereits leer.");
		}
	}

	// ----------------------------------------------------
	// Aggregation / Monthly / Yearly - eine Implementierung
	// ----------------------------------------------------
	private normalizeSymbol(s: string) {
		if (s === " ") return "Spacebar";
		if (s === "\n") return "⏎";
		return s;
	}

	// Alle Tage eines Monats abrufen (month: 0–11)
	private getAllDaysOfMonth(year: number, month: number): string[] {
		const date = new Date(year, month, 1);
		const result: string[] = [];

		while (date.getFullYear() === year && date.getMonth() === month) {
			result.push(date.toISOString().slice(0, 10)); // YYYY-MM-DD
			date.setDate(date.getDate() + 1);
		}

		return result;
	}

	// Aggregation aus vielen DailyStats
	private aggregateStats(stats: DailyStats[]) {
		const keyFreq: Record<string, number> = {};
		const delFreq: Record<string, number> = {};
		const sysShortcuts: Record<string, number> = {};
		const vimShortcuts: Record<string, number> = {};

		for (const d of stats) {
			for (const [k, v] of Object.entries(d.keyFrequency)) keyFreq[k] = (keyFreq[k] || 0) + v;
			for (const [k, v] of Object.entries(d.deletedCharFrequency)) delFreq[k] = (delFreq[k] || 0) + v;
			for (const [k, v] of Object.entries(d.shortcutUsage.system)) sysShortcuts[k] = (sysShortcuts[k] || 0) + v;
			for (const [k, v] of Object.entries(d.shortcutUsage.vim)) vimShortcuts[k] = (vimShortcuts[k] || 0) + v;
		}

		return { keyFreq, delFreq, sysShortcuts, vimShortcuts };
	}

	// Tabellen für Alphabet, Sonderzeichen & Shortcuts bauen
	private buildTablesFromAggregated(
		keyFreq: Record<string, number>,
		delFreq: Record<string, number>,
		sysShortcuts: Record<string, number>,
		vimShortcuts: Record<string, number>
	) {
		// Alphabet
		const alphabetTable = [
			"| Position | Zeichen | Menge |",
			"|---|---|---|",
			...this.SWISS_ALPHABET.map((c, i) => `| ${i + 1}. | \`${c}\` | ${keyFreq[c] || 0} |`),
		].join("\n");

		// Sonderzeichen
		const symbolTable = [
			"| Position | Zeichen | Menge |",
			"|---|---|---|",
			...this.SWISS_SYMBOLS.map((s, i) => `| ${i + 1}. | \`${this.normalizeSymbol(s)}\` | ${keyFreq[s] || 0} |`),
		].join("\n");




		// ------------------------------------------------------------
		// Löschstatistik – meistgelöschtes Zeichen + Top-20 ohne Space
		// ------------------------------------------------------------

		// Normalisieren
		const normalize = (s: string) => {
			if (s === " ") return "Spacebar";
			if (s === "\n") return "⏎";
			return s;
		};

		// Meistgelöschtes Zeichen bestimmen (inkl. Spacebar)
		let mostDeleted = "—";
		let mostDeletedCount = 0;

		for (const [ch, count] of Object.entries(delFreq)) {
			if (count > mostDeletedCount) {
				mostDeleted = ch;
				mostDeletedCount = count;
			}
		}

		// Top 20 erstellen – aber Spacebar herausfiltern
		const topDeleted = Object.entries(delFreq)
			.filter(([k, v]) => k !== " ")                     // ← Spacebar raus
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20);

		// Abschnitt zusammenbauen
		let deletedSection = "";

		if (mostDeleted === " ") {
			// Falls Spacebar #1 ist
			deletedSection = [
				"### Löschstatistik",
				"",
				"> Das meistgelöschte Zeichen war ein Leerzeichen.",
				"",
				"### Top 20 gelöschte Zeichen (ohne Leerzeichen)",
				"",
				"| Zeichen | Anzahl |",
				"|---|---|",
				...topDeleted.map(([k, v]) =>
					`| \`${normalize(k)}\` | ${v} |`
				),
				""
			].join("\n");
		} else {
			// Normale Ausgabe
			deletedSection = [
				"### Löschstatistik",
				"",
				"**Meist gelöschtes Zeichen:**",
				"",
				`- Zeichen: \`${normalize(mostDeleted)}\``,
				`- Anzahl: ${mostDeletedCount}`,
				"",
				"### Top 20 gelöschte Zeichen (ohne Leerzeichen)",
				"",
				"| Zeichen | Anzahl |",
				"|---|---|",
				...topDeleted.map(([k, v]) =>
					`| \`${normalize(k)}\` | ${v} |`
				),
				""
			].join("\n");
		}

			
		// Shortcuts system
		const systemShortcutTable = [
			"| Position | Shortcut | Menge |",
			"|---|---|---|",
			...Object.entries(sysShortcuts)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v], i) => `| ${i + 1}. | \`${k}\` | ${v} |`),
		].join("\n");

		// Shortcuts vim
		const vimShortcutTable = [
			"| Position | Shortcut | Menge |",
			"|---|---|---|",
			...Object.entries(vimShortcuts)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v], i) => `| ${i + 1}. | \`${k}\` | ${v} |`),
		].join("\n");

		return {
			deletedSection,
			alphabetTable,
			symbolTable,
			systemShortcutTable,
			vimShortcutTable,
		};
	}

	// Utility zum Anlegen oder Rückgeben existierender TFile
	private async ensureFile(path: string, initial: string): Promise<TFile> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return await this.app.vault.create(path, initial);
		return file as TFile;
	}
	// -------------------------------------------------------------
	// Monthly / Yearly Builder & Updater (bereinigt & funktionsfähig)
	// -------------------------------------------------------------
	private async buildMonthlyMarkdown(
		year: number,
		monthName: string,
		month: number
	): Promise<string> {
		const monthFolder = `${this.BASE_DIR}/${year}/${monthName}`;
		const files = this.app.vault.getFiles().filter(
			f => f.path.startsWith(`${monthFolder}/Metadata/`) && f.path.endsWith(".json")
		);


		if (files.length === 0) return "";

		// DailyStats laden
		const stats: DailyStats[] = [];
		for (const file of files) {
			const raw = await this.app.vault.read(file);
			stats.push(JSON.parse(raw));
		}

		// Summen berechnen
		let totalChars = 0;
		let totalWords = 0;
		let totalAccuracy = 0;
		let activeDays = 0;

		for (const s of stats) {
			if (s.totals.charsTyped > 0) {
				activeDays++;
				totalChars += s.totals.charsTyped;
				totalWords += s.totals.wordsTyped;
				totalAccuracy += s.accuracy;
			}
		}

		const avgAcc = activeDays > 0
			? (totalAccuracy / activeDays) * 100
			: 0;

		// Aggregation für Tabellen
		const { keyFreq, delFreq, sysShortcuts, vimShortcuts } =
			this.aggregateStats(stats);

		const tables = this.buildTablesFromAggregated(
			keyFreq,
			delFreq,
			sysShortcuts,
			vimShortcuts
		);

		// Map für Daten
		const byDate = new Map<string, DailyStats>();
		for (const s of stats) {
			byDate.set(s.date, s);
		}

		const allDays = this.getAllDaysOfMonth(year, month);

		const dayRows = allDays.map((d) => {
			const wd = this.weekdayName(d);
			const js = byDate.get(d);

			if (!js) {
				return `| ${wd} | ${d} | 0 | 0 | 0 | 0 |`;
			}

			// Schutz gegen Division durch 0
			const mins = js.activeMinutes || 0;

			const cpm = mins > 0 ? Math.round(js.totals.charsTyped / mins) : 0;
			const wpm = mins > 0 ? Math.round(js.totals.wordsTyped / mins) : 0;

			let row = `| ${wd} | [[Tippstatistik-${d}]] | ${js.totals.charsTyped} | ${js.totals.wordsTyped} | ${cpm} | ${wpm} |`;

			// Highlight komplette Zeile bei Sonntag
			if (wd === "Sonntag") {
				row = `| ==${wd}== | ==[[Tippstatistik-${d}]]== | ==${js.totals.charsTyped}== | ==${js.totals.wordsTyped}== | ==${cpm}== | ==${wpm}== |`;
			}

			return row;
		});


		// Monatswerte-Block
		const monthlySummaryBlock = [
			"## Monatswerte",
			"",
			`- Zeichen: ${totalChars}`,
			`- Wörter: ${totalWords}`,
			`- Genauigkeit Ø: ${avgAcc.toFixed(1)}%`,
			""
		].join("\n");

		return [
			"---",
			`type: tippstatistik-monthly`,
			`yearRef: "[[Tippstatistik-Jahr-${year}]]"`,
			"---",
			"",
			`# Tippstatistik Monat ${monthName} ${year}`,
			"",
			monthlySummaryBlock,
			"## Zeichenstatistik",
			"### Alphabet",
			tables.alphabetTable,
			"",
			"### Sonderzeichen",
			tables.symbolTable,
			"",
			"## Shortcutstatistik",
			"### System",
			tables.systemShortcutTable,
			"",
			"### Vim",
			tables.vimShortcutTable,
			"",
			"## Löschstatistik",
			tables.deletedSection,
			"",
			"## Tagesstatistik",
			"| Wochentag | Datum | Zeichen | Wörter |Zeichen Pro Min |Wöter Pro Min|",
			"|---|---|---|---|",

			...dayRows,
			""
		].join("\n");
	}

	// -------------------------------------------------------------
	// YEARLY
	// -------------------------------------------------------------
	private async buildYearlyMarkdown(year: number): Promise<string> {
		const yearFolder = `${this.BASE_DIR}/${year}`;
		const files = this.app.vault.getFiles().filter(
			f => f.path.includes(`/Metadata/`) && f.path.endsWith(".json")
		);


		if (files.length === 0) return "";

		const stats: DailyStats[] = [];
		for (const file of files) {
			const raw = await this.app.vault.read(file);
			stats.push(JSON.parse(raw));
		}

		// Summen
		let totalChars = 0;
		let totalWords = 0;
		let totalAccuracy = 0;
		let totalDays = 0;

		for (const s of stats) {
			if (s.totals.charsTyped > 0) {
				totalDays++;
				totalChars += s.totals.charsTyped;
				totalWords += s.totals.wordsTyped;
				totalAccuracy += s.accuracy;
			}
		}

		const avgAcc = totalDays > 0
			? (totalAccuracy / totalDays) * 100
			: 0;

		// Tabelle aggregieren
		const { keyFreq, delFreq, sysShortcuts, vimShortcuts } =
			this.aggregateStats(stats);

		const tables = this.buildTablesFromAggregated(
			keyFreq,
			delFreq,
			sysShortcuts,
			vimShortcuts
		);

		// Map
		const byDate = new Map<string, DailyStats>();
		for (const s of stats) {
			byDate.set(s.date, s);
		}

		// Alle Tage 01.01–31.12
		const allDays: string[] = [];
		for (let m = 0; m < 12; m++) {
			allDays.push(...this.getAllDaysOfMonth(year, m));
		}

		const dayRows = allDays.map(d => {
			const js = byDate.get(d);
			const wd = this.weekdayName(d);

			if (!js) {
				return `| ${wd} | ${d} | 0 | 0 | 0 | 0 |`;
			}

			// Schutz gegen Division durch 0
			const mins = js.activeMinutes || 0;

			const cpm = mins > 0 ? Math.round(js.totals.charsTyped / mins) : 0;
			const wpm = mins > 0 ? Math.round(js.totals.wordsTyped / mins) : 0;

			let row = `| ${wd} | ${d} | ${js.totals.charsTyped} | ${js.totals.wordsTyped} | ${cpm} | ${wpm} |`;

			// Highlight komplette Zeile bei Sonntag
			if (wd === "Sonntag") {
				row = `| ==${wd}== | ==${d}== | ==${js.totals.charsTyped}== | ==${js.totals.wordsTyped}== | ==${cpm}== | ==${wpm}== |`;
			}

			return row;
		});


		const yearlySummaryBlock = [
			"## Jahreswerte",
			"",
			`- Zeichen: ${totalChars}`,
			`- Wörter: ${totalWords}`,
			`- Genauigkeit Ø: ${avgAcc.toFixed(1)}%`,
			""
		].join("\n");

		return [
			"---",
			`Kategorie: JahresStatistik`, 
			`Bezieht sich auf: "[[Vault Admin/indexes/Tags/Vault Admin/Statistik|Statistik]]"`, 
			"---",
			"",
			`# Tippstatistik Jahr ${year}`,
			"",
			yearlySummaryBlock,
			"## Zeichenstatistik",
			"### Alphabet",
			tables.alphabetTable,
			"",
			"### Sonderzeichen",
			tables.symbolTable,
			"",
			"## Shortcutstatistik",
			"### System",
			tables.systemShortcutTable,
			"",
			"### Vim",
			tables.vimShortcutTable,
			"",
			"## Löschstatistik",
			tables.deletedSection,
			"",
			"## Tagesstatistik",
			"| Wochentag | Datum | Zeichen | Wörter |Zeichen Pro Min |Wöter Pro Min|",
			"|---|---|---|---|",
			...dayRows,
			""
		].join("\n");
	}
	private weekdayName(d: string): string {
		const date = new Date(d);
		const days = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
		return days[date.getDay()];
	}

	// -------------------------------------------------------------
	// Updater
	// -------------------------------------------------------------
	private async updateMonthlyStats(year: number, monthName: string) {
		const month = this.MONTHS.indexOf(monthName);
		if (month < 0) return;

		const md = await this.buildMonthlyMarkdown(year, monthName, month);
		if (md === "") return;

		const filePath = `${this.BASE_DIR}/${year}/${monthName}/Tippstatistik-Monat-${monthName}-${year}.md`;
		await this.app.vault.modify(await this.ensureFile(filePath, md), md);

		await this.updateYearlyStats(year);
	}

	private async updateYearlyStats(year: number) {
		const md = await this.buildYearlyMarkdown(year);
		if (md === "") return;

		const path = `${this.BASE_DIR}/${year}/Tippstatistik-Jahr-${year}.md`;
		await this.app.vault.modify(await this.ensureFile(path, md), md);
	}


	// ----------------------------------------------------
	// Write daily outputs: JSON + Markdown + update month/year
	// ----------------------------------------------------
	private async writeDailyOutputs(daily: DailyStats) {
		try {
			const d = new Date(daily.date);
			const year = d.getFullYear();
			const monthName = this.MONTHS[d.getMonth()];
			await this.ensureFolder(`${this.BASE_DIR}/${year}`);
			await this.ensureFolder(`${this.BASE_DIR}/${year}/${monthName}`);
			await this.ensureFolder(`${this.BASE_DIR}/${year}/${monthName}/Metadata`);
			await this.ensureFolder(`${this.BASE_DIR}/${year}/${monthName}/Tippstatistik`);


			const mins = daily.activeMinutes ?? 0;
			const cpm  = mins > 0 ? Math.round(daily.totals.charsTyped  / mins) : 0;
			const wpm  = mins > 0 ? Math.round(daily.totals.wordsTyped / mins) : 0;
	
	

			const jsonPath = `${this.BASE_DIR}/${year}/${monthName}/Metadata/${daily.date}.json`;
			await this.app.vault.modify(await this.ensureFile(jsonPath, JSON.stringify(daily, null, 2)), JSON.stringify(daily, null, 2));

			// Markdown Daily
			const mdPath = `${this.BASE_DIR}/${year}/${monthName}/Tippstatistik/Tippstatistik-${daily.date}.md`;
			const mdContent = [
				"---",
				`type: tippstatistik-daily`,
				`date: ${daily.date}`,
				`monthRef: "[[Tippstatistik-Monat-${monthName}-${year}]]"`, 
				"---",
				"",
				`# Tippstatistik ${daily.date}`,
				"",
				`- Zeichen: ${daily.totals.charsTyped}`,
				`- Wörter: ${daily.totals.wordsTyped}`,
				`- Genauigkeit: ${(daily.accuracy * 100).toFixed(1)}%`,
				`- Zeichen Pro Min: ${cpm}`, 
				`- Worte Pro Min: ${wpm}`, 
				"",
			].join("\n");
			await this.app.vault.modify(await this.ensureFile(mdPath, mdContent), mdContent);

			// Update month/year files
			await this.updateMonthlyStats(year, monthName);
		} catch (e) {
			console.error("⚠️ Fehler beim Schreiben der Tagesausgaben:", e);
		}
	}

	// ----------------------------------------------------
	// Helpers
	// ----------------------------------------------------
	private getToday(): string {
		return this.nowLocalISO().slice(0, 10);
	}

	private createEmptyStats(date: string): DailyStats {
		return {
			date,
			sessionStart: this.nowLocalISO(),
			sessionEnd: null,
			sessions: [{ start: this.nowLocalISO(), end: null, durationMinutes: 0 }],
			totals: { wordsTyped: 0, charsTyped: 0, wordsDeleted: 0, charsDeleted: 0 },
			speedHistory: [],
			shortcutUsage: { vim: {}, system: {} },
			keyFrequency: {},
			deletedCharFrequency: {},
			focusStreaks: [],
			currentFocusStreak: 0,
			activeMinutes: 0,
			accuracy: 1,
			vimRatio: 0,
			focusIndex: 0,
		};
	}

	private isWeekend(dateStr: string): boolean {
		const d = new Date(dateStr);
		const day = d.getDay(); // 0 = So, 6 = Sa
		return day === 0 || day === 6;
	}

	private async getYesterdayStats(today: string): Promise<DailyStats | null> {
		try {
			const date = new Date(today);
			date.setDate(date.getDate() - 1);
			const yesterdayStr = date.toISOString().slice(0, 10);
			const year = date.getFullYear();
			const monthName = this.MONTHS[date.getMonth()];
			const jsonPath = `${this.BASE_DIR}/${year}/${monthName}/${yesterdayStr}.json`;
			const file = this.app.vault.getAbstractFileByPath(jsonPath);
			if (file instanceof TFile) {
				const data = await this.app.vault.read(file);
				return JSON.parse(data) as DailyStats;
			}
			return null;
		} catch (e) {
			console.warn("⚠️ Konnte gestrige Statistik nicht laden:", e);
			return null;
		}
	}
}

/**
 * Dialog für kritische Löschvorgänge, erfordert Eingabe von "LÖSCHEN".
 */
class ConfirmDeleteModal extends Modal {
	private inputField!: TextComponent;
	private confirmed = false;

	constructor(
		app: App,
		private titleText: string,
		private message: string,
		private onConfirm: () => void,
		private onCancel: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: this.titleText });
		contentEl.createEl("p", { text: this.message });

		let typed = "";

		new Setting(contentEl).setName("Bestätigung").addText((text) => {
			this.inputField = text;
			text.onChange((val) => (typed = val.trim()));
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Ja, alles löschen").setCta().onClick(() => {
					if (typed === "LÖSCHEN") {
						this.confirmed = true;
						this.close();
					} else {
						new Notice("❗ Bitte gib exakt 'LÖSCHEN' ein, um fortzufahren.");
					}
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Abbrechen").onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		this.contentEl.empty();
		if (this.confirmed) this.onConfirm();
		else this.onCancel();
	}
}

class TippstatistikSettingTab extends PluginSettingTab {
	plugin: TippstatistikPlugin;

	constructor(app: App, plugin: TippstatistikPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "📁 Getrackte Ordner & Filter" });

		// Beispiel: Liste der getrackten Ordner anzeigen
		this.plugin.settings.trackedFolders.forEach((f, idx) => {
			containerEl.createEl("div", { text: `${idx + 1}. ${f.path}` });
		});

		// Einstellung für AutoSave-Intervall
		new Setting(containerEl)
			.setName("Auto-Save Intervall (ms)")
			.setDesc("Intervall, in dem currentStats.json automatisch gespeichert wird")
			.addText((text) => {
				text.setValue(String(this.plugin.settings.autoSaveInterval));
				text.onChange((val) => {
					const num = Number(val);
					if (!Number.isNaN(num) && num >= 1000) {
						this.plugin.settings.autoSaveInterval = num;
						this.plugin.saveSettings();
						if (this.plugin.intervalId) {
							window.clearInterval(this.plugin.intervalId);
							this.plugin.startTracking();
						}
					}
				});
			});
	}
}