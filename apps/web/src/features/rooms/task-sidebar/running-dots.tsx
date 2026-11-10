/** Town "thinking dots" (town-dot-wave) sized for compact status pills. */
export function RunningDots({ size = 4 }: { size?: number }) {
  const dot = { height: size, width: size };
  return (
    <span
      aria-hidden="true"
      className="town-dots text-muted-foreground"
      style={{ gap: size / 2 }}
    >
      <span style={dot} />
      <span style={dot} />
      <span style={dot} />
    </span>
  );
}
