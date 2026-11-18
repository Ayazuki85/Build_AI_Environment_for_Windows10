const STATUS_LABELS: Record<string, string> = {
	pending: "等待中",
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	aborted: "已中止",
	unknown: "未知",
};

/** Translate display text only; persisted statuses and protocol values stay unchanged. */
export function formatStatus(status: string): string {
	return STATUS_LABELS[status] ?? status;
}

export function formatAgentSource(source: string): string {
	switch (source) {
		case "user": return "用户";
		case "project": return "项目";
		case "unknown": return "未知";
		default: return source;
	}
}

export function formatAgentScope(scope: string): string {
	return scope === "both" ? "用户和项目" : formatAgentSource(scope);
}

export function formatStopReason(reason: string): string {
	switch (reason) {
		case "pending": return "等待中";
		case "stop":
		case "end": return "已结束";
		case "length": return "长度限制";
		case "toolUse": return "工具调用";
		case "error": return "错误";
		case "aborted": return "已中止";
		case "deferred": return "已延后";
		default: return reason;
	}
}
