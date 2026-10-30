// Minimal stand-in for the "obsidian" module so main.ts can be loaded in
// node tests. Only what main.ts touches at load time or in the pure text
// paths under test is provided.
/* eslint-disable @typescript-eslint/no-explicit-any */

export class Component {
	registerEvent(): void {}
	registerDomEvent(): void {}
	registerInterval(id: number): number {
		return id;
	}
	register(): void {}
}

export class Plugin extends Component {
	app: any;
	manifest: any;
	constructor(app?: any, manifest?: any) {
		super();
		this.app = app ?? {};
		this.manifest = manifest ?? {};
	}
	async loadData(): Promise<any> {
		return null;
	}
	async saveData(): Promise<void> {}
	addCommand(): void {}
	addSettingTab(): void {}
	registerEditorExtension(): void {}
	registerEditorSuggest(): void {}
}

export class PluginSettingTab {
	app: any;
	containerEl: any = {};
	constructor(app: any) {
		this.app = app;
	}
	hide(): void {}
}

export class App {}
export class Setting {}
export class Modal {
	app: any;
	contentEl: any = {};
	constructor(app: any) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
}
export class Notice {
	messages: string[] = [];
	constructor(public message?: string) {}
	setMessage(m: string): this {
		this.message = m;
		return this;
	}
	hide(): void {}
}

export class EditorSuggest<T> {
	app: any;
	limit = 0;
	context: any = null;
	scope: any = { register() {}, unregister() {} };
	constructor(app: any) {
		this.app = app;
	}
	setInstructions(): void {}
	open(): void {}
	close(): void {}
	_t?: T;
}

export function prepareFuzzySearch(query: string) {
	const q = query.toLowerCase();
	return (text: string) => {
		const idx = text.toLowerCase().indexOf(q);
		return idx === -1 ? null : { score: -idx, matches: [[idx, idx + q.length]] };
	};
}

export function renderMatches(): void {}
export function setIcon(): void {}

// Obsidian's per-editor info (which note an editor shows).
import { StateField } from "@codemirror/state";
export const editorInfoField = StateField.define<{ file: unknown } | null>({
	create: () => null,
	update: (value) => value,
});

export class MarkdownView {}
