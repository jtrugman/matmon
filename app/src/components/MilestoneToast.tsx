import { useEffect } from 'react';

/**
 * A single milestone the toast renders. Built fresh by the caller (App.tsx or
 * the AchievementsView replay handler) every time a toast should appear. The
 * `t` timestamp is the React-key signal: the parent bumps it on every new
 * fire so a rapid click re-mounts the toast and resets the auto-dismiss
 * timer, even when the same milestone fires twice in a row.
 *
 * Crucially this is a SINGLE-SLOT state, not a queue: the next fire replaces
 * the current toast rather than stacking behind it. That is the contract
 * Justin relies on so the "Replay celebration" click on a specific stamp
 * always shows THAT stamp's milestone, not a stale queued one.
 */
export type ToastMilestone = {
  key: string;
  glyph: string;
  title: string;
  copy: string;
  /** Optional unlock date label (e.g. "Apr 02, 2024") shown on replays. */
  date?: string;
  /** Mount-time signal that bumps on every fire so React re-mounts the toast. */
  t?: number;
};

/** Auto-dismiss window in ms. Tuned so a celebration breathes but never gets in the way. */
const AUTO_DISMISS_MS = 5000;

export function MilestoneToast({
  milestone,
  onDismiss,
}: {
  milestone: ToastMilestone | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!milestone) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
    // Re-arm whenever the milestone identity OR the fire timestamp changes,
    // so a rapid second click resets the 5-second countdown from zero.
  }, [milestone, onDismiss]);

  if (!milestone) return null;

  return (
    <div className="toast-container" data-testid="milestone-toast-container">
      <div
        className="toast"
        key={milestone.key + '-' + (milestone.t ?? 0)}
        data-testid="milestone-toast"
        data-milestone-key={milestone.key}
        onClick={onDismiss}
        role="status"
        aria-live="polite"
      >
        <div className="toast-glyph">{milestone.glyph}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="toast-title">{milestone.title}</div>
          <div className="toast-body">{milestone.copy}</div>
          {milestone.date && (
            <div
              className="toast-body"
              style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}
            >
              Unlocked {milestone.date}
            </div>
          )}
        </div>
        <button
          className="toast-close"
          onClick={e => {
            // Stop the click from bubbling to the toast container so the
            // dismiss only fires once (close-button OR background, not both).
            e.stopPropagation();
            onDismiss();
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
