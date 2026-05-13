/**
 * Pub-count / grant-count summary row. Used in the PersonPopover header
 * region for surfaces that don't have a more specific contextual line.
 */
export function PersonCardStats({
  pubCount,
  grantCount,
}: {
  pubCount: number;
  grantCount: number;
}) {
  if (pubCount === 0 && grantCount === 0) return null;
  return (
    <div className="mt-3 flex gap-4 border-t border-border pt-2.5 text-xs text-foreground/80">
      {pubCount > 0 ? (
        <span>
          <span className="font-semibold tabular-nums text-foreground">
            {pubCount.toLocaleString()}
          </span>{" "}
          pub{pubCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {grantCount > 0 ? (
        <span>
          <span className="font-semibold tabular-nums text-foreground">
            {grantCount.toLocaleString()}
          </span>{" "}
          grant{grantCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}
