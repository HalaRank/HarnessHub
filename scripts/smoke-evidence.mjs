// Only output from successfully completed native tools in THIS Turn is evidence.
// Prompt/input text and activity in a later cancellation Turn are not execution proof.
export function smokeEvidence(events, turn, workspace, sentinel) {
  const sameTurn = events.filter((event) => event.turnId === turn.id);
  const tools = new Map();
  const strings = (value) => {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
  };
  for (const event of sameTurn) {
    if (!["tool_call", "tool_call_update"].includes(event.kind)) continue;
    const p = event.payload;
    if (typeof p?.toolCallId !== "string") continue;
    const tool = tools.get(p.toolCallId) ?? { status: null, output: [], exitCode: null };
    if (p.status) tool.status = p.status;
    if (p.rawOutput !== undefined) tool.output.push(...strings(p.rawOutput));
    for (const block of Array.isArray(p.content) ? p.content : [])
      if (block.content?.type === "text") tool.output.push(block.content.text);
    const delta = p._meta?.terminal_output_delta;
    if (typeof delta?.data === "string") tool.output.push(delta.data);
    const exit = p._meta?.terminal_exit;
    if (typeof exit?.exit_code === "number") tool.exitCode = exit.exit_code;
    tools.set(p.toolCallId, tool);
  }
  const completed = [...tools.values()].filter(
    (tool) => tool.status === "completed" && (tool.exitCode === null || tool.exitCode === 0),
  );
  const output = completed.flatMap((tool) => [...tool.output, tool.output.join("")]);
  const readVerified = output.some((text) => text.includes(sentinel));
  const pwdVerified = output.some((text) =>
    text.split(/\r?\n/).some((line) => line.trim() === workspace),
  );
  return {
    toolCalls: tools.size,
    completedTools: completed.length,
    readVerified,
    pwdVerified,
    agentText: sameTurn
      .filter((event) => event.kind === "agent_message_chunk")
      .map((event) => event.payload?.content?.text ?? "")
      .join(""),
    toolsVerified: readVerified && pwdVerified,
  };
}
