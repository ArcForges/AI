// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { moduleReferences, tokenize } from "../../eng/policy/source-lexer.ts";

const references = (source: string) =>
  moduleReferences(tokenize(source)).map((item) => [item.form, item.specifier, item.typeOnly]);
const words = (source: string) =>
  tokenize(source)
    .filter((token) => token.kind === "word")
    .map((token) => token.value);

/** The substitution opener, kept out of plain string literals. */
const sub = "$";

describe("policy lexer", () => {
  it("ignores comments, strings, templates without substitutions and regular expressions", () => {
    const source = [
      "// eval(1)",
      "/* new Function('x') */",
      "const a = \"eval(1)\" + 'Reflect.ownKeys' + `Atomics.wait`;",
      "const b = /Reflect\\.get\\(/u.test(a) ? 1 / 2 : 3;",
    ].join("\n");
    expect(words(source)).toEqual(["const", "a", "const", "b", "test", "a"]);
  });

  it("exposes template substitutions as tokens", () => {
    const source = `log(\`failed ${sub}{token} ${sub}{ \`${sub}{secret}\` }\`)`;
    expect(words(source)).toEqual(["log", "token", "secret"]);
  });

  it("distinguishes division from a regular expression", () => {
    expect(tokenize("x = a / b / c;").some((token) => token.kind === "regex")).toBe(false);
    expect(tokenize("x = /a\\/b/g;").filter((token) => token.kind === "regex")).toHaveLength(1);
    expect(tokenize("return /x/.test(y);").filter((token) => token.kind === "regex")).toHaveLength(
      1,
    );
  });

  it("recognises every static module declaration form", () => {
    const source = [
      'import "side-effect";',
      'import def, { a as b, type C } from "pkg";',
      'import * as ns from "namespace";',
      'import type { T } from "types-only";',
      'export * from "re-all";',
      'export { x } from "re-named";',
      'export type { Y } from "re-type";',
      'const m = await import("dynamic");',
      'const r = require("cjs");',
      "export const own = 1;",
      "export { own as other };",
    ].join("\n");
    expect(references(source)).toEqual([
      ["import", "side-effect", false],
      ["import", "pkg", false],
      ["import", "namespace", false],
      ["import", "types-only", true],
      ["export", "re-all", false],
      ["export", "re-named", false],
      ["export", "re-type", true],
      ["dynamic", "dynamic", false],
      ["require", "cjs", false],
    ]);
  });

  it("records import bindings and reports computed specifiers as null", () => {
    const [first] = moduleReferences(tokenize('import def, { a as b, type C } from "pkg";'));
    expect([...(first?.bindings ?? [])]).toEqual([
      ["def", "default"],
      ["b", "a"],
      ["C", "C"],
    ]);
    expect(references(`import(\`./${sub}{name}\`); require(name); import(x);`)).toEqual([
      ["dynamic", null, false],
      ["require", null, false],
      ["dynamic", null, false],
    ]);
  });

  it("does not mistake members or import.meta for declarations", () => {
    expect(references("obj.import('x'); obj.require('y'); import.meta.url;")).toEqual([]);
  });

  it("does not read module syntax inside strings or comments", () => {
    expect(references('const s = "import x from \'y\'"; // import z from "w"')).toEqual([]);
  });
});
