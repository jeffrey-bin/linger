import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, option, values } from "./command-input.js";
import { falGeneration } from "./connector-fal.js";
import { higgsfieldGeneration } from "./connector-higgsfield.js";
import { assertNewOutput, validateLocalFiles } from "./connector-files.js";
import {
  choice,
  pageInput,
  pageSchema,
  schema,
  stringSchema,
  text,
  usage,
} from "./connector-input.js";
import {
  fieldValues,
  generationPrices,
  prose,
  type GenerationProvider,
} from "./connector-media.js";
import {
  connectorDefinition,
  optionalFields,
  toggle,
  value,
  type Json,
} from "./connector-runtime.js";
import { array, object } from "./connector-schemas.js";

const providers: Record<string, GenerationProvider> = {
  fal: falGeneration,
  higgsfield: higgsfieldGeneration,
};
const anyObject = { type: "object", additionalProperties: true };

export const generationCommandDefinitions: CommandDefinition[] = [
  "image",
  "video",
].map((type) =>
  connectorDefinition({
    command: [`${type}-gen`],
    app: (input) => input.provider as string,
    description: `Start ${type === "image" ? "an image" : "a video"} generation job, look up model prices, or check a job and save its result.`,
    readOnly: false,
    options: {
      "--provider": value("fal or higgsfield; required."),
      "--model": value(
        "Provider model ID; required for generation and job lookup.",
      ),
      "--prompt": value("What to generate; required for generation."),
      "--price": toggle(
        "Read model prices without starting a job; --model selects one model and its parameters.",
      ),
      "--job": value(
        "Check an existing job once without submitting again; repeatable for Higgsfield.",
        true,
      ),
      "--set": value(
        "Model parameter as field=value; repeatable. JSON values keep their types.",
        true,
      ),
      "--file": value(
        "Reference input as field=local-path; repeatable. Use a fal input field or a Higgsfield media role.",
        true,
      ),
      "--output": value(
        "Where finished results are saved: one to a new file, several to a new directory. Saved by the --job check that finds the job finished; never overwrites.",
      ),
      "--limit": value("Price-list page size, 1-100, default 20."),
      "--cursor": value(
        "Continue the previous price-list page with the same provider and account.",
      ),
    },
    usage: [
      `teamhub ${type}-gen --provider <provider> --model <model-id> --prompt <text> [flags]`,
      `teamhub ${type}-gen --provider <provider> --price [--model <model-id>] [flags]`,
      `teamhub ${type}-gen --provider <provider> --model <model-id> --job <job-id> [flags]`,
    ],
    examples:
      type === "image"
        ? [
            'teamhub image-gen --provider fal --model fal-ai/flux/dev --prompt "a red fox in snow" --output ./fox.png',
            "teamhub image-gen --provider higgsfield --price",
            "teamhub image-gen --provider higgsfield --price --model gpt_image_2_6",
          ]
        : [
            'teamhub video-gen --provider higgsfield --model seedance_2_5 --prompt "camera slowly orbits the product" --file start_image=./bottle.png --set duration=5 --output ./orbit.mp4',
            "teamhub video-gen --provider fal --price",
          ],
    notes: [
      "Generation spends the selected connected account's balance. --price returns fal unit prices; Higgsfield reports pricingStatus=unavailable because its model catalog exposes no price table. No estimate is substituted and no job starts.",
      "Generation returns as soon as the provider accepts the job; it does not wait for the result. Run the returned nextCommand later to check the job once; it saves to --output when the job has finished. Never repeat a paid submission after an unknown outcome.",
      "--price --model also shows model-specific parameters and reference inputs. Pass those parameters with --set and local reference files with --file.",
      "A single result is saved as delivered under the requested name. A warning reports a mismatched file extension; no conversion is performed.",
    ],
    inputSchema: schema(
      {
        provider: { enum: ["fal", "higgsfield"] },
        type: { enum: ["image", "video"] },
        mode: { enum: ["generate", "price", "job"] },
        model: stringSchema,
        parameters: anyObject,
        files: array(object({ field: stringSchema, path: stringSchema })),
        jobIds: array(stringSchema),
        output: stringSchema,
        ...pageSchema,
      },
      ["provider", "type", "mode"],
    ),
    outputSchema: {
      anyOf: [
        generationPrices,
        falGeneration.outputSchema,
        higgsfieldGeneration.outputSchema,
      ],
    },
    sourceFiles: (input) =>
      ((input.files ?? []) as Json[]).map((file) => file.path as string),
    normalize: async (args, reader) => {
      assertPositionals(args, 0);
      const provider =
        choice(
          option(args, "--provider"),
          ["fal", "higgsfield"],
          "--provider",
        ) ?? usage("Provide --provider fal or higgsfield.");
      const jobIds = values(args, "--job");
      if (args.options["--price"] && jobIds.length)
        usage("Choose --price or --job, not both.");
      const mode = args.options["--price"]
        ? "price"
        : jobIds.length
          ? "job"
          : "generate";
      const model = option(args, "--model");
      if (model !== undefined) {
        const valid =
          provider === "fal"
            ? /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+$/u
            : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
        if (model.length > 256 || !valid.test(model))
          usage("--model must be a provider model ID from --price.");
      }
      if (mode !== "generate") {
        for (const flag of ["--prompt", "--set", "--file"])
          if (args.options[flag])
            usage(`${flag} is only available for generation.`);
      }
      if (mode !== "price" || model !== undefined) {
        for (const flag of ["--limit", "--cursor"])
          if (args.options[flag])
            usage(`${flag} is only available with --price without --model.`);
      }
      if (mode === "price") {
        if (args.options["--output"])
          usage("--output is not available with --price.");
        return {
          input: optionalFields({
            provider,
            type,
            mode,
            model,
            ...(model === undefined ? pageInput(args) : {}),
          }),
        };
      }
      if (model === undefined)
        usage("Provide --model; list models and prices with --price.");
      const input: Json = { provider, type, mode, model };
      if (mode === "job") {
        const valid =
          provider === "fal"
            ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
            : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
        if (
          jobIds.length > (provider === "fal" ? 1 : 12) ||
          jobIds.some((id) => !valid.test(id))
        )
          usage(
            "Provide valid job IDs from this provider; fal takes one, Higgsfield up to 12.",
          );
        input.jobIds = [...new Set(jobIds)];
      } else {
        const parameters = {
          prompt: prose(option(args, "--prompt"), "--prompt"),
          ...fieldValues(args),
        };
        for (const name of [
          "model",
          "prompt",
          "get_cost",
          "__proto__",
          "constructor",
          "prototype",
        ])
          if (
            values(args, "--set").some(
              (item) => item.slice(0, item.indexOf("=")) === name,
            )
          )
            usage(`Use the dedicated flags instead of --set ${name}.`);
        input.parameters = parameters;
        const files = values(args, "--file").map((item) => {
          const at = item.indexOf("=");
          const field = at > 0 ? item.slice(0, at) : "";
          if (
            !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(field) ||
            ["__proto__", "constructor", "prototype"].includes(field) ||
            at === item.length - 1
          )
            usage("--file takes field=local-path with a plain field name.");
          if (
            Object.hasOwn(parameters, field) ||
            (provider === "higgsfield" && Object.hasOwn(parameters, "medias"))
          )
            usage(`${field} is set by more than one flag.`);
          return { field, path: item.slice(at + 1) };
        });
        if (files.length > (provider === "higgsfield" ? 12 : 20))
          usage(
            "Too many reference files: fal accepts up to 20, Higgsfield up to 12.",
          );
        const paths = await validateLocalFiles(
          files.map((file) => file.path),
          reader.cwd,
        );
        if (files.length)
          input.files = files.map((file, index) => ({
            ...file,
            path: paths[index]!,
          }));
      }
      const output = option(args, "--output");
      if (output !== undefined)
        input.output = await assertNewOutput(
          text(output, "--output", 4096),
          reader.cwd,
        );
      return { input };
    },
    bindings: (input) => providers[input.provider as string]!.bindings(input),
    bindingSchema: (slug, schema) =>
      falGeneration.bindingSchema?.(slug, schema) ?? schema,
    execute: (input, runtime) =>
      providers[input.provider as string]!.execute(input, runtime),
  }),
);
