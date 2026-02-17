/**
 * Ask User Tool Extension for pi
 *
 * Interactive user prompting during execution. Ask the user a question
 * with options and allow them to select one or more, or type a custom answer.
 *
 * Use this tool when you need to:
 *   - Gather user preferences or requirements
 *   - Clarify ambiguous instructions
 *   - Get decisions on implementation choices as you work
 *   - Offer choices to the user about what direction to take
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// =============================================================================
// Types
// =============================================================================

interface OptionItem {
	label: string;
	description?: string;
}

interface AskUserInput {
	question: string;
	options: OptionItem[];
	multi?: boolean;
	allow_other?: boolean;
	recommended?: number;
}

interface AskUserResult {
	question: string;
	options: string[];
	multi: boolean;
	selected: string[];
	custom_input?: string;
	cancelled: boolean;
}

interface MultiSelectResult {
	selected: string[];
	custom_input?: string;
	cancelled: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const OTHER_OPTION = "Other (type your own)";
const RECOMMENDED_SUFFIX = " (Recommended)";

// =============================================================================
// Schema
// =============================================================================

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
});

const AskUserParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Available options for the user to choose from" }),
	multi: Type.Optional(Type.Boolean({ description: "Allow multiple selections (default: false)" })),
	allow_other: Type.Optional(Type.Boolean({ description: "Allow free text input (default: true)" })),
	recommended: Type.Optional(Type.Number({ description: "Index of the recommended option (0-indexed)" })),
});

// =============================================================================
// Helper Functions
// =============================================================================

/** Add "(Recommended)" suffix to option if it's the recommended one */
function addRecommendedSuffix(label: string, index: number, recommended?: number): string {
	if (recommended === undefined || index !== recommended) return label;
	if (label.endsWith(RECOMMENDED_SUFFIX)) return label;
	return label + RECOMMENDED_SUFFIX;
}

/** Strip the "(Recommended)" suffix from a label */
function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

// =============================================================================
// Selection Logic
// =============================================================================

interface UIContext {
	select(prompt: string, options: string[]): Promise<string | undefined>;
	input(prompt: string): Promise<string | undefined>;
	custom: ExtensionContext["ui"]["custom"];
}

async function askSingleQuestion(
	ui: UIContext,
	question: string,
	optionLabels: string[],
	allowOther: boolean,
	recommended?: number,
): Promise<{ selected: string[]; custom_input?: string }> {
	const displayLabels = optionLabels.map((label, i) => addRecommendedSuffix(label, i, recommended));

	const options = [...displayLabels];
	if (allowOther) {
		options.push(OTHER_OPTION);
	}

	const choice = await ui.select(question, options);

	if (choice === undefined) {
		return { selected: [] };
	}

	if (choice === OTHER_OPTION) {
		const input = await ui.input("Enter your response:");
		return { selected: [], custom_input: input || undefined };
	}

	return { selected: [stripRecommendedSuffix(choice)] };
}

async function askMultiQuestion(
	ui: UIContext,
	question: string,
	optionLabels: string[],
	allowOther: boolean,
	recommended?: number,
	descriptions?: (string | undefined)[],
): Promise<MultiSelectResult> {
	const displayLabels = optionLabels.map((label, i) => addRecommendedSuffix(label, i, recommended));
	const allOptionLabels = [...displayLabels];
	if (allowOther) {
		allOptionLabels.push(OTHER_OPTION);
	}

	const result = await ui.custom<MultiSelectResult>((tui, theme, _kb, done) => {
		const selected = new Set<number>();
		let cursorIndex = Math.min(Math.max(recommended ?? 0, 0), allOptionLabels.length - 1);
		let cachedLines: string[] | undefined;
		let inputMode = false;

		// Create inline editor for "Other" option
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed) {
				// Filter out "Other" index (last index) and map to labels
				const otherIndex = allOptionLabels.length - 1;
				const selectedLabels = Array.from(selected)
					.filter((idx) => idx !== otherIndex)
					.map((idx) => stripRecommendedSuffix(optionLabels[idx]));
				done({ selected: selectedLabels, custom_input: trimmed, cancelled: false });
			} else {
				// Empty input, exit input mode
				inputMode = false;
				editor.setText("");
				refresh();
			}
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function toggleSelection(index: number) {
			const otherIndex = allOptionLabels.length - 1;
			if (selected.has(index)) {
				selected.delete(index);
				// If unchecking "Other", also exit input mode
				if (allowOther && index === otherIndex) {
					inputMode = false;
					editor.setText("");
				}
			} else {
				selected.add(index);
				// If checking "Other", enter input mode
				if (allowOther && index === otherIndex) {
					inputMode = true;
				}
			}
			refresh();
		}

		function handleInput(data: string) {
			// In input mode, route to editor
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Navigation
			if (matchesKey(data, Key.up)) {
				cursorIndex = Math.max(0, cursorIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursorIndex = Math.min(allOptionLabels.length - 1, cursorIndex + 1);
				refresh();
				return;
			}

			// Space bar to toggle selection
			if (data === " ") {
				toggleSelection(cursorIndex);
				return;
			}

			// Enter to confirm selection
			if (matchesKey(data, Key.enter)) {
				const otherIndex = allOptionLabels.length - 1;
				const otherSelected = selected.has(otherIndex);

				// If "Other" is selected but no text entered, stay in input mode
				if (otherSelected) {
					const customText = editor.getText().trim();
					if (!customText) {
						inputMode = true;
						refresh();
						return;
					}
					// Return selections + custom text
					const selectedLabels: string[] = [];
					for (const idx of selected) {
						if (idx !== otherIndex) {
							selectedLabels.push(stripRecommendedSuffix(optionLabels[idx]));
						}
					}
					done({ selected: selectedLabels, custom_input: customText, cancelled: false });
					return;
				}

				// No "Other" selected - just return selections
				const selectedLabels: string[] = [];
				for (const idx of selected) {
					selectedLabels.push(stripRecommendedSuffix(optionLabels[idx]));
				}
				done({ selected: selectedLabels, cancelled: false });
				return;
			}

			// Escape to cancel
			if (matchesKey(data, Key.escape)) {
				done({ selected: [], cancelled: true });
				return;
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			// Header
			add(theme.fg("accent", "─".repeat(width)));

			// Question with selection count
			const count = selected.size;
			const countText = count > 0 ? theme.fg("success", ` (${count} selected)`) : "";
			add(` ${theme.fg("accent", theme.bold(question))}${countText}`);
			add("");

			// Options
			for (let i = 0; i < allOptionLabels.length; i++) {
				const label = allOptionLabels[i];
				const isSelected = selected.has(i);
				const isCursor = i === cursorIndex;
				const isOther = allowOther && i === allOptionLabels.length - 1;
				const inInputMode = isOther && inputMode;

				const checkbox = isSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const cursor = isCursor ? theme.fg("accent", "> ") : "  ";
				const textColor: ThemeColor = isCursor ? "accent" : isSelected ? "success" : "text";

				if (isOther && (inInputMode || isSelected)) {
					// Show "Other" with editor indicator when editing or selected
					add(`${cursor}${checkbox} ${theme.fg(textColor, `${label} ✎`)}`);
				} else {
					add(`${cursor}${checkbox} ${theme.fg(textColor, label)}`);
				}

				// Show description if available
				if (descriptions && i < descriptions.length && descriptions[i]) {
					add(`     ${theme.fg("muted", descriptions[i]!)}`);
				}
			}

			// Inline editor for "Other" option
			if (inputMode) {
				add("");
				add(` ${theme.fg("muted", "Your answer:")}`);
				for (const line of editor.render(width - 2)) {
					add(` ${line}`);
				}
			}

			// Footer
			add("");
			if (inputMode) {
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else {
				add(theme.fg("dim", " Space toggle • ↑↓ navigate • Enter confirm • Esc cancel"));
			}
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return result ?? { selected: [], cancelled: true };
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: `Ask the user a question and let them pick from options. Use when you need user input to proceed, such as:
  - Gathering user preferences or requirements
  - Clarifying ambiguous instructions
  - Getting decisions on implementation choices
  - Offering choices about what direction to take

The user can select "Other" to type a custom answer inline.
Use multi: true to allow multiple selections (space toggles, enter confirms).
Use recommended: <index> to mark the default option (0-indexed).`,
		shortDescription: "Ask the user a question with selectable options",
		systemGuidelines: [
			"Use ask_user when you need user input to proceed rather than guessing or making assumptions",
			"Prefer ask_user over open-ended text prompts when there are clear options to choose from",
		],
		parameters: AskUserParams,

		async execute(
			_toolCallId: string,
			params: AskUserInput,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ExtensionContext,
		) {
			// Headless fallback
			if (!ctx?.hasUI || !ctx.ui) {
				return {
					content: [{ type: "text" as const, text: "Error: User prompt requires interactive mode" }],
					details: { cancelled: true } as AskUserResult,
				};
			}

			const ui: UIContext = {
				select: ctx.ui.select.bind(ctx.ui),
				input: ctx.ui.input.bind(ctx.ui),
				custom: ctx.ui.custom.bind(ctx.ui),
			};

			const optionLabels = params.options.map((o) => o.label);
			const descriptions = params.options.map((o) => o.description);
			const multi = params.multi ?? false;
			const allowOther = params.allow_other !== false;

			if (params.options.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Error: options must not be empty" }],
					details: { cancelled: true } as AskUserResult,
				};
			}

			const result = multi
				? await askMultiQuestion(ui, params.question, optionLabels, allowOther, params.recommended, descriptions)
				: await askSingleQuestion(ui, params.question, optionLabels, allowOther, params.recommended);

			const details: AskUserResult = {
				question: params.question,
				options: optionLabels,
				multi,
				selected: result.selected,
				custom_input: result.custom_input,
				cancelled:
					"cancelled" in result
						? (result as MultiSelectResult).cancelled
						: result.selected.length === 0 && !result.custom_input,
			};

			// Build response text - show both selections and custom input when present
			let responseText: string;
			if (result.selected.length > 0 && result.custom_input) {
				// Both selections and custom input
				const selectedText = result.selected.join(", ");
				responseText = `User selected: ${selectedText}; and provided custom input: ${result.custom_input}`;
			} else if (result.custom_input) {
				// Only custom input
				responseText = `User provided custom input: ${result.custom_input}`;
			} else if (result.selected.length > 0) {
				// Only selections
				responseText = multi
					? `User selected: ${result.selected.join(", ")}`
					: `User selected: ${result.selected[0]}`;
			} else {
				responseText = "User cancelled the selection";
			}

			return {
				content: [{ type: "text" as const, text: responseText }],
				details,
			};
		},

		renderCall(args, theme) {
			const opts = args.options as OptionItem[] | undefined;
			const count = opts?.length ?? 0;
			const multi = args.multi ?? false;
			const allowOther = args.allow_other !== false;

			let text = `${theme.bold("ask_user")} ${theme.fg("accent", args.question as string)}`;

			const meta: string[] = [];
			if (multi) meta.push("multi");
			if (allowOther) meta.push("other");
			if (count > 0) meta.push(`${count} options`);

			if (meta.length > 0) {
				text += ` ${theme.fg("dim", `(${meta.join(" · ")})`)}`;
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserResult | undefined;
			if (!details) {
				const txt = result.content[0];
				return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			// Both selections and custom input
			if (details.selected.length > 0 && details.custom_input) {
				const lines: string[] = [
					`${theme.fg("success", `✓ ${details.selected.length} selected`)}${theme.fg("muted", " + custom:")}`,
				];
				for (let i = 0; i < details.selected.length; i++) {
					const branch = i === details.selected.length - 1 ? "└─" : "├─";
					lines.push(
						` ${theme.fg("dim", branch)} ${theme.fg("success", "[x]")} ${theme.fg("accent", details.selected[i])}`,
					);
				}
				lines.push(
					` ${theme.fg("dim", "└─")} ${theme.fg("success", "✎")} ${theme.fg("accent", details.custom_input)}`,
				);
				return new Text(lines.join("\n"), 0, 0);
			}

			// Only custom input
			if (details.custom_input) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.custom_input),
					0,
					0,
				);
			}

			if (details.selected.length === 0) {
				return new Text(theme.fg("warning", "No selection"), 0, 0);
			}

			// Only selections (multi)
			if (details.multi) {
				const lines = details.selected.map((s, i) => {
					const branch = i === details.selected.length - 1 ? "└─" : "├─";
					return ` ${theme.fg("dim", branch)} ${theme.fg("success", "[x]")} ${theme.fg("accent", s)}`;
				});
				return new Text(
					`${theme.fg("success", `[x] ${details.selected.length} selected`)}\n${lines.join("\n")}`,
					0,
					0,
				);
			}

			// Single selection
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", details.selected[0]), 0, 0);
		},
	});
}
