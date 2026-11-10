// Grades answers with the prompts memo_eval pinned: the Agent Memory
// Benchmark (AMB) judge prompts for LoCoMo and for each LongMemEval question
// type, and LongMemEval's official abstention prompt for its unanswerable
// questions, all asking the gateway judge model for {correct, reason}.
// Sources, copied verbatim:
// - https://github.com/vectorize-io/agent-memory-benchmark/blob/8ea4c837cb00903453515929df4f80bcc793530c/src/memory_bench/dataset/locomo.py (build_judge_prompt)
// - https://github.com/vectorize-io/agent-memory-benchmark/blob/8ea4c837cb00903453515929df4f80bcc793530c/src/memory_bench/dataset/longmemeval.py (get_judge_prompt_fn)
// - https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py (get_anscheck_prompt, abstention)
import type { ModelCall } from "../../src/runtime-model-call.js";
import type { Benchmark, Case } from "./datasets.js";

export const JUDGE_PROTOCOL = "amb-8ea4c837+longmemeval-abstention-9e0b455f";

export interface Judgment {
  correct: boolean;
  reason: string;
  judge_model: string;
}

const GENEROUS_LOCOMO = (question: string, gold: string, answer: string) =>
  `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.
There's an edge case where the actual answer can't be found in the data and in that case the gold answer will say so (e.g. 'You did not mention this information.'); if the generated answer says that it cannot be answered or it doesn't know all the details, it should be counted as CORRECT.

Question: ${question}
Gold answer: ${gold}
Generated answer: ${answer}
First, provide a short (one sentence) explanation of your reasoning. Short reasoning is preferred.
If it's correct, set correct=true.
`;

function longMemEvalPrompt(
  type: string,
  question: string,
  gold: string,
  answer: string,
): string {
  if (
    [
      "single-session-user",
      "single-session-assistant",
      "multi-session",
    ].includes(type)
  )
    return `Evaluate if the model response contains the correct answer to the question.

I will give you a question, a correct answer, and a response from a model.
Please set correct=true if the response contains the correct answer. Otherwise, set correct=no.
If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also set correct=true.
If the response only contains a subset of the information required by the answer, set correct=false

Question: ${question}

Correct Answer: ${gold}

Model Response: ${answer}

Evaluation criteria:
- Set correct=true if the response contains the correct answer
- Set correct=true if the response is equivalent to the correct answer or contains intermediate steps
- Set correct=false if the response is incorrect or missing key information

Provide your evaluation as JSON with:
- reasoning: One sentence explanation
- correct: true or false`;
  if (type === "temporal-reasoning")
    return `I will give you a question, a correct answer, and a response from a model.
Please set correct=true if the response contains the correct answer. Otherwise, set correct=false.
If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also set correct=true.
If the response only contains a subset of the information required by the answer, answer correct=false.
In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Question: ${question}
Correct Answer: ${gold}
Model Response: ${answer}
First, provide a short (one sentence) explanation of your reasoning. Short reasoning is preferred.
If it's correct, set correct=true.`;
  if (type === "knowledge-update")
    return `I will give you a question, a correct answer, and a response from a model.
Please set correct=true if the response contains the correct answer. Otherwise, set correct=false.
If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Question: ${question}
Correct Answer: ${gold}
Model Response: ${answer}
First, provide a short (one sentence) explanation of your reasoning. Short reasoning is preferred.
If it's correct, set correct=true.`;
  if (type === "single-session-preference")
    return `I will give you a question, a answer for desired personalized response, and a response from a model.
Please set correct=true if the response satisfies the desired response. Otherwise, set correct=false.
The model does not need to reflect all the points in the desired response. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: ${question}
Gold answer: ${gold}
Generated answer: ${answer}
First, provide a short (one sentence) explanation of your reasoning. Short reasoning is preferred.
If it's correct, set correct=true.`;
  throw new Error(`No AMB judge prompt for LongMemEval type ${type}`);
}

const abstentionPrompt = (
  question: string,
  explanation: string,
  answer: string,
) =>
  `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${explanation}\n\nModel Response: ${answer}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;

export function judgePrompt(item: Case, answer: string): string {
  if (item.benchmark === "locomo")
    return GENEROUS_LOCOMO(item.question, item.answer, answer);
  return item.unanswerable
    ? abstentionPrompt(item.question, item.answer, answer)
    : longMemEvalPrompt(item.type, item.question, item.answer, answer);
}

const JUDGMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["correct", "reason"],
  properties: {
    correct: { type: "boolean" },
    reason: { type: "string" },
  },
};

export async function judge(
  modelCall: ModelCall,
  key: string,
  prompt: string,
): Promise<Judgment> {
  const result = await modelCall.call({
    kind: "memory",
    key: `benchmark:judge:${key}`,
    effort: "low",
    input: prompt,
    schemaName: "judgment",
    outputSchema: JUDGMENT_SCHEMA,
  });
  const output = result.output as { correct: boolean; reason: string };
  return {
    correct: output.correct,
    reason: output.reason,
    judge_model: result.model ?? "",
  };
}

/**
 * Known-answer controls run before any grading, so a judge that rewards a
 * missing or wrong answer invalidates the run instead of inflating it.
 */
export async function calibrateJudge(
  modelCall: ModelCall,
  benchmark: Benchmark,
): Promise<void> {
  const question = "When did Gina lose her job at Door Dash?";
  const control: Case = {
    id: "control",
    benchmark,
    type: benchmark === "locomo" ? "2" : "single-session-user",
    question,
    askedAt: "",
    answer: "January, 2023",
    unanswerable: false,
    corpus: { id: "", sessions: [] },
  };
  const controls: [string, boolean][] = [
    [judgePrompt(control, "January 2023"), true],
    [judgePrompt(control, "I do not have information about this."), false],
    [judgePrompt(control, "July 2024"), false],
  ];
  if (benchmark === "longmemeval")
    controls.push(
      [
        abstentionPrompt(
          question,
          "The history never mentions Gina losing a job at Door Dash.",
          "I do not have information about this.",
        ),
        true,
      ],
      [
        abstentionPrompt(
          question,
          "The history never mentions Gina losing a job at Door Dash.",
          "January 2023",
        ),
        false,
      ],
    );
  for (const [index, [prompt, expected]] of controls.entries()) {
    const { correct, reason } = await judge(
      modelCall,
      `control:${benchmark}:${index}`,
      prompt,
    );
    if (correct !== expected)
      throw new Error(
        `The judge failed known-answer control ${index} (${reason}); grades would be invalid`,
      );
  }
}
