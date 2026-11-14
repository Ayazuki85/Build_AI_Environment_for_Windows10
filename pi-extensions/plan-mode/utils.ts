/**
 * Pure command analysis for plan mode.
 *
 * Every shell command is classified three ways:
 * - allow: known read-only, runs without bothering the user
 * - ask:   unknown, the user confirms once in a dialog
 * - block: destructive, rejected with an actionable reason
 *
 * Compound commands are split into segments (&&, ||, ;, |, &, newlines) and
 * every segment must pass. Command substitutions ($(), backticks, process
 * substitution) are analyzed recursively. Quoted text is masked before
 * operator scanning so `echo "a && b"` is not split.
 */

export type Decision = "allow" | "ask" | "block"

export interface Analysis {
	decision: Decision
	/** Original segment that triggered the decision, for display. */
	segment?: string
	/** Why the segment was blocked or needs confirmation. */
	reason?: string
	/** Read-only alternative suggested to the model. */
	suggestion?: string
}

const ALLOW: Analysis = { decision: "allow" }

function ask(segment: string, reason: string): Analysis {
	return { decision: "ask", segment, reason }
}

function block(segment: string | undefined, reason: string, suggestion?: string): Analysis {
	return { decision: "block", segment, reason, suggestion }
}

export function clipText(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

interface Substitution {
	start: number
	end: number
	inner: string
}

/** Find $(...), `...`, <(...) and >(...) spans. Single quotes suppress substitution; double quotes do not. */
function findSubstitutions(command: string): Substitution[] {
	const spans: Substitution[] = []
	let quote: "'" | '"' | undefined
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]
		if (quote === "'") {
			if (ch === "'") quote = undefined
			continue
		}
		if (ch === "\\") {
			i++
			continue
		}
		if (quote === '"' && ch === '"') {
			quote = undefined
			continue
		}
		if (!quote && (ch === "'" || ch === '"')) {
			quote = ch
			continue
		}
		if (ch === "`") {
			const close = command.indexOf("`", i + 1)
			if (close === -1) return spans
			spans.push({ start: i, end: close + 1, inner: command.slice(i + 1, close) })
			i = close
			continue
		}
		if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
			let depth = 0
			let j = i + 1
			for (; j < command.length; j++) {
				if (command[j] === "(") depth++
				else if (command[j] === ")") {
					depth--
					if (depth === 0) break
				}
			}
			if (j >= command.length) return spans
			spans.push({ start: i, end: j + 1, inner: command.slice(i + 2, j) })
			i = j
		}
	}
	return spans
}

/** Replace quoted and backslash-escaped content with spaces, preserving length and indices. */
function maskQuotes(text: string): string {
	let out = ""
	let quote: "'" | '"' | undefined
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (quote) {
			if (ch === quote) quote = undefined
			out += " "
			continue
		}
		if (ch === "\\") {
			out += "  "
			i++
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			out += " "
			continue
		}
		out += ch
	}
	return out
}

function maskSpan(text: string, span: Substitution): string {
	return text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end)
}

/**
 * Blank out redirections that cannot write files: fd duplication (2>&1), /dev/null
 * sinks, and input redirects. Length-preserving so segment indices stay aligned.
 * Runs before operator splitting because the `&` in `2>&1` always signals fd
 * duplication, not a background job.
 */
function stripBenignRedirections(text: string): string {
	return text
		.replace(/\d*>&\d+/g, (m) => " ".repeat(m.length))
		.replace(/&>>?\s*\/dev\/null/g, (m) => " ".repeat(m.length))
		.replace(/\d*>>?\s*\/dev\/null\b/g, (m) => " ".repeat(m.length))
		.replace(/(?<![0-9&<])<\s*[^\s<&|;()]+/g, (m) => " ".repeat(m.length))
}

/**
 * Blank out heredoc bodies up to their terminator lines. The body is data, not
 * commands, so `cat <<EOF` stays allowed while its content is never analyzed.
 * Length- and line-preserving so segment indices stay aligned with the original.
 */
function stripHeredocBodies(text: string): string {
	const out: string[] = []
	let delimiters: string[] = []
	for (const line of text.split("\n")) {
		if (delimiters.length > 0) {
			if (line.trim() === delimiters[0]) delimiters.shift()
			out.push(" ".repeat(line.length))
			continue
		}
		// Quote-mask only for locating the marker, so `echo "a << b"` is not a heredoc.
		// Herestrings (<<<) are masked first to keep them out of the << scan.
		const visible = maskQuotes(line).replace(/<<</g, "   ")
		for (const match of visible.matchAll(/<<-?/g)) {
			const rest = line.slice(match.index + match[0].length)
			const delimiter = rest.match(/^\s*(?:['"]([^'"]+)['"]|([A-Za-z_]\w*))/)
			if (delimiter) delimiters.push(delimiter[1] ?? delimiter[2])
		}
		out.push(line)
	}
	return out.join("\n")
}

/** Split a quote-free string on shell operators, keeping indices aligned with the input. */
function splitSpans(text: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = []
	let start = 0
	let i = 0
	while (i < text.length) {
		const ch = text[i]
		if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
			const pair = (ch === "&" || ch === "|") && text[i + 1] === ch
			spans.push({ start, end: i })
			i += pair ? 2 : 1
			start = i
			continue
		}
		i++
	}
	spans.push({ start, end: text.length })
	return spans
}

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

const ALLOW_COMMANDS = new Set([
	"[",
	"test",
	"cd",
	"pwd",
	"ls",
	"eza",
	"exa",
	"tree",
	"find",
	"fd",
	"fdfind",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"batcat",
	"file",
	"stat",
	"du",
	"df",
	"wc",
	"sort",
	"uniq",
	"comm",
	"diff",
	"cmp",
	"xxd",
	"od",
	"hexdump",
	"strings",
	"md5sum",
	"sha1sum",
	"sha224sum",
	"sha256sum",
	"sha384sum",
	"sha512sum",
	"b2sum",
	"cksum",
	"echo",
	"printf",
	"true",
	"false",
	"which",
	"whereis",
	"type",
	"uname",
	"whoami",
	"id",
	"date",
	"cal",
	"uptime",
	"hostname",
	"arch",
	"ps",
	"free",
	"top",
	"htop",
	"lsof",
	"jobs",
	"ping",
	"lsblk",
	"lscpu",
	"lsusb",
	"lspci",
	"lsmod",
	"jq",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"tr",
	"cut",
	"paste",
	"column",
	"expand",
	"unexpand",
	"nl",
	"fold",
	"fmt",
	"iconv",
	"zipinfo",
	"zcat",
	"bzcat",
	"xzcat",
	"gzcat",
	"locale",
	"printenv",
	"read",
])

/** Commands that are allowed when called with a single version flag. */
const VERSIONABLE = new Set([
	"node",
	"python",
	"python3",
	"pip",
	"pip3",
	"ruby",
	"perl",
	"php",
	"java",
	"go",
	"rustup",
	"rustc",
	"cargo",
	"dotnet",
	"bun",
	"deno",
	"npm",
	"yarn",
	"pnpm",
])

const VERSION_FLAGS = new Set(["--version", "-v", "-V", "version"])

/** Network commands can exfiltrate data, so they always need user confirmation. */
const NETWORK_COMMANDS = new Set([
	"curl",
	"wget",
	"ssh",
	"scp",
	"sftp",
	"rsync",
	"ftp",
	"telnet",
	"nc",
	"nmap",
])

/** Leading words that carry no command of their own. */
const STRUCTURAL = new Set(["then", "do", "else", "fi", "done", "esac", "{", "}", "!", "&", "time"])

/** Prefix commands that run another command of their own; skip to the one they wrap. */
const WRAPPERS = new Set([
	"xargs",
	"env",
	"nohup",
	"exec",
	"nice",
	"ionice",
	"stdbuf",
	"watch",
	"command",
	"builtin",
])

const GIT_READONLY = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"rev-parse",
	"rev-list",
	"describe",
	"shortlog",
	"reflog",
	"grep",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"count-objects",
	"whatchanged",
	"show-branch",
	"name-rev",
	"cat-file",
	"help",
])

const PKG_READONLY: Record<string, Set<string>> = {
	npm: new Set(["list", "ls", "view", "info", "search", "outdated", "audit", "explain", "why"]),
	pnpm: new Set(["list", "ls", "view", "info", "why", "outdated", "audit"]),
	yarn: new Set(["list", "info", "why", "audit", "licenses"]),
	pip: new Set(["list", "show", "freeze", "check"]),
	pip3: new Set(["list", "show", "freeze", "check"]),
}

interface BlockRule {
	pattern: RegExp
	reason: string
	suggestion: string
}

const FILE_WRITE_HINT = "查看用 ls / cat / stat；写操作请记入计划，退出计划模式后执行"

/**
 * Patterns anchored to whole words, matched against sliding 1-3 word windows of
 * the segment so path-like arguments (e.g. ./touch-notes) never false-positive.
 */
const BLOCK_RULES: BlockRule[] = [
	{
		pattern: /^(rm|rmdir|mkdir|mv|cp|ln|touch|truncate|dd|shred)$/i,
		reason: "会修改或删除文件",
		suggestion: FILE_WRITE_HINT,
	},
	{
		pattern: /^(chmod|chown|chgrp)$/i,
		reason: "会修改文件权限或归属",
		suggestion: "用 ls -l / stat 查看权限信息",
	},
	{
		pattern: /^tee$/i,
		reason: "tee 会写入文件",
		suggestion: "去掉 tee，让输出直接返回",
	},
	{
		pattern: /^(npm|pnpm) (install|uninstall|update|ci|link|publish|add|remove)$/i,
		reason: "会修改依赖与 node_modules",
		suggestion: "用 npm ls / npm view / pnpm list 查看依赖信息",
	},
	{
		pattern: /^yarn (add|remove|install|publish|upgrade)$/i,
		reason: "会修改依赖与 node_modules",
		suggestion: "用 yarn list / yarn info 查看依赖信息",
	},
	{
		pattern: /^pip3? (install|uninstall)$/i,
		reason: "会修改 Python 环境",
		suggestion: "用 pip list / pip show 查看已装包",
	},
	{
		pattern: /^apt(-get)? (install|remove|purge|update|upgrade)$/i,
		reason: "会修改系统软件包",
		suggestion: "用 apt list --installed 查看已装包",
	},
	{
		pattern: /^brew (install|uninstall|upgrade|reinstall)$/i,
		reason: "会修改系统软件包",
		suggestion: "用 brew list / brew info 查看软件包信息",
	},
	{
		pattern:
			/^git (add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|cherry-pick|revert|init|clone|clean|apply|am|worktree)$/i,
		reason: "该 git 子命令会修改仓库",
		suggestion: "用 git status / log / diff / show 查看仓库状态",
	},
	{
		pattern: /^(sudo|su|doas)$/i,
		reason: "提权命令不属于只读探索",
		suggestion: "去掉提权前缀重试；仍失败则说明需要退出计划模式",
	},
	{
		pattern: /^(kill|pkill|killall)$/i,
		reason: "会终止进程",
		suggestion: "用 ps 查看进程信息",
	},
	{
		pattern: /^(shutdown|reboot|halt|poweroff)$/i,
		reason: "会影响系统运行状态",
		suggestion: "无只读替代，请记入计划",
	},
	{
		pattern: /^systemctl (start|stop|restart|enable|disable|mask|reload)$/i,
		reason: "会改变服务状态",
		suggestion: "用 systemctl status 查看服务状态",
	},
	{
		pattern: /^service \S+ (start|stop|restart|reload)$/i,
		reason: "会改变服务状态",
		suggestion: "用 service --status-all 查看服务状态",
	},
	{
		pattern: /^(vi|vim|nano|emacs|code|subl|notepad)$/i,
		reason: "编辑器会修改文件",
		suggestion: "查看内容用 cat / bat / head",
	},
	{
		pattern: /^(mkfs|fdisk|parted|mount|umount)$/i,
		reason: "会影响磁盘或挂载状态",
		suggestion: "用 lsblk / df 查看磁盘信息",
	},
]

// ---------------------------------------------------------------------------
// Per-command classifiers
// ---------------------------------------------------------------------------

function classifyGit(args: string[], seg: string): Analysis {
	const sub = args[0]
	if (!sub) return ALLOW
	if (GIT_READONLY.has(sub) || sub.startsWith("ls-")) return ALLOW
	const rest = args.slice(1)
	switch (sub) {
		case "branch":
			if (rest.length === 0) return ALLOW
			if (rest.every((a) => a.startsWith("-")) && !rest.some((a) => /-[a-zA-Z]*[dDmM]/.test(a))) return ALLOW
			return block(seg, "git branch 带参数会创建、删除或重命名分支", "用 git branch 或 git branch -l 仅查看分支")
		case "tag":
			if (rest.length === 0) return ALLOW
			if (rest.every((a) => a.startsWith("-")) && !rest.some((a) => /-[a-zA-Z]*[dD]/.test(a))) return ALLOW
			return block(seg, "git tag 带参数会创建或删除标签", "用 git tag 或 git tag -l 仅查看标签")
		case "remote":
			if (rest.length === 0 || (rest.length === 1 && rest[0] === "-v")) return ALLOW
			return block(seg, "git remote 带参数会修改远程配置", "用 git remote -v 查看远程")
		case "config":
			if (rest.some((a) => /^--(get|get-all|get-regexp|list)$/.test(a)) || rest.includes("-l")) return ALLOW
			return block(seg, "git config 写入会修改仓库配置", "用 git config --get <键> 读取配置")
		case "stash":
			if (rest[0] === "list" || rest[0] === "show") return ALLOW
			return block(seg, "git stash 会改动工作区状态", "用 git stash list / git stash show 查看")
	}
	return ask(seg, `git ${sub} 无法确认只读`)
}

function classifyTar(args: string[], seg: string): Analysis {
	// Old-style flags come first without a dash (tar tf); long flags keep the dash.
	const flags = args.filter((a, i) => a.startsWith("-") || i === 0).join(" ")
	if (/(?:^|\s)-?[a-zA-Z]*[xcru]/.test(flags) || /--(extract|create|delete|append|update)/.test(flags)) {
		return block(seg, "tar 解包或打包会写入文件系统", "用 tar tf <文件> 仅列出归档内容")
	}
	if (/(?:^|\s)-?[a-zA-Z]*t/.test(flags) || /--list/.test(flags)) return ALLOW
	return ask(seg, "无法确认 tar 调用只读")
}

function classifySegmentCommand(cmd: string, args: string[], originalSeg: string): Analysis {
	if (cmd === "find" || cmd === "fd" || cmd === "fdfind") {
		if (args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) {
			return block(originalSeg, "find 的 -exec / -delete / -fprint 会修改文件", "去掉这些参数，只用 find 打印路径")
		}
		return ALLOW
	}
	if (cmd === "sort" && args.some((a) => a === "-o" || a.startsWith("--output"))) {
		return block(originalSeg, "sort -o 会写入文件", "去掉 -o，让排序结果输出到 stdout")
	}
	if (cmd === "date" && args.some((a) => a === "-s" || a.startsWith("--set"))) {
		return block(originalSeg, "date -s 会修改系统时间", "去掉 -s 仅查看当前时间")
	}
	if (ALLOW_COMMANDS.has(cmd)) return ALLOW
	if (args.length === 1 && VERSION_FLAGS.has(args[0]) && VERSIONABLE.has(cmd)) return ALLOW

	switch (cmd) {
		case "git":
			return classifyGit(args, originalSeg)
		case "npm":
		case "pnpm":
		case "yarn":
		case "pip":
		case "pip3": {
			const sub = args[0]
			if (sub && PKG_READONLY[cmd].has(sub)) return ALLOW
			return ask(originalSeg, `${cmd} ${sub ?? ""} 无法确认只读`.trim())
		}
		case "tar":
			return classifyTar(args, originalSeg)
		case "unzip":
			if (args.includes("-l")) return ALLOW
			return block(originalSeg, "unzip 解压会写入文件", "用 unzip -l <文件> 仅列出内容")
		case "gzip":
		case "gunzip":
			if (args.some((a) => /^-[a-z]*[lc]/.test(a) || a === "--list" || a === "--stdout")) return ALLOW
			return ask(originalSeg, "gzip / gunzip 默认会改写压缩文件")
		case "sed":
			if (args.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("i")) || args.some((a) => a.startsWith("--in-place"))) {
				return block(originalSeg, "sed -i 会就地修改文件", "去掉 -i，让结果输出到 stdout 即可查看")
			}
			return ALLOW
		case "awk":
		case "gawk":
		case "mawk":
			if (/\bsystem\s*\(/.test(originalSeg)) {
				return block(originalSeg, "awk 的 system() 可执行任意命令", "改写 awk 程序避免 system()，或用 grep / sed 替代")
			}
			if (/>\s*["']/.test(originalSeg)) {
				return block(originalSeg, "awk 程序内的重定向会写入文件", "让 awk 输出到 stdout，由调用方查看")
			}
			return ALLOW
		case "env":
			// Bare env prints the environment; env KEY=val too; env cmd runs cmd.
			if (args.every((a) => /^[A-Za-z_]\w*=/.test(a))) return ALLOW
			return ask(originalSeg, "env 可作为前缀执行任意命令")
	}

	if (NETWORK_COMMANDS.has(cmd)) {
		return ask(originalSeg, `${cmd} 是网络命令，无法确认只读（可能向外发送数据）`)
	}
	return ask(originalSeg, `"${cmd}" 不在只读白名单内，无法自动确认只读`)
}

// ---------------------------------------------------------------------------
// Segment analysis
// ---------------------------------------------------------------------------

function analyzeSegment(maskedSeg: string, originalSeg: string): Analysis {
	// Output redirection writes files; benign redirections were already stripped.
	if (maskedSeg.includes(">")) {
		return block(originalSeg, "包含输出重定向，会写入文件", "去掉重定向让输出直接返回，或用 head / tail 截取输出")
	}

	const tokens = maskedSeg.split(/\s+/).filter(Boolean)

	// Only the command position can be a destructive verb; arguments that merely
	// look like one (ls cp) must not match. Wrappers such as xargs hand off to the
	// command they run, so skip them and their options to find that position.
	const commandAt = (() => {
		let i = 0
		while (i < tokens.length) {
			const clean = tokens[i].replace(/^\(+/, "").replace(/^.*\//, "")
			if (!/^[A-Za-z_]\w*=/.test(tokens[i]) && !STRUCTURAL.has(clean) && !WRAPPERS.has(clean)) return i
			i++
			while (i < tokens.length && tokens[i].startsWith("-")) i++
		}
		return tokens.length
	})()

	const words = tokens.map((t, i) => (i === 0 ? t.replace(/^\(+/, "").replace(/^.*\//, "") : t))
	for (let len = 1; len <= 3 && commandAt + len <= words.length; len++) {
		const slice = words.slice(commandAt, commandAt + len).join(" ")
		for (const rule of BLOCK_RULES) {
			if (rule.pattern.test(slice)) return block(originalSeg, rule.reason, rule.suggestion)
		}
	}

	// Shell control flow: headers run nothing themselves, their bodies are separate segments.
	const head = tokens[0]?.replace(/^\(+/, "")
	if (head === "for") {
		return /^for\s+\w+\s+in\b/.test(maskedSeg) ? ALLOW : ask(originalSeg, "无法解析的 for 循环")
	}
	if (head === "if" || head === "elif" || head === "while" || head === "until") {
		const rest = maskedSeg.slice(maskedSeg.indexOf(tokens[0]) + tokens[0].length).trim()
		return rest ? analyzeSegment(rest, originalSeg) : ALLOW
	}

	const raw = tokens[commandAt]
	if (!raw) return ALLOW
	const cmd = raw.replace(/^.*\//, "").replace(/^\(+|\)+$/g, "")
	return classifySegmentCommand(cmd, tokens.slice(commandAt + 1), originalSeg)
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

/** PowerShell verbs and aliases that mutate files or system state. */
const POWERSHELL_WRITE = new Set([
	"remove-item",
	"clear-item",
	"clear-content",
	"set-content",
	"add-content",
	"out-file",
	"new-item",
	"move-item",
	"copy-item",
	"rename-item",
	"set-item",
	"set-itemproperty",
	"new-itemproperty",
	"remove-itemproperty",
	"start-process",
	"stop-process",
	"stop-service",
	"start-service",
	"restart-service",
	"stop-computer",
	"restart-computer",
	"set-executionpolicy",
	"invoke-expression",
	"invoke-webrequest",
	"invoke-restmethod",
	"rm",
	"del",
	"erase",
	"rd",
	"rmdir",
	"mv",
	"move",
	"cp",
	"copy",
	"mkdir",
	"ni",
	"sc",
	"ac",
	"clc",
	"iex",
	"iwr",
	"irm",
	"tee",
])

/**
 * PowerShell has no read-only allowlist here: anything not recognized as a write
 * verb needs a confirmation, which mirrors opencode asking for every unknown call.
 */
export function analyzePowerShell(command: string): Analysis {
	const visible = stripBenignRedirections(maskQuotes(command))
	if (visible.includes(">")) {
		return block(command.trim(), "包含输出重定向，会写入文件", "去掉重定向让输出直接返回，或用 Select-Object -First 截取")
	}
	for (const span of splitSpans(visible)) {
		const first = visible
			.slice(span.start, span.end)
			.trim()
			.split(/\s+/)[0]
			?.replace(/^[&$]/, "")
			.toLowerCase()
		if (first && POWERSHELL_WRITE.has(first)) {
			return block(
				command.slice(span.start, span.end).trim(),
				"该 PowerShell 命令会修改文件或系统状态",
				"用 Get-ChildItem / Get-Content / Select-String 等只读命令",
			)
		}
	}
	return ask(command.trim(), "PowerShell 命令无法自动确认只读，请确认")
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function analyzeCommand(command: string): Analysis {
	// Heredoc bodies are data, so mask them before any command scanning.
	const bodyMasked = stripHeredocBodies(command)
	// Command substitutions execute too, so analyze them recursively and mask
	// their spans before the outer operator/redirect scan.
	let masked = bodyMasked
	let nestedAsk: Analysis | undefined
	for (const span of findSubstitutions(bodyMasked)) {
		masked = maskSpan(masked, span)
		const inner = analyzeCommand(span.inner)
		if (inner.decision === "block") {
			return block(
				undefined,
				`命令替换内的 \`${clipText(inner.segment ?? span.inner.trim())}\` ${inner.reason ?? "包含写操作"}`,
				inner.suggestion,
			)
		}
		if (inner.decision === "ask" && !nestedAsk) {
			nestedAsk = ask(span.inner.trim(), `命令替换内包含无法确认只读的命令：${clipText(span.inner.trim())}`)
		}
	}

	const quoteMasked = maskQuotes(masked)
	const redirectMasked = stripBenignRedirections(quoteMasked)
	let firstAsk: Analysis | undefined
	for (const span of splitSpans(redirectMasked)) {
		const maskedSeg = redirectMasked.slice(span.start, span.end).trim()
		if (!maskedSeg) continue
		const result = analyzeSegment(maskedSeg, command.slice(span.start, span.end).trim())
		if (result.decision === "block") return result
		if (result.decision === "ask" && !firstAsk) firstAsk = result
	}
	return firstAsk ?? nestedAsk ?? ALLOW
}
