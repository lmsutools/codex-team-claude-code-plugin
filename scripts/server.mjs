process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Secure process entry point. */
import { invokeTool, oneLine } from "./tool-output.mjs";
import { untrustedOutput } from "./untrusted-output.mjs";
import readline from "node:readline";
import { profileTool, profileSchema, criterionSchema } from "./profile.mjs";
import { reportTool, pushTool, hygieneTool } from "./delivery.mjs";
import { handoffTool } from "./continuity.mjs";
import { batchTool } from "./batch.mjs";
import {
  doctor,
  startJob,
  statusJob,
  cancelJob,
  verifyJob,
  reviewJob,
  contextJob,
  integrateJob,
} from "./runtime.mjs";
const str = (description) => ({ type: "string", description });
const arr = { type: "array", items: { type: "string" } };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const cwd = str(
  "Absolute Git project root in the Claude conversation, never the plugin directory.",
);
import { typicalLine } from "./run-stats.mjs";
const jobId = str("Exact job ID returned by codex_start.");
const assignment = object(
  {
    objective: str("Concrete implementation outcome."),
    scope: {
      ...arr,
      description:
        "Literal relative files/directories using forward slashes. Use . for entire project; no globs.",
    },
    constraints: arr,
    decisions: arr,
    dependencies: arr,
    acceptanceCriteria: {
      type: "array",
      items: criterionSchema,
      description:
        "Observable criteria in stable order; review evidence refers to their zero-based indexes.",
    },
    verification: {
      type: "array",
      items: object(
        {
          id: str("Unique check identifier."),
          command: str(
            "Executable to run directly without a shell. Use node + argument array, or an explicit shell executable if a shell is authorized.",
          ),
          args: arr,
          passEnv: arr,
          host: { type: "boolean" },
          allowInline: { type: "boolean" },
          criteria: { type: "array", items: { type: "integer", minimum: 0 } },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
        },
        ["id", "command"],
      ),
    },
  },
  ["objective", "scope", "acceptanceCriteria", "verification"],
);
const definitions = [
  {
    name: "codex_doctor",
    description:
      "Diagnose the exact Codex executable/version and saved sandbox failures without model usage. Optional probe runs one bounded sandbox command and may invoke normal Windows sandbox setup; use after an authorized repair, not as an automatic retry loop.",
    inputSchema: object({
      cwd,
      jobId,
      probe: { type: "boolean" },
      probeNetwork: str("Opt-in sandbox network probe destination host:port; omitted means no network probe."),
      readOnly: { type: "boolean" },
    }),
    annotations: { readOnlyHint: false },
  },
  {
    name: "codex_start",
    description:
      "Claude delegates code to Codex. Prefer a structured assignment and stable requestId; duplicate requests return the same job. Revisions preserve the exact thread. Completion means implementation_finished, not acceptance.",
    inputSchema: object(
      {
        cwd,
        prompt: str(
          "Additional instructions or revision feedback. Legacy prompt-only calls remain supported.",
        ),
        assignment: { ...assignment, required: [] },
        mode: { type: "string", enum: ["implementation", "scout"] },
        confirmDraftHash: str("Confirm the exact scout draft hash after inspecting its host verification commands."),
        fromScout: str("Completed validated scout job ID; draft fields are shallow-merged with assignment overrides."),
        requestId: str(
          "Stable ID for this assignment attempt. Reuse on transport retry; use a NEW ID for each revision.",
        ),
        resumeJobId: jobId,
        readOnly: { type: "boolean" },
        autoVerify: { type: "boolean" },
        isolation: { type: "string", enum: ["direct", "worktree"] },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 14400 },
        salvageSeconds: { type: "integer", minimum: 0, maximum: 300, description: "Read-only deadline finalize window; 0 disables. Default min(300, 10% of timeout)." },
        maxRevisions: { type: "integer", minimum: 0, maximum: 50 },
        model: str("Optional explicit Codex model; otherwise inherit."),
        effort: {
          type: "string",
          enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        },
        workerProfile: {
          type: "string",
          enum: ["inherit", "local-code"],
          description:
            "local-code disables configured MCP servers/plugins and web search for code-only tasks. Keeps auth, model, instructions, rules and hooks.",
        },
        branch: str("Owned branch."),
        topic: str("Branch topic."),
        lane: str("Explicit lane."),
        contextPacks: arr,
        criteriaTemplates: arr,
        criteriaOmissions: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        batchId: str("Recorded batch ID."),
      },
      ["cwd"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_status",
    description:
      "Recover project jobs or inspect one job, its result, changed files, checks and reviews. Run waitCommand in the background for active jobs. Status checks current content only with refresh:true; verify, review, integration and delivery enforce current content.",
    inputSchema: object(
      { cwd, jobId, waitSeconds: { type: "integer", minimum: 0, maximum: 30 }, refresh: {type:"boolean",description:"Refresh stored review fingerprint and listing after lead edits; snapshots outside the write lock."}, includeProfileChecks: {type:"boolean",description:"Select the fingerprint for the intended verify check plan."} },
      ["cwd"],
    ),
    annotations: { readOnlyHint: true },
  },
  {
    name: "codex_cancel",
    description:
      "Request cancellation during startup, coding or verification. Poll until terminal. Does not erase generated files.",
    inputSchema: object({ cwd, jobId, hostAck: str("Current reviewFingerprint after lead inspection.") }, ["cwd", "jobId"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_verify",
    description:
      "Run the assignment verification commands independently of Codex, as background local processes with deadlines and captured outputs. These commands execute with the host user permissions: use only commands authorized for this task. Refuses out-of-scope or Git metadata changes. Poll status; only stable files and all passing checks yield verified.",
    inputSchema: object(
      { cwd, jobId, hostAck: str("Current reviewFingerprint after lead inspection."), includeProfileChecks: { type: "boolean" } },
      ["cwd", "jobId"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_review",
    description:
      "Claude records a review note, requests revisions, or accepts verified work. Accept requires evidence for every criterion, no worker blockers, and unchanged verified files. This is Claude acceptance, not a new human approval requirement.",
    inputSchema: object(
      {
        cwd,
        jobId,
        action: { type: "string", enum: ["note", "request_changes", "accept"] },
        summary: str("Independent review findings and decision."),
        packetFileObservations: { type: "array", items: object({ file: str("Inspected file."), observation: str("Lead observation of full changes.") }, ["file", "observation"]) },
        handbookNotes: { type: "array", items: { type: "integer", minimum: 0 } },
        evidence: {
          type: "array",
          items: object(
            {
              criterionIndex: { type: "integer", minimum: 0 },
              checkId: str("Passed independent check ID."),
              observation: str(
                "How the checked behavior and inspected diff satisfy this criterion.",
              ),
              leadObservation: object(
                {
                  kind: { type: "string", enum: ["browser", "ownerDecision"] },
                  tool: str("Browser controller declared by the lead."),
                  url: str("Tested URL without credentials or access tokens."),
                  viewports: arr,
                  consoleErrors: arr,
                  failedRequests: arr,
                  attachments: arr,
                  quote: str("Exact owner decision."),
                  date: str("Observation date."),
                },
                ["kind"],
              ),
            },
            ["criterionIndex", "observation"],
          ),
        },
      },
      ["cwd", "jobId", "action", "summary"],
    ),
    annotations: { readOnlyHint: false },
  },
  {
    name: "codex_context",
    description:
      "Recover or update Claude lead decisions, open questions and dependencies for a project. Updates require expectedVersion from a prior read to avoid overwriting another session.",
    inputSchema: object(
      {
        cwd,
        action: { type: "string", enum: ["get", "update", "handbook_get", "handbook_replace"] },
        expectedVersion: { type: "integer", minimum: 0 },
        text: str("Replacement project handbook text; deterministically capped at 16000 characters."),
        expectedHandbookVersion: { type: "integer", minimum: 0 },
        expectedHandbookHash: str("Expected handbook SHA-256."),
        decisions: arr,
        openQuestions: arr,
        dependencies: arr,
        key: str("Branch context key when continuity is enabled."),
        crossLaneRequests: arr,
        nextSteps: arr,
        confirmImported: { type: "array", items: { type: "integer", minimum: 0 } },
      },
      ["cwd"],
    ),
    annotations: { readOnlyHint: false },
  },
  {
    name: "codex_integrate",
    description:
      "Apply accepted worktree file changes to the original project. Refuses if either reviewed worktree or original project changed. Preserves Git index; no commits or pushes. Review and verification must precede integration.",
    inputSchema: object(
      {
        cwd,
        jobId,
        commitMessage: str("Reviewed commit subject/body in branch mode."),
      },
      ["cwd", "jobId"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];
definitions.push(
  {
    name: "codex_profile",
    description:
      "Read, validate, approve or explain optional project policy. Approval records an exact hash; it does not authorize owner-only actions.",
    inputSchema: object(
      {
        cwd,
        action: {
          type: "string",
          enum: ["read", "validate", "approve", "explain"],
        },
        expectedHash: str("Exact resolved hash."),
        profile: profileSchema,
        ownerApprovals: {
          type: "array",
          items: object(
            {
              path: str("Exact owner-authorized file."),
              quote: str("Existing owner authorization."),
              date: str("Authorization date."),
            },
            ["path", "quote", "date"],
          ),
        },
        branch: str("Target branch."),
        topic: str("Target topic."),
        lane: str("Active lane."),
        files: arr,
      },
      ["cwd"],
    ),
    annotations: { readOnlyHint: false },
  },
  {
    name: "codex_report",
    description:
      "Render recorded acceptance evidence or write the authorized delivery report. Writing requires the target hash and commits only the report in branch mode.",
    inputSchema: object(
      {
        cwd,
        jobId,
        action: { type: "string", enum: ["render", "write"] },
        ownerSummary: str("Plain Spanish owner summary."),
        lessonSummary: str("Lesson added or changed."),
        requirementIds: arr,
        schemaNotes: str("Schema changes or none."),
        operatorView: str("Operator view findings."),
        securityNotes: str("Security review performed."),
        evidenceKind: str("local, convex-test or mocked as configured."),
        crossLaneRequests: arr,
        openDecisions: arr,
        deviations: arr,
        expectedTargetHash: str("SHA-256 of current target bytes."),
      },
      ["cwd", "jobId"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_batch",
    description:
      "Run explicitly authorized independent assignments in isolated child worktrees; integrate sequentially and require verification of their union.",
    inputSchema: object(
      {
        cwd,
        action: { type: "string", enum: ["start", "status", "integrate"] },
        requestId: str("Stable batch request ID."),
        batchId: str("Batch ID."),
        authorization: str(
          "Reference to the user's authorization for multiple workers.",
        ),
        branch: str("Parent branch."),
        lane: str("Parent lane."),
        prewireJobId: jobId,
        resolution: object(
          {
            commit: str("Exact resolved parent commit."),
            summary: str("Reviewed conflict resolution."),
          },
          ["commit", "summary"],
        ),
        assignments: {
          type: "array",
          items: object(
            { part: str("Unique lowercase part name."), assignment },
            ["part", "assignment"],
          ),
        },
      },
      ["cwd", "action"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_push",
    description:
      "Explicitly push only the recorded own branch after accepted delivery. Requires exact local commit and policy; force-with-lease additionally requires the expected remote commit.",
    inputSchema: object(
      {
        cwd,
        jobId,
        expectedCommit: str("Exact current commit."),
        forceWithLease: { type: "boolean" },
        expectedRemoteCommit: str("Expected remote SHA for a lease."),
      },
      ["cwd", "jobId", "expectedCommit"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_hygiene",
    description:
      "Check text format against the working baseline or explicitly restore unambiguous original formatting. Fix invalidates verification.",
    inputSchema: object(
      {
        cwd,
        jobId,
        action: { type: "string", enum: ["check", "fix"] },
        files: arr,
        expectedFingerprint: str("Fingerprint returned by check."),
      },
      ["cwd", "jobId"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "codex_handoff",
    description:
      "Export branch context or import notes with version control. Imported notes never grant approvals or acceptance.",
    inputSchema: object(
      {
        cwd,
        action: { type: "string", enum: ["export", "import"] },
        branch: str("Branch."),
        lane: str("Lane."),
        text: str("Handoff Markdown."),
        file: str("Relative handoff input file."),
        write: { type: "boolean" },
        expectedVersion: { type: "integer", minimum: 0 },
        expectedTargetHash: str(
          "SHA-256 of current target bytes, or empty bytes when absent.",
        ),
      },
      ["cwd", "action"],
    ),
    annotations: { readOnlyHint: false },
  },
);
// Reuse the existing lead evidence contract for targeted packet overrides.
for (const name of ["codex_integrate", "codex_commit", "codex_push", "codex_report", "codex_batch"]) { const d=definitions.find(d=>d.name===name); if(d) d.inputSchema.properties.hostAck=str("Current reviewFingerprint after lead inspection."); }
const reviewOptionsSchema = object({native:{type:'boolean'},mode:{type:'string',enum:['standard','adversarial']},focus:{type:'array',maxItems:10,items:{type:'string',maxLength:200}},maxReviewers:{type:'integer',minimum:1,maximum:4}},[]);
definitions.find(d=>d.name==='codex_start').inputSchema.properties.review = reviewOptionsSchema;
const reviewProperties = definitions.find(d => d.name === "codex_review").inputSchema.properties;
reviewProperties.findingDispositions = {type:'array',items:object({findingIndex:{type:'integer',minimum:0},disposition:{type:'string',enum:['not-a-defect','accepted-risk','fixed']},observation:{type:'string',maxLength:1500}},['findingIndex','disposition','observation'])};
reviewProperties.packetEvidenceOverrides = reviewProperties.evidence;
reviewProperties.evidence = { anyOf: [reviewProperties.evidence, { type: "string", enum: ["packet"] }] };
for (const definition of definitions)
  definition.inputSchema.properties.detail = { type: "string", enum: ["compact", "full"], default: "compact" };
const handlers = {
  codex_doctor: doctor,
  codex_start: startJob,
  codex_status: statusJob,
  codex_cancel: cancelJob,
  codex_verify: verifyJob,
  codex_review: reviewJob,
  codex_context: contextJob,
  codex_integrate: integrateJob,
  codex_profile: profileTool,
  codex_report: reportTool,
  codex_batch: batchTool,
  codex_push: pushTool,
  codex_hygiene: hygieneTool,
  codex_handoff: handoffTool,
};
function validate(value, spec, label = "arguments") {
  if (spec.anyOf) {
    for (const child of spec.anyOf)
      try {
        validate(value, child, label);
        return;
      } catch {}
    throw new Error("Invalid " + label);
  }
  if (spec.type === "null") {
    if (value !== null) throw new Error("Invalid " + label);
    return;
  }
  if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(label + " must be an object.");
    for (const key of Object.keys(value))
      if (
        !Object.hasOwn(spec.properties || {}, key) &&
        !spec.additionalProperties
      )
        throw new Error("Unexpected argument: " + key);
    for (const key of spec.required || [])
      if (!(key in value)) throw new Error("Missing argument: " + key);
    for (const [key, child] of Object.entries(value))
      validate(
        child,
        spec.properties?.[key] || spec.additionalProperties,
        label + "." + key,
      );
  } else if (spec.type === "array") {
    if (!Array.isArray(value)) throw new Error(label + " must be an array.");
    for (const child of value) validate(child, spec.items, label);
  } else if (spec.type === "integer") {
    if (
      !Number.isInteger(value) ||
      (spec.minimum !== undefined && value < spec.minimum) ||
      (spec.maximum !== undefined && value > spec.maximum)
    )
      throw new Error("Invalid " + label);
  } else if (typeof value !== spec.type)
    throw new Error(label + " must be " + spec.type);
  if (spec.enum && !spec.enum.includes(value))
    throw new Error("Invalid " + label);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
async function handle(message) {
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize")
    return reply({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "codex-team", version: "1.2.1" },
      instructions:
        "Claude leads; Codex contributes code. Structured assignments require stable request IDs. Poll, review actual changes, independently verify, then record acceptance.",
    });
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") return reply({ tools: definitions.map(tool => { const line = tool.name === "codex_start" ? typicalLine() : ""; return line ? { ...tool, description: tool.description + "\n" + line } : tool; }) });
  if (message.method === "tools/call") {
    try {
      const name = message.params?.name;
      if (!Object.hasOwn(handlers, name))
        throw new Error("Unknown tool: " + name);
      const args = message.params.arguments ?? {};
      validate(args, definitions.find((d) => d.name === name).inputSchema);
      return reply({
        content: [
          { type: "text", text: JSON.stringify(await invokeTool(name, handlers[name], args)) },
        ],
      });
    } catch (error) {
      return reply({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(untrustedOutput({error: message.params?.arguments?.detail === "full" ? error.message : oneLine(error.message, 1000)})) }],
      });
    }
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
}
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
    return;
  }
  handle(message).catch((error) => process.stderr.write(error.message + "\n"));
});
