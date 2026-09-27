import { PageHead } from '../components/PageHead';

export function StubView({ title }: { title: string }) {
  return (
    <div>
      <PageHead title={title} />
      <div className="card" style={{ padding: '48px 32px', textAlign: 'center' }}>
        <div className="display" style={{ fontSize: 28, color: 'var(--ink-3)', marginBottom: 8 }}>
          On the design backlog
        </div>
        <p className="muted" style={{ maxWidth: 460, margin: '0 auto', fontSize: 13 }}>
          We've designed the headline screens first. This one's queued behind them, happy to take it next.
        </p>
      </div>
    </div>
  );
}
