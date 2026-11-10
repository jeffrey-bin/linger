/** The Linger L and amber dot on the approved dark app tile. */
export function BrandMark({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      alt={decorative ? "" : "Linger"}
      aria-hidden={decorative || undefined}
      className={`linger-brand-mark ${className}`}
      draggable={false}
      src="/favicon.svg"
    />
  );
}
