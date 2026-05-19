// Shared whimsical "nothing to show yet" card used across the app whenever a
// section's underlying real data is empty. Keeps the tone consistent with the
// PRD's voice guide (clever, encouraging friend; no exclamation marks unless
// genuinely celebratory; contractions welcome).
//
// Usage:
//   <EmptyState
//     title="Quiet around here."
//     body="Your activity feed will fill in once you import some history."
//     ctaLabel="Add an Account"
//     onCta={() => onAddAccount?.()}
//   />
//
// Omit `onCta` to render without a CTA (useful for cases where the path to
// resolution isn't a CSV upload, like opening an HSA, or inside a filtered
// account view where the account already exists).

import type { ReactNode } from 'react';

type Props = {
  /** The whimsical headline line. Sentence case, no exclamation marks. */
  title: string;
  /** Optional supporting copy below the title. */
  body?: ReactNode;
  /** Optional CTA button label. Defaults to "Add an Account" when onCta is provided. */
  ctaLabel?: string;
  /** Click handler for the CTA. If omitted, no button renders. */
  onCta?: () => void;
  /**
   * Use smaller padding for in-card empty states (e.g. a panel inside a card),
   * versus the default which is sized to anchor a full page slot.
   */
  compact?: boolean;
  /** Optional glyph rendered above the title. Defaults to a soft mark. */
  glyph?: string;
};

export function EmptyState({ title, body, ctaLabel, onCta, compact, glyph = '✦' }: Props) {
  const label = ctaLabel ?? 'Add an Account';
  return (
    <div className={`empty-state${compact ? ' empty-state-compact' : ''}`} role="status">
      <div className="empty-state-glyph" aria-hidden="true">
        {glyph}
      </div>
      <div className="empty-state-title">{title}</div>
      {body && <div className="empty-state-body">{body}</div>}
      {onCta && (
        <div className="empty-state-actions">
          <button type="button" className="btn btn-primary" onClick={onCta}>
            {label}
          </button>
        </div>
      )}
    </div>
  );
}
