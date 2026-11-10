import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
  Children,
  isValidElement,
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Icon } from "@/components/ui/icon";

export interface SelectItemProps {
  children: ReactNode;
  disabled?: boolean;
  value: string;
}

const SelectPopup = lazy(() =>
  import("./select-popup").then((module) => ({ default: module.SelectPopup })),
);

export function Select({
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  autoFocus,
  id,
  "aria-label": ariaLabel,
  children,
  className = "",
  disabled = false,
  onValueChange,
  placeholder,
  value,
  variant = "field",
}: {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  autoFocus?: boolean;
  id?: string;
  "aria-label": string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  placeholder?: string;
  value: string;
  /** "pill" is the compact filter trigger; "field" matches form inputs. */
  variant?: "field" | "pill";
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () =>
      Children.toArray(children).flatMap((child) =>
        isValidElement<SelectItemProps>(child) ? [child.props] : [],
      ),
    [children],
  );
  const selectedIndex = options.findIndex((option) => option.value === value);

  function close(focusTrigger = false) {
    setOpen(false);
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        aria-label={ariaLabel}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
        autoFocus={autoFocus}
        className={`${
          variant === "pill"
            ? "select-pill min-w-0 text-left disabled:cursor-not-allowed disabled:opacity-50"
            : "ui-field-control flex min-w-0 items-center justify-between gap-2 px-3 text-left text-sm text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
        } ${className}`}
        disabled={disabled}
        id={id}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
        value={value}
      >
        <span
          className={`min-w-0 flex-1 truncate ${selectedIndex >= 0 ? "" : "text-muted-foreground"}`}
        >
          {options[selectedIndex]?.children ?? placeholder}
        </span>
        <Icon
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          icon={ArrowDown01Icon}
          size={14}
        />
      </button>
      {open ? (
        <Suspense fallback={null}>
          <SelectPopup
            id={listboxId}
            onChoose={(option) => {
              onValueChange(option.value);
              close(true);
            }}
            onClose={close}
            options={options}
            triggerRef={triggerRef}
            value={value}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export function SelectItem(_props: SelectItemProps): ReactElement | null {
  void _props;
  return null;
}
