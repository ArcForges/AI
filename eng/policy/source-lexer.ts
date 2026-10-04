// SPDX-License-Identifier: AGPL-3.0-only
// Lexical model used by the AI architecture policy. It is deliberately not a
// parser: comments are discarded, string/template/regular-expression bodies are
// opaque, and module declarations are recognised from the remaining tokens.
// Forms it cannot classify with certainty are reported by the caller as
// computed or unresolved, so the policy fails closed instead of guessing.

export type TokenKind = "word" | "string" | "template" | "number" | "regex" | "punct";

export interface Token {
  kind: TokenKind;
  /** Decoded text for strings, raw text for every other kind. */
  value: string;
  line: number;
  /** A template literal that contains at least one substitution. */
  dynamic?: boolean;
}

export interface ModuleReference {
  specifier: string | null;
  form: "import" | "export" | "dynamic" | "require";
  /** Local name -> imported name; `*` for namespace imports, `default` for defaults. */
  bindings: Map<string, string>;
  typeOnly: boolean;
  line: number;
}

const punctuators = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];
const valueWords = new Set(["this", "super", "null", "true", "false", "undefined"]);
const regexStarters = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function decode(body: string) {
  return body.replace(
    /\\u\{([a-f\d]+)\}|\\u([a-f\d]{4})|\\x([a-f\d]{2})|\\([\s\S])/giu,
    (_all, wide: string, unicode: string, hex: string, escaped: string) => {
      const code = wide || unicode || hex;
      if (!code) return escaped;
      const point = Number.parseInt(code, 16);
      return point > 0x10ffff ? "�" : String.fromCodePoint(point);
    },
  );
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  const scan = (start: number, end: number, nested: boolean): number => {
    let index = start;
    let depth = 0;
    const last = () => tokens.at(-1);
    while (index < end) {
      const char = source[index] as string;
      if (char === "\n") {
        line++;
        index++;
        continue;
      }
      if (/\s/u.test(char)) {
        index++;
        continue;
      }
      if (char === "/" && source[index + 1] === "/") {
        while (index < end && source[index] !== "\n") index++;
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        const close = source.indexOf("*/", index + 2);
        const stop = close < 0 ? end : close + 2;
        for (const ch of source.slice(index, stop)) if (ch === "\n") line++;
        index = stop;
        continue;
      }
      if (char === '"' || char === "'") {
        let cursor = index + 1;
        while (cursor < end && source[cursor] !== char && source[cursor] !== "\n")
          cursor += source[cursor] === "\\" ? 2 : 1;
        tokens.push({ kind: "string", value: decode(source.slice(index + 1, cursor)), line });
        index = cursor + 1;
        continue;
      }
      if (char === "`") {
        let cursor = index + 1;
        let text = "";
        let dynamic = false;
        const startLine = line;
        const inner: [number, number][] = [];
        while (cursor < end && source[cursor] !== "`") {
          if (source[cursor] === "\\") {
            text += source.slice(cursor, cursor + 2);
            cursor += 2;
            continue;
          }
          if (source[cursor] === "$" && source[cursor + 1] === "{") {
            dynamic = true;
            let nesting = 1;
            let probe = cursor + 2;
            while (probe < end && nesting > 0) {
              const c = source[probe] as string;
              if (c === "{") nesting++;
              else if (c === "}") nesting--;
              else if (c === '"' || c === "'" || c === "`") {
                // Skip nested literal bodies so their braces do not count.
                const quote = c;
                probe++;
                while (probe < end && source[probe] !== quote)
                  probe += source[probe] === "\\" ? 2 : 1;
              }
              probe++;
            }
            inner.push([cursor + 2, probe - 1]);
            cursor = probe;
            continue;
          }
          if (source[cursor] === "\n") line++;
          text += source[cursor];
          cursor++;
        }
        tokens.push({ kind: "template", value: decode(text), line: startLine, dynamic });
        const resume = line;
        for (const [from, to] of inner) {
          tokens.push({ kind: "punct", value: "${", line });
          scan(from, to, true);
          tokens.push({ kind: "punct", value: "}", line });
        }
        line = Math.max(line, resume);
        index = cursor + 1;
        continue;
      }
      const numeric =
        /^(?:0[xXbBoO][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/u.exec(
          source.slice(index, Math.min(end, index + 64)),
        );
      if (numeric && (/\d/u.test(char) || (char === "." && /\d/u.test(source[index + 1] ?? "")))) {
        tokens.push({ kind: "number", value: numeric[0], line });
        index += numeric[0].length;
        continue;
      }
      if (/[A-Za-z_$]/u.test(char) || char.charCodeAt(0) > 127) {
        let cursor = index + 1;
        while (cursor < end && /[\w$]|[^\x00-\x7f]/u.test(source[cursor] as string)) cursor++;
        tokens.push({ kind: "word", value: source.slice(index, cursor), line });
        index = cursor;
        continue;
      }
      if (char === "/") {
        const previous = last();
        const divides =
          previous !== undefined &&
          (previous.kind === "number" ||
            previous.kind === "string" ||
            previous.kind === "template" ||
            previous.kind === "regex" ||
            (previous.kind === "word" &&
              (valueWords.has(previous.value) || !regexStarters.has(previous.value))) ||
            [")", "]", "}"].includes(previous.value));
        if (!divides) {
          let cursor = index + 1;
          let inClass = false;
          while (cursor < end && source[cursor] !== "\n") {
            const c = source[cursor] as string;
            if (c === "\\") cursor++;
            else if (c === "[") inClass = true;
            else if (c === "]") inClass = false;
            else if (c === "/" && !inClass) break;
            cursor++;
          }
          cursor++;
          while (cursor < end && /[a-z]/u.test(source[cursor] as string)) cursor++;
          tokens.push({ kind: "regex", value: source.slice(index, cursor), line });
          index = cursor;
          continue;
        }
      }
      const matched = punctuators.find((item) => source.startsWith(item, index));
      const value = matched ?? char;
      if (nested) {
        if (value === "{") depth++;
        else if (value === "}") depth--;
      }
      tokens.push({ kind: "punct", value, line });
      index += value.length;
    }
    return index;
  };
  scan(0, source.length, false);
  return tokens;
}

const word = (token: Token | undefined, value?: string) =>
  token?.kind === "word" && (value === undefined || token.value === value);
const punct = (token: Token | undefined, value: string) =>
  token?.kind === "punct" && token.value === value;
const literal = (token: Token | undefined) =>
  token?.kind === "string" || (token?.kind === "template" && !token.dynamic);

export function moduleReferences(tokens: Token[]): ModuleReference[] {
  const references: ModuleReference[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind !== "word") continue;
    const previous = tokens[index - 1];
    // A property or member named import/require is not a module declaration.
    if (punct(previous, ".") || punct(previous, "?.")) continue;
    const next = tokens[index + 1];
    if ((token.value === "import" || token.value === "require") && punct(next, "(")) {
      const argument = tokens[index + 2];
      const closing = tokens[index + 3];
      references.push({
        specifier:
          literal(argument) && (punct(closing, ")") || punct(closing, ","))
            ? (argument as Token).value
            : null,
        form: token.value === "import" ? "dynamic" : "require",
        bindings: new Map(),
        typeOnly: false,
        line: token.line,
      });
      continue;
    }
    if (token.value !== "import" && token.value !== "export") continue;
    let cursor = index + 1;
    let typeOnly = false;
    if (word(tokens[cursor], "type") && !word(tokens[cursor + 1], "from")) {
      typeOnly = true;
      cursor++;
    }
    const bindings = new Map<string, string>();
    if (token.value === "import" && literal(tokens[cursor])) {
      references.push({
        specifier: (tokens[cursor] as Token).value,
        form: "import",
        bindings,
        typeOnly,
        line: token.line,
      });
      continue;
    }
    if (token.value === "export" && !(punct(tokens[cursor], "{") || punct(tokens[cursor], "*")))
      continue;
    let imported = true;
    while (cursor < tokens.length) {
      const current = tokens[cursor] as Token;
      if (word(current, "from")) break;
      if (current.kind === "punct" && !["{", "}", ",", "*"].includes(current.value)) {
        imported = false;
        break;
      }
      if (current.kind === "string" || current.kind === "template") {
        imported = false;
        break;
      }
      if (punct(current, "{")) {
        cursor++;
        while (cursor < tokens.length && !punct(tokens[cursor], "}")) {
          let name = tokens[cursor] as Token;
          if (word(name, "type") && word(tokens[cursor + 1]) && !word(tokens[cursor + 1], "as"))
            name = tokens[++cursor] as Token;
          const alias = word(tokens[cursor + 1], "as") ? (tokens[cursor + 2] as Token) : name;
          if (name.kind === "word" || name.kind === "string") bindings.set(alias.value, name.value);
          cursor += alias === name ? 1 : 3;
          if (punct(tokens[cursor], ",")) cursor++;
        }
        cursor++;
        continue;
      }
      if (punct(current, "*")) {
        const alias = word(tokens[cursor + 1], "as") ? (tokens[cursor + 2] as Token) : null;
        if (alias) bindings.set(alias.value, "*");
        cursor += alias ? 3 : 1;
        continue;
      }
      if (word(current)) {
        if (token.value === "import") bindings.set(current.value, "default");
        cursor++;
        continue;
      }
      cursor++;
    }
    if (!imported || !word(tokens[cursor], "from")) continue;
    const target = tokens[cursor + 1];
    references.push({
      specifier: literal(target) ? (target as Token).value : null,
      form: token.value as "import" | "export",
      bindings,
      typeOnly,
      line: token.line,
    });
  }
  return references;
}

/** Texts of every word token, in order; used for identifier-level rules. */
export const words = (tokens: Token[]) =>
  tokens.filter((token) => token.kind === "word").map((token) => token.value);
