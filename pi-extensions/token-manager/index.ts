/**
 * Token Manager：Kimi For Coding 用量 + DeepSeek 余额 + 阿里云 Token Plan 坐席管理扩展
 *
 * 功能：
 * - 状态栏跟随当前模型：Kimi 模型显示 5 小时/7 天套餐用量，DeepSeek 模型显示账户余额
 * - `/token-manager` 打开三页管理界面（←→ 翻页）：第 1 页 Kimi 多 key 池管理，第 2 页 DeepSeek 余额，第 3 页 Token Plan 坐席
 * - 当前启用项每 3 分钟自动刷新
 *
 * 数据文件：<agentDir>/extensions/token-manager/token-manager.keys.json（Kimi 池 + aliyun AccessKey 配置）
 * 用量协议：GET https://api.kimi.com/coding/v1/usages + Bearer（Kimi）
 *           GET https://api.deepseek.com/user/balance + Bearer（DeepSeek）
 */

import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

// ── 常量 ────────────────────────────────────────────────────

const KIMI_PROVIDER_ID = "kimi-coding";
const KIMI_BASE_PATTERN = /api\.kimi\.com\/coding/i;
const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages";
const DS_PROVIDER_ID = "deepseek";
const DS_BASE_PATTERN = /api\.deepseek\.com/i;
const DS_BALANCE_URL = "https://api.deepseek.com/user/balance";
const STATUS_ID = "token-manager";
const POLL_MS = 3 * 60 * 1000;
const WARN_PCT = 80;
const CRIT_PCT = 95;
/** DeepSeek 余额警告阈值（数值，不分币种；国内账户即人民币元） */
const DS_WARN_BALANCE = 10;
const DS_CRIT_BALANCE = 5;
const FETCH_TIMEOUT_MS = 15_000;

const ADD_ACTION = "＋ 添加新 key";
const REMOVE_ACTION = "－ 删除 key…";
const RENAME_ACTION = "✎ 重命名备注…";
const VIEW_ACTION = "👁 查看 key 明文";
const REFRESH_ACTION = "⟳ 刷新用量";
const DS_REFRESH_ACTION = "⟳ 刷新余额";
const ALI_PROVIDER_ID = "qwen-token-plan-cn";
const ALI_BASE_PATTERN = /token-plan\..*aliyuncs\.com/i;
const ALI_REFRESH_ACTION = "⟳ 刷新用量";
const ALI_CONFIG_ACTION = "⚙ 配置AccessKey";
const ALI_BIND_ACTION = "⇄ 绑定/换绑坐席";
const ALI_VIEW_ACTION = "👁 查看AK明文";

// ── 阿里云 Token Plan 坐席查询（签名 / XML 解析 / 分页拉取）─────────
//
// API：GET https://modelstudio.cn-beijing.aliyuncs.com/tokenplan/subscription/seat-detail
// 鉴权：阿里云 API Gateway（ROA）HMAC-SHA1 签名，Authorization: acs {AK}:{base64(sig)}
// 响应：XML（SeatDetailResponse > Data > Items > Item）
// 注意：非官方公开文档接口（社区验证 2026-08），解析保持容错

export const ENDPOINT = "https://modelstudio.cn-beijing.aliyuncs.com";
export const SEAT_DETAIL_PATH = "/tokenplan/subscription/seat-detail";
export const PAGE_SIZE = 20;

export interface AliyunCredential {
	accessKeyId: string;
	accessKeySecret: string;
}

export interface SeatUsage {
	seatId: string;
	accountName: string;
	specType: string; // standard / pro / max …
	status: string; // NORMAL / RELEASE
	assigned: string; // ASSIGNED / UNASSIGNED
	total: number; // 周期总额度 Credits
	surplus: number; // 周期剩余 Credits
	cycleStart?: number; // ms 时间戳
	cycleEnd?: number; // ms 时间戳
}

export interface SeatQuery {
	seats?: SeatUsage[];
	invalid?: boolean; // 401/403 或签名/AK 类错误
	error?: string; // 网络/HTTP/解析错误
	queriedAt: number;
}

/** 阿里云 API Gateway（ROA）签名头。date 可注入便于测试，默认当前 GMT 时间 */
export function acsSignHeaders(
	method: string,
	path: string,
	params: Record<string, string>,
	cred: AliyunCredential,
	date: string = new Date().toUTCString(),
): Record<string, string> {
	const qs = Object.keys(params)
		.sort()
		.map((k) => `${k}=${params[k]}`)
		.join("&");
	const resource = qs ? `${path}?${qs}` : path;
	const stringToSign = `${method}\n*/*\n\n\n${date}\n${resource}`;
	const sig = createHmac("sha1", cred.accessKeySecret).update(stringToSign).digest("base64");
	return {
		Date: date,
		Accept: "*/*",
		Authorization: `acs ${cred.accessKeyId}:${sig}`,
	};
}

/** 千分位整数字符串（18432 → "18,432"）；NaN/Infinity 兜底 "0" */
export function fmtCredits(n: number): string {
	if (!Number.isFinite(n)) return "0";
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 已用百分比（0-100，钳制）；total<=0 防除零返回 0 */
export function seatUsedPct(seat: SeatUsage): number {
	if (seat.total <= 0) return 0;
	// 先乘后除，避免 (6568/25000*100) 出现 26.272000000000002 浮点误差
	return Math.min(100, Math.max(0, ((seat.total - seat.surplus) * 100) / seat.total));
}

// ── XML 极简提取（结构固定，不引第三方依赖；缺失节点返回空值而非抛错）──

function tagText(xml: string, tag: string): string | undefined {
	const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
	return m ? m[1].trim() : undefined;
}

/** 取所有 <tag>…</tag> 块；<Item> 不会误配 <Items>（要求字面闭合标签） */
function tagBlocks(xml: string, tag: string): string[] {
	return xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g")) ?? [];
}

/** 网关错误码：出现即视为凭证/签名问题 */
const INVALID_CODES = ["InvalidAccessKeyId", "SignatureDoesNotMatch", "Forbidden", "Unauthorized"];

/** 纯函数：HTTP 状态 + XML 文本 → SeatQuery */
export function seatUsageFromXml(status: number, xml: string): SeatQuery {
	const queriedAt = Date.now();
	if (status === 401 || status === 403) return { invalid: true, queriedAt };
	if (status !== 200) {
		if (INVALID_CODES.some((c) => xml.includes(c))) return { invalid: true, queriedAt };
		return { error: `HTTP ${status}`, queriedAt };
	}
	const data = tagBlocks(xml, "Data")[0];
	if (!data) {
		if (INVALID_CODES.some((c) => xml.includes(c))) return { invalid: true, queriedAt };
		return { error: "响应中无席位数据", queriedAt };
	}
	const num = (v: string | undefined): number => {
		const n = v === undefined ? NaN : Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const ms = (v: string | undefined): number | undefined => {
		const n = v === undefined ? NaN : Number(v);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	const seats: SeatUsage[] = tagBlocks(data, "Item").map((item) => {
		const eq = tagBlocks(item, "Equity").find((e) => tagText(e, "EquityType") === "CREDITS");
		return {
			seatId: tagText(item, "SeatId") ?? "",
			accountName: tagText(item, "AccountName") ?? "",
			specType: tagText(item, "SpecType") ?? "",
			status: tagText(item, "Status") ?? "",
			assigned: tagText(item, "AssignedStatus") ?? "",
			total: num(eq && tagText(eq, "CycleTotalValue")),
			surplus: num(eq && tagText(eq, "CycleSurplusValue")),
			cycleStart: ms(eq && tagText(eq, "CycleStartTime")),
			cycleEnd: ms(eq && tagText(eq, "CycleEndTime")),
		};
	});
	return { seats, queriedAt };
}

/** 分页拉取全部坐席用量；任一页出错即返回该错误 */
export async function fetchSeatUsage(cred: AliyunCredential): Promise<SeatQuery> {
	const all: SeatUsage[] = [];
	for (let page = 1; ; page++) {
		const params: Record<string, string> = { PageNo: String(page), PageSize: String(PAGE_SIZE) };
		const qs = Object.keys(params)
			.sort()
			.map((k) => `${k}=${params[k]}`)
			.join("&");
		let res: Response;
		try {
			res = await fetch(`${ENDPOINT}${SEAT_DETAIL_PATH}?${qs}`, {
				headers: acsSignHeaders("GET", SEAT_DETAIL_PATH, params, cred),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (e) {
			return { error: `网络错误: ${e instanceof Error ? e.message : String(e)}`, queriedAt: Date.now() };
		}
		const q = seatUsageFromXml(res.status, await res.text());
		if (q.invalid || q.error) return q;
		const batch = q.seats ?? [];
		all.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	return { seats: all, queriedAt: Date.now() };
}

// ── 类型 ────────────────────────────────────────────────────

export interface WindowUsage {
	pct: number; // 0-100 利用率
	resetsAt?: string; // ISO 8601
}

export interface KeyUsage {
	fiveHour?: WindowUsage;
	weekly?: WindowUsage;
	invalid?: boolean; // 401/403
	error?: string; // 网络/HTTP 错误
	queriedAt?: number;
}

// ── 格式化 ──────────────────────────────────────────────────

/** 显示宽度（CJK 记 2） */
export function dw(s: string): number {
	let w = 0;
	for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
	return w;
}

export function padEnd(s: string, width: number): string {
	const pad = width - dw(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}

export function fmtPct(pct: number): string {
	return `${String(Math.round(pct)).padStart(3)}%`;
}

export function fmtCountdown(resetsAt?: string): string {
	if (!resetsAt) return "";
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const d = Math.floor(ms / 86_400_000);
	const h = Math.floor((ms % 86_400_000) / 3_600_000);
	const m = Math.max(1, Math.floor((ms % 3_600_000) / 60_000));
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

// ── Kimi 用量窗口解析 ───────────────────────────────────────

export function parseWindow(detail: unknown): WindowUsage | undefined {
	if (!detail || typeof detail !== "object") return undefined;
	const d = detail as Record<string, unknown>;
	const num = (v: unknown): number | undefined => {
		if (typeof v === "number") return v;
		if (typeof v === "string") {
			const n = Number(v);
			return Number.isFinite(n) ? n : undefined;
		}
		return undefined;
	};
	const limit = num(d.limit);
	const remaining = num(d.remaining);
	if (limit === undefined || remaining === undefined) return undefined;
	const pct = Math.min(100, Math.max(0, ((limit - remaining) / (limit > 0 ? limit : 1)) * 100));
	let resetsAt: string | undefined;
	const rt = d.resetTime;
	if (typeof rt === "string") resetsAt = rt;
	else if (typeof rt === "number" && rt > 0) {
		const ms = rt < 1_000_000_000_000 ? rt * 1000 : rt;
		resetsAt = new Date(ms).toISOString();
	}
	return { pct, resetsAt };
}

// ── 凭据与池类型 ────────────────────────────────────────────

/** 与 auth.json 凭据格式一致；OAuth 条目整存整取（含 refresh/expires） */
export type Credential =
	| { type: "api_key"; key: string; env?: Record<string, string> }
	| { type: "oauth"; access: string; refresh: string; expires: number };

export interface PoolKey {
	id: string;
	label: string;
	credential: Credential;
}

/** 阿里云 Token Plan 查询配置（存 token-manager.keys.json 顶层 aliyun 字段） */
export interface AliyunConfig {
	accessKeyId: string;
	accessKeySecret: string;
	mySeatId?: string; // 已绑定的"我的坐席" SeatId
}

export interface Pool {
	keys: PoolKey[];
	activeId?: string;
	aliyun?: AliyunConfig;
}

// ── 路径 ────────────────────────────────────────────────────

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const authPath = join(agentDir, "auth.json");
const poolPath = join(agentDir, "extensions", "token-manager", "token-manager.keys.json");

// ── 池存储（原子写 0600）────────────────────────────────────

export function loadPoolFrom(path: string): Pool {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (raw && Array.isArray(raw.keys)) {
			const pool: Pool = { keys: raw.keys, activeId: raw.activeId };
			// aliyun 字段可选；残缺（缺 id/secret）则丢弃
			const a = raw.aliyun;
			if (a && typeof a.accessKeyId === "string" && typeof a.accessKeySecret === "string") {
				pool.aliyun = { accessKeyId: a.accessKeyId, accessKeySecret: a.accessKeySecret };
				if (typeof a.mySeatId === "string") pool.aliyun.mySeatId = a.mySeatId;
			}
			return pool;
		}
	} catch {
		// 文件不存在或损坏 → 空池
	}
	return { keys: [] };
}

export function savePoolTo(path: string, pool: Pool): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(pool, null, 2), { encoding: "utf-8", mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

const loadPool = (): Pool => loadPoolFrom(poolPath);
const savePool = (pool: Pool): void => savePoolTo(poolPath, pool);

// ── auth.json 凭据读写 ──────────────────────────────────────

/** 用于查询用量/匹配活跃账户的密钥部分：api_key → key，oauth → access */
export function credSecret(cred: Credential): string {
	return cred.type === "api_key" ? cred.key : cred.access;
}

/** 读取 auth.json 中指定 provider 的凭据（含 $env/!cmd 形式的 key 原样返回） */
export function readAuthCred(providerId: string): Credential | undefined {
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data?.[providerId];
		if (cred?.type === "api_key" && typeof cred.key === "string") return cred as Credential;
		if (
			cred?.type === "oauth" &&
			typeof cred.access === "string" &&
			typeof cred.refresh === "string" &&
			typeof cred.expires === "number"
		) {
			return cred as Credential;
		}
	} catch {
		// 无 auth.json
	}
	return undefined;
}

/** 凭据是否可直接用于 Bearer 查询（$env/!cmd 形式无法取字面值） */
export function secretOf(cred: Credential | undefined): string | undefined {
	if (!cred) return undefined;
	const s = credSecret(cred);
	if (cred.type === "api_key" && (s.startsWith("!") || s.includes("$"))) return undefined;
	return s;
}

/**
 * 热切换：整体替换 auth.json 的指定 provider 凭据，原子写回。
 * pi 的 AuthStorage 每次读取前检查文件 mtime，变更即重载，下一次请求生效。
 */
export function writeAuthCred(providerId: string, cred: Credential, path: string = authPath): void {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// 文件不存在则新建
	}
	// 合法 JSON 但非普通对象（null/标量/数组）时拒绝写入：标量会抛 TypeError、
	// 数组的命名属性会被 JSON.stringify 静默丢弃，均不得写坏原文件
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("auth.json 内容不是 JSON 对象，拒绝写入");
	}
	data[providerId] = cred;
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** 活跃 key 判定：以 auth.json 实际值反查池为准；识别不了时回退 activeId。
 *  注：OAuth 的 access 会被 pi refresh 更新导致匹配失败，此时靠 activeId 兜底。 */
function resolveActiveId(pool: Pool): string | undefined {
	const authCred = readAuthCred(KIMI_PROVIDER_ID);
	if (authCred) {
		const secret = secretOf(authCred);
		const hit = secret && pool.keys.find((k) => credSecret(k.credential) === secret);
		if (hit) return hit.id;
	}
	if (pool.activeId && pool.keys.some((k) => k.id === pool.activeId)) return pool.activeId;
	return undefined;
}

// ── Kimi 用量查询 ───────────────────────────────────────────

/** 纯函数：HTTP 状态 + 响应体 → KeyUsage（401/403 → invalid；无数据 → error） */
export function kimiUsageFromBody(status: number, body: unknown): KeyUsage {
	if (status === 401 || status === 403) return { invalid: true, queriedAt: Date.now() };
	if (status !== 200) return { error: `HTTP ${status}`, queriedAt: Date.now() };
	const usage: KeyUsage = { queriedAt: Date.now() };
	const limits = (body as Record<string, unknown> | null)?.limits;
	if (Array.isArray(limits)) {
		for (const item of limits) {
			const detail = (item as Record<string, unknown> | null)?.detail;
			const win = parseWindow(detail);
			if (win) {
				usage.fiveHour = win;
				break;
			}
		}
	}
	const weekly = parseWindow((body as Record<string, unknown> | null)?.usage);
	if (weekly) usage.weekly = weekly;
	if (!usage.fiveHour && !usage.weekly) usage.error = "响应中无用量数据";
	return usage;
}

export async function fetchKimiUsage(apiKey: string): Promise<KeyUsage> {
	let res: Response;
	try {
		res = await fetch(KIMI_USAGES_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (e) {
		return { error: `网络错误: ${e instanceof Error ? e.message : String(e)}`, queriedAt: Date.now() };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	if (res.ok && body === undefined) return { error: "响应解析失败", queriedAt: Date.now() };
	return kimiUsageFromBody(res.status, body);
}

// ── 中文选择器（内置 ctx.ui.select 的提示行是硬编码英文，这里用
//    ctx.ui.custom 自绘同款列表，提示行汉化；外观与内置选择器一致）──

/** 返回选中项下标；Esc/Ctrl+C 取消返回 undefined。返回下标而非文本，避免重名 label 反查错配 */
function selectZh(ctx: ExtensionContext, title: string, options: string[]): Promise<number | undefined> {
	return ctx.ui.custom<number | undefined>((_tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		const border = () => new DynamicBorder((s: string) => theme.fg("border", s));
		const container = new Container();
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Spacer(1));
		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ 移动 · Enter 选择 · Esc 取消"), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(border());

		const updateList = () => {
			listContainer.clear();
			for (let i = 0; i < options.length; i++) {
				const selected = i === selectedIndex;
				const text = selected
					? theme.fg("accent", "→ ") + theme.fg("accent", options[i])
					: `  ${theme.fg("text", options[i])}`;
				listContainer.addChild(new Text(text, 1, 0));
			}
		};
		updateList();

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (options.length === 0) {
					done(undefined);
					return;
				}
				if (data === "\x1b[A" || data === "k") {
					selectedIndex = Math.max(0, selectedIndex - 1);
					updateList();
				} else if (data === "\x1b[B" || data === "j") {
					selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
					updateList();
				} else if (data === "\r" || data === "\n") {
					done(selectedIndex);
				} else if (data === "\x1b" || data === "\x03") {
					done(undefined);
				}
			},
		};
	});
}

// ── 分页器（三页：Kimi / DeepSeek / Token Plan；←→ 翻页在组件内完成，
//    Enter 关闭并返回所选，动作由外层执行后重开——不嵌套模态）──

export interface PagerPage {
	title: string; // 页名（标题栏显示）
	header: string[]; // 只读信息行（不可选）
	options: string[]; // 可选条目
}

export interface PagerResult {
	page: number; // 0 起页码
	index: number; // 该页 options 下标
	option: string;
}

function pagerZh(ctx: ExtensionContext, pages: PagerPage[], initialPage: number): Promise<PagerResult | undefined> {
	return ctx.ui.custom<PagerResult | undefined>((_tui, theme, _keybindings, done) => {
		let pageIdx = Math.min(Math.max(0, initialPage), Math.max(0, pages.length - 1));
		let selIdx = 0;
		const border = () => new DynamicBorder((s: string) => theme.fg("border", s));
		const container = new Container();
		const titleContainer = new Container();
		const headerContainer = new Container();
		const listContainer = new Container();
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(titleContainer);
		container.addChild(new Spacer(1));
		container.addChild(headerContainer);
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ 移动 · ←→ 翻页 · Enter 选择 · Esc 退出"), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(border());

		const rebuild = () => {
			const p = pages[pageIdx];
			selIdx = Math.min(selIdx, Math.max(0, p.options.length - 1));
			titleContainer.clear();
			titleContainer.addChild(
				new Text(theme.fg("accent", theme.bold(`Token Manager · ${p.title} (${pageIdx + 1}/${pages.length})`)), 1, 0),
			);
			headerContainer.clear();
			for (const line of p.header) headerContainer.addChild(new Text(theme.fg("text", line), 1, 0));
			if (p.header.length > 0) headerContainer.addChild(new Spacer(1));
			listContainer.clear();
			for (let i = 0; i < p.options.length; i++) {
				const selected = i === selIdx;
				const text = selected
					? theme.fg("accent", "→ ") + theme.fg("accent", p.options[i])
					: `  ${theme.fg("text", p.options[i])}`;
				listContainer.addChild(new Text(text, 1, 0));
			}
		};
		rebuild();

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const p = pages[pageIdx];
				if (data === "\x1b[D" || data === "h") {
					pageIdx = flipPage(pageIdx, -1, pages.length);
					selIdx = 0;
					rebuild();
				} else if (data === "\x1b[C" || data === "l") {
					pageIdx = flipPage(pageIdx, 1, pages.length);
					selIdx = 0;
					rebuild();
				} else if (data === "\x1b[A" || data === "k") {
					selIdx = Math.max(0, selIdx - 1);
					rebuild();
				} else if (data === "\x1b[B" || data === "j") {
					selIdx = Math.min(p.options.length - 1, selIdx + 1);
					rebuild();
				} else if (data === "\r" || data === "\n") {
					const opt = p.options[selIdx];
					if (opt !== undefined) done({ page: pageIdx, index: selIdx, option: opt });
				} else if (data === "\x1b" || data === "\x03") {
					done(undefined);
				}
			},
		};
	});
}

// ── 主逻辑 ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	let pool: Pool = loadPool();
	const usageMap = new Map<string, KeyUsage>();
	let dsBalance: DeepSeekBalance | undefined;
	let lastCtx: ExtensionContext | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let kimiRefreshing = false;
	let dsRefreshing = false;
	let aliQuery: SeatQuery | undefined;
	let aliRefreshing = false;

	function isKimiModel(model: { provider?: string; baseUrl?: string } | undefined | null): boolean {
		if (!model) return false;
		return model.provider === KIMI_PROVIDER_ID || KIMI_BASE_PATTERN.test(model.baseUrl ?? "");
	}

	function isDeepSeekModel(model: { provider?: string; baseUrl?: string } | undefined | null): boolean {
		if (!model) return false;
		return model.provider === DS_PROVIDER_ID || DS_BASE_PATTERN.test(model.baseUrl ?? "");
	}

	function isAliyunModel(model: { provider?: string; baseUrl?: string } | undefined | null): boolean {
		if (!model) return false;
		return model.provider === ALI_PROVIDER_ID || ALI_BASE_PATTERN.test(model.baseUrl ?? "");
	}

	/** 首次运行：池为空时把 auth.json 现有 kimi 凭据导入池 */
	function seedImport(): void {
		if (pool.keys.length > 0) return;
		const cred = readAuthCred(KIMI_PROVIDER_ID);
		if (!cred || !secretOf(cred)) return;
		const id = `k${Date.now()}`;
		const label = cred.type === "oauth" ? "当前登录(OAuth)" : "默认";
		pool = { keys: [{ id, label, credential: cred }], activeId: id };
		savePool(pool);
	}

	// ── 刷新 ────────────────────────────────────────────────

	async function refreshAll(): Promise<void> {
		if (pool.keys.length === 0) return;
		if (kimiRefreshing) {
			if (lastCtx?.hasUI) lastCtx.ui.notify("上一次刷新尚未完成，请稍候再试", "warning");
			return;
		}
		kimiRefreshing = true;
		try {
			const results = await Promise.all(pool.keys.map((k) => fetchKimiUsage(credSecret(k.credential))));
			pool.keys.forEach((k, i) => usageMap.set(k.id, results[i]));
		} finally {
			kimiRefreshing = false;
		}
		render();
		if (lastCtx?.hasUI) {
			const failed = pool.keys.filter((k) => {
				const u = usageMap.get(k.id);
				return u?.invalid || (u?.error && !u.fiveHour && !u.weekly);
			});
			if (failed.length === 0) {
				lastCtx.ui.notify("API keys的状态刷新完成！", "info");
			} else {
				const names = failed.map((k) => `「${k.label}」`).join("、");
				lastCtx.ui.notify(`刷新完成，但 ${names} 查询失败（key 无效或网络/HTTP 错误）`, "warning");
			}
		}
	}

	/** 定时轮询只刷当前启用的 key；备用 key 靠打开 /token-manager 时的 refreshAll */
	async function refreshActive(): Promise<void> {
		if (kimiRefreshing) return;
		const activeId = resolveActiveId(pool);
		const activeKey = pool.keys.find((k) => k.id === activeId);
		if (!activeKey) return;
		kimiRefreshing = true;
		try {
			usageMap.set(activeKey.id, await fetchKimiUsage(credSecret(activeKey.credential)));
		} finally {
			kimiRefreshing = false;
		}
		render();
	}

	async function refreshDeepSeek(): Promise<void> {
		if (dsRefreshing) return;
		dsRefreshing = true;
		try {
			const cred = readAuthCred(DS_PROVIDER_ID);
			if (!cred) {
				dsBalance = { isAvailable: false, currency: "", total: 0, granted: 0, toppedUp: 0, noKey: true, queriedAt: Date.now() };
			} else {
				const secret = secretOf(cred);
				if (!secret) {
					dsBalance = { isAvailable: false, currency: "", total: 0, granted: 0, toppedUp: 0, noSecret: true, queriedAt: Date.now() };
				} else {
					dsBalance = await fetchDeepSeekBalance(secret);
				}
			}
		} finally {
			dsRefreshing = false;
		}
		render();
	}

	async function refreshAliyun(): Promise<void> {
		if (aliRefreshing) return;
		const cred = pool.aliyun;
		if (!cred) {
			aliQuery = undefined;
			render();
			return;
		}
		aliRefreshing = true;
		try {
			aliQuery = await fetchSeatUsage({ accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret });
		} finally {
			aliRefreshing = false;
		}
		render();
	}

	// ── 状态栏渲染 ────────────────────────────────────────────

	function usageText(u: KeyUsage | undefined): { five: string; week: string; bad: boolean; exhausted: boolean } {
		if (!u) return { five: "5h:  — ", week: "7d:  — ", bad: false, exhausted: false };
		if (u.invalid) return { five: "5h:无效key", week: "7d:无效key", bad: true, exhausted: false };
		if (u.error && !u.fiveHour && !u.weekly)
			return { five: "5h:查询失败", week: "7d:查询失败", bad: true, exhausted: false };
		const fmtWin = (w?: WindowUsage) => {
			if (!w) return "  — ";
			const cd = fmtCountdown(w.resetsAt);
			return cd ? `${fmtPct(w.pct)} ${cd}` : fmtPct(w.pct);
		};
		const exhausted = (u.fiveHour?.pct ?? 0) >= 100 || (u.weekly?.pct ?? 0) >= 100;
		return { five: `5h:${fmtWin(u.fiveHour)}`, week: `7d:${fmtWin(u.weekly)}`, bad: false, exhausted };
	}

	function render(): void {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;

		if (isKimiModel(ctx.model)) {
			const activeId = resolveActiveId(pool);
			if (pool.keys.length === 0) {
				ctx.ui.setStatus(STATUS_ID, theme.fg("dim", "当前用量 暂无 key · /token-manager 添加"));
				return;
			}
			const activeKey = pool.keys.find((k) => k.id === activeId);
			if (!activeKey) {
				ctx.ui.setStatus(STATUS_ID, theme.fg("dim", "当前用量 未选择 key · /token-manager 切换"));
				return;
			}
			const u = usageMap.get(activeKey.id);
			const t = usageText(u);
			const paint = (txt: string, pct?: number) => {
				if (t.bad) return theme.fg("error", txt);
				if (pct !== undefined && pct >= CRIT_PCT) return theme.fg("error", txt);
				if (pct !== undefined && pct >= WARN_PCT) return theme.fg("warning", txt);
				return theme.fg("dim", txt);
			};
			const five = paint(t.five, u?.fiveHour?.pct);
			const week = paint(t.week, u?.weekly?.pct);
			const tag = t.exhausted ? theme.fg("error", " ⛔已达限额") : "";
			ctx.ui.setStatus(STATUS_ID, `${theme.fg("dim", "当前用量")} ${five} ${week}${tag}`);
			return;
		}

		if (isDeepSeekModel(ctx.model)) {
			const txt = balanceStatusText(dsBalance);
			const lv = dsBalance ? balanceLevel(dsBalance) : "ok";
			const painted = lv === "crit" ? theme.fg("error", txt) : lv === "warn" ? theme.fg("warning", txt) : theme.fg("dim", txt);
			ctx.ui.setStatus(STATUS_ID, painted);
			return;
		}

		if (isAliyunModel(ctx.model)) {
			const s = aliyunStatusText(pool.aliyun, aliQuery);
			const painted =
				s.bad || (s.pct !== undefined && s.pct >= CRIT_PCT)
					? theme.fg("error", s.text)
					: s.pct !== undefined && s.pct >= WARN_PCT
						? theme.fg("warning", s.text)
						: theme.fg("dim", s.text);
			const tag = s.exhausted ? theme.fg("error", " ⛔已达限额") : "";
			ctx.ui.setStatus(STATUS_ID, painted + tag);
			return;
		}

		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	// ── 轮询（单一定时器，按当前模型刷新对应 provider）─────────

	function tick(): void {
		if (isKimiModel(lastCtx?.model)) void refreshActive();
		else if (isDeepSeekModel(lastCtx?.model)) void refreshDeepSeek();
		else if (isAliyunModel(lastCtx?.model)) void refreshAliyun();
	}

	function startPolling(): void {
		stopPolling();
		pollTimer = setInterval(tick, POLL_MS);
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	function syncVisibility(model: { provider?: string; baseUrl?: string } | undefined): void {
		if (isKimiModel(model)) {
			render();
			void refreshActive();
			startPolling();
		} else if (isDeepSeekModel(model)) {
			render();
			void refreshDeepSeek();
			startPolling();
		} else if (isAliyunModel(model)) {
			render();
			void refreshAliyun();
			startPolling();
		} else {
			stopPolling();
			lastCtx?.ui.setStatus(STATUS_ID, undefined);
		}
	}

	// ── 页面构建 ──────────────────────────────────────────────

	function buildKimiPage(): { page: PagerPage; keyIds: (string | null)[] } {
		const activeId = resolveActiveId(pool);
		const labelWidth = pool.keys.length > 0 ? Math.max(...pool.keys.map((k) => dw(k.label))) : 0;
		const options: string[] = [];
		const keyIds: (string | null)[] = [];

		pool.keys.forEach((k, i) => {
			const active = k.id === activeId;
			const t = usageText(usageMap.get(k.id));
			const parts = [
				`${i + 1}.`,
				active ? "●" : "○",
				padEnd(k.label, labelWidth),
				t.five.padEnd(14),
				t.week.padEnd(14),
			];
			if (active) parts.push("← 当前生效");
			else if (t.exhausted) parts.push("已达限额");
			else if (t.bad) parts.push("");
			options.push(parts.join(" ").trimEnd());
			keyIds.push(k.id);
		});

		options.push(ADD_ACTION, REMOVE_ACTION, RENAME_ACTION, REFRESH_ACTION, VIEW_ACTION);
		keyIds.push(null, null, null, null, null);

		const header: string[] = [];
		if (pool.keys.length === 0) header.push("暂无 key · 选择下方「添加新 key」");
		return { page: { title: "Kimi 用量", header, options }, keyIds };
	}

	function buildDeepSeekPage(): PagerPage {
		const b = dsBalance;
		const header: string[] = [];
		if (!b) {
			header.push("余额: 尚未查询");
		} else if (b.noKey) {
			header.push("未在 auth.json 配置 deepseek 凭据");
		} else if (b.noSecret) {
			header.push("key 为 $env/!cmd 引用形式，无法直接查询");
		} else if (b.invalid) {
			header.push("key 无效（401/403）");
		} else if (b.error) {
			header.push(`查询失败: ${b.error}`);
		} else {
			header.push(`余额: ${fmtMoney(b.total, b.currency)}（赠金 ${fmtMoney(b.granted, b.currency)} · 充值 ${fmtMoney(b.toppedUp, b.currency)}）`);
			header.push(`状态: ${b.isAvailable ? "可用" : "不可用（余额不足）"}`);
			header.push(`查询时间: ${fmtDateTime(b.queriedAt)}`);
		}
		header.push("key 来源: auth.json 的 deepseek 凭据");
		return { title: "DeepSeek 余额", header, options: [DS_REFRESH_ACTION, VIEW_ACTION] };
	}

	/** AK 脱敏：前 4 后 4 */
	function maskAk(ak: string): string {
		return ak.length <= 8 ? "****" : `${ak.slice(0, 4)}****${ak.slice(-4)}`;
	}

	function buildAliyunPage(): PagerPage {
		const header: string[] = [];
		const cfg = pool.aliyun;
		if (!cfg) {
			header.push("未配置 AccessKey · 选择下方「配置AccessKey」");
			header.push("需要 Token Plan 购买者的 RAM AccessKey（建议只读权限）");
		} else {
			const q = aliQuery;
			if (q?.invalid) {
				header.push("AK 无效或权限不足（401/403/签名错误）");
			} else if (q?.error) {
				header.push(`查询失败: ${q.error}`);
			} else if (!q) {
				header.push("尚未查询");
			} else {
				const seat = q.seats?.find((s) => s.seatId === cfg.mySeatId);
				if (!cfg.mySeatId) {
					header.push(`查询成功，共 ${q.seats?.length ?? 0} 个坐席 · 请绑定我的坐席`);
				} else if (!seat) {
					header.push("绑定的坐席已失效（被回收？）· 请换绑");
				} else {
					header.push(
						`坐席: ${seat.accountName || "(未命名)"} · 规格 ${seat.specType || "-"} · ${seat.status}/${seat.assigned}`,
					);
					header.push(
						`额度: 已用 ${fmtCredits(seat.total - seat.surplus)} / ${fmtCredits(seat.total)}（${Math.round(seatUsedPct(seat))}%）· 剩余 ${fmtCredits(seat.surplus)} Credits`,
					);
					if (seat.cycleStart && seat.cycleEnd) {
						header.push(`周期: ${fmtDateTime(seat.cycleStart).slice(0, 11)} ~ ${fmtDateTime(seat.cycleEnd).slice(0, 11)}`);
					}
					header.push(`查询时间: ${fmtDateTime(q.queriedAt)}`);
				}
			}
			header.push(`AK: ${maskAk(cfg.accessKeyId)}`);
		}
		return { title: "Token Plan 坐席", header, options: [ALI_REFRESH_ACTION, ALI_CONFIG_ACTION, ALI_BIND_ACTION, ALI_VIEW_ACTION] };
	}

	// ── Kimi 操作流 ───────────────────────────────────────────

	async function addKeyFlow(ctx: ExtensionContext): Promise<void> {
		const label = await ctx.ui.input("新 key 的备注名（如：主号/副号）：", "备注名");
		if (label === undefined) return;
		const key = await ctx.ui.input("API key（明文回显，注意周围人）：", "sk-...");
		if (key === undefined) return;
		const trimmed = key.trim();
		if (!trimmed) {
			ctx.ui.notify("key 为空，已取消", "warning");
			return;
		}
		if (pool.keys.some((k) => k.credential.type === "api_key" && k.credential.key === trimmed)) {
			ctx.ui.notify("该 key 已在池中", "warning");
			return;
		}
		const id = `k${Date.now()}`;
		pool.keys.push({
			id,
			label: label.trim() || `key-${pool.keys.length + 1}`,
			credential: { type: "api_key", key: trimmed },
		});
		savePool(pool);
		ctx.ui.notify(`已添加「${pool.keys[pool.keys.length - 1].label}」`, "info");
		usageMap.set(id, await fetchKimiUsage(trimmed));
	}

	/** 弹出 key 列表供选择；按下标取 key，重名 label 也不会误选 */
	async function pickKey(ctx: ExtensionContext, title: string): Promise<PoolKey | undefined> {
		if (pool.keys.length === 0) {
			ctx.ui.notify("池为空", "warning");
			return undefined;
		}
		const options = pool.keys.map((k, i) => `${i + 1}. ${k.label}`);
		const idx = await selectZh(ctx, title, options);
		if (idx === undefined) return undefined;
		return idx >= 0 && idx < pool.keys.length ? pool.keys[idx] : undefined;
	}

	async function removeKeyFlow(ctx: ExtensionContext): Promise<void> {
		const target = await pickKey(ctx, "删除哪个 key？");
		if (!target) return;
		const isActive = resolveActiveId(pool) === target.id;
		const ok = await ctx.ui.confirm(
			"确认删除",
			isActive
				? `「${target.label}」是当前生效的 key。仅从池中删除，auth.json 保持不变？`
				: `从池中删除「${target.label}」？`,
		);
		if (!ok) return;
		pool.keys = pool.keys.filter((k) => k.id !== target.id);
		if (pool.activeId === target.id) pool.activeId = undefined;
		usageMap.delete(target.id);
		savePool(pool);
		ctx.ui.notify(`已删除「${target.label}」`, "info");
	}

	async function renameKeyFlow(ctx: ExtensionContext): Promise<void> {
		const target = await pickKey(ctx, "重命名哪个 key？");
		if (!target) return;
		const name = await ctx.ui.input(`「${target.label}」的新备注名：`, target.label);
		if (name === undefined) return;
		const trimmed = name.trim();
		if (!trimmed) {
			ctx.ui.notify("备注名为空，已取消", "warning");
			return;
		}
		const old = target.label;
		target.label = trimmed;
		savePool(pool);
		ctx.ui.notify(`已重命名：「${old}」→「${trimmed}」`, "info");
		render();
	}

	async function viewKeyFlow(ctx: ExtensionContext): Promise<void> {
		const target = await pickKey(ctx, "查看哪个 key 的明文？");
		if (!target) return;
		const cred = target.credential;
		const text =
			cred.type === "api_key"
				? cred.key
				: `access:  ${cred.access}\nrefresh: ${cred.refresh}\nexpires: ${new Date(cred.expires).toLocaleString()}`;
		// 用 editor 展示明文：可全选复制；返回值丢弃，修改不会保存
		await ctx.ui.editor(`「${target.label}」明文（Esc 关闭；此处修改不会保存）`, text);
	}

	async function switchToKey(ctx: ExtensionContext, id: string): Promise<void> {
		const target = pool.keys.find((k) => k.id === id);
		if (!target) return;
		if (resolveActiveId(pool) === id) return;
		try {
			writeAuthCred(KIMI_PROVIDER_ID, target.credential);
		} catch (e) {
			ctx.ui.notify(`切换失败：${e instanceof Error ? e.message : String(e)}`, "error");
			return;
		}
		pool.activeId = id;
		savePool(pool);
		ctx.ui.notify(`已切换到「${target.label}」，下一次请求生效`, "info");
		usageMap.set(id, await fetchKimiUsage(credSecret(target.credential)));
		render();
	}

	// ── DeepSeek 操作流 ───────────────────────────────────────

	async function dsViewKeyFlow(ctx: ExtensionContext): Promise<void> {
		const cred = readAuthCred(DS_PROVIDER_ID);
		if (!cred) {
			ctx.ui.notify("auth.json 中无 deepseek 凭据", "warning");
			return;
		}
		const secret = secretOf(cred);
		if (!secret) {
			ctx.ui.notify("key 为 $env/!cmd 引用形式，无法显示明文", "warning");
			return;
		}
		const text =
			cred.type === "api_key"
				? cred.key
				: `access:  ${cred.access}\nrefresh: ${cred.refresh}\nexpires: ${new Date(cred.expires).toLocaleString()}`;
		await ctx.ui.editor("DeepSeek 当前 key 明文（Esc 关闭；此处修改不会保存）", text);
	}

	// ── 阿里云 Token Plan 操作流 ────────────────────────────

	async function aliConfigFlow(ctx: ExtensionContext): Promise<void> {
		const id = await ctx.ui.input("AccessKey ID（RAM 用户，建议只读权限）：", "LTAI...");
		if (id === undefined) return;
		const secret = await ctx.ui.input("AccessKey Secret（明文回显，注意周围人）：", "");
		if (secret === undefined) return;
		const accessKeyId = id.trim();
		const accessKeySecret = secret.trim();
		if (!accessKeyId || !accessKeySecret) {
			ctx.ui.notify("AccessKey 为空，已取消", "warning");
			return;
		}
		// 重配 AK 保留已绑定坐席（同账号轮换密钥场景）
		pool.aliyun = { accessKeyId, accessKeySecret, mySeatId: pool.aliyun?.mySeatId };
		savePool(pool);
		ctx.ui.notify("AccessKey 已保存，正在查询坐席…", "info");
		await refreshAliyun();
		if (aliQuery?.seats && !pool.aliyun.mySeatId) await aliBindFlow(ctx);
	}

	async function aliBindFlow(ctx: ExtensionContext): Promise<void> {
		if (!pool.aliyun) {
			ctx.ui.notify("请先配置 AccessKey", "warning");
			return;
		}
		if (!aliQuery?.seats) {
			ctx.ui.notify("正在查询坐席…", "info");
			await refreshAliyun();
		}
		const seats = aliQuery?.seats;
		if (!seats || seats.length === 0) {
			ctx.ui.notify("未查到坐席（AK 无效/无权限/无订阅）", "warning");
			return;
		}
		const options = seats.map(
			(s, i) => `${i + 1}. ${s.accountName || s.seatId} · ${s.specType || "-"} · 余${fmtCredits(s.surplus)}/${fmtCredits(s.total)}`,
		);
		const idx = await selectZh(ctx, "哪个坐席是你的？", options);
		if (idx === undefined || idx < 0 || idx >= seats.length) return;
		pool.aliyun.mySeatId = seats[idx].seatId;
		savePool(pool);
		ctx.ui.notify(`已绑定坐席「${seats[idx].accountName || seats[idx].seatId}」`, "info");
		render();
	}

	async function aliViewAkFlow(ctx: ExtensionContext): Promise<void> {
		const cfg = pool.aliyun;
		if (!cfg) {
			ctx.ui.notify("未配置 AccessKey", "warning");
			return;
		}
		await ctx.ui.editor(
			"AccessKey 明文（Esc 关闭；此处修改不会保存）",
			`accessKeyId:     ${cfg.accessKeyId}\naccessKeySecret: ${cfg.accessKeySecret}`,
		);
	}

	// ── 命令 ─────────────────────────────────────────────────

	pi.registerCommand("token-manager", {
		description: "Token Manager：Kimi 用量 / DeepSeek 余额 / Token Plan 坐席（←→ 翻页）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			lastCtx = ctx;
			seedImport();

			ctx.ui.notify("正在刷新用量、余额与坐席用量…", "info");
			await Promise.all([refreshAll(), refreshDeepSeek(), refreshAliyun()]);

			let page = 0;
			for (;;) {
				const kimi = buildKimiPage();
				const sel = await pagerZh(ctx, [kimi.page, buildDeepSeekPage(), buildAliyunPage()], page);
				if (sel === undefined) break;
				page = sel.page;

				if (page === 0) {
					const keyId = kimi.keyIds[sel.index];
					if (keyId) {
						// 选 key 即切换，切换后直接退出
						await switchToKey(ctx, keyId);
						break;
					}
					if (sel.option === ADD_ACTION) {
						await addKeyFlow(ctx);
					} else if (sel.option === REMOVE_ACTION) {
						await removeKeyFlow(ctx);
					} else if (sel.option === RENAME_ACTION) {
						await renameKeyFlow(ctx);
					} else if (sel.option === VIEW_ACTION) {
						await viewKeyFlow(ctx);
					} else if (sel.option === REFRESH_ACTION) {
						ctx.ui.notify("正在刷新用量…", "info");
						await refreshAll();
					}
				} else if (page === 1) {
					if (sel.option === DS_REFRESH_ACTION) {
						ctx.ui.notify("正在刷新余额…", "info");
						await refreshDeepSeek();
						ctx.ui.notify("DeepSeek 余额已刷新", "info");
					} else if (sel.option === VIEW_ACTION) {
						await dsViewKeyFlow(ctx);
					}
				} else {
					if (sel.option === ALI_REFRESH_ACTION) {
						if (!pool.aliyun) {
							ctx.ui.notify("未配置 AccessKey", "warning");
						} else {
							ctx.ui.notify("正在刷新坐席用量…", "info");
							await refreshAliyun();
						}
					} else if (sel.option === ALI_CONFIG_ACTION) {
						await aliConfigFlow(ctx);
					} else if (sel.option === ALI_BIND_ACTION) {
						await aliBindFlow(ctx);
					} else if (sel.option === ALI_VIEW_ACTION) {
						await aliViewAkFlow(ctx);
					}
				}
				render();
			}
		},
	});

	// ── 事件接线 ────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		seedImport();
		syncVisibility(ctx.model);
	});

	pi.on("model_select", async (event, ctx) => {
		lastCtx = ctx;
		syncVisibility(event.model);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
	});
}

// ── DeepSeek 余额 ───────────────────────────────────────────

export interface DeepSeekBalance {
	isAvailable: boolean;
	currency: string; // "CNY" | "USD" | ...
	total: number;
	granted: number; // 赠金
	toppedUp: number; // 充值
	invalid?: boolean; // 401/403
	error?: string; // 网络/HTTP/解析错误
	noKey?: boolean; // auth.json 无 deepseek 凭据
	noSecret?: boolean; // key 为 $env/!cmd 引用，无法取字面值
	queriedAt: number;
}

export type Level = "ok" | "warn" | "crit";

/**
 * 纯函数：HTTP 状态 + 响应体 → DeepSeekBalance。
 * 金额字段是字符串（如 "110.00"）需 Number()；多币种优先 CNY，无 CNY 取第一条。
 */
export function parseBalanceResponse(status: number, body: unknown): DeepSeekBalance {
	const base: DeepSeekBalance = { isAvailable: false, currency: "", total: 0, granted: 0, toppedUp: 0, queriedAt: Date.now() };
	if (status === 401 || status === 403) return { ...base, invalid: true };
	if (status !== 200) return { ...base, error: `HTTP ${status}` };
	const b = body as Record<string, unknown> | null;
	const infos = Array.isArray(b?.balance_infos) ? (b.balance_infos as Record<string, unknown>[]) : [];
	const pick = infos.find((i) => i?.currency === "CNY") ?? infos[0];
	if (!pick) return { ...base, error: "响应中无余额数据" };
	const num = (v: unknown): number => {
		const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
		return Number.isFinite(n) ? n : 0;
	};
	return {
		isAvailable: b?.is_available !== false,
		currency: typeof pick.currency === "string" ? pick.currency : "",
		total: num(pick.total_balance),
		granted: num(pick.granted_balance),
		toppedUp: num(pick.topped_up_balance),
		queriedAt: base.queriedAt,
	};
}

export async function fetchDeepSeekBalance(apiKey: string): Promise<DeepSeekBalance> {
	let res: Response;
	try {
		res = await fetch(DS_BALANCE_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (e) {
		return { isAvailable: false, currency: "", total: 0, granted: 0, toppedUp: 0, error: `网络错误: ${e instanceof Error ? e.message : String(e)}`, queriedAt: Date.now() };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	if (res.ok && body === undefined) {
		return { isAvailable: false, currency: "", total: 0, granted: 0, toppedUp: 0, error: "响应解析失败", queriedAt: Date.now() };
	}
	return parseBalanceResponse(res.status, body);
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$" };

export function fmtMoney(amount: number, currency: string): string {
	const sym = CURRENCY_SYMBOL[currency] ?? (currency ? `${currency} ` : "");
	return `${sym}${amount.toFixed(2)}`;
}

/** 本地时间格式化为「YYYY年MM月DD日HH:MM:SS」（避免 toLocaleString 的地区差异） */
export function fmtDateTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 警告级别：余额 <10 黄、<5 或不可用/无效/出错红；noKey/noSecret 仅提示不变色 */
export function balanceLevel(b: DeepSeekBalance): Level {
	if (b.invalid || b.error) return "crit";
	if (b.noKey || b.noSecret) return "ok";
	if (!b.isAvailable) return "crit";
	if (b.total < DS_CRIT_BALANCE) return "crit";
	if (b.total < DS_WARN_BALANCE) return "warn";
	return "ok";
}

export function balanceStatusText(b: DeepSeekBalance | undefined): string {
	if (!b) return "deepseek开放平台余额  — ";
	if (b.noKey) return "deepseek开放平台余额 未配置key";
	if (b.noSecret) return "deepseek开放平台余额 key为环境引用";
	if (b.invalid) return "deepseek开放平台余额 无效key";
	if (b.error) return "deepseek开放平台余额 查询失败";
	return `deepseek开放平台余额 ${fmtMoney(b.total, b.currency)}`;
}

/** 循环翻页：count<=0 时归 0 */
export function flipPage(current: number, dir: 1 | -1, count: number): number {
	if (count <= 0) return 0;
	return (((current + dir) % count) + count) % count;
}

// ── 阿里云 Token Plan 状态栏文案 ──────────────────────────

export interface AliyunStatus {
	text: string;
	pct?: number; // 已用百分比（用于着色）
	bad: boolean; // 凭证/查询异常 → 红
	exhausted: boolean; // 用尽 → ⛔
}

/** 纯函数：配置 + 查询结果 → 状态栏文案 */
export function aliyunStatusText(cfg: AliyunConfig | undefined, q: SeatQuery | undefined): AliyunStatus {
	if (!cfg) return { text: "tokenplan坐席 未配置AK · /token-manager 设置", bad: false, exhausted: false };
	if (!cfg.mySeatId) return { text: "tokenplan坐席 未绑定坐席 · /token-manager 绑定", bad: false, exhausted: false };
	if (!q) return { text: "tokenplan坐席  — ", bad: false, exhausted: false };
	if (q.invalid) return { text: "tokenplan坐席 AK无效", bad: true, exhausted: false };
	if (q.error) return { text: "tokenplan坐席 查询失败", bad: true, exhausted: false };
	const seat = q.seats?.find((s) => s.seatId === cfg.mySeatId);
	if (!seat) return { text: "tokenplan坐席 坐席已失效", bad: true, exhausted: false };
	const pct = seatUsedPct(seat);
	const cd = seat.cycleEnd ? fmtCountdown(new Date(seat.cycleEnd).toISOString()) : "";
	const text = `当前席位余额 ${fmtCredits(seat.surplus)} Credits${cd ? ` ${cd}后重置` : ""}`;
	return { text, pct, bad: false, exhausted: pct >= 100 };
}
