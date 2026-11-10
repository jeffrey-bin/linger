import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useState,
} from "react";

interface Hsv {
  h: number;
  s: number;
  v: number;
}

/**
 * A continuous color palette: a saturation/brightness field over a hue strip.
 * Dragging either updates the color live; arrow keys nudge it.
 */
export function ColorPalette({
  "aria-label": ariaLabel,
  disabled = false,
  onChange,
  value,
}: {
  "aria-label": string;
  disabled?: boolean;
  onChange: (hex: string) => void;
  value: string;
}) {
  const hsv = hexToHsv(value);
  // Grays carry no hue; remember the last one so the field doesn't jump to red.
  const [lastHue, setLastHue] = useState(hsv.h);
  const hue = hsv.s > 0 && hsv.v > 0 ? hsv.h : lastHue;
  const current = { ...hsv, h: hue };

  function emit(next: Hsv) {
    setLastHue(next.h);
    onChange(hsvToHex(next));
  }

  function track(
    event: PointerEvent<HTMLElement>,
    apply: (x: number, y: number) => void,
  ) {
    if (disabled) return;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const update = (clientX: number, clientY: number) => {
      const rect = target.getBoundingClientRect();
      apply(
        clamp((clientX - rect.left) / rect.width),
        clamp((clientY - rect.top) / rect.height),
      );
    };
    update(event.clientX, event.clientY);
    const move = (moveEvent: globalThis.PointerEvent) =>
      update(moveEvent.clientX, moveEvent.clientY);
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  }

  function nudgeField(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = {
      ArrowDown: [0, -step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    emit({
      ...current,
      s: clamp(current.s + move[0]),
      v: clamp(current.v + move[1]),
    });
  }

  function nudgeHue(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 15 : 3;
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? step
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -step
          : 0;
    if (!delta) return;
    event.preventDefault();
    emit({ ...current, h: (hue + delta + 360) % 360 });
  }

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      className="color-palette"
      role="group"
      style={
        {
          "--color-palette-hue": `hsl(${hue} 100% 50%)`,
        } as CSSProperties
      }
    >
      <div
        aria-label={`${ariaLabel} saturation and brightness`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(current.v * 100)}
        aria-valuetext={`${Math.round(current.s * 100)}% saturation, ${Math.round(current.v * 100)}% brightness`}
        className="color-palette-field"
        onKeyDown={nudgeField}
        onPointerDown={(event) =>
          track(event, (x, y) => emit({ ...current, s: x, v: 1 - y }))
        }
        role="slider"
        tabIndex={disabled ? -1 : 0}
      >
        <span
          aria-hidden="true"
          className="color-palette-thumb"
          style={{
            backgroundColor: value,
            left: `${current.s * 100}%`,
            top: `${(1 - current.v) * 100}%`,
          }}
        />
      </div>
      <div
        aria-label={`${ariaLabel} hue`}
        aria-valuemax={360}
        aria-valuemin={0}
        aria-valuenow={Math.round(hue)}
        className="color-palette-hue"
        onKeyDown={nudgeHue}
        onPointerDown={(event) =>
          track(event, (x) => emit({ ...current, h: x * 359.9 }))
        }
        role="slider"
        tabIndex={disabled ? -1 : 0}
      >
        <span
          aria-hidden="true"
          className="color-palette-thumb"
          style={{
            backgroundColor: `hsl(${hue} 100% 50%)`,
            left: `${(hue / 360) * 100}%`,
            top: "50%",
          }}
        />
      </div>
    </div>
  );
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function hexToHsv(color: string): Hsv {
  const hex = /^#?[0-9a-f]{6}$/i.test(color)
    ? color.replace("#", "")
    : "9F56F2";
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    h =
      max === r
        ? ((g - b) / d + 6) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
  }
  return { h: h * 60, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}
