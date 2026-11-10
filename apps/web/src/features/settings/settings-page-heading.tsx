export function SettingsPageHeading({
  description,
  title,
}: {
  description?: string;
  title: string;
}) {
  return (
    <header>
      <h1 className="text-2xl text-foreground">{title}</h1>
      {description ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
