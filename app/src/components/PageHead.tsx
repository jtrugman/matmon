import type { ReactNode } from 'react';

type Props = {
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
};

export function PageHead({ eyebrow, title, meta, actions }: Props) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        {meta && <div className="page-meta">{meta}</div>}
        {actions}
      </div>
    </div>
  );
}
