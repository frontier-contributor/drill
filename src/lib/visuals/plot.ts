/* ============================================================================
 * plot.ts — a function plot with sliders, compiled to a Vega-Lite spec.
 *
 * Vega-Lite can already draw y = f(x) with a slider per parameter: a sequence
 * of x values, a calculate per function, and params bound to range inputs. But
 * a model asked to write that spec from scratch gets it subtly wrong often
 * enough to matter — the fold, the expression syntax, `datum.` on every x — and
 * "show me what the learning rate does" is exactly the figure this app exists
 * to draw well. So the model writes the small shape in the catalogue and this
 * writes the spec.
 *
 * The expression compiler emits only what it recognised: numbers, x, the
 * declared parameters, a fixed list of functions and constants. Anything else
 * is refused with its name, so model text never reaches a Vega expression as
 * text — Vega's own language is sandboxed, and this does not rely on it.
 *
 * Pure.
 * ========================================================================== */

type Range3 = [number, number, number];

interface PlotInput {
  title?: unknown;
  x?: unknown;
  y?: unknown;
  fn?: unknown;
  labels?: unknown;
  params?: unknown;
  points?: unknown;
}

/** Functions a plot may call, and the Vega expression each becomes. */
const FUNCTIONS: Record<string, { arity: [number, number]; emit: (a: string[]) => string }> = {
  sin: { arity: [1, 1], emit: ([a]) => `sin(${a})` },
  cos: { arity: [1, 1], emit: ([a]) => `cos(${a})` },
  tan: { arity: [1, 1], emit: ([a]) => `tan(${a})` },
  asin: { arity: [1, 1], emit: ([a]) => `asin(${a})` },
  acos: { arity: [1, 1], emit: ([a]) => `acos(${a})` },
  atan: { arity: [1, 1], emit: ([a]) => `atan(${a})` },
  atan2: { arity: [2, 2], emit: ([a, b]) => `atan2(${a},${b})` },
  exp: { arity: [1, 1], emit: ([a]) => `exp(${a})` },
  log: { arity: [1, 1], emit: ([a]) => `log(${a})` },
  ln: { arity: [1, 1], emit: ([a]) => `log(${a})` },
  log10: { arity: [1, 1], emit: ([a]) => `(log(${a})/LN10)` },
  log2: { arity: [1, 1], emit: ([a]) => `(log(${a})/LN2)` },
  sqrt: { arity: [1, 1], emit: ([a]) => `sqrt(${a})` },
  abs: { arity: [1, 1], emit: ([a]) => `abs(${a})` },
  floor: { arity: [1, 1], emit: ([a]) => `floor(${a})` },
  ceil: { arity: [1, 1], emit: ([a]) => `ceil(${a})` },
  round: { arity: [1, 1], emit: ([a]) => `round(${a})` },
  pow: { arity: [2, 2], emit: ([a, b]) => `pow(${a},${b})` },
  min: { arity: [2, 8], emit: (a) => `min(${a.join(",")})` },
  max: { arity: [2, 8], emit: (a) => `max(${a.join(",")})` },
  sigmoid: { arity: [1, 1], emit: ([a]) => `(1/(1+exp(-(${a}))))` },
  relu: { arity: [1, 1], emit: ([a]) => `max(0,${a})` },
  softplus: { arity: [1, 1], emit: ([a]) => `log(1+exp(${a}))` },
  tanh: { arity: [1, 1], emit: ([a]) => `((exp(2*(${a}))-1)/(exp(2*(${a}))+1))` },
  sinh: { arity: [1, 1], emit: ([a]) => `((exp(${a})-exp(-(${a})))/2)` },
  cosh: { arity: [1, 1], emit: ([a]) => `((exp(${a})+exp(-(${a})))/2)` }
};

const CONSTANTS: Record<string, string> = { pi: "PI", e: "E" };

type Token = { t: "num"; v: string } | { t: "name"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const s = src.replace(/\*\*/g, "^");
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const name = /^[a-z_][a-z0-9_]*/i.exec(s.slice(i));
    if (name) {
      out.push({ t: "name", v: name[0] });
      i += name[0].length;
      continue;
    }
    if ("+-*/^(),".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new Error(`"${ch}" is not something a plot's function can contain`);
  }
  return out;
}

/** Compile one function of x into a Vega expression. */
export function compileExpression(src: string, params: readonly string[]): string {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const take = (v: string) => {
    if (!isOp(v)) throw new Error(`expected "${v}" in ${src}`);
    pos++;
  };

  const expr = (): string => {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = tokens[pos++].v;
      left = `(${left}${op}${term()})`;
    }
    return left;
  };
  const term = (): string => {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = tokens[pos++].v;
        left = `(${left}${op}${unary()})`;
        continue;
      }
      /* Written maths multiplies by juxtaposition: 2x, 3(x+1), a sin(x). */
      const next = peek();
      if (next && (next.t === "num" || next.t === "name" || (next.t === "op" && next.v === "("))) {
        left = `(${left}*${unary()})`;
        continue;
      }
      return left;
    }
  };
  const unary = (): string => {
    if (isOp("-")) {
      pos++;
      return `(-${unary()})`;
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  };
  const power = (): string => {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return `pow(${base},${unary()})`;
    }
    return base;
  };
  const primary = (): string => {
    const tok = peek();
    if (!tok) throw new Error(`${src} ends too soon`);
    if (tok.t === "num") {
      pos++;
      return tok.v;
    }
    if (tok.t === "op" && tok.v === "(") {
      pos++;
      const inner = expr();
      take(")");
      return `(${inner})`;
    }
    if (tok.t === "name") {
      pos++;
      const name = tok.v;
      const lower = name.toLowerCase();
      if (FUNCTIONS[lower] && isOp("(")) {
        pos++;
        const args = [expr()];
        while (isOp(",")) {
          pos++;
          args.push(expr());
        }
        take(")");
        const f = FUNCTIONS[lower];
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new Error(`${name} takes ${f.arity[0]} argument(s)`);
        return f.emit(args);
      }
      if (name === "x") return "datum.x";
      if (params.includes(name)) return name;
      if (CONSTANTS[lower]) return CONSTANTS[lower];
      throw new Error(`"${name}" is not x, a declared parameter, or a function a plot knows`);
    }
    throw new Error(`unexpected "${tok.v}" in ${src}`);
  };

  const out = expr();
  if (pos < tokens.length) throw new Error(`unexpected "${tokens[pos].v}" in ${src}`);
  return out;
}

function pair(v: unknown, fallback: [number, number] | null): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return fallback;
  const a = Number(v[0]);
  const b = Number(v[1]);
  return Number.isFinite(a) && Number.isFinite(b) && a < b ? [a, b] : fallback;
}

const RESERVED = new Set(["x", ...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), "datum", "PI", "E"]);

function readParams(v: unknown): Record<string, Range3> {
  const out: Record<string, Range3> = {};
  if (!v || typeof v !== "object") return out;
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]{0,15}$/i.test(name) || RESERVED.has(name) || RESERVED.has(name.toLowerCase())) {
      throw new Error(`"${name}" cannot be a parameter name`);
    }
    const r = raw as unknown[] | { min?: unknown; max?: unknown; value?: unknown };
    const [min, max, value] = Array.isArray(r) ? r.map(Number) : [Number(r?.min), Number(r?.max), Number(r?.value)];
    if (![min, max].every(Number.isFinite) || min >= max) throw new Error(`parameter "${name}" needs [min, max, start]`);
    out[name] = [min, max, Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : (min + max) / 2];
  }
  return out;
}

function niceStep(min: number, max: number): number {
  const raw = (max - min) / 100;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return Number((Math.round(raw / mag) * mag).toPrecision(6)) || raw;
}

export function compilePlot(source: string): Record<string, unknown> {
  let input: PlotInput;
  try {
    input = JSON.parse(source) as PlotInput;
  } catch {
    try {
      input = JSON.parse(source.replace(/,\s*([}\]])/g, "$1")) as PlotInput;
    } catch (e) {
      throw new Error(`the plot is not valid JSON (${(e as Error).message})`);
    }
  }
  const fns = (Array.isArray(input.fn) ? input.fn : typeof input.fn === "string" ? [input.fn] : []).filter(
    (f): f is string => typeof f === "string" && !!f.trim()
  );
  if (!fns.length) throw new Error('the plot has no "fn" to draw');
  if (fns.length > 6) throw new Error("a plot can show at most six functions");

  const params = readParams(input.params);
  const names = Object.keys(params);
  const [x0, x1] = pair(input.x, [-5, 5])!;
  const y = pair(input.y, null);
  const points = Math.min(1000, Math.max(20, Math.round(Number(input.points) || 240)));
  const step = (x1 - x0) / points;
  const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
  const series = fns.map((f, i) => ({ as: `f${i}`, expr: compileExpression(f, names), label: labels[i] || f }));

  /* The label shown for each series, as a Vega expression. JSON.stringify
     writes a correctly escaped string literal for whatever the label says. */
  const labelExpr = series.reduceRight(
    (rest, s) => `datum.series === ${JSON.stringify(s.as)} ? ${JSON.stringify(s.label)} : ${rest}`,
    '""'
  );

  return {
    ...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim() } : {}),
    width: "container",
    height: 280,
    params: Object.entries(params).map(([name, [min, max, value]]) => ({
      name,
      value,
      bind: { input: "range", min, max, step: niceStep(min, max), name: `${name} ` }
    })),
    data: { sequence: { start: x0, stop: x1 + step / 2, step, as: "x" } },
    transform: [
      ...series.map((s) => ({ calculate: s.expr, as: s.as })),
      { fold: series.map((s) => s.as), as: ["series", "y"] },
      { calculate: labelExpr, as: "fn" },
      { filter: "isFinite(datum.y)" }
    ],
    mark: { type: "line", clip: true, strokeWidth: 2 },
    encoding: {
      x: { field: "x", type: "quantitative", title: "x", scale: { domain: [x0, x1], nice: false } },
      y: {
        field: "y",
        type: "quantitative",
        title: series.length === 1 ? series[0].label : "y",
        scale: y ? { domain: y } : { zero: false }
      },
      color: { field: "fn", type: "nominal", title: null, legend: series.length > 1 ? { orient: "top" } : null },
      tooltip: [
        { field: "fn", title: "f" },
        { field: "x", format: ".3~f" },
        { field: "y", format: ".3~f" }
      ]
    }
  };
}
