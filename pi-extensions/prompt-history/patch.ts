export const PATCH_MARK = "__promptHistoryPatched";
export const SEED_MARK = "__promptHistorySeeded";

const DEFAULT_SEED_LIMIT = 100;

export interface PatchDeps {
	append: (text: string) => void;
	recent: (limit: number) => string[];
	seedLimit?: number;
}

type AnyEditor = Record<string | symbol, any>;

export function installPatch(editorProto: AnyEditor | undefined | null, deps: PatchDeps): boolean {
	if (editorProto == null) return false;
	if (editorProto[PATCH_MARK]) return true;
	const originalAdd = editorProto.addToHistory;
	if (typeof originalAdd !== "function") return false;
	const originalNavigate = editorProto.navigateHistory;

	editorProto.addToHistory = function (this: AnyEditor, text: string): void {
		originalAdd.call(this, text);
		try {
			deps.append(text);
		} catch {
			// persistence must never break input
		}
	};

	if (typeof originalNavigate === "function") {
		const limit = deps.seedLimit ?? DEFAULT_SEED_LIMIT;
		editorProto.navigateHistory = function (this: AnyEditor, direction: number): unknown {
			if (!this[SEED_MARK]) {
				this[SEED_MARK] = true;
				try {
					const live = this.history;
					if (Array.isArray(live)) {
						const liveSet = new Set<string>(live);
						const older = deps.recent(limit).filter((t) => !liveSet.has(t));
						// 旧→新的 older 反序（新→旧）尾插：导航索引递增方向即由新到旧
						for (let i = older.length - 1; i >= 0; i--) live.push(older[i]);
						if (live.length > limit) live.length = limit;
					}
				} catch {
					// seeding failure must not break navigation
				}
			}
			return originalNavigate.call(this, direction);
		};
	}

	editorProto[PATCH_MARK] = true;
	return true;
}
