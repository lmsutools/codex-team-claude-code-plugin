/** Only persisted tool output is trimmed. Parsers consume the original event. */
const outputKeys = new Set(["aggregated_output", "stdout", "stderr", "output", "result", "content"]);
function trimText(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= 4096) return text;
  return bytes.subarray(0, 1024).toString("utf8") +
    `\n[trimmed; original ${bytes.length} bytes]\n` + bytes.subarray(-1024).toString("utf8");
}
export function trimEvent(event) {
  function walk(value, tool = false, output = false) {
    if (typeof value === "string") return output ? trimText(value) : value;
    if (Array.isArray(value)) return value.map(item => walk(item, tool, output));
    if (!value || typeof value !== "object") return value;
    // Reports/messages and error objects are always preserved intact.
    if (/agent_message|reasoning|error|turn.failed/.test(value.type || "")) return value;
    const toolContext = tool || /command|tool|mcp/.test(value.type || "");
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      key === "error" ? child : walk(child, toolContext, toolContext && (outputKeys.has(key) || (output && key === "text"))),
    ]));
  }
  return walk(event);
}
