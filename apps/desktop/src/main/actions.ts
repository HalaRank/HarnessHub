import type { Approval, Draft, Turn } from "@harnesshub/shared";
import { type Client, HttpError } from "@harnesshub/shared/client";
import type { DesktopRequest } from "../contracts";

// The renderer never supplies a URL, method, headers, executable or credential.
export async function performAction(client: Client, request: DesktopRequest): Promise<unknown> {
  const base = "conversationId" in request ? `/v1/conversations/${request.conversationId}` : "";
  switch (request.type) {
    case "project.branches":
      return client.request(`/v1/projects/${request.projectId}/branches`);
    case "changes.list":
      return client.request(`${base}/changes`);
    case "changes.diff":
      return client.request(`${base}/changes?path=${encodeURIComponent(request.path)}`);
    case "workspace.open":
      return client.request(`${base}/workspace/location`, "POST", request.location);
    case "worktrees.list":
      return client.request("/v1/worktrees");
    case "worktrees.cleanup":
      return client.request(`/v1/worktrees/${request.worktreeId}/cleanup`, "POST", {
        confirmed: request.confirmed,
      });
    case "history":
      return client.request(`${base}/events?after_seq=${request.after}&limit=200`);
    case "draft.load":
      return client.request(`${base}/draft`);
    case "new-draft.load":
      return client.request("/v1/new-conversation-draft");
    case "new-draft.save":
      return client.request("/v1/new-conversation-draft", "PUT", request.draft);
    case "draft.save":
      return client.request(`${base}/draft`, "PUT", request.draft);
    case "turn.submit": {
      if (request.input.delivery) throw new Error("Desktop 当前仅支持空闲会话提交。");
      const draft = await client.request<Draft>(`${base}/draft`);
      if (draft.pendingSubmission)
        throw new HttpError(409, "有未确认请求，请先查询原 requestId；不会重发。");
      await client.request(`${base}/draft`, "PUT", {
        revision: request.revision,
        text: request.input.message,
        images: request.input.images ?? [],
        pendingSubmission: request.input,
      });
      try {
        return await client.request(`${base}/turns`, "POST", request.input);
      } catch (error) {
        // Only explicit validation/conflict responses prove rejection. Transport errors,
        // timeouts and server errors keep the durable reservation for read-only recovery.
        if (error instanceof HttpError && [400, 409].includes(error.status)) {
          const reserved = await client.request<Draft>(`${base}/draft`);
          if (reserved.pendingSubmission?.requestId === request.input.requestId)
            await client.request(`${base}/draft`, "PUT", {
              ...reserved,
              conversationId: undefined,
              pendingSubmission: null,
            });
        }
        throw error;
      }
    }
    case "request.lookup": {
      const value = await client.request<Turn>(`/v1/requests/${request.requestId}`);
      if (value.conversationId !== request.conversationId) throw new Error("请求不属于此会话。");
      return value;
    }
    case "turn.cancel": {
      const turn = await client.request<Turn>(`/v1/turns/${request.turnId}`);
      if (turn.conversationId !== request.conversationId || turn.state === "UNCERTAIN")
        throw new Error("无法安全取消：会话不匹配或执行结果 UNCERTAIN。");
      return client.request(`/v1/turns/${request.turnId}/cancel`, "POST");
    }
    case "approval.decide": {
      const approvals = await client.request<Approval[]>(`${base}/approvals`);
      if (!approvals.some((a) => a.id === request.approvalId))
        throw new Error("审批已处理或已失效。");
      return client.request(`/v1/approvals/${request.approvalId}/decision`, "POST", {
        optionId: request.optionId,
      });
    }
    case "harness.select":
      return client.request(`${base}/harness`, "PUT", { harnessId: request.harnessId });
    case "session.prepare":
      return client.request(`${base}/sessions`, "POST", { harnessId: request.harnessId });
    case "session.recover":
      return client.request(`${base}/session/recover`, "POST", {
        nativeSessionId: request.nativeSessionId,
        confirmed: request.confirmed,
      });
    case "session.settings":
      return client.request(`${base}/settings`, "POST", request.setting);
    case "handoff.action":
      return client.request(`${base}/handoff/action`, "POST", request.input);
    case "conversation.create":
      return client.request(`/v1/projects/${request.projectId}/conversations`, "POST", {
        title: request.title,
        workspaceMode: request.workspaceMode,
        baseBranch: request.baseBranch,
      });
    case "conversation.standalone":
      return client.request("/v1/conversations", "POST", {
        title: request.title,
        workspacePath: request.workspacePath,
      });
    case "conversation.patch":
      return client.request(base, "PATCH", request.patch);
    case "conversation.delete":
      return client.request(base, "DELETE", { confirmed: request.confirmed });
    default:
      throw new Error("不支持的业务操作。");
  }
}
