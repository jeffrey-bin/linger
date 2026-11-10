import { useEffect, useLayoutEffect, useRef, useState } from "react";

const HOURS = Array.from({ length: 24 }, (_, hour) =>
  String(hour).padStart(2, "0"),
);
const MINUTES = Array.from({ length: 60 }, (_, minute) =>
  String(minute).padStart(2, "0"),
);

export function RoutineTimeField({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const minuteInputRef = useRef<HTMLInputElement>(null);
  const hourOptionRef = useRef<HTMLButtonElement>(null);
  const minuteOptionRef = useRef<HTMLButtonElement>(null);
  const parsed = parseClock(value) ?? { hour: "09", minute: "00" };
  const [open, setOpen] = useState(false);
  const [hourText, setHourText] = useState(parsed.hour);
  const [minuteText, setMinuteText] = useState(parsed.minute);

  useEffect(() => {
    if (open) return;
    const next = parseClock(value) ?? { hour: "09", minute: "00" };
    setHourText(next.hour);
    setMinuteText(next.minute);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    hourOptionRef.current?.scrollIntoView?.({ block: "center" });
    minuteOptionRef.current?.scrollIntoView?.({ block: "center" });
  }, [open, parsed.hour, parsed.minute]);

  function commit(nextHour: string, nextMinute: string) {
    const clock = parseClock(`${nextHour}:${nextMinute}`);
    if (!clock) return;
    setHourText(clock.hour);
    setMinuteText(clock.minute);
    onChange(`${clock.hour}:${clock.minute}`);
  }

  return (
    <div className="relative mt-1 w-full" ref={rootRef}>
      <div className="relative grid grid-cols-2 rounded-md border border-input bg-card transition-colors duration-150 hover:border-border-hover focus-within:border-foreground focus-within:ring-2 focus-within:ring-ring">
        <input
          aria-label="Hour"
          className="h-[34px] w-full bg-transparent px-3 py-1 text-center text-sm tabular-nums text-foreground outline-none"
          inputMode="numeric"
          maxLength={2}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, 2);
            setHourText(digits);
            if (digits.length === 2 && Number(digits) <= 23) {
              commit(digits, parsed.minute);
              minuteInputRef.current?.focus();
            }
          }}
          onFocus={() => setOpen(true)}
          spellCheck={false}
          value={hourText}
        />
        <input
          aria-label="Minute"
          className="h-[34px] w-full bg-transparent px-3 py-1 text-center text-sm tabular-nums text-foreground outline-none"
          inputMode="numeric"
          maxLength={2}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, 2);
            setMinuteText(digits);
            if (digits.length === 2 && Number(digits) <= 59) {
              commit(parsed.hour, digits);
            }
          }}
          onFocus={() => setOpen(true)}
          ref={minuteInputRef}
          spellCheck={false}
          value={minuteText}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 flex items-center -translate-x-1/2 text-sm text-muted-foreground"
        >
          :
        </span>
      </div>
      {open ? (
        <div className="app-floating-enter absolute inset-x-0 top-full z-20 mt-1 grid grid-cols-2 overflow-hidden rounded-lg bg-popover shadow-lg">
          <TimeColumn
            label="Hours"
            onSelect={(nextHour) => commit(nextHour, parsed.minute)}
            options={HOURS}
            selected={parsed.hour}
            selectedRef={hourOptionRef}
          />
          <TimeColumn
            label="Minutes"
            onSelect={(nextMinute) => {
              commit(parsed.hour, nextMinute);
              setOpen(false);
            }}
            options={MINUTES}
            selected={parsed.minute}
            selectedRef={minuteOptionRef}
          />
        </div>
      ) : null}
    </div>
  );
}

function TimeColumn({
  label,
  onSelect,
  options,
  selected,
  selectedRef,
}: {
  label: string;
  onSelect: (value: string) => void;
  options: string[];
  selected: string;
  selectedRef: { current: HTMLButtonElement | null };
}) {
  return (
    <div
      aria-label={label}
      className="workspace-scrollbar max-h-48 overflow-y-auto py-1"
      role="listbox"
    >
      {options.map((option) => {
        const isSelected = option === selected;
        return (
          <button
            aria-selected={isSelected}
            className={`flex h-7 w-full items-center justify-center text-xs tabular-nums ${
              isSelected
                ? "bg-app-selected font-medium text-app-ink"
                : "text-app-ink hover:bg-app-hover"
            }`}
            key={option}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(option)}
            ref={isSelected ? selectedRef : undefined}
            role="option"
            type="button"
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function parseClock(value: string) {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour > 23 || minute > 59) return null;
  return {
    hour: String(hour).padStart(2, "0"),
    minute: String(minute).padStart(2, "0"),
  };
}
