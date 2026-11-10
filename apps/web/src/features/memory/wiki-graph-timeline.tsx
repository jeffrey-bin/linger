import { ArrowRightDoubleIcon } from "@hugeicons/core-free-icons";
import { formatDateTime } from "@/lib/date-format";
import { Icon } from "@/components/ui/icon";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { TimeBucket, TimeGranularity } from "./wiki-graph-model";

interface WikiGraphTimelineProps {
  buckets: TimeBucket[];
  granularity: TimeGranularity;
  /** Bucket under the playhead. */
  cursor: number;
  onCursorChange: (cursor: number) => void;
  onSelect?: (index: number) => void;
  /** True once a day is picked; false while every page is shown. */
  focused: boolean;
  onShowAll: () => void;
}

/** The ruler scrolls under a fixed playhead, like a focus ring. */
const STEP: Record<TimeGranularity, number> = { day: 18, week: 60 };
const FRICTION = 0.93;
const SNAP_MS = 260;
const CLICK_SLOP = 4;

export function WikiGraphTimeline({
  buckets,
  granularity,
  cursor,
  onCursorChange,
  onSelect,
  focused,
  onShowAll,
}: WikiGraphTimelineProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Fractional playhead position while dragging, gliding or snapping.
  const [position, setPosition] = useState(cursor);
  const positionRef = useRef(cursor);
  const animation = useRef(0);
  const settling = useRef(false);
  const drag = useRef<{
    x: number;
    origin: number;
    moved: boolean;
    samples: { x: number; t: number }[];
  }>(undefined);
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [dragging, setDragging] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number>();
  const reducedMotion = usePrefersReducedMotion();

  const count = buckets.length;
  const last = Math.max(0, count - 1);
  const step = STEP[granularity];
  const center = width / 2;
  const maxCount = Math.max(
    1,
    ...buckets.map((b) => b.counts.session + b.counts.event),
  );

  useLayoutEffect(() => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? 0),
    );
    observer.observe(ruler);
    return () => observer.disconnect();
  }, []);

  const place = useCallback((value: number) => {
    positionRef.current = value;
    setPosition(value);
  }, []);

  // Follow cursor changes from outside (granularity switch, jump to latest).
  useEffect(() => {
    if (
      !drag.current &&
      !settling.current &&
      Math.round(positionRef.current) !== cursor
    )
      place(cursor);
  }, [cursor, place]);

  useEffect(
    () => () => {
      cancelAnimationFrame(animation.current);
      clearTimeout(wheelTimer.current);
    },
    [],
  );

  const commit = useCallback(
    (value: number) => {
      const index = clamp(Math.round(value), 0, last);
      if (index !== cursor) onCursorChange(index);
    },
    [cursor, last, onCursorChange],
  );

  /** Ease onto a bucket so the playhead always rests on a day or week. */
  const snapTo = useCallback(
    (from: number, target: number) => {
      cancelAnimationFrame(animation.current);
      const goal = clamp(Math.round(target), 0, last);
      commit(goal);
      if (reducedMotion) return place(goal);
      settling.current = true;
      const startedAt = performance.now();
      const frame = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / SNAP_MS);
        const eased = 1 - (1 - progress) ** 3;
        place(from + (goal - from) * eased);
        if (progress < 1) animation.current = requestAnimationFrame(frame);
        else settling.current = false;
      };
      animation.current = requestAnimationFrame(frame);
    },
    [commit, last, place, reducedMotion],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !count) return;
    cancelAnimationFrame(animation.current);
    settling.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      origin: positionRef.current,
      moved: false,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    };
  };

  /** The bucket whose slot is under a viewport x, given the ruler's offset. */
  const slotAt = (clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const offset = rect.width / 2 - (positionRef.current + 0.5) * step;
    const index = Math.floor((clientX - rect.left - offset) / step);
    return index < 0 || index > last ? undefined : index;
  };

  const hoverAt = (clientX: number | undefined) =>
    setHoverIndex(clientX === undefined ? undefined : slotAt(clientX));

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return hoverAt(event.clientX);
    const deltaX = event.clientX - current.x;
    if (!current.moved && Math.abs(deltaX) < CLICK_SLOP) return;
    if (!current.moved) {
      current.moved = true;
      setDragging(true);
      hoverAt(undefined);
    }
    current.samples = [
      ...current.samples.slice(-4),
      { x: event.clientX, t: event.timeStamp },
    ];
    // Dragging the ruler right brings earlier days under the playhead.
    const next = clamp(current.origin - deltaX / step, -0.4, last + 0.4);
    place(next);
    commit(next);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = undefined;
    setDragging(false);
    if (!current) return;
    if (!current.moved) {
      // A click glides the clicked bucket under the playhead.
      const rect = event.currentTarget.getBoundingClientRect();
      const offset = (event.clientX - rect.left - rect.width / 2) / step;
      const target = clamp(Math.round(positionRef.current + offset), 0, last);
      snapTo(positionRef.current, target);
      onSelect?.(target);
      return;
    }
    const [first, latest] = [current.samples[0]!, current.samples.at(-1)!];
    const velocity =
      latest.t > first.t
        ? -(latest.x - first.x) / (latest.t - first.t) / step
        : 0; // buckets/ms
    if (reducedMotion || Math.abs(velocity) < 0.002)
      return snapTo(positionRef.current, positionRef.current);
    let speed = velocity * 16;
    let value = positionRef.current;
    const glide = () => {
      speed *= FRICTION;
      value = clamp(value + speed, 0, last);
      place(value);
      commit(value);
      if (Math.abs(speed) > 0.02 && value > 0 && value < last)
        animation.current = requestAnimationFrame(glide);
      else snapTo(value, value);
    };
    animation.current = requestAnimationFrame(glide);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
    cancelAnimationFrame(animation.current);
    settling.current = false;
    const next = clamp(positionRef.current + delta / step, 0, last);
    place(next);
    commit(next);
    clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(
      () => snapTo(positionRef.current, positionRef.current),
      120,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(cursor);
      return;
    }
    const target =
      event.key === "ArrowLeft"
        ? cursor - 1
        : event.key === "ArrowRight"
          ? cursor + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    snapTo(positionRef.current, target);
    onSelect?.(clamp(target, 0, last));
  };

  if (!count) {
    return (
      <div className="wiki-graph-timeline wiki-graph-timeline-empty">
        No dated sessions or events yet.
      </div>
    );
  }

  const focus = clamp(Math.round(position), 0, last);
  const bucket = buckets[focus]!;
  const offset = center - (position + 0.5) * step;
  const traveled = (clamp(position, 0, last) + 0.5) * step;
  const atLatest = cursor === last;

  return (
    <div className="wiki-graph-timeline">
      <div className="wiki-graph-timeline-controls">
        <div className="wiki-graph-readout" aria-live="polite">
          <p className="wiki-graph-readout-date">
            {longLabel(bucket.start, granularity)}
            <span className="wiki-graph-readout-year">
              {yearOf(bucket.start, granularity)}
            </span>
          </p>
        </div>
        <button
          aria-label="Jump to latest"
          className="wiki-graph-latest"
          data-hidden={(atLatest && !focused) || undefined}
          onClick={() => {
            snapTo(positionRef.current, last);
            onShowAll();
          }}
          tabIndex={atLatest && !focused ? -1 : 0}
          type="button"
        >
          Latest <Icon icon={ArrowRightDoubleIcon} size={14} />
        </button>
      </div>
      <div
        aria-label="Timeline playhead"
        aria-valuemax={last}
        aria-valuemin={0}
        aria-valuenow={cursor}
        aria-valuetext={fullLabel(
          buckets[cursor]?.start ?? bucket.start,
          granularity,
        )}
        className="wiki-graph-ruler"
        data-dragging={dragging || undefined}
        onKeyDown={onKeyDown}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => !drag.current && hoverAt(undefined)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        ref={rulerRef}
        role="slider"
        tabIndex={0}
      >
        <div
          className="wiki-graph-ruler-track"
          style={{ transform: `translateX(${offset}px)`, width: count * step }}
        >
          <span className="wiki-graph-ruler-line" />
          <span
            className="wiki-graph-ruler-traveled"
            style={{ width: traveled }}
          />
          {buckets.map((item, index) => {
            const total = item.counts.session + item.counts.event;
            const distance = Math.abs((index - position) * step);
            const nearness = Math.max(0, 1 - distance / Math.max(center, 1));
            const major =
              Boolean(item.monthLabel) ||
              (granularity === "day" && isMonday(item.start));
            const past = index <= position + 0.5;
            return (
              <span
                className="wiki-graph-ruler-slot"
                key={item.start}
                style={{ left: index * step, width: step }}
              >
                <span
                  className="wiki-graph-ruler-tick"
                  data-hovered={index === hoverIndex || undefined}
                  data-major={major || undefined}
                  data-past={past || undefined}
                  style={{ opacity: 0.25 + 0.75 * nearness }}
                />
                {total ? (
                  <span
                    className="wiki-graph-ruler-event"
                    data-past={past || undefined}
                    style={
                      {
                        "--size": `${3 + 5 * Math.sqrt(total / maxCount)}px`,
                      } as CSSProperties
                    }
                  />
                ) : null}
                {item.monthLabel ? (
                  <span className="wiki-graph-ruler-month">
                    {item.monthLabel}
                    {item.yearLabel ? (
                      <span className="wiki-graph-ruler-year">
                        {item.yearLabel}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
        <span aria-hidden className="wiki-graph-playhead" />
      </div>
      {hoverIndex !== undefined && !dragging ? (
        <HoverPreview
          inset={rulerRef.current?.offsetLeft ?? 0}
          label={fullLabel(buckets[hoverIndex]!.start, granularity)}
          left={center - (position + 0.5) * step + (hoverIndex + 0.5) * step}
          width={width}
        />
      ) : null}
    </div>
  );
}

function HoverPreview({
  inset,
  label,
  left,
  width,
}: {
  inset: number;
  label: string;
  left: number;
  width: number;
}) {
  const x = inset + clamp(left, 110, Math.max(110, width - 110));
  return (
    <div
      className="wiki-graph-preview"
      style={{ transform: `translateX(${x}px) translateX(-50%)` }}
    >
      <p className="wiki-graph-preview-date">{label}</p>
    </div>
  );
}

function longLabel(start: string, granularity: TimeGranularity): string {
  const date = new Date(`${start}T00:00:00Z`);
  const month = formatDateTime(date, {
    month: "short",
    timeZone: "UTC",
  }).toUpperCase();
  if (granularity === "day") return `${month} ${date.getUTCDate()}`;
  const end = new Date(date.getTime() + 6 * 86_400_000);
  const endMonth = formatDateTime(end, {
    month: "short",
    timeZone: "UTC",
  }).toUpperCase();
  return `${month} ${date.getUTCDate()} – ${endMonth === month ? "" : `${endMonth} `}${end.getUTCDate()}`;
}

/** The bucket's year, or both years for a week that crosses New Year. */
function yearOf(start: string, granularity: TimeGranularity): string {
  const first = start.slice(0, 4);
  if (granularity === "day") return first;
  const last = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000)
    .toISOString()
    .slice(0, 4);
  return first === last ? first : `${first}–${last}`;
}

function fullLabel(start: string, granularity: TimeGranularity): string {
  return `${longLabel(start, granularity)}, ${yearOf(start, granularity)}`;
}

function isMonday(day: string): boolean {
  return new Date(`${day}T00:00:00Z`).getUTCDay() === 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
