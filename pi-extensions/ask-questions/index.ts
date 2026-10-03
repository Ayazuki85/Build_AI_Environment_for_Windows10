import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const TOOL_NAME = "ask_questions";
const TOOL_TITLE = ` ${TOOL_NAME} `;
const CUSTOM_LABEL = "自己输入答案";
const CUSTOM_DESCRIPTION = "打开输入框，手动填写。";
const UNAVAILABLE_TEXT =
	"ask_questions requires the interactive TUI. Ask the user in chat instead.";
const CANCELLED_TEXT =
	"The user dismissed the questions without submitting answers.";

const OptionSchema = Type.Object({
	label: Type.String({
		minLength: 1,
		description: "Concrete option label; aim for 40 characters or fewer",
	}),
	description: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Optional explanation; aim for 100 characters or fewer",
		}),
	),
});

const QuestionSchema = Type.Object({
	header: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Short progress label; aim for 30 characters or fewer",
		}),
	),
	question: Type.String({
		minLength: 1,
		description:
			"Concise question, usually one sentence; aim for 120 characters or fewer",
	}),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		maxItems: 8,
		description: "Short concrete choices.",
	}),
});

const AskQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description: "Ordered questions. No upper limit.",
	}),
});

type QuestionOption = Static<typeof OptionSchema>;
type InputQuestion = Static<typeof QuestionSchema>;
type DisplayOption = QuestionOption & { isCustom?: true };

/** Question shape used internally by the TUI flow. */
interface NormalizedQuestion {
	header: string;
	question: string;
	options: QuestionOption[];
}

/** Question metadata persisted in tool results. */
interface QuestionDetails {
	header: string;
	question: string;
	options: string[];
}

/** Answer metadata persisted in tool results. */
interface AnswerDetails {
	questionIndex: number;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
}

/** Full persisted result shape for the ask_questions tool. */
interface ToolDetails {
	status: "answered" | "cancelled" | "unavailable";
	questions: QuestionDetails[];
	answers: AnswerDetails[];
}

/**
 * Normalizes tool input and derives the persisted question metadata in one pass.
 */
function prepareQuestions(input: InputQuestion[]) {
	const questions = input.map(
		(question, index) =>
			({
				header: question.header?.trim() || `Q${index + 1}`,
				question: question.question,
				options: question.options,
			}) satisfies NormalizedQuestion,
	);
	return {
		questions,
		details: questions.map(
			(question) =>
				({
					header: question.header,
					question: question.question,
					options: question.options.map((option) => option.label),
				}) satisfies QuestionDetails,
		),
	};
}

/** Builds the standard text content for a tool result. */
function textResult(
	text: string,
	details: ToolDetails,
): AgentToolResult<ToolDetails> {
	return { content: [{ type: "text", text }], details };
}

/** Formats submitted answers into a full-fidelity text block for the agent. */
function summarize(details: ToolDetails): string {
	return details.answers.length === 0
		? "No answers were submitted."
		: details.answers
				.map(
					(answer, index) =>
						`${index + 1}. Question: ${answer.question}\n   Answer: ${answer.answer}`,
				)
				.join("\n\n");
}

/** Formats a persisted answer for full-fidelity result rendering. */
function formatAnswer(answer: AnswerDetails): string {
	return `${answer.header}\n问题：${answer.question}\n答案：${answer.answer}`;
}

/**
 * Runs the interactive ask_questions flow.
 *
 * Keymap:
 * - `j` / `k` or up/down arrows move through options on question screens, or
 *   through review items on the review screen (the viewport follows the cursor)
 * - `h` / `l` or left/right arrows switch to the previous / next question
 *   without touching answers; the last question leads to the review screen
 * - `Enter` confirms the current option; on the review screen it jumps to the
 *   selected question for editing, or submits on the trailing submit row
 * - `Esc` cancels the flow
 */
async function askQuestionsInTui(
	ctx: ExtensionContext,
	questions: NormalizedQuestion[],
	details: QuestionDetails[],
): Promise<ToolDetails> {
	return ctx.ui.custom<ToolDetails>((tui, theme, _kb, done) => {
		const answers: Array<AnswerDetails | undefined> = Array(questions.length);
		const drafts = Array(questions.length).fill("");
		const selections = Array(questions.length).fill(0);
		const single = questions.length === 1;
		const editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		} satisfies EditorTheme);
		let screen = 0;
		let editing = false;
		let reviewScroll = 0;
		let reviewCursor = questions.length;
		let returnToReview = false;
		let cache: { width: number; rows: number; lines: string[] } | undefined;

		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		const isUp = (data: string) => matchesKey(data, Key.up) || data === "k";
		const isDown = (data: string) => matchesKey(data, Key.down) || data === "j";
		const isBack = (data: string) => matchesKey(data, Key.left) || data === "h";
		const isConfirm = (data: string) => matchesKey(data, Key.enter);
		const isForward = (data: string) =>
			matchesKey(data, Key.right) || data === "l";
		const inReview = () => !single && screen === questions.length;
		const question = () => questions[screen];
		const answer = () => answers[screen];
		const selection = () => selections[screen] ?? 0;
		const options = (index = screen): DisplayOption[] => {
			const item = questions[index];
			return !item
				? []
				: [
						...item.options,
						{
							label: CUSTOM_LABEL,
							description: CUSTOM_DESCRIPTION,
							isCustom: true,
						},
					];
		};
		const addResult = (status: ToolDetails["status"]) =>
			done({
				status,
				questions: details,
				answers: answers.filter(
					(value): value is AnswerDetails => value !== undefined,
				),
			});
		const title = (text: string) =>
			theme.fg("toolTitle", theme.bold(TOOL_TITLE)) + theme.fg("muted", text);
		const resetEditor = () => {
			editing = false;
			editor.setText("");
		};
		const submit = (next: AnswerDetails) => {
			answers[next.questionIndex] = next;
			if (single) {
				addResult("answered");
				return;
			}
			if (returnToReview) {
				// Re-answer launched from the review screen: jump straight back.
				returnToReview = false;
				screen = questions.length;
				reviewCursor = next.questionIndex;
			} else {
				screen = Math.min(questions.length, next.questionIndex + 1);
				if (inReview()) {
					reviewCursor = questions.length;
				}
			}
			refresh();
		};
		const select = () => {
			const current = question();
			const index = selection();
			const option = options()[index];
			if (!current || !option) {
				return;
			}
			selections[screen] = index;
			if (option.isCustom) {
				editing = true;
				editor.setText(
					drafts[screen] || (answer()?.wasCustom ? answer()?.answer : "") || "",
				);
				refresh();
				return;
			}
			submit({
				questionIndex: screen,
				header: current.header,
				question: current.question,
				answer: option.label,
				wasCustom: false,
				optionIndex: index + 1,
			});
		};

		editor.onSubmit = (value) => {
			const current = question();
			const next = value.trim();
			if (!current || !next) {
				refresh();
				return;
			}
			drafts[screen] = next;
			resetEditor();
			submit({
				questionIndex: screen,
				header: current.header,
				question: current.question,
				answer: next,
				wasCustom: true,
			});
		};

		function render(width: number) {
			const lines = [theme.fg("accent", "─".repeat(width))];
			const add = (text = "") => lines.push(truncateToWidth(text, width));
			const addWrapped = (prefix = "", text = "") => {
				if (!text) {
					add(prefix);
					return;
				}
				const prefixWidth = visibleWidth(prefix);
				const wrapped = wrapTextWithAnsi(
					text,
					Math.max(1, width - prefixWidth),
				);
				const indent = " ".repeat(prefixWidth);
				for (const [index, line] of wrapped.entries()) {
					add(`${index === 0 ? prefix : indent}${line}`);
				}
			};

			if (inReview()) {
				add(title("确认答案"));
				add(theme.fg("text", " 检查回答：Enter 修改所选，最后一项提交。"));
				add();

				// Build the full item list (questions + a submit row), recording each
				// item's start line so the viewport can follow the cursor.
				const body: string[] = [];
				const itemStarts: number[] = [];
				for (const [index, item] of questions.entries()) {
					itemStarts.push(body.length);
					body.push(
						truncateToWidth(
							index === reviewCursor
								? theme.fg("accent", `> ${item.header}`)
								: theme.fg("muted", `  ${item.header}`),
							width,
						),
					);
					const answerText = answers[index]?.answer || "（未回答）";
					for (const line of wrapTextWithAnsi(
						theme.fg("text", answerText),
						Math.max(1, width - 3),
					)) {
						body.push(truncateToWidth(`   ${line}`, width));
					}
					body.push("");
				}
				itemStarts.push(body.length);
				body.push(
					truncateToWidth(
						reviewCursor === questions.length
							? theme.fg("accent", "> ✓ 提交所有答案")
							: theme.fg("success", "  ✓ 提交所有答案"),
						width,
					),
				);

				// Reserve rows for pi chrome (transcript sliver + footer) and this
				// component's fixed lines (borders, title, subtitle, help).
				const maxBody = Math.max(3, tui.terminal.rows - 10);
				reviewCursor = Math.max(0, Math.min(reviewCursor, questions.length));
				const cursorStart = itemStarts[reviewCursor] ?? 0;
				const cursorEnd = (itemStarts[reviewCursor + 1] ?? body.length) - 1;
				if (cursorStart < reviewScroll) reviewScroll = cursorStart;
				if (cursorEnd >= reviewScroll + maxBody) {
					reviewScroll = cursorEnd - maxBody + 1;
				}
				const maxScroll = Math.max(0, body.length - maxBody);
				reviewScroll = Math.max(0, Math.min(reviewScroll, maxScroll));
				for (const line of body.slice(reviewScroll, reviewScroll + maxBody)) {
					add(line);
				}

				add(theme.fg("dim", " jk/↑↓ 移动 • Enter 修改/提交 • Esc 取消"));
				lines.push(theme.fg("accent", "─".repeat(width)));
				return lines;
			}

			const current = question();
			if (!current) {
				return lines;
			}

			add(title(`${screen + 1}/${questions.length} • ${current.header}`));
			addWrapped(" ", theme.fg("text", current.question));
			add();
			for (const [index, option] of options().entries()) {
				const active = index === selection();
				const picked = option.isCustom
					? answer()?.wasCustom === true
					: answer()?.optionIndex === index + 1;
				const color = active ? "accent" : picked ? "success" : "text";
				addWrapped(
					(active ? theme.fg("accent", "> ") : "  ") +
						theme.fg(color, `${index + 1}. `),
					theme.fg(color, option.label),
				);
				if (option.description) {
					addWrapped("   ", theme.fg("muted", option.description));
				}
				if (option.isCustom && !editing && drafts[screen]) {
					addWrapped("   ", theme.fg("muted", drafts[screen] ?? ""));
				}
				if (option.isCustom && editing && active) {
					for (const line of editor.render(Math.max(1, width - 3))) {
						add(`   ${line}`);
					}
				}
			}
			add();
			add(
				theme.fg(
					"dim",
					editing
						? " 输入答案 • Enter 保存 • Esc 返回"
						: ` jk/↑↓ 移动 • 1-9 选择 • Enter 确认${single ? "" : " • h/l/←/→ 上下题"} • Esc 取消`,
				),
			);
			lines.push(theme.fg("accent", "─".repeat(width)));
			return lines;
		}

		function handleInput(data: string) {
			if (editing) {
				if (matchesKey(data, Key.escape)) {
					resetEditor();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (inReview()) {
				if (isUp(data)) {
					reviewCursor = Math.max(0, reviewCursor - 1);
					refresh();
					return;
				}
				if (isDown(data)) {
					reviewCursor = Math.min(questions.length, reviewCursor + 1);
					refresh();
					return;
				}
				if (isConfirm(data)) {
					if (reviewCursor < questions.length) {
						// Jump back to edit the selected question; after re-answering,
						// submit() returns to this screen instead of advancing.
						returnToReview = true;
						screen = reviewCursor;
						refresh();
						return;
					}
					addResult("answered");
					return;
				}
				if (matchesKey(data, Key.escape)) {
					addResult("cancelled");
				}
				return;
			}
			for (let index = 0; index < Math.min(options().length, 9); index++) {
				if (data === String(index + 1)) {
					selections[screen] = index;
					select();
					return;
				}
			}
			if (isUp(data)) {
				selections[screen] = Math.max(0, selection() - 1);
				refresh();
				return;
			}
			if (isDown(data)) {
				selections[screen] = Math.min(options().length - 1, selection() + 1);
				refresh();
				return;
			}
			if (isBack(data)) {
				if (screen > 0) {
					returnToReview = false;
					screen -= 1;
					refresh();
				}
				return;
			}
			if (isForward(data)) {
				// Free forward navigation: never touches answers, selections, or
				// drafts, so switching back and forth is side-effect free.
				if (!single) {
					returnToReview = false;
					screen = Math.min(questions.length, screen + 1);
					if (inReview()) {
						reviewCursor = questions.length;
					}
					refresh();
				}
				return;
			}
			if (isConfirm(data)) {
				select();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				addResult("cancelled");
			}
		}

		return {
			render(width: number) {
				const rows = tui.terminal.rows;
				if (!cache || cache.width !== width || cache.rows !== rows) {
					cache = { width, rows, lines: render(width) };
				}
				return cache.lines;
			},
			invalidate() {
				cache = undefined;
			},
			handleInput,
		};
	});
}

/**
 * Registers the minimal `ask_questions` Pi extension.
 *
 * The stable contract is the schema and TUI flow. Prompt copy stays small and
 * tunable.
 */
export default function askQuestionsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask Questions",
		description:
			"Ask the user structured questions in the interactive TUI. Default to this for direct user questions when structured input helps.",
		promptSnippet: "Ask structured questions for missing user input.",
		promptGuidelines: [
			"Use ask_questions for direct user questions unless the question is trivial, rhetorical, or only a lightweight next-step question at the end of a normal answer.",
			"Use ask_questions to batch related questions. Keep each question concise, keep options short and concrete, and put the recommended option first when helpful.",
		],
		parameters: AskQuestionsParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = prepareQuestions(params.questions);
			if (!ctx.hasUI) {
				return textResult(UNAVAILABLE_TEXT, {
					status: "unavailable",
					questions: prepared.details,
					answers: [],
				});
			}
			const details = await askQuestionsInTui(
				ctx,
				prepared.questions,
				prepared.details,
			);
			return textResult(
				details.status === "cancelled"
					? CANCELLED_TEXT
					: `User answers:\n${summarize(details)}`,
				details,
			);
		},
		renderCall(args, theme) {
			const questions = Array.isArray(args.questions)
				? (args.questions as InputQuestion[])
				: [];
			const preview = questions[0]?.question;
			return new Text(
				theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) +
					theme.fg(
						"muted",
						`${questions.length} 个问题${preview ? ` • ${preview}` : ""}`,
					),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as ToolDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", "界面不可用"), 0, 0);
			}
			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", "已取消"), 0, 0);
			}
			return new Text(
				details.answers
					.map(
						(answer) =>
							theme.fg("success", "✓ ") +
							theme.fg("accent", formatAnswer(answer)),
					)
					.join("\n\n"),
				0,
				0,
			);
		},
	});
}
