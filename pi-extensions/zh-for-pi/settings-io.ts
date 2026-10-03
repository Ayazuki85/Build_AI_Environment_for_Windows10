/**
 * settings-io.ts — 读写全局 ~/.pi/agent/settings.json
 *
 * 纯 Node 实现，不 import 任何 pi 包，可用 node --test 直接测试。
 * settings.json 的路径由调用方注入（index.ts 用 getAgentDir() 定位）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SettingsObject = Record<string, unknown>;

export interface LoadResult {
	/** 解析后的设置对象；文件缺失或损坏时为 {} */
	settings: SettingsObject;
	/** JSON 解析失败或顶层不是对象时为 true（此时 settings 为 {}） */
	corrupted: boolean;
	/** 损坏文件被备份到的路径（仅 corrupted 时有值） */
	backupPath?: string;
}

/** 文件系统安全的时间戳：2026-08-27T10-30-00 */
function timestamp(): string {
	return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

/** 加载 settings.json；不存在按空配置，损坏时备份后按空配置（不丢用户原文件） */
export function loadSettings(settingsPath: string): LoadResult {
	if (!existsSync(settingsPath)) {
		return { settings: {}, corrupted: false };
	}
	const raw = readFileSync(settingsPath, "utf-8");
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("settings.json 顶层不是对象");
		}
		return { settings: parsed as SettingsObject, corrupted: false };
	} catch {
		const backupPath = `${settingsPath}.bak-${timestamp()}`;
		copyFileSync(settingsPath, backupPath);
		return { settings: {}, corrupted: true, backupPath };
	}
}

/** 原子写保存：写前备份 .bak，同目录临时文件 + rename，失败不破坏原文件 */
export function saveSettings(settingsPath: string, settings: SettingsObject): void {
	mkdirSync(dirname(settingsPath), { recursive: true });
	if (existsSync(settingsPath)) {
		copyFileSync(settingsPath, `${settingsPath}.bak`);
	}
	const tmpPath = join(dirname(settingsPath), `.settings.json.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
	renameSync(tmpPath, settingsPath);
}

/** 按段数组路径读取嵌套字段；路径穿过非对象或缺失时返回 undefined */
export function getByPath(obj: SettingsObject, path: string[]): unknown {
	let current: unknown = obj;
	for (const key of path) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as SettingsObject)[key];
	}
	return current;
}

/** 按段数组路径写入；自动创建中间对象，替换冲突的非对象中间值 */
export function setByPath(obj: SettingsObject, path: string[], value: unknown): void {
	let current = obj;
	for (const key of path.slice(0, -1)) {
		const next = current[key];
		if (next === null || typeof next !== "object" || Array.isArray(next)) {
			current[key] = {};
		}
		current = current[key] as SettingsObject;
	}
	current[path[path.length - 1]] = value;
}

/** 按段数组路径删除；键不存在时无操作 */
export function deleteByPath(obj: SettingsObject, path: string[]): void {
	let current: unknown = obj;
	for (const key of path.slice(0, -1)) {
		if (current === null || typeof current !== "object") return;
		current = (current as SettingsObject)[key];
	}
	if (current !== null && typeof current === "object") {
		delete (current as SettingsObject)[path[path.length - 1]];
	}
}
