import { createBashTool } from "@mariozechner/pi-coding-agent";

const CONTROL_OPERATOR_PATTERN = /&&|\|\||;|`|\$\(|\n|\r/;

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|init|clone|worktree|apply|am|bisect|clean|restore|switch)\b/i,
	/\bgit\s+tag\b(?!\s+--list)/i,
	/\bgit\s+branch\s+-[dD]\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*pwd\b/i,
	/^\s*ls\b/i,
	/^\s*find\b/i,
	/^\s*grep\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*wc\b/i,
	/^\s*sort\b/i,
	/^\s*uniq\b/i,
	/^\s*cut\b/i,
	/^\s*stat\b/i,
	/^\s*realpath\b/i,
	/^\s*which\b/i,
	/^\s*echo\b/i,
	/^\s*printf\b/i,
	/^\s*(env|printenv)\b/i,
	/^\s*uname\b/i,
	/^\s*whoami\b/i,
	/^\s*date\b/i,
	/^\s*git\s+(status|log|diff|show|blame|grep|rev-parse|ls-files|cat-file|describe)\b/i,
	/^\s*git\s+branch\b(\s+--list)?/i,
	/^\s*git\s+tag\s+--list\b/i,
	/^\s*git\s+remote\b(\s+-v)?/i,
	/^\s*git\s+config\s+--get\b/i,
	/^\s*git\s+reflog\s+show\b/i,
];

export function validateReadOnlyBashCommand(command: string): { allowed: boolean; reason?: string } {
	const trimmed = command.trim();

	if (!trimmed) {
		return { allowed: false, reason: "empty command" };
	}

	if (CONTROL_OPERATOR_PATTERN.test(trimmed)) {
		return { allowed: false, reason: "command chaining/subshell syntax is not allowed" };
	}

	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return { allowed: false, reason: "destructive command pattern detected" };
	}

	if (!SAFE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return { allowed: false, reason: "command is not on the read-only allowlist" };
	}

	return { allowed: true };
}

export function createReadOnlyBashTool(cwd: string) {
	const bashTool = createBashTool(cwd);
	type Execute = typeof bashTool.execute;

	const execute: Execute = async (...args) => {
		const [, input] = args;
		const validation = validateReadOnlyBashCommand(input.command);
		if (!validation.allowed) {
			throw new Error(
				`Command blocked by read-only bash policy: ${validation.reason ?? "not allowed"}\nCommand: ${input.command}`,
			);
		}
		return bashTool.execute(...args);
	};

	return {
		...bashTool,
		description: `${bashTool.description} Commands are filtered through a read-only safety policy.`,
		execute,
	};
}
