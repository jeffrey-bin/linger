import { z } from "zod";

const appKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_-]{0,119}$/u);

const connectionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .describe("Stable identifier of a connected application account.");

const connectedAppSchema = z
  .object({
    connectionId: connectionIdSchema,
    appKey: appKeySchema.describe("Connected application type."),
    displayName: z
      .string()
      .min(1)
      .max(80)
      .describe("Human-readable name of the connection."),
    identityLabel: z
      .string()
      .max(240)
      .describe("Account identity associated with the connection."),
  })
  .strict()
  .describe("One connected application account delegated to this Agent.");

export const listConnectedAppsInputSchema = z
  .object({})
  .strict()
  .describe(
    "Request to list connected application accounts available to this Agent.",
  );

export const listConnectedAppsOutputSchema = z
  .object({
    connections: z
      .array(connectedAppSchema)
      .describe("Delegated active connected application accounts."),
  })
  .strict()
  .describe("Connected application accounts delegated to this Agent.");

export const searchAppToolsInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() !== "", "Query must not be blank.")
      .describe(
        "Describe one concrete app action in English, including the app name, e.g. retrieve a Notion page as Markdown. Search separate actions separately. Do not include private page content or credentials.",
      ),
    connectionId: connectionIdSchema
      .optional()
      .describe("Optional connection to restrict the search to."),
    appKey: appKeySchema
      .optional()
      .describe("Optional application type to restrict the search to."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum number of matching tools to return."),
  })
  .strict()
  .describe("Search criteria for tools exposed by delegated connected apps.");

export const searchAppToolsOutputSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            toolSlug: z
              .string()
              .regex(/^[A-Z0-9][A-Z0-9_]{1,199}$/u)
              .describe("Provider tool identifier used for execution."),
            toolVersion: z
              .string()
              .regex(/^[0-9]{8}_[0-9]{2}$/u)
              .describe("Immutable provider tool version used for execution."),
            name: z.string().min(1).max(240).describe("Tool display name."),
            description: z
              .string()
              .max(4_000)
              .describe("Tool capability and expected behavior."),
            appKey: appKeySchema.describe("Application type."),
            inputSchema: z
              .record(z.string(), z.json())
              .describe("JSON Schema for the provider tool arguments."),
            outputSchema: z
              .record(z.string(), z.json())
              .describe(
                "Unconstrained schema (empty object). Discovery omits verbose output schemas; execute_app_tool returns the actual result data.",
              ),
            availableConnections: z
              .array(connectedAppSchema)
              .min(1)
              .describe("Connections that can execute this tool."),
          })
          .strict()
          .describe("One versioned provider tool available to this Agent."),
      )
      .max(50)
      .describe("Matching connected app tools."),
  })
  .strict()
  .describe("Versioned connected app tools matching the search.");

export const executeAppToolInputSchema = z
  .object({
    connectionId: connectionIdSchema,
    toolSlug: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_]{1,199}$/u)
      .describe("Exact provider tool identifier returned by search_app_tools."),
    toolVersion: z
      .string()
      .regex(/^[0-9]{8}_[0-9]{2}$/u)
      .describe("Exact provider tool version returned by search_app_tools."),
    arguments: z
      .record(z.string(), z.json())
      .describe(
        "Arguments satisfying the input schema returned by search_app_tools.",
      ),
  })
  .strict()
  .describe(
    "A version-pinned invocation on one delegated connected app account.",
  );

export const executeAppToolOutputSchema = z
  .object({
    data: z
      .json()
      .optional()
      .describe(
        "Sanitized JSON result returned by the connected app tool; absent when the call waits for confirmation.",
      ),
    confirmation: z
      .object({
        status: z.literal("pending").describe("Waiting for the sponsor."),
        roomId: z.string().describe("Room of the confirmation card."),
        messageId: z.string().describe("Message of the confirmation card."),
        interactionId: z.string().describe("The pending confirmation."),
      })
      .strict()
      .optional()
      .describe(
        "Present when nothing ran: TeamHub holds this write for the sponsor's confirmation card and sends the result after approval, or the denial and its reason.",
      ),
  })
  .strict()
  .refine(
    (value) =>
      (value.data !== undefined) !== (value.confirmation !== undefined),
    "Exactly one of data or confirmation is present.",
  )
  // JSON Schema cannot carry the refinement, so state it there too.
  .meta({
    oneOf: [
      { description: "The tool ran.", required: ["data"] },
      {
        description: "The call waits for confirmation.",
        required: ["confirmation"],
      },
    ],
  })
  .describe(
    "Result returned by the connected app tool, or the confirmation a write waits for.",
  );
export const listConnectedAppsSchema = {
  input: listConnectedAppsInputSchema,
  output: listConnectedAppsOutputSchema,
};

export const searchAppToolsSchema = {
  input: searchAppToolsInputSchema,
  output: searchAppToolsOutputSchema,
};

export const executeAppToolSchema = {
  input: executeAppToolInputSchema,
  output: executeAppToolOutputSchema,
};
