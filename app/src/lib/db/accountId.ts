// Build a stable, human-readable account ID from the user-facing account name.
// We previously used `${slug}-${Date.now()}-${random}` which produced ugly
// strings like "fidelity-individual-mh3wp9-7lh" that leaked into the UI. The
// new approach keeps it readable ("fidelity-taxable", "fidelity-taxable-2") and
// deterministic for the same input + collision set.

const MAX_BASE_LEN = 40;

/** Lowercase, alphanum + dash, collapse runs, trim edges, cap length. */
function baseSlug(name: string): string {
  const raw = (name || '').trim();
  if (!raw) return 'account';
  return (
    raw
      .toLowerCase()
      // Replace anything that isn't a-z or 0-9 with a single dash.
      .replace(/[^a-z0-9]+/g, '-')
      // Trim leading/trailing dashes that the replace may have produced.
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_BASE_LEN)
      // After slicing we may have a trailing dash again; strip it.
      .replace(/-+$/g, '') || 'account'
  );
}

/**
 * Build a unique account ID derived from `name`. If the base slug collides with
 * anything in `existingIds`, append `-2`, `-3`, etc. until we find a free slot.
 *
 * `brokerage` is accepted for forward-compatibility (future callers may want to
 * incorporate it into the prefix) but is currently unused: the name already
 * tends to include the brokerage ("Fidelity Taxable"), and adding it again
 * produces noisy IDs like "fidelity-fidelity-taxable".
 */
export function slugifyAccountId(name: string, _brokerage: string, existingIds: string[] = []): string {
  const base = baseSlug(name);
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
