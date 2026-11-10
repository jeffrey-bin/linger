import type { components } from "@linger/wire-contracts/linger-installer/types";
export type SetupReport = components["schemas"]["SetupReport"];
export type SetupChoice = components["schemas"]["SetupChoice"];
export function bytes(value: number | null | undefined): string {
  if (value == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit =
    value > 0
      ? Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))))
      : 0;
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
export function SetupChoicePanel({
  report,
  choice,
  onChange,
  onInstall,
  disabled,
  blocker,
}: {
  report: SetupReport;
  choice?: SetupChoice;
  onChange: (choice: SetupChoice) => void;
  onInstall: () => void;
  disabled: boolean;
  blocker?: string;
}) {
  const selected =
    choice === "local-models"
      ? report.localModels.estimate
      : report.runtimes.find((r) => r.choice === choice)?.estimate;
  const label =
    choice === "local-models"
      ? report.localModels.estimate.model || "Local models"
      : choice
        ? { codex: "Codex", claude: "Claude Code", pi: "Pi" }[choice]
        : "";
  return (
    <section className="setup-choice" aria-label={"Deployment plan"}>
      <p className="recommended-plan">
        <span className="recommendation-tag">
          {choice === report.recommendation ? "Recommended" : "Selected"}
        </span>
        <strong>{label}</strong>
      </p>
      {selected && (
        <div className="setup-budget">
          <p>
            {"Download"} {bytes(selected.downloadBytes)} · {"Disk"}{" "}
            {bytes(selected.diskBytes)}
            {selected.memoryBytes != null
              ? ` · RAM ${bytes(selected.memoryBytes)}`
              : ""}
          </p>
          {selected.durationSeconds && (
            <p>
              {"About"} {Math.ceil(selected.durationSeconds.min / 60)}–
              {Math.ceil(selected.durationSeconds.max / 60)} {"minutes"}
            </p>
          )}
          {choice === "local-models" && (
            <p>
              {
                "Includes model loading. Review the exact GPU and resource plan before downloading."
              }
            </p>
          )}
        </div>
      )}
      {blocker && (
        <p
          className="setup-blocker"
          role="status"
          aria-label={"Before installation"}
        >
          {blocker}
        </p>
      )}
      <div className="harness-choices">
        <div role="radiogroup" aria-label={"Installation plan"}>
          {report.choices
            .filter((option) => option !== "local-models")
            .map((option) => {
              const runtime = report.runtimes.find((r) => r.choice === option);
              return (
                <label
                  className={`setup-option ${choice === option ? "selected" : ""}`}
                  key={option}
                >
                  <input
                    type="radio"
                    name="setup-choice"
                    value={option}
                    checked={choice === option}
                    onChange={() => onChange(option)}
                  />
                  <span>
                    <strong>
                      {
                        { codex: "Codex", claude: "Claude Code", pi: "Pi" }[
                          option
                        ]
                      }
                    </strong>
                    {report.recommendation === option ? " · Recommended" : ""}
                    <small>
                      {runtime?.installed
                        ? "Installed · will reuse"
                        : "Will install"}
                    </small>
                  </span>
                </label>
              );
            })}
        </div>
      </div>
      <button
        className="button primary deploy-action"
        disabled={disabled}
        onClick={onInstall}
      >
        {"Install Linger"}
      </button>
    </section>
  );
}
