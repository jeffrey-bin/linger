import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DecisionMessageCard } from "./decision-card";
import { settledCardNotice } from "./card-notice";
import { QuestionDecision } from "./decision-question-view";

const assignee = {
  display_name: "mallory",
  id: "actor_other_mallory",
  kind: "human" as const,
};

function questionsCard(
  status: "pending" | "answered" | "expired",
): DecisionMessageCard {
  const question = {
    questions: [
      {
        id: "hobby",
        input: "radio" as const,
        options: [
          { id: "walk", label: "Go for a walk" },
          { id: "home", label: "Rest at home" },
        ],
        prompt: "What would you rather do this weekend?",
      },
      {
        id: "day",
        input: "radio" as const,
        options: [
          { id: "sat", label: "Saturday" },
          { id: "sun", label: "Sunday" },
        ],
        prompt: "Which day?",
      },
    ],
  };
  const common = {
    card_type: "personal_notice" as const,
    decision_id: "decision-1",
    decision_owner: assignee,
    intent: "decision_requested" as const,
    kind: "question" as const,
    question,
    requester: {
      display_name: "Another Me",
      id: "actor_agent",
      kind: "agent" as const,
    },
    title: "Please answer a few easy questions.",
  };
  if (status === "pending") {
    return { ...common, status: "pending", version: 1 };
  }
  if (status === "expired") {
    return { ...common, status: "expired", version: 2 };
  }
  return {
    ...common,
    answer: {
      answers: { day: "sat", hobby: "walk" },
      decision: "submit",
    },
    decided_at: "2026-08-20T07:00:00Z",
    decided_by: assignee,
    status: "answered",
    version: 2,
  };
}

describe("QuestionDecision", () => {
  function renderCard(
    card: DecisionMessageCard,
    onDecision: (decision: unknown) => void = vi.fn(),
  ) {
    return render(
      <QuestionDecision
        card={card}
        currentActorId={assignee.id}
        messageId="message-1"
        onDecision={onDecision}
      />,
    );
  }

  it("puts the question in the box as its heading, with plain option rows", async () => {
    const onDecision = vi.fn();
    renderCard(questionsCard("pending"), onDecision);
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "What would you rather do this weekend?",
      }),
    ).toBeVisible();
    // Options carry no letter keys.
    expect(screen.queryByText("A")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go for a walk" }));
    // The chosen row stays lit for a beat before the next question.
    expect(
      await screen.findByRole("heading", { name: "Which day?" }),
    ).toBeVisible();
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Saturday" }));
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalled());
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { day: "sat", hobby: "walk" },
        decision: "submit",
      }),
    );
  });

  it("takes an answer of their own through Other… in place of an option", async () => {
    const onDecision = vi.fn();
    renderCard(questionsCard("pending"), onDecision);
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Your own answer to What would you rather do this weekend?",
      }),
      { target: { value: "Go hiking" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Sunday" }));
    await vi.waitFor(() => expect(onDecision).toHaveBeenCalled());
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { day: "sun", hobby: "Go hiking" } }),
    );
  });

  it("lets a multiple choice pick any options and add its own before sending", () => {
    const onDecision = vi.fn();
    const card = questionsCard("pending");
    renderCard(
      {
        ...card,
        question: {
          questions: [
            {
              id: "sides",
              input: "checkbox",
              options: [
                { id: "egg", label: "Egg" },
                { id: "tofu", label: "Tofu" },
              ],
              prompt: "Sides?",
            },
          ],
        },
      },
      onDecision,
    );
    expect(screen.getByText("Choose any")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Egg" }));
    expect(screen.getByRole("button", { name: "Egg" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Other…" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Your own answer to Sides?" }),
      { target: { value: "Kimchi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { sides: ["egg", "Kimchi"] } }),
    );
  });

  it("leaves nothing once answered; each answer becomes a system line", () => {
    const card = questionsCard("answered");
    const { container } = renderCard(card);
    expect(container).toBeEmptyDOMElement();
    expect(settledCardNotice(card, assignee.id)).toMatchObject({
      text: "You answered “What would you rather do this weekend?” with “Go for a walk”",
      more: ["You answered “Which day?” with “Saturday”"],
    });
  });

  it("names someone else who answered, and keeps a note and their own words", () => {
    const card = questionsCard("answered");
    expect(
      settledCardNotice(
        {
          ...card,
          answer: {
            answers: { day: "sun", hobby: "Go hiking" },
            comment: "Back by six.",
            decision: "submit",
          },
        },
        "someone-else",
      ),
    ).toMatchObject({
      text: "mallory answered “What would you rather do this weekend?” with “Go hiking”",
      more: [
        "mallory answered “Which day?” with “Sunday”",
        "mallory added “Back by six.”",
      ],
    });
  });

  it("says an expired question went unanswered", () => {
    expect(settledCardNotice(questionsCard("expired"), assignee.id)?.text).toBe(
      "No one answered “Please answer a few easy questions.” in time",
    );
  });

  it("keeps a waiting question a card", () => {
    expect(settledCardNotice(questionsCard("pending"), assignee.id)).toBeNull();
  });
});
