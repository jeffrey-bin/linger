import {
  BotIcon,
  LaptopIcon,
  Message01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";

import styles from "./agent-creation-progress.module.css";

export type AgentCreationStage = "preparing" | "creating" | "opening";

export function AgentCreationProgress({
  stage,
}: {
  stage: AgentCreationStage;
}) {
  const steps = ["Connect computer", "Create Agent", "Open chat"];
  const activeStep = { preparing: 0, creating: 1, opening: 2 }[stage];
  const title = {
    preparing: "Finding your computer",
    creating: "Bringing your Agent to life",
    opening: "Your Agent is ready",
  }[stage];
  const description = {
    preparing: "Looking for a connected computer to get started.",
    creating: "Setting up everything for your first conversation.",
    opening: "Opening your conversation. Say hello!",
  }[stage];

  return (
    <div className="w-full max-w-sm py-3 text-center text-app-ink">
      <div className={styles.illustration} aria-hidden="true">
        <div className={styles.halo} />
        <svg className={styles.connection} viewBox="0 0 320 140" fill="none">
          <path d="M60 76 C100 76 100 58 160 58 S225 76 260 76" />
        </svg>
        <span className={`${styles.node} ${styles.source}`}>
          <Icon icon={LaptopIcon} size={24} />
        </span>
        <span className={styles.agent}>
          <Icon icon={BotIcon} size={40} />
          {stage === "opening" && (
            <span className={styles.online}>
              <Icon icon={Tick02Icon} size={10} />
            </span>
          )}
        </span>
        <span className={styles.sparkle}>
          <Icon icon={SparklesIcon} size={20} />
        </span>
        <span className={`${styles.node} ${styles.chat}`}>
          <Icon icon={Message01Icon} size={24} />
        </span>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h3
          className={`text-base font-semibold ${stage === "opening" ? "" : "town-shimmer-text"}`}
        >
          {title}
        </h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <ol
        aria-label="Agent creation progress"
        className="mt-7 grid grid-cols-3 gap-2 text-xs leading-4"
      >
        {steps.map((step, index) => (
          <li
            key={step}
            aria-current={index === activeStep ? "step" : undefined}
            className={
              index === activeStep
                ? "font-medium text-app-ink"
                : index < activeStep
                  ? "text-app-body"
                  : "text-app-muted"
            }
          >
            <span
              aria-hidden="true"
              className={`mx-auto mb-2 grid size-6 place-items-center rounded-full text-xs leading-none tabular-nums ${index < activeStep ? "bg-[var(--app-status-success-surface)] text-app-success" : index === activeStep ? "bg-primary font-semibold text-primary-foreground ring-4 ring-muted" : "bg-muted text-muted-foreground"}`}
            >
              {index < activeStep ? (
                <Icon icon={Tick02Icon} size={12} />
              ) : (
                <span>{index + 1}</span>
              )}
            </span>
            {step}
            <span className="sr-only">
              {index < activeStep
                ? ": complete"
                : index === activeStep
                  ? ": in progress"
                  : ": waiting"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
