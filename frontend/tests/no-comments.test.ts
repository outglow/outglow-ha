import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "mock", "tests", "e2e", "scripts"];
const FILES = ["vite.config.ts", "vite.mock.config.ts", "vitest.config.ts", "playwright.config.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return /\.(ts|js|mjs)$/.test(name) ? [path] : [];
  });
}

export function comments(text: string): number[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const lines: number[] = [];
  const kinds = new Set([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia]);
  const open: ("brace" | "template")[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenBraceToken) {
      open.push("brace");
    } else if (token === ts.SyntaxKind.TemplateHead) {
      open.push("template");
    } else if (token === ts.SyntaxKind.CloseBraceToken && open.at(-1) === "template") {
      if (scanner.reScanTemplateToken(false) === ts.SyntaxKind.TemplateTail) {
        open.pop();
      }
    } else if (token === ts.SyntaxKind.CloseBraceToken) {
      open.pop();
    } else if (kinds.has(token)) {
      lines.push(text.slice(0, scanner.getTokenStart()).split("\n").length);
    }
  }
  return lines;
}

describe("comment scanner", () => {
  it("finds comments outside strings and templates only", () => {
    const text = ["const a = \"https://x\"; /" + "/ one", "const b = `x ${a} // not ${`${a}`}` /" + "* two *" + "/;", "function f() { return 1; }", "/" + "/ three"].join("\n");
    expect(comments(text)).toEqual([1, 2, 4]);
  });
});

describe("no comments in TypeScript (D9)", () => {
  const files = [...DIRS.flatMap((d) => sources(join(ROOT, d))), ...FILES.map((f) => join(ROOT, f))];
  it.each(files.map((f) => [relative(ROOT, f), f]))("%s", (_name, path) => {
    expect(comments(readFileSync(path, "utf8"))).toEqual([]);
  });
});
