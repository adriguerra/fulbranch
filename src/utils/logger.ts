/**
 * Structured logger with two output formats.
 *
 * Format selection (LOG_FORMAT env):
 *   - "json"   → one NDJSON record per line. Use this for production /
 *                log aggregators (Datadog, Loki, Cloudwatch, etc.).
 *   - "pretty" → human-readable, columnar, ANSI-colored. Use this for
 *                local `docker compose up` / interactive dev.
 *
 * Default resolution:
 *   - explicit LOG_FORMAT wins
 *   - else NODE_ENV=production → "json"
 *   - else                     → "pretty"
 *
 * Colors are auto-disabled when NO_COLOR is set (https://no-color.org).
 *
 * The runtime API is intentionally identical between formats so call sites
 * (`logger.info("event", { issueId, ... })`) don't need to know which mode
 * is active.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  msg: string;
}

type LogFormat = "json" | "pretty";

function resolveFormat(): LogFormat {
  const env = (Bun.env.LOG_FORMAT || "").toLowerCase();
  if (env === "json" || env === "pretty") return env as LogFormat;
  if (Bun.env.NODE_ENV === "production") return "json";
  return "pretty";
}

const FORMAT: LogFormat = resolveFormat();

// NO_COLOR (any non-empty value) disables ANSI escapes per https://no-color.org.
const COLOR = FORMAT === "pretty" && !Bun.env.NO_COLOR;

// ─── Pretty-format helpers ────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function paint(text: string, color: string): string {
  return COLOR ? `${color}${text}${ANSI.reset}` : text;
}

const LEVEL_FMT: Record<LogLevel, { label: string; color: string }> = {
  debug: { label: "DEBG", color: ANSI.gray },
  info:  { label: "INFO", color: ANSI.cyan },
  warn:  { label: "WARN", color: ANSI.yellow },
  error: { label: "ERR ", color: ANSI.red },
};

// Width budgets — pads keep columns aligned across mixed event sources.
// Values longer than the budget are truncated; we accept that for a rare
// long component name in exchange for predictable scanning.
const COMPONENT_WIDTH = 18;
const ISSUE_WIDTH = 8;
const MAX_VALUE_LEN = 300;

// Fields rendered inline by the column layout — skipped from the trailing
// `key=value` cloud so they aren't printed twice.
const SKIP_FIELDS = new Set(["ts", "level", "msg", "component", "issueId"]);

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function formatPretty(record: LogRecord): string {
  // "2026-04-27T21:06:02.046Z" → "21:06:02"
  const time = paint(record.ts.slice(11, 19), ANSI.dim);

  const lvl = LEVEL_FMT[record.level];
  const level = paint(lvl.label, lvl.color);

  const component = typeof record.component === "string" ? record.component : "";
  const compCol = paint(pad(component, COMPONENT_WIDTH), ANSI.magenta);

  const issueId = typeof record.issueId === "string" ? record.issueId : "";
  const issueCol = paint(pad(issueId, ISSUE_WIDTH), ANSI.green);

  const msg = paint(record.msg, ANSI.bold);

  const parts: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    if (SKIP_FIELDS.has(k)) continue;
    parts.push(`${paint(k, ANSI.gray)}=${formatValue(v)}`);
  }
  const tail = parts.length > 0 ? "  " + parts.join(" ") : "";

  return `${time} ${level} ${compCol} ${issueCol} ${msg}${tail}`;
}

function formatValue(v: unknown): string {
  if (v === null) return paint("null", ANSI.gray);
  if (v === undefined) return paint("undefined", ANSI.gray);
  if (typeof v === "string") {
    if (v.length === 0) return paint('""', ANSI.gray);
    // Quote strings containing whitespace or `"`/`=` so the key=value layout
    // stays parseable; bare for short identifiers like "ERP-12".
    if (/[\s"=]/.test(v)) {
      const out = JSON.stringify(v);
      return out.length > MAX_VALUE_LEN ? out.slice(0, MAX_VALUE_LEN - 3) + '..."' : out;
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Object/array: inline JSON, truncated.
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    json = String(v);
  }
  return json.length > MAX_VALUE_LEN ? json.slice(0, MAX_VALUE_LEN - 3) + "..." : json;
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

function emit(level: LogLevel, msg: string, fields: LogFields, base: LogFields): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
    ...fields,
  };
  // warn/error → stderr; info/debug → stdout. Mirrors typical 12-factor
  // convention so log shippers can split severities.
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const line = FORMAT === "pretty" ? formatPretty(record) : JSON.stringify(record);
  stream.write(line + "\n");
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function make(base: LogFields): Logger {
  return {
    debug: (msg, fields = {}) => emit("debug", msg, fields, base),
    info: (msg, fields = {}) => emit("info", msg, fields, base),
    warn: (msg, fields = {}) => emit("warn", msg, fields, base),
    error: (msg, fields = {}) => emit("error", msg, fields, base),
    child: (fields) => make({ ...base, ...fields }),
  };
}

export const logger: Logger = make({});
