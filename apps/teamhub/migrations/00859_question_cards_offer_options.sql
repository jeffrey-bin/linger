-- +goose Up
-- A question card now only offers options; an open question is asked in an
-- ordinary message and answered in the chat. A card that holds a text-only
-- question stops being a card: its decision and card rows go, and its Message
-- stays as the Agent's plain words.
WITH removed AS (
    DELETE FROM decisions
    WHERE kind = 'question'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(view -> 'questions') AS question
          WHERE question ->> 'input' = 'text'
      )
    RETURNING message_id
)
DELETE FROM message_cards
WHERE message_id IN (SELECT message_id FROM removed);

-- +goose Down
-- The removed text-only question cards are not restored.
SELECT 1;
