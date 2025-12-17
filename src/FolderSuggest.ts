import { App, FuzzySuggestModal, TFolder } from "obsidian";

export class FolderSuggest {
	constructor(private app: App, private inputEl: HTMLInputElement) {
		this.inputEl.addEventListener("focus", () => {
			new FolderFuzzySuggestModal(this.app, this.inputEl).open();
		});
	}
}

class FolderFuzzySuggestModal extends FuzzySuggestModal<TFolder> {
	inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app);
		this.inputEl = inputEl;
	}

	getItems(): TFolder[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder);
	}

	getItemText(item: TFolder): string {
		return item.path;
	}

	onChooseItem(item: TFolder): void {
		this.inputEl.value = item.path;
		this.inputEl.dispatchEvent(new Event("input"));
	}
}
