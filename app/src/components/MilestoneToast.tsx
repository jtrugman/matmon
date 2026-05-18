import { useEffect } from 'react';

export type ToastMilestone = {
  key: string;
  glyph: string;
  title: string;
  copy: string;
  t?: number;
};

export function MilestoneToast({
  milestone,
  onDismiss,
}: {
  milestone: ToastMilestone | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!milestone) return;
    const t = setTimeout(onDismiss, 7500);
    return () => clearTimeout(t);
  }, [milestone, onDismiss]);

  if (!milestone) return null;

  return (
    <div className="toast-container">
      <div className="toast" key={milestone.key + '-' + (milestone.t ?? 0)}>
        <div className="toast-glyph">{milestone.glyph}</div>
        <div style={{ flex: 1 }}>
          <div className="toast-title">{milestone.title}</div>
          <div className="toast-body">{milestone.copy}</div>
        </div>
        <button className="toast-close" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  );
}
