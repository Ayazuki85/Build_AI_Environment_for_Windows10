export const MAX_COMMAND_VIEWPORT_HEIGHT = 3;

export function getCommandPage(
	lines: readonly string[],
	scrollTop: number,
	viewportHeight = MAX_COMMAND_VIEWPORT_HEIGHT,
): string[] {
	const height = Math.max(0, Math.trunc(viewportHeight));
	const start = Math.max(0, Math.trunc(scrollTop));
	return Array.from({ length: height }, (_, index) => lines[start + index] ?? "");
}
