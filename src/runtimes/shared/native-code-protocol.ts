import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { consumeCliJsonl, record, tokenCount, type CliEvent } from "./cli-jsonl.js";

export function consumeNativeCode(name: string, handle: ProcessHandle, context: AttemptContext, secrets: readonly string[]): Promise<SolveResult> {
  let result: CliEvent | undefined;
  let error: string | undefined;
  return consumeCliJsonl(handle, context, secrets, {
    solver: name, label: name,
    accept(event) {
      const update = record(record(record(event.message)?.params)?.update);
      const kind = update?.sessionUpdate;
      if (event.type.startsWith("item.") || event.type === "turn.started" ||
          (typeof kind === "string" && ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(kind))) {
        context.activity?.({});
      }
      if (event.type === "evaluator.error") error = typeof event.message === "string" ? redactDiagnostic(event.message, secrets) : "Native CLI failed";
      if (event.type !== "evaluator.result") return;
      if (result) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", `${name} emitted multiple final results`);
      result = event;
    },
    finish(exit, stderr) {
      if (exit.code !== 0 || exit.signal !== null || error) {
        const failure = classifyError(new Error(error || stderr || `${name} exited with code ${exit.code}`), {
          phase: "solve", component: name, fallbackCode: error === undefined ? "SOLVER_PROCESS_CRASHED" : "SOLVER_RESULT_INCOMPLETE",
        });
        throw new EvaluatorError(failure.code, failure.message, failure.details);
      }
      if (!result || typeof result.finalText !== "string" || !result.finalText.trim()) throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", `${name} exited without a final answer`);
      const usage = record(result.usage);
      const inputTokens = tokenCount(usage?.inputTokens);
      const outputTokens = tokenCount(usage?.outputTokens);
      return { finalText: result.finalText, usage: { inputTokens, outputTokens,
        totalTokens: tokenCount(usage?.totalTokens) ?? (inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens) } };
    },
  });
}
