// Explicit any is intentional: private Pi methods have incompatible signatures, but each call site
// supplies a precise PatchFunction subtype and keeps its own argument checking.
export type PatchFunction = (...args: any[]) => any;

export interface SharedPatchState<T extends PatchFunction = PatchFunction> {
	active: boolean;
	original: T;
	wrapper: T;
}

export function installSharedPatch<T extends PatchFunction>(
	target: Record<PropertyKey, unknown>,
	method: PropertyKey,
	stateKey: symbol,
	createWrapper: (original: T, state: SharedPatchState<T>) => T,
): SharedPatchState<T> {
	const existing = Reflect.get(target, stateKey) as SharedPatchState<T> | undefined;
	if (existing) {
		existing.active = true;
		// A previous shutdown restored stock. Reattach the one shared wrapper. If another extension
		// currently wraps ours, leave that outer function intact.
		if (Reflect.get(target, method) === existing.original) Reflect.set(target, method, existing.wrapper);
		return existing;
	}

	const original = Reflect.get(target, method) as T;
	if (typeof original !== "function") throw new TypeError(`Cannot patch non-function ${String(method)}`);
	const state = { active: true, original, wrapper: undefined as unknown as T };
	state.wrapper = createWrapper(original, state);
	Reflect.set(target, stateKey, state);
	Reflect.set(target, method, state.wrapper);
	return state;
}

export function uninstallSharedPatch(
	target: Record<PropertyKey, unknown>,
	method: PropertyKey,
	stateKey: symbol,
): void {
	const state = Reflect.get(target, stateKey) as SharedPatchState | undefined;
	if (!state?.active) return;
	state.active = false;
	// Do not remove a wrapper another extension placed above ours. Ours now passes through because
	// state.active is false, and a later install can reactivate that same shared wrapper.
	if (Reflect.get(target, method) === state.wrapper) Reflect.set(target, method, state.original);
}
