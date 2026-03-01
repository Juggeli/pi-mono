import type { TestCase } from "./types.js";

// ============================================================================
// Source fixtures — reusable code snippets
// ============================================================================

const SIMPLE_FUNCTION = `function greet(name: string): string {
  const prefix = "Hello";
  return \`\${prefix}, \${name}!\`;
}`;

const MULTI_FUNCTION_FILE = `import { readFile } from "fs/promises";

const DEFAULT_ENCODING = "utf-8";

interface Config {
  path: string;
  verbose: boolean;
  retries: number;
}

function loadConfig(path: string): Config {
  return {
    path,
    verbose: false,
    retries: 3,
  };
}

function formatOutput(data: string, config: Config): string {
  if (config.verbose) {
    console.log("Formatting data:", data.length, "chars");
  }
  return data.trim().toUpperCase();
}

async function processFile(filePath: string): Promise<string> {
  const config = loadConfig(filePath);
  const raw = await readFile(filePath, DEFAULT_ENCODING);
  return formatOutput(raw, config);
}

export { loadConfig, formatOutput, processFile };`;

const CLASS_FILE = `class UserService {
  private users: Map<string, User> = new Map();

  constructor(private readonly db: Database) {}

  async getUser(id: string): Promise<User | null> {
    if (this.users.has(id)) {
      return this.users.get(id)!;
    }
    const user = await this.db.query("SELECT * FROM users WHERE id = ?", [id]);
    if (user) {
      this.users.set(id, user);
    }
    return user;
  }

  async createUser(name: string, email: string): Promise<User> {
    const id = crypto.randomUUID();
    const user = { id, name, email, createdAt: new Date() };
    await this.db.insert("users", user);
    this.users.set(id, user);
    return user;
  }

  async deleteUser(id: string): Promise<boolean> {
    const existed = this.users.delete(id);
    await this.db.delete("users", { id });
    return existed;
  }
}

interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

interface Database {
  query(sql: string, params: unknown[]): Promise<any>;
  insert(table: string, data: Record<string, unknown>): Promise<void>;
  delete(table: string, where: Record<string, unknown>): Promise<void>;
}`;

const SWITCH_FILE = `type LogLevel = "debug" | "info" | "warn" | "error";

function getLogPrefix(level: LogLevel): string {
  switch (level) {
    case "debug":
      return "[DEBUG]";
    case "info":
      return "[INFO]";
    case "warn":
      return "[WARN]";
  }
}

function log(level: LogLevel, message: string): void {
  const prefix = getLogPrefix(level);
  console.log(\`\${prefix} \${message}\`);
}`;

const CALLBACK_FILE = `function fetchData(url: string, callback: (err: Error | null, data?: string) => void): void {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url);
  xhr.onload = function () {
    if (xhr.status === 200) {
      callback(null, xhr.responseText);
    } else {
      callback(new Error(\`HTTP \${xhr.status}\`));
    }
  };
  xhr.onerror = function () {
    callback(new Error("Network error"));
  };
  xhr.send();
}

function processData(input: string, callback: (err: Error | null, result?: number) => void): void {
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed.value !== "number") {
      callback(new Error("Invalid data: missing numeric value"));
      return;
    }
    callback(null, parsed.value * 2);
  } catch (e) {
    callback(e instanceof Error ? e : new Error(String(e)));
  }
}`;

const LOOP_FILE = `interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
}

function findProductsByCategory(products: Product[], category: string): Product[] {
  const result: Product[] = [];
  for (const product of products) {
    if (product.category === category) {
      result.push(product);
    }
  }
  return result;
}

function getTotalPrice(products: Product[]): number {
  let total = 0;
  for (const product of products) {
    total += product.price;
  }
  return total;
}

function findCheapest(products: Product[]): Product | undefined {
  if (products.length === 0) return undefined;
  let cheapest = products[0];
  for (let i = 1; i < products.length; i++) {
    if (products[i].price < cheapest.price) {
      cheapest = products[i];
    }
  }
  return cheapest;
}`;

const OBJECT_LITERAL = `const serverConfig = {
  host: "localhost",
  port: 3000,
  debug: false,
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
};`;

const GENERIC_FETCH = `async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(\`Fetch failed: \${response.status}\`);
  }
  return response.json();
}`;

const NESTED_IF = `function categorize(score: number): string {
  if (score >= 0) {
    if (score < 50) {
      if (score < 25) {
        return "very low";
      } else {
        return "low";
      }
    } else {
      if (score < 75) {
        return "medium";
      } else {
        if (score <= 100) {
          return "high";
        } else {
          return "invalid";
        }
      }
    }
  } else {
    return "invalid";
  }
}`;

const PURE_SIDE_EFFECTS = `let callCount = 0;
const cache: Record<string, number> = {};

function compute(input: string): number {
  callCount++;
  if (cache[input] !== undefined) {
    return cache[input];
  }
  const result = input.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  cache[input] = result;
  console.log(\`Computed \${input} = \${result}\`);
  return result;
}`;

const SIMPLE_ARRAY_FUNC = `function getColors(): string[] {
  return ["red", "green", "blue"];
}`;

const VAR_FILE = `var count = 0;
var name = "world";
var items = [];

function increment() {
  var step = 1;
  count += step;
  return count;
}`;

const TYPE_ANNOTATION_FILE = `function add(a, b) {
  return a + b;
}

function concat(items, separator) {
  return items.join(separator);
}

function findFirst(arr, predicate) {
  for (const item of arr) {
    if (predicate(item)) return item;
  }
  return undefined;
}`;

const RATE_LIMIT_TARGET = `async function callApi(endpoint: string, body: unknown): Promise<Response> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}`;

const DEPRECATION_TARGET = `function oldParser(input: string): string[] {
  return input.split(",").map((s) => s.trim());
}

function newParser(input: string, delimiter = ","): string[] {
  return input.split(delimiter).map((s) => s.trim()).filter(Boolean);
}`;

const READONLY_TARGET = `interface AppState {
  user: {
    name: string;
    email: string;
  };
  settings: {
    theme: string;
    language: string;
  };
  items: string[];
}`;

// ============================================================================
// Synthetic test cases — exact expected output
// ============================================================================

const syntheticCases: TestCase[] = [
	{
		id: "syn-01-replace-value",
		category: "synthetic",
		description: "Replace a string literal value on a single line",
		sourceContent: SIMPLE_FUNCTION,
		prompt: 'Change the prefix variable value from "Hello" to "Hi".',
		expectedContent: `function greet(name: string): string {
  const prefix = "Hi";
  return \`\${prefix}, \${name}!\`;
}`,
	},
	{
		id: "syn-02-rename-function",
		category: "synthetic",
		description: "Rename a function",
		sourceContent: SIMPLE_FUNCTION,
		prompt: 'Rename the function from "greet" to "sayHello".',
		expectedContent: `function sayHello(name: string): string {
  const prefix = "Hello";
  return \`\${prefix}, \${name}!\`;
}`,
	},
	{
		id: "syn-03-add-parameter",
		category: "synthetic",
		description: "Add a parameter to a function signature",
		sourceContent: SIMPLE_FUNCTION,
		prompt: 'Add an optional "exclaim" boolean parameter (default false). If true, append "!!" instead of "!".',
		expectedContent: `function greet(name: string, exclaim = false): string {
  const prefix = "Hello";
  return \`\${prefix}, \${name}\${exclaim ? "!!" : "!"}\`;
}`,
	},
	{
		id: "syn-04-change-return-type",
		category: "synthetic",
		description: "Change return type from string to object",
		sourceContent: SIMPLE_FUNCTION,
		prompt: "Change the function to return { message: string } instead of string. Wrap the template literal in an object.",
		expectedContent: `function greet(name: string): { message: string } {
  const prefix = "Hello";
  return { message: \`\${prefix}, \${name}!\` };
}`,
	},
	{
		id: "syn-05-add-import",
		category: "synthetic",
		description: "Add an import statement at the top of the file",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt: 'Add `import { join } from "path";` right after the existing fs/promises import.',
		expectedContent: MULTI_FUNCTION_FILE.replace(
			'import { readFile } from "fs/promises";',
			'import { readFile } from "fs/promises";\nimport { join } from "path";',
		),
	},
	{
		id: "syn-06-change-config-default",
		category: "synthetic",
		description: "Change a default value in an object literal",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt: "Change the default retries value from 3 to 5 in loadConfig.",
		expectedContent: MULTI_FUNCTION_FILE.replace("retries: 3,", "retries: 5,"),
	},
	{
		id: "syn-07-add-property-to-object",
		category: "synthetic",
		description: "Add a property to an object literal",
		sourceContent: OBJECT_LITERAL,
		prompt: 'Add a "timeout" property with value 5000 after the port property.',
		expectedContent: `const serverConfig = {
  host: "localhost",
  port: 3000,
  timeout: 5000,
  debug: false,
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
};`,
	},
	{
		id: "syn-08-remove-property",
		category: "synthetic",
		description: "Remove a property from an object literal",
		sourceContent: OBJECT_LITERAL,
		prompt: "Remove the debug property from serverConfig.",
		expectedContent: `const serverConfig = {
  host: "localhost",
  port: 3000,
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
};`,
	},
	{
		id: "syn-09-add-array-element",
		category: "synthetic",
		description: "Add an element to an array",
		sourceContent: SIMPLE_ARRAY_FUNC,
		prompt: 'Add "yellow" to the returned array, after "blue".',
		expectedContent: `function getColors(): string[] {
  return ["red", "green", "blue", "yellow"];
}`,
	},
	{
		id: "syn-10-add-else-branch",
		category: "synthetic",
		description: "Add missing case to switch statement",
		sourceContent: SWITCH_FILE,
		prompt: 'Add the missing "error" case to the switch that returns "[ERROR]".',
		expectedContent: SWITCH_FILE.replace(
			`    case "warn":\n      return "[WARN]";`,
			`    case "warn":\n      return "[WARN]";\n    case "error":\n      return "[ERROR]";`,
		),
	},
	{
		id: "syn-11-var-to-const",
		category: "synthetic",
		description: "Convert var declarations to const/let",
		sourceContent: VAR_FILE,
		prompt: "Convert all top-level var declarations to let (count, name, items). Convert the var inside increment to const.",
		expectedContent: VAR_FILE.replace("var count", "let count")
			.replace("var name", "let name")
			.replace("var items", "let items")
			.replace("var step", "const step"),
	},
	{
		id: "syn-12-append-eof-function",
		category: "synthetic",
		description: "Append a new function at end of file",
		sourceContent: SIMPLE_ARRAY_FUNC,
		prompt: 'Add a new function "getWarmColors" that returns ["red", "orange", "yellow"] after the existing function.',
		expectedContent: `function getColors(): string[] {
  return ["red", "green", "blue"];
}

function getWarmColors(): string[] {
  return ["red", "orange", "yellow"];
}`,
	},
	{
		id: "syn-13-prepend-bof-comment",
		category: "synthetic",
		description: "Prepend a header comment at beginning of file",
		sourceContent: SIMPLE_ARRAY_FUNC,
		prompt: "Add a single-line comment at the very top of the file: // Color utility functions",
		expectedContent: `// Color utility functions\n${SIMPLE_ARRAY_FUNC}`,
	},
	{
		id: "syn-14-delete-lines",
		category: "synthetic",
		description: "Delete console.log from a function",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt: 'Remove the console.log line from the formatOutput function (the one that says "Formatting data:").',
		expectedContent: MULTI_FUNCTION_FILE.replace(
			'    console.log("Formatting data:", data.length, "chars");\n',
			"",
		),
	},
	{
		id: "syn-15-expand-oneliner",
		category: "synthetic",
		description: "Expand a one-line return to multiple lines",
		sourceContent: GENERIC_FETCH,
		prompt: "Split the function into separate steps: first call fetch and store in a variable, then check response.ok and throw, then call response.json() and store in a variable, then return it.",
		expectedContent: `async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(\`Fetch failed: \${response.status}\`);
  }
  const data = await response.json();
  return data;
}`,
	},
	{
		id: "syn-16-change-interface-field",
		category: "synthetic",
		description: "Change a field type in an interface",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt: "Change the retries field type in the Config interface from number to { count: number; delay: number }.",
		expectedContent: MULTI_FUNCTION_FILE.replace(
			"  retries: number;",
			"  retries: { count: number; delay: number };",
		),
	},
	{
		id: "syn-17-add-export",
		category: "synthetic",
		description: "Add export keyword to a function",
		sourceContent: SWITCH_FILE,
		prompt: "Make both functions (getLogPrefix and log) exported.",
		expectedContent: SWITCH_FILE.replace("function getLogPrefix", "export function getLogPrefix").replace(
			"function log",
			"export function log",
		),
	},
	{
		id: "syn-18-change-method-body",
		category: "synthetic",
		description: "Replace method body with new implementation",
		sourceContent: CLASS_FILE,
		prompt: "Change the deleteUser method to also clear the user from the cache and return true only if the db delete succeeds. Make it: call db.delete first, then delete from cache, return true.",
		expectedContent: CLASS_FILE.replace(
			`  async deleteUser(id: string): Promise<boolean> {
    const existed = this.users.delete(id);
    await this.db.delete("users", { id });
    return existed;
  }`,
			`  async deleteUser(id: string): Promise<boolean> {
    await this.db.delete("users", { id });
    this.users.delete(id);
    return true;
  }`,
		),
	},
	{
		id: "syn-19-add-cors-method",
		category: "synthetic",
		description: "Add element to nested array in object literal",
		sourceContent: OBJECT_LITERAL,
		prompt: 'Add "DELETE" to the cors.methods array.',
		expectedContent: OBJECT_LITERAL.replace(
			'methods: ["GET", "POST"]',
			'methods: ["GET", "POST", "DELETE"]',
		),
	},
	{
		id: "syn-20-change-encoding",
		category: "synthetic",
		description: "Change a constant value",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt: 'Change DEFAULT_ENCODING from "utf-8" to "utf-16le".',
		expectedContent: MULTI_FUNCTION_FILE.replace('"utf-8"', '"utf-16le"'),
	},
];

// ============================================================================
// Real prompt test cases — validated by pattern matching
// ============================================================================

const realCases: TestCase[] = [
	{
		id: "real-01-input-validation",
		category: "real",
		description: "Add input validation to a function",
		sourceContent: SIMPLE_FUNCTION,
		prompt:
			"Add input validation at the start of greet(): if name is empty or only whitespace, throw an Error saying 'name must not be empty'.",
		expectedPatterns: ["throw", "Error", "name must not be empty", /\.trim\(\)|\.length/],
	},
	{
		id: "real-02-jsdoc",
		category: "real",
		description: "Add JSDoc documentation",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt: "Add JSDoc comments to the loadConfig function describing its parameter and return value.",
		expectedPatterns: ["/**", "@param", "@returns", "*/"],
	},
	{
		id: "real-03-default-case",
		category: "real",
		description: "Add default case to switch",
		sourceContent: SWITCH_FILE,
		prompt: "Add a default case to the switch in getLogPrefix that returns \"[UNKNOWN]\".",
		expectedPatterns: ["default:", "[UNKNOWN]"],
	},
	{
		id: "real-04-async-await",
		category: "real",
		description: "Convert callback to async/await",
		sourceContent: CALLBACK_FILE,
		prompt:
			"Rewrite the fetchData function to use async/await with the Fetch API instead of XMLHttpRequest and callbacks. It should return a Promise<string>.",
		expectedPatterns: ["async", "await", "fetch", "Promise<string>"],
		forbiddenPatterns: ["XMLHttpRequest", /callback\(null/, /callback\(new Error/],
	},
	{
		id: "real-05-try-catch",
		category: "real",
		description: "Add error handling with try/catch",
		sourceContent: GENERIC_FETCH,
		prompt:
			"Wrap the fetch call in a try/catch. In the catch, throw a new Error with a descriptive message that includes the original error.",
		expectedPatterns: ["try", "catch", "throw", "Error"],
	},
	{
		id: "real-06-make-generic",
		category: "real",
		description: "Make a function generic",
		sourceContent: GENERIC_FETCH,
		prompt:
			"Make fetchJson generic: `fetchJson<T>(url: string): Promise<T>`. Add a type assertion on the return.",
		expectedPatterns: ["<T>", "Promise<T>", /as\s+T|<T>/],
	},
	{
		id: "real-07-add-cache",
		category: "real",
		description: "Add memoization cache",
		sourceContent: LOOP_FILE,
		prompt:
			"Add a simple Map-based cache to findProductsByCategory. Use a module-level Map<string, Product[]> keyed by category. Check cache before filtering, store result after.",
		expectedPatterns: ["Map", "get(", "set(", "category"],
	},
	{
		id: "real-08-add-logging",
		category: "real",
		description: "Add logging to trace execution",
		sourceContent: MULTI_FUNCTION_FILE,
		prompt:
			"Add console.log statements at the start and end of processFile: log when starting (with filePath) and when done (with result length).",
		expectedPatterns: ["console.log", "filePath", "length"],
	},
	{
		id: "real-09-null-checks",
		category: "real",
		description: "Add null safety checks",
		sourceContent: CLASS_FILE,
		prompt:
			"Add null/undefined checks to createUser: validate that name and email are non-empty strings before proceeding. Throw an Error with a descriptive message if validation fails.",
		expectedPatterns: ["throw", "Error", /name|email/],
	},
	{
		id: "real-10-private-fields",
		category: "real",
		description: "Convert to ES private fields",
		sourceContent: CLASS_FILE,
		prompt:
			"Convert the 'users' field from TypeScript's 'private' keyword to use the ES native '#users' private field syntax. Update all references.",
		expectedPatterns: ["#users"],
		forbiddenPatterns: [/private users/],
	},
	{
		id: "real-11-timeout",
		category: "real",
		description: "Add timeout to async function",
		sourceContent: GENERIC_FETCH,
		prompt:
			"Add a timeout parameter (default 5000ms) to fetchJson. Use AbortController to abort the fetch if it takes too long.",
		expectedPatterns: ["AbortController", "abort", "timeout", "signal"],
	},
	{
		id: "real-12-early-returns",
		category: "real",
		description: "Refactor nested ifs to early returns",
		sourceContent: NESTED_IF,
		prompt:
			'Refactor categorize() to use early returns and guard clauses instead of deeply nested if/else. The result should be flat: check invalid conditions first, then return progressively.',
		expectedPatterns: ["return"],
		forbiddenPatterns: [/else\s*\{[\s\S]*else\s*\{[\s\S]*else\s*\{/],
	},
	{
		id: "real-13-retry-logic",
		category: "real",
		description: "Add retry logic to fetch",
		sourceContent: GENERIC_FETCH,
		prompt:
			"Add retry logic: take a maxRetries parameter (default 3). On failure, retry up to maxRetries times with a 100ms delay between attempts. Throw the last error if all retries fail.",
		expectedPatterns: ["maxRetries", /retry|attempt|tries/i, /await|delay|sleep|setTimeout/],
	},
	{
		id: "real-14-extract-helper",
		category: "real",
		description: "Extract logic into helper function",
		sourceContent: CLASS_FILE,
		prompt:
			"Extract the cache lookup logic from getUser into a private helper method called 'getCachedUser(id: string): User | undefined'. Use it in getUser.",
		expectedPatterns: ["getCachedUser", "private"],
	},
	{
		id: "real-15-type-annotations",
		category: "real",
		description: "Add TypeScript type annotations",
		sourceContent: TYPE_ANNOTATION_FILE,
		prompt:
			"Add proper TypeScript type annotations to all three functions. 'add' takes two numbers and returns a number. 'concat' takes string[] and string separator, returns string. 'findFirst' is generic: takes T[] and a predicate (item: T) => boolean, returns T | undefined.",
		expectedPatterns: ["number", "string[]", "string", "<T>", "T | undefined", "(item: T) => boolean"],
	},
	{
		id: "real-16-optimize-map",
		category: "real",
		description: "Optimize lookup using Map",
		sourceContent: LOOP_FILE,
		prompt:
			"Optimize findProductsByCategory: instead of returning a filtered array, add a buildCategoryIndex function that creates a Map<string, Product[]> from an array. Then rewrite findProductsByCategory to accept the index map and do an O(1) lookup.",
		expectedPatterns: ["Map<string, Product[]>", "buildCategoryIndex", ".get("],
	},
	{
		id: "real-17-rate-limiter",
		category: "real",
		description: "Add rate limiting",
		sourceContent: RATE_LIMIT_TARGET,
		prompt:
			"Add token-bucket rate limiting to callApi. Add a module-level token bucket (capacity 10, refills 1 per 100ms). Before each call, wait for a token to be available.",
		expectedPatterns: [/token|bucket|capacity/i, /wait|sleep|delay|setTimeout/i],
	},
	{
		id: "real-18-pure-function",
		category: "real",
		description: "Make function pure by removing side effects",
		sourceContent: PURE_SIDE_EFFECTS,
		prompt:
			"Refactor compute() to be a pure function: remove the global callCount mutation, remove the global cache, remove the console.log. Just compute and return the result.",
		expectedPatterns: ["function compute"],
		forbiddenPatterns: ["callCount++", "console.log", "cache[input]"],
	},
	{
		id: "real-19-readonly",
		category: "real",
		description: "Add readonly modifiers to interface",
		sourceContent: READONLY_TARGET,
		prompt:
			"Make the AppState interface deeply readonly: all properties and nested object properties should be readonly. The items array should be readonly string[].",
		expectedPatterns: ["readonly", "readonly string[]"],
	},
	{
		id: "real-20-deprecation",
		category: "real",
		description: "Add deprecation notice",
		sourceContent: DEPRECATION_TARGET,
		prompt:
			"Add a @deprecated JSDoc tag to oldParser saying to use newParser instead. Also add a console.warn inside oldParser that warns about deprecation on each call.",
		expectedPatterns: ["@deprecated", "console.warn", "newParser"],
	},
];

export const ALL_CASES: TestCase[] = [...syntheticCases, ...realCases];
