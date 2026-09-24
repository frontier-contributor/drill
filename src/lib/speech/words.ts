/* ============================================================================
 * words.ts — what a reply sounds like, before any voice is involved.
 *
 * A voice reads exactly the characters it is handed, and model output is not
 * written to be heard. `\frac{1}{2m}` handed to a voice is "backslash frac", an
 * arrow is silence, a link is forty characters of punctuation, and a
 * 900-character sentence is a minute of audio that Chrome's own voice abandons
 * after fifteen seconds.
 *
 * So everything a voice needs is decided here, as plain string functions:
 *
 *   texToWords     LaTeX as a person says it. Maths is the part of a reply in
 *                  this app that matters most and survives being read worst.
 *   speakable      prose, with its symbols, abbreviations and links spelled out
 *   sentenceSpans  where the sentences are, as offsets into the text, so the
 *                  page can light up the one being read
 *   splitSpoken    a sentence cut to a size every engine accepts
 *   planChunks     which sentences travel together in one request
 *
 * Pure: no DOM, no voices, no network. lib/speech/segment.ts walks the
 * rendered reply and hands its text to these; words.test.ts holds the rest.
 * ========================================================================== */

/** The longest piece of text any engine is handed at once. Groq's speech
 *  endpoint refuses more than 200 characters, and Chrome cuts its own voice
 *  off after about fifteen seconds — which lands in the same place. One
 *  number keeps every engine inside both. */
export const MAX_SPOKEN = 200;

/** The first request carries a sentence or two so the voice starts quickly.
 *  Later ones can be longer: the next is always being fetched ahead. */
export const FIRST_CHUNK = 240;

/** Speech runs near 150 words a minute, about fifteen characters a second.
 *  Only ever used to say "about a minute left" — never to bill anything. */
export const CHARS_PER_SECOND = 15;

export function secondsFor(chars: number, rate = 1): number {
  return Math.max(0, chars) / CHARS_PER_SECOND / (rate > 0 ? rate : 1);
}

/* ------------------------------------------------------------------ maths -- */

type Tok =
  | { t: "cmd"; v: string }
  | { t: "open" }
  | { t: "close" }
  | { t: "sup" }
  | { t: "sub" }
  | { t: "ch"; v: string }
  | { t: "sp" };

const CMD_RE = /\\([A-Za-z]+|[^A-Za-z])/y;
const NUM_RE = /\d+(?:\.\d+)?/y;

function tokenize(tex: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < tex.length) {
    const ch = tex[i];
    if (ch === "\\") {
      CMD_RE.lastIndex = i;
      const m = CMD_RE.exec(tex);
      if (m) {
        out.push({ t: "cmd", v: m[1] });
        i += m[0].length;
      } else i++;
    } else if (ch === "{") {
      out.push({ t: "open" });
      i++;
    } else if (ch === "}") {
      out.push({ t: "close" });
      i++;
    } else if (ch === "^") {
      out.push({ t: "sup" });
      i++;
    } else if (ch === "_") {
      out.push({ t: "sub" });
      i++;
    } else if (/\s/.test(ch)) {
      out.push({ t: "sp" });
      i++;
    } else {
      NUM_RE.lastIndex = i;
      const n = NUM_RE.exec(tex);
      const v = n ? n[0] : ch;
      out.push({ t: "ch", v });
      i += v.length;
    }
  }
  return out;
}

interface Atom {
  say: string;
  /** Carries an operator — "a + b" rather than "2m". A fraction or a script
   *  around one needs a spoken comma to stay unambiguous; "2m" does not. */
  ops: boolean;
  /** Is an operator. */
  op?: boolean;
  /** Can take an argument: f, sigma, log. "f(x)" is "f of x". */
  fn?: boolean;
  /** Waiting for its limits: the sum, the integral, the limit, the gradient. */
  big?: string;
  /** A blackboard set — R, N, Z — whose superscript is a dimension, not a power. */
  set?: boolean;
  /** Came in brackets, which a power turns into "the quantity". */
  paren?: boolean;
}

const GREEK: Record<string, string> = {
  alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta", epsilon: "epsilon", varepsilon: "epsilon",
  zeta: "zeta", eta: "eta", theta: "theta", vartheta: "theta", iota: "iota", kappa: "kappa", lambda: "lambda",
  mu: "mu", nu: "nu", xi: "xi", pi: "pi", varpi: "pi", rho: "rho", varrho: "rho", sigma: "sigma",
  varsigma: "sigma", tau: "tau", upsilon: "upsilon", phi: "phi", varphi: "phi", chi: "chi", psi: "psi",
  omega: "omega", Gamma: "gamma", Delta: "delta", Theta: "theta", Lambda: "lambda", Xi: "xi", Pi: "pi",
  Sigma: "sigma", Upsilon: "upsilon", Phi: "phi", Psi: "psi", Omega: "omega", ell: "l", hbar: "h bar"
};

const FUNCTIONS: Record<string, string> = {
  log: "log", ln: "natural log", lg: "log", exp: "exp", sin: "sine", cos: "cosine", tan: "tangent",
  sinh: "hyperbolic sine", cosh: "hyperbolic cosine", tanh: "tanh", det: "determinant", tr: "trace",
  Tr: "trace", dim: "dimension", rank: "rank", deg: "degree", Pr: "probability", sgn: "sign", arg: "arg"
};

/** Said as a relation or an operation, so a group holding one is "compound". */
const OPERATORS: Record<string, string> = {
  le: "is less than or equal to", leq: "is less than or equal to", leqslant: "is less than or equal to",
  ge: "is greater than or equal to", geq: "is greater than or equal to", geqslant: "is greater than or equal to",
  ne: "is not equal to", neq: "is not equal to", approx: "is approximately", simeq: "is approximately",
  sim: "is distributed as", equiv: "is equivalent to", cong: "is congruent to", propto: "is proportional to",
  ll: "is much less than", gg: "is much greater than", in: "in", notin: "not in", ni: "contains",
  subset: "is a subset of", subseteq: "is a subset of", supset: "is a superset of", supseteq: "is a superset of",
  cup: "union", cap: "intersect", setminus: "minus", to: "to", rightarrow: "to", longrightarrow: "to",
  mapsto: "maps to", leftarrow: "gets", gets: "gets", Rightarrow: "implies", implies: "implies",
  Longrightarrow: "implies", Leftrightarrow: "if and only if", iff: "if and only if", forall: "for all",
  exists: "there exists", neg: "not", lnot: "not", land: "and", wedge: "and", lor: "or", vee: "or",
  times: "times", cdot: "times", div: "divided by", pm: "plus or minus", mp: "minus or plus", ast: "star",
  circ: "composed with", odot: "element-wise times", otimes: "tensor", oplus: "direct sum", mid: "given",
  perp: "is perpendicular to", parallel: "is parallel to", triangleq: "is defined as",
  coloneqq: "is defined as", doteq: "is defined as", "&": "and"
};

/** Said as a thing rather than an operation. */
const SYMBOLS: Record<string, string> = {
  infty: "infinity", partial: "partial", emptyset: "the empty set", varnothing: "the empty set",
  angle: "angle", prime: "prime", top: "transpose", intercal: "transpose", dagger: "dagger", star: "star",
  ldots: "dot dot dot", dots: "dot dot dot", cdots: "dot dot dot", vdots: "dot dot dot", ddots: "dot dot dot",
  "%": "percent"
};

/** Operators that take limits underneath and on top. */
const BIG: Record<string, string> = {
  sum: "sum", prod: "product", coprod: "coproduct", int: "integral", iint: "double integral",
  oint: "contour integral", lim: "limit", limsup: "limit superior", liminf: "limit inferior", max: "max",
  min: "min", sup: "supremum", inf: "infimum", argmax: "arg max", argmin: "arg min", bigcup: "union",
  bigcap: "intersection", nabla: "gradient"
};

/** Spacing, sizing and style switches, and the closing half of a pair. */
const SILENT = new Set([
  "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "middle",
  "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", ",", ";", ":", "!", " ", "quad", "qquad",
  "enspace", "thinspace", "medspace", "thickspace", "nonumber", "notag", "{", "}", "rangle", "rVert", "rvert",
  "$", "#", "_"
]);

const CHAR_SAY: Record<string, string> = {
  "+": "plus", "-": "minus", "=": "equals", "<": "is less than", ">": "is greater than", ",": ",", ";": ",",
  ":": ",", "!": "factorial", "*": "star", "/": "over", ".": "", "&": "", "~": "", ")": "", "]": ""
};

class Reader {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    let j = this.i;
    while (this.toks[j]?.t === "sp") j++;
    return this.toks[j];
  }
  take(): Tok | undefined {
    while (this.toks[this.i]?.t === "sp") this.i++;
    return this.toks[this.i++];
  }
  /** Spaces included — `\text{if }` keeps its word gap. */
  takeRaw(): Tok | undefined {
    return this.toks[this.i++];
  }
}

function isCh(t: Tok | undefined, v: string): boolean {
  return !!t && t.t === "ch" && t.v === v;
}

function isCmd(t: Tok | undefined, ...names: string[]): boolean {
  return !!t && t.t === "cmd" && names.includes(t.v);
}

function merge(atoms: Atom[], extra?: Partial<Atom>): Atom {
  if (atoms.length === 1) return { ...atoms[0], ...extra };
  return { say: atoms.map((a) => a.say).join(" "), ops: atoms.some((a) => a.op || a.ops), ...extra };
}

function enclose(prefix: string, inner: Atom[]): Atom | null {
  if (!inner.length) return null;
  const m = merge(inner);
  return { say: `${prefix} ${m.say}${m.ops ? "," : ""}`, ops: m.ops };
}

function ordinal(s: string): string {
  if (s === "2") return "square";
  if (s === "3") return "cube";
  return /^\d+$/.test(s) ? s + "th" : s + "-th";
}

function sequence(r: Reader, until: (t: Tok) => boolean, inParen = false): Atom[] {
  const out: Atom[] = [];
  for (let t = r.peek(); t && !until(t); t = r.peek()) {
    const a = atom(r, inParen);
    if (!a) continue;
    const full = scripts(r, a);
    out.push(full);
    const next = r.peek();
    if (full.fn && !full.big && (isCh(next, "(") || isCh(next, "["))) out.push({ say: "of", ops: false });
  }
  return out;
}

/** Always consumes at least one token, which is what keeps every loop above
 *  from spinning on input it does not understand. */
function atom(r: Reader, inParen: boolean): Atom | null {
  const t = r.take();
  if (!t) return null;
  if (t.t === "open") {
    const inner = sequence(r, (x) => x.t === "close");
    if (r.peek()?.t === "close") r.take();
    return inner.length ? merge(inner) : null;
  }
  if (t.t === "ch") return charAtom(r, t.v, inParen);
  if (t.t === "cmd") return commandAtom(r, t.v);
  return null;
}

function argument(r: Reader): Atom | null {
  const t = r.peek();
  if (!t || t.t === "close") return null;
  return atom(r, false);
}

function charAtom(r: Reader, v: string, inParen: boolean): Atom | null {
  if (/^\d/.test(v)) return { say: v, ops: false };
  if (/^[A-Za-z]$/.test(v)) return { say: v, ops: false, fn: true };
  if (v === "'") return { say: "prime", ops: false };
  if (v === "(" || v === "[") {
    const close = v === "(" ? ")" : "]";
    const inner = sequence(r, (x) => isCh(x, close), true);
    if (isCh(r.peek(), close)) r.take();
    return inner.length ? merge(inner, { paren: true }) : null;
  }
  if (v === "|") {
    /* Inside brackets a bar is almost always conditioning — p(y|x). Outside
       them it opens an absolute value. */
    if (inParen) return { say: "given", ops: false, op: true };
    const inner = sequence(r, (x) => isCh(x, "|"));
    if (isCh(r.peek(), "|")) r.take();
    return enclose("the absolute value of", inner);
  }
  const said = CHAR_SAY[v];
  if (said !== undefined) return said ? { say: said, ops: false, op: true } : null;
  return { say: v, ops: false };
}

/** Text in a brace group, as written: `\text{softmax}`, `\operatorname{ReLU}`. */
function rawGroup(r: Reader): string {
  if (r.peek()?.t !== "open") return "";
  r.take();
  let depth = 1;
  let out = "";
  for (let t = r.takeRaw(); t; t = r.takeRaw()) {
    if (t.t === "open") depth++;
    else if (t.t === "close") {
      if (--depth === 0) break;
    } else if (t.t === "sp" || t.t === "sub") out += " ";
    else if (t.t === "ch") out += t.v;
    else if (t.t === "cmd") out += /^[A-Za-z]+$/.test(t.v) ? " " + t.v + " " : /[,;: ]/.test(t.v) ? " " : t.v;
  }
  return out.replace(/\s+/g, " ").trim();
}

function accent(r: Reader, word: string): Atom | null {
  const a = argument(r);
  return a ? { say: `${a.say} ${word}`, ops: a.ops, fn: a.fn } : null;
}

function environment(r: Reader): Atom | null {
  const name = rawGroup(r).replace(/\*$/, "");
  const atEnd = (x: Tok) => isCmd(x, "end");
  if (/matrix$/.test(name) || name === "array" || name === "tabular") {
    /* A matrix read cell by cell is a minute of numbers nobody can hold in
       their head. Saying that there is one is the useful part. */
    for (let t = r.peek(); t && !atEnd(t); t = r.peek()) r.take();
    if (r.peek()) {
      r.take();
      rawGroup(r);
    }
    return { say: "a matrix", ops: false };
  }
  const inner = sequence(r, atEnd);
  if (r.peek()) {
    r.take();
    rawGroup(r);
  }
  if (!inner.length) return null;
  const body = merge(inner);
  return { say: name === "cases" ? `cases: ${body.say}` : body.say, ops: true };
}

function commandAtom(r: Reader, name: string): Atom | null {
  if (name === "arg" && isCmd(r.peek(), "max", "min")) {
    const t = r.take() as { t: "cmd"; v: string };
    return { say: "", ops: false, big: "arg " + t.v };
  }
  if (name in GREEK) return { say: GREEK[name], ops: false, fn: true };
  if (name in FUNCTIONS) return { say: FUNCTIONS[name], ops: false, fn: true };
  if (name in OPERATORS) return { say: OPERATORS[name], ops: false, op: true };
  if (name in SYMBOLS) return { say: SYMBOLS[name], ops: false };
  if (name in BIG) return { say: "", ops: false, big: BIG[name] };

  switch (name) {
    case "frac":
    case "dfrac":
    case "tfrac":
    case "cfrac": {
      const num = argument(r);
      const den = argument(r);
      if (!num || !den) return num || den;
      /* "1 over 2 m" needs no help. "a plus b over c" does: said flat it is
         a + b/c, so a compound numerator is announced as a fraction and each
         compound part is closed with a pause. */
      if (num.ops) return { say: `the fraction ${num.say}, over ${den.say}${den.ops ? "," : ""}`, ops: true };
      return { say: `${num.say} over ${den.say}${den.ops ? "," : ""}`, ops: true };
    }
    case "binom": {
      const n = argument(r);
      const k = argument(r);
      return n && k ? { say: `${n.say} choose ${k.say}`, ops: true } : n || k;
    }
    case "sqrt": {
      let index: Atom | null = null;
      if (isCh(r.peek(), "[")) {
        r.take();
        const inner = sequence(r, (x) => isCh(x, "]"));
        if (isCh(r.peek(), "]")) r.take();
        index = inner.length ? merge(inner) : null;
      }
      const body = argument(r);
      if (!body) return null;
      const head = index ? `the ${ordinal(index.say)} root of` : "the square root of";
      return { say: `${head} ${body.say}${body.ops ? "," : ""}`, ops: body.ops };
    }
    case "text":
    case "textrm":
    case "textit":
    case "textbf":
    case "textsf":
    case "texttt":
    case "mathrm":
    case "mathit":
    case "mathsf":
    case "mathtt":
    case "operatorname": {
      if (isCh(r.peek(), "*")) r.take();
      const raw = rawGroup(r);
      if (/^arg\s*(max|min)$/i.test(raw)) return { say: "", ops: false, big: raw.toLowerCase().replace(/^arg\s*/, "arg ") };
      return raw ? { say: raw, ops: false, fn: true } : null;
    }
    case "mathbb": {
      const a = argument(r);
      return a ? { ...a, set: /^[RNZQC]$/.test(a.say) } : null;
    }
    case "mathbf":
    case "boldsymbol":
    case "bm":
    case "mathcal":
    case "mathscr":
    case "mathfrak":
    case "mathnormal":
    case "vec":
    case "overrightarrow":
    case "underline":
      return argument(r);
    case "hat":
    case "widehat":
      return accent(r, "hat");
    case "bar":
    case "overline":
      return accent(r, "bar");
    case "tilde":
    case "widetilde":
      return accent(r, "tilde");
    case "dot":
      return accent(r, "dot");
    case "ddot":
      return accent(r, "double dot");
    case "|":
    case "lVert":
    case "Vert": {
      const inner = sequence(r, (x) => isCmd(x, "|", "rVert", "Vert"));
      if (r.peek()) r.take();
      return enclose("the norm of", inner);
    }
    case "lvert": {
      const inner = sequence(r, (x) => isCmd(x, "rvert"));
      if (r.peek()) r.take();
      return enclose("the absolute value of", inner);
    }
    case "langle": {
      const inner = sequence(r, (x) => isCmd(x, "rangle"));
      if (r.peek()) r.take();
      return enclose("the inner product of", inner);
    }
    case "\\":
    case "cr":
    case "newline":
      return { say: ",", ops: false, op: true };
    case "begin":
      return environment(r);
    case "end":
    case "label":
    case "tag":
    case "color":
    case "hspace":
    case "vspace":
      rawGroup(r);
      return null;
    case "textcolor":
      rawGroup(r);
      return argument(r);
    default:
      if (SILENT.has(name)) return null;
      /* A named command nobody listed is most likely a macro the model made
         up. Its name is the best guess at what it means. */
      return /^[A-Za-z]+$/.test(name) ? { say: name, ops: false, fn: true } : null;
  }
}

function big(name: string, sub: Atom | null, sup: Atom | null): Atom {
  let say: string;
  if (name === "gradient") say = sub ? `the gradient with respect to ${sub.say} of` : "the gradient of";
  else if (name.startsWith("limit")) say = sub ? `the ${name} as ${sub.say.replace(/\bto\b/, "goes to")} of` : `the ${name} of`;
  else if (sub && sup) say = `the ${name} from ${sub.say} to ${sup.say} of`;
  else if (sub) say = `the ${name} over ${sub.say} of`;
  else if (sup) say = `the ${name} up to ${sup.say} of`;
  else say = `the ${name} of`;
  return { say, ops: true };
}

function power(base: Atom, sup: Atom): string {
  const s = sup.say.trim();
  if (base.set) return s.replace(/\btimes\b/g, "by");
  if (s === "2") return "squared";
  if (s === "3") return "cubed";
  if (s === "T" || s === "transpose") return "transpose";
  if (s === "minus 1") return "inverse";
  if (s === "star" || s === "prime" || s === "dagger") return s;
  /* x^{(i)} is the i-th example, not x raised to anything — the convention
     every ML course writes in. */
  if (sup.paren) return `superscript ${s}`;
  if (!sup.ops || /^minus \S+$/.test(s)) return `to the ${s}`;
  return `to the power of ${s},`;
}

function scripts(r: Reader, base: Atom): Atom {
  let sub: Atom | null = null;
  let sup: Atom | null = null;
  let primes = 0;
  for (;;) {
    const t = r.peek();
    if (t?.t === "sub" && !sub) {
      r.take();
      sub = argument(r);
    } else if (t?.t === "sup" && !sup) {
      r.take();
      sup = argument(r);
    } else if (isCh(t, "'")) {
      r.take();
      primes++;
    } else break;
  }
  if (base.big) return big(base.big, sub, sup);
  if (!sub && !sup && !primes) return base;

  let say = base.paren && base.ops ? `the quantity ${base.say},` : base.say;
  if (primes) say += primes === 1 ? " prime" : primes === 2 ? " double prime" : " triple prime";
  if (sub) say += ` sub ${sub.say}${sub.ops ? "," : ""}`;
  if (sup) say += " " + power(base, sup);
  return { say, ops: base.ops || !!sub?.ops || !!sup?.ops, fn: base.fn };
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

/** LaTeX as it would be said aloud — "x sub i squared", "1 over 2 m",
 *  "the sum from i equals 1 to m of". Deliberately a subset: the notation
 *  replies in this app actually use, with anything unknown falling back to
 *  its own name rather than to punctuation. */
export function texToWords(tex: string): string {
  const r = new Reader(tokenize(String(tex || "")));
  return tidy(
    sequence(r, () => false)
      .map((a) => a.say)
      .join(" ")
  );
}

/* ------------------------------------------------------------------ prose -- */

const ABBREVIATIONS: [RegExp, string][] = [
  [/\be\.g\.(?=[\s,)]|$)/gi, "for example"],
  [/\bi\.e\.(?=[\s,)]|$)/gi, "that is"],
  [/\bw\.r\.t\.?(?=[\s,)]|$)/gi, "with respect to"],
  [/\ba\.k\.a\.?(?=[\s,)]|$)/gi, "also known as"],
  [/\betc\.(?=[\s,)]|$)/gi, "et cetera"],
  [/\bet al\.(?=[\s,)]|$)/gi, "and others"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\.(?=\s)/gi, "approximately"],
  [/\bcf\.(?=\s)/gi, "compare"]
];

const SYMBOL_WORDS: [RegExp, string][] = [
  [/https?:\/\/[^\s<>()]+/gi, " a link "],
  [/\bwww\.[^\s<>()]+/gi, " a link "],
  [/\s*(?:<=>|<->|⇔|↔)\s*/g, " if and only if "],
  [/\s*(?:=>|⇒|⟹)\s*/g, " implies "],
  [/\s*(?:->|→|⟶)\s*/g, " to "],
  [/\s*(?:<-|←)\s*/g, " from "],
  [/\s*(?:>=|≥)\s*/g, " greater than or equal to "],
  [/\s*(?:<=|≤)\s*/g, " less than or equal to "],
  [/\s*(?:!=|≠)\s*/g, " not equal to "],
  [/\s*≈\s*/g, " approximately "],
  [/\s*±\s*/g, " plus or minus "],
  [/\s*×\s*/g, " times "],
  [/\s*÷\s*/g, " divided by "],
  [/\s*∝\s*/g, " proportional to "],
  [/\s+=\s+/g, " equals "],
  [/\s+\+\s+/g, " plus "],
  [/\s+>\s+/g, " greater than "],
  [/\s+<\s+/g, " less than "],
  [/\s*[—–]\s*/g, ", "],
  [/∞/g, " infinity "],
  [/∑/g, " sum "],
  [/∏/g, " product "],
  [/∫/g, " integral "],
  [/√/g, " square root of "],
  [/∂/g, " partial "],
  [/∇/g, " gradient "],
  [/∉/g, " not in "],
  [/∈/g, " in "],
  [/⁻¹/g, " inverse "],
  [/²/g, " squared "],
  [/³/g, " cubed "],
  [/°/g, " degrees "],
  [/\s&\s/g, " and "],
  [/~(?=\d)/g, "about "]
];

const GREEK_CHARS: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta",
  θ: "theta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho",
  σ: "sigma", ς: "sigma", τ: "tau", υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
  Γ: "gamma", Δ: "delta", Θ: "theta", Λ: "lambda", Ξ: "xi", Π: "pi", Σ: "sigma", Φ: "phi", Ψ: "psi",
  Ω: "omega"
};

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** Prose as a voice should get it: abbreviations and symbols in words, links
 *  named rather than spelled, emoji and leftover markdown dropped. */
export function speakable(text: string): string {
  let s = String(text || "");
  for (const [re, word] of ABBREVIATIONS) s = s.replace(re, word);
  for (const [re, word] of SYMBOL_WORDS) s = s.replace(re, word);
  s = s.replace(/[α-ωΑ-Ωϵϕ]/g, (c) => (GREEK_CHARS[c] ? ` ${GREEK_CHARS[c]} ` : c));
  s = s.replace(/[₀-₉]+/g, (m) => " sub " + [...m].map((c) => SUBSCRIPT_DIGITS.indexOf(c)).join("") + " ");
  s = s.replace(/[⁰¹⁴-⁹]+/g, (m) => " to the " + [...m].map((c) => SUPERSCRIPT_DIGITS.indexOf(c)).join("") + " ");
  s = s.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, " ");
  /* What is left of markdown and code: underscores in identifiers read as
     gaps ("x_train" is "x train"), and the rest is punctuation a voice would
     either skip or pronounce. */
  s = s.replace(/[*_`#|\\^~<>{}[\]]+/g, " ");
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,(?:\s*,)+/g, ",")
    .trim();
}

/** A heading or a list item has no full stop, and without one the next
 *  sentence runs straight on in the same breath. */
export function finishSentence(s: string): string {
  /* A trailing comma is where a table row ended, not a pause worth keeping:
     "Adam, yes," becomes "Adam, yes." rather than "Adam, yes,." */
  const t = s.trim().replace(/[,\s]+$/, "");
  if (!t) return t;
  return /[.!?…:;]["')\]]*$/.test(t) ? t : t + ".";
}

const CODE_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  tsx: "TypeScript", py: "Python", python: "Python", bash: "Shell", sh: "Shell", shell: "Shell", zsh: "Shell",
  console: "Shell", json: "JSON", css: "CSS", html: "HTML", xml: "XML", sql: "SQL", rust: "Rust", go: "Go",
  java: "Java", cpp: "C plus plus", "c++": "C plus plus", c: "C", r: "R", yaml: "YAML", yml: "YAML",
  markdown: "Markdown"
};

/** What is said in place of a code block. Code read aloud is a stream of
 *  brackets nobody can follow; saying there is some, and in what, is the
 *  part a listener can use. */
export function codeCue(lang: string): string {
  const name = codeName(lang);
  return name ? `${name} code, skipped.` : "A code block, skipped.";
}

/** A fence's language as a person says it — "Python", "C plus plus" — or ""
 *  when the fence names none worth saying. */
export function codeName(lang: string): string {
  const l = String(lang || "").trim().toLowerCase();
  if (!l || l === "text" || l === "plaintext") return "";
  return CODE_NAMES[l] || l.charAt(0).toUpperCase() + l.slice(1);
}

/* -------------------------------------------------------------- sentences -- */

export interface Span {
  start: number;
  end: number;
}

/* A break after one of these is a full stop that is not the end of a
   sentence. ICU already knows "e.g." and decimals; these are the ones it was
   seen to split. */
const NO_BREAK_AFTER = /\b(?:e\.g|i\.e|etc|vs|cf|approx|fig|figs|eq|eqs|no|dr|mr|mrs|ms|prof|sec|ch|al|resp|incl|ca|st)\.\s*$/i;

function trimSpan(text: string, sp: Span): Span {
  let { start, end } = sp;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** Sentence boundaries as offsets into `text`, trimmed of surrounding space.
 *  Offsets rather than strings because the caller maps them back onto the
 *  page to highlight the sentence being read. */
export function sentenceSpans(text: string): Span[] {
  const raw: Span[] = [];
  const Seg = typeof Intl !== "undefined" ? (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter : undefined;
  if (typeof Seg === "function") {
    for (const s of new Seg("en", { granularity: "sentence" }).segment(text)) {
      raw.push({ start: s.index, end: s.index + s.segment.length });
    }
  } else {
    let start = 0;
    const re = /[.!?]+["')\]]*\s+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      raw.push({ start, end: m.index + m[0].length });
      start = m.index + m[0].length;
    }
    if (start < text.length) raw.push({ start, end: text.length });
  }

  const merged: Span[] = [];
  for (const sp of raw) {
    const prev = merged[merged.length - 1];
    if (prev && NO_BREAK_AFTER.test(text.slice(prev.start, prev.end))) prev.end = sp.end;
    else merged.push({ ...sp });
  }
  return merged
    .map((sp) => trimSpan(text, sp))
    .filter((sp) => sp.end > sp.start && /[\p{L}\p{N}\uFFFC]/u.test(text.slice(sp.start, sp.end)));
}

/** One spoken sentence cut into pieces no longer than `max`, at a clause if
 *  there is one late enough, otherwise at a word, and only as a last resort
 *  in the middle of one. */
export function splitSpoken(text: string, max = MAX_SPOKEN): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    const clause = /[,;:)](?=\s)/g;
    for (let m = clause.exec(window); m; m = clause.exec(window)) {
      if (m.index >= max * 0.4 && m.index < max) cut = m.index + 1;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(" ");
      cut = space >= max * 0.4 ? space : max;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/* ----------------------------------------------------------------- chunks -- */

/** Group sentences into requests: in order, each group within `maxChars`
 *  (counting the space that joins them), the first one smaller so the voice
 *  starts fast. A `maxChars` of 0 puts every sentence in a group of its own. */
export function planChunks(lengths: number[], maxChars: number, firstChars = FIRST_CHUNK): number[][] {
  const chunks: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  lengths.forEach((n, i) => {
    const limit = chunks.length === 0 ? Math.min(firstChars, maxChars) : maxChars;
    if (cur.length && len + 1 + n > limit) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    len += (cur.length ? 1 : 0) + n;
    cur.push(i);
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}
