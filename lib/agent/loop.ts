import type {
  AgentRunRecord,
  ApprovalRequestRecord,
  ApproveRouteResponse,
  ChatPhase,
  ChatRouteResponse,
  ChatStreamEvent,
  HistoryPayload,
  PlannerContext,
  RetryRouteResponse,
  SubAgentResult,
  ToolExecutionRecord,
  ToolResult,
} from "@/lib/agent/types";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import {
  createAgentRun,
  createApprovalRequest,
  finishToolExecution,
  getAgentRunById,
  getApprovalRequest,
  getConversationUsageSummary,
  getHistoryPayload,
  getLatestUserMessage,
  getMessageById,
  getToolExecutionById,
  insertMessage,
  loadExecutorContext,
  loadPlannerContext,
  logLlmUsageEvent,
  logToolExecutionStart,
  maybeSummarizeConversation,
  resolveApprovalRequest,
  updateAgentRun,
} from "@/lib/agent/memory";
import { planNextStep } from "@/lib/agent/planner";
import {
  toApprovalSummaryRecord,
  toToolTimelineRecord,
} from "@/lib/agent/presentation";
import { evaluateToolSafety } from "@/lib/agent/safety";
import type { ToolPresentationDetails } from "@/lib/agent/types";
import type { AgentProvider } from "@/lib/llm/provider";
import {
  getDefaultProvider,
  getExecutorProvider,
} from "@/lib/llm/resolveProvider";
import { prepareCodeToolOperation } from "@/lib/tools/codeTool";
import { validateToolCall } from "@/lib/tools/registry";
import { toErrorMessage, toStableJsonString } from "@/lib/utils";

const LOOP_LIMIT = 8;
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const TRANSIENT_ERROR_PATTERNS = [
  /timed out/i,
  /temporary/i,
  /network error/i,
  /net::ERR_/i,
];
const TRANSIENT_BROWSER_ERROR_PATTERNS = [
  /Target page, context or browser has been closed/i,
  /browser has been closed/i,
  /page has been closed/i,
  /context has been closed/i,
  /Execution context was destroyed/i,
];

type TurnEventSink = (event: ChatStreamEvent) => Promise<void> | void;

type ProviderSet = {
  planner: AgentProvider;
  executor: AgentProvider;
};

type ExecutorContinuation =
  | {
      kind: "completed";
      result: SubAgentResult;
    }
  | {
      kind: "response";
      response: ChatRouteResponse;
    };

function toHistoryPayload(
  response: ChatRouteResponse | ApproveRouteResponse | RetryRouteResponse,
): HistoryPayload {
  return {
    messages: response.messages,
    toolExecutions: response.toolExecutions,
    pendingApprovals: response.pendingApprovals,
    usage: response.usage,
  };
}

function getProviders(
  plannerProvider: AgentProvider = getDefaultProvider(),
  executorProvider: AgentProvider = getExecutorProvider(),
): ProviderSet {
  return {
    planner: plannerProvider,
    executor: executorProvider,
  };
}

function getErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return null;
}

function isRetryableToolFailure(toolName: string, message: string, error: unknown) {
  if (message.startsWith("Blocked:")) {
    return false;
  }

  const code = getErrorCode(error);
  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  if (toolName === "browserTool") {
    return [...TRANSIENT_ERROR_PATTERNS, ...TRANSIENT_BROWSER_ERROR_PATTERNS]
      .some((pattern) => pattern.test(message));
  }

  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function formatToolFailureMessage(toolResult: ToolResult) {
  const suffix = toolResult.error?.trim() ? `: ${toolResult.error.trim()}` : ".";

  if (toolResult.status === "blocked") {
    return `I couldn't finish because ${toolResult.toolName} was blocked${suffix}`;
  }

  if (toolResult.status === "error") {
    return `I couldn't finish because ${toolResult.toolName} failed${suffix}`;
  }

  return "I couldn't finish the task.";
}

function formatRetryRequiredMessage(toolResult: ToolResult) {
  return `${formatToolFailureMessage(toolResult)} Retry the failed tool execution to continue.`;
}

function isRepeatedFailedToolCall(
  lastToolResult: ToolResult | undefined,
  lastExecution: ToolExecutionRecord | null,
  toolName: string,
  args: unknown,
) {
  if (!lastToolResult || !lastExecution) {
    return false;
  }

  return (
    lastExecution.status === "error" &&
    lastExecution.retryable &&
    lastToolResult.status === "error" &&
    lastToolResult.retryable &&
    lastToolResult.toolName === toolName &&
    toStableJsonString(lastToolResult.args) === toStableJsonString(args)
  );
}

async function emitEvent(onEvent: TurnEventSink | undefined, event: ChatStreamEvent) {
  if (!onEvent) {
    return;
  }

  await onEvent(event);
}

async function emitPhase(
  onEvent: TurnEventSink | undefined,
  phase: ChatPhase,
  label: string,
) {
  await emitEvent(onEvent, {
    type: "phase.changed",
    phase,
    label,
  });
}

async function emitUsageUpdate(
  conversationId: string,
  onEvent: TurnEventSink | undefined,
) {
  const usage = await getConversationUsageSummary(conversationId);

  await emitEvent(onEvent, {
    type: "usage.updated",
    usage,
  });
}

async function recordAssistantError({
  conversationId,
  provider,
  sourceMessageId,
  content,
}: {
  conversationId: string;
  provider: AgentProvider;
  sourceMessageId: string | null;
  content: string;
}) {
  await insertMessage({
    conversationId,
    role: "assistant",
    kind: "error",
    content,
  });

  await maybeSummarizeConversation(provider, conversationId, sourceMessageId);
}

async function buildChatResponse(
  conversationId: string,
  status: ChatRouteResponse["status"],
  pendingApproval?: ApprovalRequestRecord,
): Promise<ChatRouteResponse> {
  const history = await getHistoryPayload(conversationId);

  return {
    status,
    ...history,
    pendingApproval: pendingApproval ? toApprovalSummaryRecord(pendingApproval) : undefined,
  };
}

async function buildApproveResponse(
  conversationId: string,
  status: ApproveRouteResponse["status"],
  toolExecution?: ToolExecutionRecord,
  pendingApproval?: ApprovalRequestRecord,
): Promise<ApproveRouteResponse> {
  const history = await getHistoryPayload(conversationId);

  return {
    status,
    ...history,
    pendingApproval: pendingApproval ? toApprovalSummaryRecord(pendingApproval) : undefined,
    toolExecution: toolExecution ? toToolTimelineRecord(toolExecution) : undefined,
  };
}

async function completeTurn<T extends ChatRouteResponse | ApproveRouteResponse | RetryRouteResponse>(
  response: T,
  onEvent?: TurnEventSink,
): Promise<T> {
  await emitEvent(onEvent, {
    type: "turn.completed",
    status: response.status,
    history: toHistoryPayload(response),
  });

  return response;
}

async function requireToolRetryTurn(
  conversationId: string,
  provider: AgentProvider,
  sourceMessageId: string | null,
  toolResult: ToolResult,
  onEvent?: TurnEventSink,
) {
  await recordAssistantError({
    conversationId,
    provider,
    sourceMessageId,
    content: formatRetryRequiredMessage(toolResult),
  });
  await emitUsageUpdate(conversationId, onEvent);

  const response = await buildChatResponse(conversationId, "retry_required");

  return completeTurn(response, onEvent);
}

async function failTurn(
  conversationId: string,
  provider: AgentProvider,
  sourceMessageId: string | null,
  content: string,
  onEvent?: TurnEventSink,
) {
  await recordAssistantError({
    conversationId,
    provider,
    sourceMessageId,
    content,
  });
  await emitUsageUpdate(conversationId, onEvent);

  const response = await buildChatResponse(conversationId, "error");

  await emitEvent(onEvent, {
    type: "turn.error",
    error: content,
    history: toHistoryPayload(response),
  });

  return response;
}

async function respondToUser({
  context,
  provider,
  sourceMessageId,
  onEvent,
}: {
  context: PlannerContext;
  provider: AgentProvider;
  sourceMessageId: string | null;
  onEvent?: TurnEventSink;
}) {
  await emitPhase(onEvent, "responding", "Responding");

  const response = onEvent && provider.streamResponse
    ? await provider.streamResponse(context, async (delta) => {
        if (!delta) {
          return;
        }

        await emitEvent(onEvent, {
          type: "assistant.delta",
          delta,
        });
      })
    : await provider.respond(context);

  await logLlmUsageEvent({
    conversationId: context.conversationId,
    sourceMessageId,
    usage: response.usage,
  });
  await emitUsageUpdate(context.conversationId, onEvent);

  const assistantMessage = await insertMessage({
    conversationId: context.conversationId,
    role: "assistant",
    kind: "text",
    content: response.content,
  });

  await emitEvent(onEvent, {
    type: "assistant.completed",
    message: assistantMessage,
  });

  await maybeSummarizeConversation(provider, context.conversationId, sourceMessageId);
  await emitUsageUpdate(context.conversationId, onEvent);

  return buildChatResponse(context.conversationId, "completed");
}

async function executeToolAttempt({
  conversationId,
  agentRunId,
  sourceMessageId,
  toolName,
  args,
  presentation,
  riskLevel,
  retryOfExecutionId,
  onEvent,
}: {
  conversationId: string;
  agentRunId: string | null;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ToolResult["riskLevel"];
  retryOfExecutionId?: string | null;
  onEvent?: TurnEventSink;
}) {
  await emitPhase(onEvent, "running_tool", `Running ${toolName}`);

  const execution = await logToolExecutionStart({
    conversationId,
    agentRunId,
    sourceMessageId,
    toolName,
    args,
    presentation,
    riskLevel,
    retryOfExecutionId,
  });

  await emitEvent(onEvent, {
    type: "tool.started",
    toolExecution: toToolTimelineRecord(execution),
  });

  const { tool, parsedArgs } = validateToolCall(toolName, args);

  let toolResult: ToolResult;
  try {
    const output = await tool.execute(parsedArgs);
    toolResult = {
      toolName,
      args,
      riskLevel,
      status: "success",
      output,
      error: null,
      retryable: false,
    };
  } catch (error) {
    const message = toErrorMessage(error);
    toolResult = {
      toolName,
      args,
      riskLevel,
      status: message.startsWith("Blocked:") ? "blocked" : "error",
      output: null,
      error: message,
      retryable: isRetryableToolFailure(toolName, message, error),
    };
  }

  const storedExecution = await finishToolExecution(execution.id, toolResult, presentation);

  if (storedExecution) {
    await emitEvent(onEvent, {
      type: "tool.completed",
      toolExecution: toToolTimelineRecord(storedExecution),
    });
  }

  return {
    storedExecution,
    toolResult,
  };
}

async function executeToolWithRecovery({
  conversationId,
  agentRunId,
  sourceMessageId,
  toolName,
  args,
  presentation,
  riskLevel,
  retryOfExecutionId,
  onEvent,
}: {
  conversationId: string;
  agentRunId: string | null;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ToolResult["riskLevel"];
  retryOfExecutionId?: string | null;
  onEvent?: TurnEventSink;
}) {
  let executionResult = await executeToolAttempt({
    conversationId,
    agentRunId,
    sourceMessageId,
    toolName,
    args,
    presentation,
    riskLevel,
    retryOfExecutionId,
    onEvent,
  });

  if (
    executionResult.toolResult.status === "error" &&
    executionResult.toolResult.retryable &&
    executionResult.storedExecution
  ) {
    executionResult = await executeToolAttempt({
      conversationId,
      agentRunId,
      sourceMessageId,
      toolName,
      args,
      presentation,
      riskLevel,
      retryOfExecutionId: executionResult.storedExecution.id,
      onEvent,
    });
  }

  return executionResult;
}

async function continueFromRun({
  run,
  providers,
  latestUserMessageId,
  latestUserMessage,
  initialToolResult,
  initialExecution,
  onEvent,
}: {
  run: AgentRunRecord;
  providers: ProviderSet;
  latestUserMessageId: string | null;
  latestUserMessage: string;
  initialToolResult?: ToolResult;
  initialExecution?: ToolExecutionRecord | null;
  onEvent?: TurnEventSink;
}): Promise<ChatRouteResponse> {
  if (run.role === "planner") {
    return continuePlannerRun({
      run,
      providers,
      latestUserMessageId,
      latestUserMessage,
      initialToolResult,
      initialExecution,
      onEvent,
    });
  }

  const executorResult = await continueExecutorRun({
    run,
    providers,
    latestUserMessageId,
    latestUserMessage,
    initialToolResult,
    initialExecution,
    onEvent,
  });

  if (executorResult.kind === "response") {
    return executorResult.response;
  }

  if (!run.parentRunId) {
    await updateAgentRun({
      runId: run.id,
      status: "error",
    });
    return failTurn(
      run.conversationId,
      providers.planner,
      run.sourceMessageId,
      "The executor completed without a parent planner run.",
      onEvent,
    );
  }

  const parentRun = await getAgentRunById(run.parentRunId);
  if (!parentRun) {
    await updateAgentRun({
      runId: run.id,
      status: "error",
    });
    return failTurn(
      run.conversationId,
      providers.planner,
      run.sourceMessageId,
      "The parent planner run could not be found after executor completion.",
      onEvent,
    );
  }

  return continueFromRun({
    run: parentRun,
    providers,
    latestUserMessageId,
    latestUserMessage,
    initialToolResult: executorResult.result.lastToolResult ?? undefined,
    initialExecution: null,
    onEvent,
  });
}

async function continuePlannerRun({
  run,
  providers,
  latestUserMessageId,
  latestUserMessage,
  initialToolResult,
  initialExecution,
  onEvent,
}: {
  run: AgentRunRecord;
  providers: ProviderSet;
  latestUserMessageId: string | null;
  latestUserMessage: string;
  initialToolResult?: ToolResult;
  initialExecution?: ToolExecutionRecord | null;
  onEvent?: TurnEventSink;
}): Promise<ChatRouteResponse> {
  let lastToolResult = initialToolResult;
  let lastExecution = initialExecution ?? null;

  for (let index = 0; index < LOOP_LIMIT; index += 1) {
    const providerContext = await loadPlannerContext({
      conversationId: run.conversationId,
      sourceMessageId: run.sourceMessageId,
      latestUserMessage,
      lastToolResult,
      stepIndex: index + 1,
    });

    await emitPhase(onEvent, "planning", "Planning");

    let decisionResult;

    try {
      decisionResult = await planNextStep(providers.planner, providerContext);
      await logLlmUsageEvent({
        conversationId: run.conversationId,
        sourceMessageId: latestUserMessageId,
        usage: decisionResult.usage,
      });
      await emitUsageUpdate(run.conversationId, onEvent);
    } catch (error) {
      await updateAgentRun({
        runId: run.id,
        status: "error",
      });
      return failTurn(
        run.conversationId,
        providers.planner,
        latestUserMessageId,
        `I couldn't plan the next step because ${toErrorMessage(error)}`,
        onEvent,
      );
    }

    const decision = decisionResult.decision;

    if (decision.type === "respond") {
      const response = await respondToUser({
        context: providerContext,
        provider: providers.planner,
        sourceMessageId: latestUserMessageId,
        onEvent,
      });

      await updateAgentRun({
        runId: run.id,
        status: "completed",
      });

      return completeTurn(response, onEvent);
    }

    if (decision.type === "delegate") {
      const executorRun = await createAgentRun({
        conversationId: run.conversationId,
        parentRunId: run.id,
        sourceMessageId: run.sourceMessageId,
        role: "executor",
        input: {
          task: decision.task,
          successCriteria: decision.successCriteria,
          notes: decision.notes ?? null,
        },
      });

      return continueFromRun({
        run: executorRun,
        providers,
        latestUserMessageId,
        latestUserMessage,
        onEvent,
      });
    }

    let parsedArgs;
    let riskLevel: ToolResult["riskLevel"];
    let presentation: ToolPresentationDetails | null = null;

    try {
      const validatedToolCall = validateToolCall(decision.toolName, decision.args);
      parsedArgs = validatedToolCall.parsedArgs;
      riskLevel = validatedToolCall.tool.getRiskLevel(parsedArgs);

      if (decision.toolName === "codeTool") {
        presentation = (await prepareCodeToolOperation(parsedArgs)).presentation;
      }
    } catch (error) {
      lastToolResult = {
        toolName: decision.toolName,
        args: decision.args,
        riskLevel: "low",
        status: "error",
        output: null,
        error: `Invalid ${decision.toolName} call: ${toErrorMessage(error)}`,
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    if (isRepeatedFailedToolCall(lastToolResult, lastExecution, decision.toolName, parsedArgs)) {
      await updateAgentRun({
        runId: run.id,
        status: "retry_required",
      });
      return requireToolRetryTurn(
        run.conversationId,
        providers.planner,
        latestUserMessageId,
        lastToolResult!,
        onEvent,
      );
    }

    try {
      const safety = await evaluateToolSafety(decision.toolName, parsedArgs, riskLevel);

      if (safety.requiresApproval) {
        await emitPhase(onEvent, "waiting_approval", `Waiting for approval for ${decision.toolName}`);

        const pendingApproval = await createApprovalRequest({
          conversationId: run.conversationId,
          agentRunId: run.id,
          sourceMessageId: latestUserMessageId,
          toolName: decision.toolName,
          args: parsedArgs,
          presentation,
          riskLevel,
          reason: decision.reason,
        });

        await updateAgentRun({
          runId: run.id,
          status: "waiting_approval",
        });

        await emitEvent(onEvent, {
          type: "approval.required",
          approval: toApprovalSummaryRecord(pendingApproval),
        });

        await maybeSummarizeConversation(providers.planner, run.conversationId, latestUserMessageId);
        await emitUsageUpdate(run.conversationId, onEvent);

        const response = await buildChatResponse(run.conversationId, "approval_required", pendingApproval);

        return completeTurn(response, onEvent);
      }
    } catch (error) {
      lastToolResult = {
        toolName: decision.toolName,
        args: parsedArgs,
        riskLevel,
        status: "error",
        output: null,
        error: `Safety evaluation failed for ${decision.toolName}: ${toErrorMessage(error)}`,
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    const executionResult = await executeToolWithRecovery({
      conversationId: run.conversationId,
      agentRunId: run.id,
      sourceMessageId: latestUserMessageId,
      toolName: decision.toolName,
      args: parsedArgs,
      presentation,
      riskLevel,
      onEvent,
    });

    lastToolResult = executionResult.toolResult;
    lastExecution = executionResult.storedExecution;
  }

  if (lastToolResult && lastExecution?.status === "error" && lastExecution.retryable) {
    await updateAgentRun({
      runId: run.id,
      status: "retry_required",
    });
    return requireToolRetryTurn(
      run.conversationId,
      providers.planner,
      latestUserMessageId,
      lastToolResult,
      onEvent,
    );
  }

  await updateAgentRun({
    runId: run.id,
    status: "error",
  });
  return failTurn(
    run.conversationId,
    providers.planner,
    latestUserMessageId,
    lastToolResult ? formatToolFailureMessage(lastToolResult) : "I hit the step limit before I could finish.",
    onEvent,
  );
}

async function continueExecutorRun({
  run,
  providers,
  latestUserMessageId,
  latestUserMessage,
  initialToolResult,
  initialExecution,
  onEvent,
}: {
  run: AgentRunRecord;
  providers: ProviderSet;
  latestUserMessageId: string | null;
  latestUserMessage: string;
  initialToolResult?: ToolResult;
  initialExecution?: ToolExecutionRecord | null;
  onEvent?: TurnEventSink;
}): Promise<ExecutorContinuation> {
  let lastToolResult = initialToolResult;
  let lastExecution = initialExecution ?? null;

  for (let index = 0; index < LOOP_LIMIT; index += 1) {
    const providerContext = await loadExecutorContext({
      runId: run.id,
      latestUserMessage,
      lastToolResult,
      stepIndex: index + 1,
    });

    await emitPhase(onEvent, "planning", "Planning");

    let decisionResult;

    try {
      decisionResult = await planNextStep(providers.executor, providerContext);
      await logLlmUsageEvent({
        conversationId: run.conversationId,
        sourceMessageId: latestUserMessageId,
        usage: decisionResult.usage,
      });
      await emitUsageUpdate(run.conversationId, onEvent);
    } catch (error) {
      await updateAgentRun({
        runId: run.id,
        status: "error",
      });
      return {
        kind: "response",
        response: await failTurn(
          run.conversationId,
          providers.planner,
          latestUserMessageId,
          `I couldn't continue the delegated task because ${toErrorMessage(error)}`,
          onEvent,
        ),
      };
    }

    const decision = decisionResult.decision;

    if (decision.type === "delegate") {
      lastToolResult = {
        toolName: "delegate",
        args: {
          task: decision.task,
          successCriteria: decision.successCriteria,
          notes: decision.notes ?? null,
        },
        riskLevel: "low",
        status: "error",
        output: null,
        error: "Executor runs cannot delegate to another sub-agent.",
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    if (decision.type === "respond") {
      if (!providers.executor.summarizeSubAgent) {
        await updateAgentRun({
          runId: run.id,
          status: "error",
        });
        return {
          kind: "response",
          response: await failTurn(
            run.conversationId,
            providers.planner,
            latestUserMessageId,
            "The configured executor provider cannot summarize sub-agent results.",
            onEvent,
          ),
        };
      }

      let summaryResult;
      try {
        summaryResult = await providers.executor.summarizeSubAgent(providerContext);
        await logLlmUsageEvent({
          conversationId: run.conversationId,
          sourceMessageId: latestUserMessageId,
          usage: summaryResult.usage,
        });
        await emitUsageUpdate(run.conversationId, onEvent);
      } catch (error) {
        await updateAgentRun({
          runId: run.id,
          status: "error",
        });
        return {
          kind: "response",
          response: await failTurn(
            run.conversationId,
            providers.planner,
            latestUserMessageId,
            `I couldn't summarize the delegated result because ${toErrorMessage(error)}`,
            onEvent,
          ),
        };
      }

      await updateAgentRun({
        runId: run.id,
        status: "completed",
        result: summaryResult.result,
      });

      return {
        kind: "completed",
        result: summaryResult.result,
      };
    }

    let parsedArgs;
    let riskLevel: ToolResult["riskLevel"];
    let presentation: ToolPresentationDetails | null = null;

    try {
      const validatedToolCall = validateToolCall(decision.toolName, decision.args);
      parsedArgs = validatedToolCall.parsedArgs;
      riskLevel = validatedToolCall.tool.getRiskLevel(parsedArgs);

      if (decision.toolName === "codeTool") {
        presentation = (await prepareCodeToolOperation(parsedArgs)).presentation;
      }
    } catch (error) {
      lastToolResult = {
        toolName: decision.toolName,
        args: decision.args,
        riskLevel: "low",
        status: "error",
        output: null,
        error: `Invalid ${decision.toolName} call: ${toErrorMessage(error)}`,
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    if (isRepeatedFailedToolCall(lastToolResult, lastExecution, decision.toolName, parsedArgs)) {
      await updateAgentRun({
        runId: run.id,
        status: "retry_required",
      });
      return {
        kind: "response",
        response: await requireToolRetryTurn(
          run.conversationId,
          providers.planner,
          latestUserMessageId,
          lastToolResult!,
          onEvent,
        ),
      };
    }

    try {
      const safety = await evaluateToolSafety(decision.toolName, parsedArgs, riskLevel);

      if (safety.requiresApproval) {
        await emitPhase(onEvent, "waiting_approval", `Waiting for approval for ${decision.toolName}`);

        const pendingApproval = await createApprovalRequest({
          conversationId: run.conversationId,
          agentRunId: run.id,
          sourceMessageId: latestUserMessageId,
          toolName: decision.toolName,
          args: parsedArgs,
          presentation,
          riskLevel,
          reason: decision.reason,
        });

        await updateAgentRun({
          runId: run.id,
          status: "waiting_approval",
        });

        await emitEvent(onEvent, {
          type: "approval.required",
          approval: toApprovalSummaryRecord(pendingApproval),
        });

        await emitUsageUpdate(run.conversationId, onEvent);

        const response = await buildChatResponse(run.conversationId, "approval_required", pendingApproval);

        return {
          kind: "response",
          response: await completeTurn(response, onEvent),
        };
      }
    } catch (error) {
      lastToolResult = {
        toolName: decision.toolName,
        args: parsedArgs,
        riskLevel,
        status: "error",
        output: null,
        error: `Safety evaluation failed for ${decision.toolName}: ${toErrorMessage(error)}`,
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    const executionResult = await executeToolWithRecovery({
      conversationId: run.conversationId,
      agentRunId: run.id,
      sourceMessageId: latestUserMessageId,
      toolName: decision.toolName,
      args: parsedArgs,
      presentation,
      riskLevel,
      onEvent,
    });

    lastToolResult = executionResult.toolResult;
    lastExecution = executionResult.storedExecution;
  }

  if (lastToolResult && lastExecution?.status === "error" && lastExecution.retryable) {
    await updateAgentRun({
      runId: run.id,
      status: "retry_required",
    });
    return {
      kind: "response",
      response: await requireToolRetryTurn(
        run.conversationId,
        providers.planner,
        latestUserMessageId,
        lastToolResult,
        onEvent,
      ),
    };
  }

  await updateAgentRun({
    runId: run.id,
    status: "error",
  });
  return {
    kind: "response",
    response: await failTurn(
      run.conversationId,
      providers.planner,
      latestUserMessageId,
      lastToolResult ? formatToolFailureMessage(lastToolResult) : "I hit the step limit before I could finish the delegated task.",
      onEvent,
    ),
  };
}

async function getRetryExecutionContext(toolExecutionId: string) {
  const toolExecution = await getToolExecutionById(toolExecutionId);

  if (!toolExecution) {
    throw new Error("Tool execution not found.");
  }

  if (toolExecution.status !== "error") {
    throw new Error("Only failed tool executions can be retried.");
  }

  if (!toolExecution.retryable) {
    throw new Error("This tool execution is not retryable.");
  }

  let run = toolExecution.agentRunId ? await getAgentRunById(toolExecution.agentRunId) : null;
  const sourceMessage = toolExecution.sourceMessageId
    ? await getMessageById(toolExecution.sourceMessageId)
    : null;
  const latestUserMessage = sourceMessage?.content ?? await getLatestUserMessage(toolExecution.conversationId);
  const latestUserMessageId = sourceMessage?.id ?? toolExecution.sourceMessageId;

  if (!run) {
    run = await createAgentRun({
      conversationId: toolExecution.conversationId,
      sourceMessageId: latestUserMessageId,
      role: "planner",
      input: {
        latestUserMessage,
      },
    });
  }

  return {
    run,
    toolExecution,
    latestUserMessageId,
    latestUserMessage,
  };
}

export async function runAgentTurn({
  message,
  conversationId = DEFAULT_CONVERSATION_ID,
  provider = getDefaultProvider(),
  executorProvider = getExecutorProvider(),
}: {
  message: string;
  conversationId?: string;
  provider?: AgentProvider;
  executorProvider?: AgentProvider;
}): Promise<ChatRouteResponse> {
  const userMessage = await insertMessage({
    conversationId,
    role: "user",
    content: message,
  });
  const plannerRun = await createAgentRun({
    conversationId,
    sourceMessageId: userMessage.id,
    role: "planner",
    input: {
      latestUserMessage: userMessage.content,
    },
  });

  return continueFromRun({
    run: plannerRun,
    providers: getProviders(provider, executorProvider),
    latestUserMessageId: userMessage.id,
    latestUserMessage: userMessage.content,
  });
}

export async function streamAgentTurn({
  message,
  conversationId = DEFAULT_CONVERSATION_ID,
  provider = getDefaultProvider(),
  executorProvider = getExecutorProvider(),
  onEvent,
}: {
  message: string;
  conversationId?: string;
  provider?: AgentProvider;
  executorProvider?: AgentProvider;
  onEvent: TurnEventSink;
}) {
  const userMessage = await insertMessage({
    conversationId,
    role: "user",
    content: message,
  });
  const plannerRun = await createAgentRun({
    conversationId,
    sourceMessageId: userMessage.id,
    role: "planner",
    input: {
      latestUserMessage: userMessage.content,
    },
  });

  return continueFromRun({
    run: plannerRun,
    providers: getProviders(provider, executorProvider),
    latestUserMessageId: userMessage.id,
    latestUserMessage: userMessage.content,
    onEvent,
  });
}

export async function handleApprovalDecision({
  requestId,
  decision,
  provider = getDefaultProvider(),
  executorProvider = getExecutorProvider(),
}: {
  requestId: string;
  decision: "approve" | "deny";
  provider?: AgentProvider;
  executorProvider?: AgentProvider;
}): Promise<ApproveRouteResponse> {
  const approvalRequest = await getApprovalRequest(requestId);

  if (!approvalRequest) {
    throw new Error("Approval request not found.");
  }

  if (approvalRequest.status !== "pending") {
    throw new Error("Approval request has already been resolved.");
  }

  const providers = getProviders(provider, executorProvider);
  const updatedApproval = await resolveApprovalRequest(requestId, decision === "approve" ? "approved" : "denied");
  if (!updatedApproval) {
    throw new Error("Failed to update approval request.");
  }

  if (decision === "deny") {
    await insertMessage({
      conversationId: updatedApproval.conversationId,
      role: "assistant",
      kind: "text",
      content: `Denied ${updatedApproval.toolName}. No action was executed.`,
      meta: {
        approvalRequestId: updatedApproval.id,
      },
    });
    if (updatedApproval.agentRunId) {
      await updateAgentRun({
        runId: updatedApproval.agentRunId,
        status: "error",
      });
    }
    await maybeSummarizeConversation(providers.planner, updatedApproval.conversationId, updatedApproval.sourceMessageId);
    return buildApproveResponse(updatedApproval.conversationId, "denied");
  }

  let run = updatedApproval.agentRunId ? await getAgentRunById(updatedApproval.agentRunId) : null;
  const sourceMessage = updatedApproval.sourceMessageId
    ? await getMessageById(updatedApproval.sourceMessageId)
    : null;
  const latestUserMessage = sourceMessage?.content ?? await getLatestUserMessage(updatedApproval.conversationId);
  const latestUserMessageId = sourceMessage?.id ?? updatedApproval.sourceMessageId;

  if (!run) {
    run = await createAgentRun({
      conversationId: updatedApproval.conversationId,
      sourceMessageId: latestUserMessageId,
      role: "planner",
      input: {
        latestUserMessage,
      },
    });
  }

  await updateAgentRun({
    runId: run.id,
    status: "running",
  });

  const executionResult = await executeToolWithRecovery({
    conversationId: updatedApproval.conversationId,
    agentRunId: run.id,
    sourceMessageId: latestUserMessageId,
    toolName: updatedApproval.toolName,
    args: updatedApproval.args,
    presentation: updatedApproval.presentation,
    riskLevel: updatedApproval.riskLevel,
  });

  const continuedResponse = await continueFromRun({
    run,
    providers,
    latestUserMessageId,
    latestUserMessage,
    initialToolResult: executionResult.toolResult,
    initialExecution: executionResult.storedExecution,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    pendingApproval: continuedResponse.pendingApproval,
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}

export async function streamApprovalDecision({
  requestId,
  decision,
  provider = getDefaultProvider(),
  executorProvider = getExecutorProvider(),
  onEvent,
}: {
  requestId: string;
  decision: "approve" | "deny";
  provider?: AgentProvider;
  executorProvider?: AgentProvider;
  onEvent: TurnEventSink;
}) {
  const approvalRequest = await getApprovalRequest(requestId);

  if (!approvalRequest) {
    throw new Error("Approval request not found.");
  }

  if (approvalRequest.status !== "pending") {
    throw new Error("Approval request has already been resolved.");
  }

  const providers = getProviders(provider, executorProvider);
  const updatedApproval = await resolveApprovalRequest(requestId, decision === "approve" ? "approved" : "denied");
  if (!updatedApproval) {
    throw new Error("Failed to update approval request.");
  }

  if (decision === "deny") {
    const denialMessage = await insertMessage({
      conversationId: updatedApproval.conversationId,
      role: "assistant",
      kind: "text",
      content: `Denied ${updatedApproval.toolName}. No action was executed.`,
      meta: {
        approvalRequestId: updatedApproval.id,
      },
    });

    if (updatedApproval.agentRunId) {
      await updateAgentRun({
        runId: updatedApproval.agentRunId,
        status: "error",
      });
    }

    await emitEvent(onEvent, {
      type: "assistant.completed",
      message: denialMessage,
    });

    await maybeSummarizeConversation(providers.planner, updatedApproval.conversationId, updatedApproval.sourceMessageId);
    await emitUsageUpdate(updatedApproval.conversationId, onEvent);

    const response = await buildApproveResponse(updatedApproval.conversationId, "denied");

    return completeTurn(response, onEvent);
  }

  let run = updatedApproval.agentRunId ? await getAgentRunById(updatedApproval.agentRunId) : null;
  const sourceMessage = updatedApproval.sourceMessageId
    ? await getMessageById(updatedApproval.sourceMessageId)
    : null;
  const latestUserMessage = sourceMessage?.content ?? await getLatestUserMessage(updatedApproval.conversationId);
  const latestUserMessageId = sourceMessage?.id ?? updatedApproval.sourceMessageId;

  if (!run) {
    run = await createAgentRun({
      conversationId: updatedApproval.conversationId,
      sourceMessageId: latestUserMessageId,
      role: "planner",
      input: {
        latestUserMessage,
      },
    });
  }

  await updateAgentRun({
    runId: run.id,
    status: "running",
  });

  const executionResult = await executeToolWithRecovery({
    conversationId: updatedApproval.conversationId,
    agentRunId: run.id,
    sourceMessageId: latestUserMessageId,
    toolName: updatedApproval.toolName,
    args: updatedApproval.args,
    presentation: updatedApproval.presentation,
    riskLevel: updatedApproval.riskLevel,
    onEvent,
  });

  return continueFromRun({
    run,
    providers,
    latestUserMessageId,
    latestUserMessage,
    initialToolResult: executionResult.toolResult,
    initialExecution: executionResult.storedExecution,
    onEvent,
  });
}

export async function retryToolExecution({
  toolExecutionId,
  provider = getDefaultProvider(),
  executorProvider = getExecutorProvider(),
}: {
  toolExecutionId: string;
  provider?: AgentProvider;
  executorProvider?: AgentProvider;
}): Promise<RetryRouteResponse> {
  const retryContext = await getRetryExecutionContext(toolExecutionId);
  const executionResult = await executeToolWithRecovery({
    conversationId: retryContext.toolExecution.conversationId,
    agentRunId: retryContext.run.id,
    sourceMessageId: retryContext.latestUserMessageId,
    toolName: retryContext.toolExecution.toolName,
    args: retryContext.toolExecution.args,
    presentation: retryContext.toolExecution.presentation,
    riskLevel: retryContext.toolExecution.riskLevel,
    retryOfExecutionId: retryContext.toolExecution.id,
  });

  const continuedResponse = await continueFromRun({
    run: retryContext.run,
    providers: getProviders(provider, executorProvider),
    latestUserMessageId: retryContext.latestUserMessageId,
    latestUserMessage: retryContext.latestUserMessage,
    initialToolResult: executionResult.toolResult,
    initialExecution: executionResult.storedExecution,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    pendingApproval: continuedResponse.pendingApproval,
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}

export async function streamRetryToolExecution({
  toolExecutionId,
  provider = getDefaultProvider(),
  executorProvider = getExecutorProvider(),
  onEvent,
}: {
  toolExecutionId: string;
  provider?: AgentProvider;
  executorProvider?: AgentProvider;
  onEvent: TurnEventSink;
}) {
  const retryContext = await getRetryExecutionContext(toolExecutionId);
  const executionResult = await executeToolWithRecovery({
    conversationId: retryContext.toolExecution.conversationId,
    agentRunId: retryContext.run.id,
    sourceMessageId: retryContext.latestUserMessageId,
    toolName: retryContext.toolExecution.toolName,
    args: retryContext.toolExecution.args,
    presentation: retryContext.toolExecution.presentation,
    riskLevel: retryContext.toolExecution.riskLevel,
    retryOfExecutionId: retryContext.toolExecution.id,
    onEvent,
  });

  const continuedResponse = await continueFromRun({
    run: retryContext.run,
    providers: getProviders(provider, executorProvider),
    latestUserMessageId: retryContext.latestUserMessageId,
    latestUserMessage: retryContext.latestUserMessage,
    initialToolResult: executionResult.toolResult,
    initialExecution: executionResult.storedExecution,
    onEvent,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    pendingApproval: continuedResponse.pendingApproval,
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}
