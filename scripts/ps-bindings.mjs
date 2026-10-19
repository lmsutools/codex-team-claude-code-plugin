/**
 * PowerShell literal-list bindings for the read-evidence heuristic. Scouts on
 * gpt-6-astra (Codex 0.153.2 and 0.163.0 alike) read files as:
 *   $paths = @('src/math.mjs', 'test/math.test.mjs'); foreach ($path in $paths) { Get-Content -LiteralPath $path }
 * A variable resolves only to string literals bound earlier in the same
 * command, and fileReads credits such a read only when the output shows the
 * file's content. Still a bounded heuristic, not a security boundary.
 */
const LITERAL = String.raw`'[^'\r\n]*'|"[^"$` + "`" + String.raw`\r\n]*"`;
const ASSIGN = new RegExp(String.raw`^\$([A-Za-z_]\w*)\s*=\s*(?:@\(\s*)?((?:${LITERAL})(?:\s*,\s*(?:${LITERAL}))*)\s*\)?\s*$`);
const LOOP = /^foreach\s*\(\s*\$([A-Za-z_]\w*)\s+in\s+\$([A-Za-z_]\w*)\s*\)/i;
const VARIABLE = /^\$([A-Za-z_]\w*)$/;
const literals = list => (list.match(new RegExp(LITERAL, "g")) || []).map(value => value.slice(1, -1)).slice(0, 64);
/** Applies one command segment's assignment or foreach binding to `vars` (a Map, mutated). */
export function bindSegment(vars, segment) {
  const text = String(segment || "").trim();
  const assign = text.match(ASSIGN);
  if (assign) { vars.set(assign[1].toLowerCase(), literals(assign[2])); return vars; }
  const loop = text.match(LOOP);
  if (loop) vars.set(loop[1].toLowerCase(), vars.get(loop[2].toLowerCase()) || []);
  return vars;
}
/** Literal values that the variable arguments of a reader stand for. */
export function resolveArguments(vars, argv) {
  return argv.flatMap(arg => {
    const name = String(arg).match(VARIABLE)?.[1]?.toLowerCase();
    return name && vars?.has(name) ? vars.get(name) : [];
  });
}
/** True when one of the file's first substantial lines appears in the command output. */
export function outputShowsContent(output, content) {
  const shown = String(output || "").slice(0, 262144);
  const lines = String(content || "").split(/\r?\n/).slice(0, 200).map(line => line.trim()).filter(line => line.length >= 8).slice(0, 5);
  return lines.some(line => shown.includes(line));
}
