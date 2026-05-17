import { PageHead } from '../components/PageHead';
import type { MatmonData } from '../data';

type JourneyItem = {
  key: string;
  glyph: string;
  title: string;
  copy: string;
  date: Date;
  unlocked: boolean;
  fresh?: boolean;
  progress?: number;
  context?: string;
  secret?: boolean;
};

function AchievementsTrail({ journey }: { journey: JourneyItem[] }) {
  const today = new Date(2026, 4, 17);
  const start = journey[0].date;
  const end = new Date(today.getFullYear() + 8, 0, 1);
  const span = end.getTime() - start.getTime();

  const W = 1000;
  const H = 84;
  const padX = 32;
  const padTop = 20;
  const padBottom = 22;
  const innerW = W - padX * 2;
  const trailY = (H - padBottom + padTop) / 2;

  const xOf = (d: Date) => padX + ((d.getTime() - start.getTime()) / span) * innerW;
  const todayX = xOf(today);

  const years: { year: number; x: number }[] = [];
  for (let y = start.getFullYear(); y <= end.getFullYear(); y += 2) {
    const d = new Date(y, 0, 1);
    if (d >= start && d <= end) years.push({ year: y, x: xOf(d) });
  }

  return (
    <div className="ach-trail">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1={padX} y1={trailY} x2={todayX} y2={trailY} stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" opacity="0.85" />
        <line x1={todayX} y1={trailY} x2={W - padX} y2={trailY} stroke="var(--ink-4)" strokeWidth="1.5" strokeDasharray="4 5" strokeLinecap="round" opacity="0.55" />

        {years.map(t => (
          <g key={t.year}>
            <line x1={t.x} y1={trailY + 8} x2={t.x} y2={trailY + 12} stroke="var(--ink-4)" strokeWidth="1" />
            <text x={t.x} y={H - 4} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--ink-4)">
              '{String(t.year).slice(-2)}
            </text>
          </g>
        ))}

        <line x1={todayX} y1={trailY - 18} x2={todayX} y2={trailY + 4} stroke="var(--accent)" strokeWidth="1" strokeDasharray="2 2" />
        <text x={todayX} y={trailY - 22} textAnchor="middle" fontSize="9.5" fontFamily="var(--font-mono)" fill="var(--accent)" letterSpacing="0.08em">
          TODAY
        </text>

        {journey.map(m => {
          const x = xOf(m.date);
          const past = m.unlocked && !m.fresh;
          const current = m.fresh;
          return (
            <g key={m.key} transform={`translate(${x}, ${trailY})`}>
              {current && <circle r="14" fill="var(--accent)" opacity="0.18" />}
              <circle
                r="8"
                fill={current ? 'var(--accent)' : past ? 'var(--paper)' : 'var(--paper-2)'}
                stroke={past || current ? 'var(--accent)' : 'var(--line)'}
                strokeWidth={current ? 2 : 1.25}
                strokeDasharray={!m.unlocked ? '1.5 2' : '0'}
              />
              {current && <circle r="3" fill="white" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function AchievementsConfetti() {
  const seeds: Array<[number, number]> = [
    [12, 18], [80, 12], [140, 32], [220, 8], [280, 28], [340, 14], [420, 36],
    [60, 88], [180, 92], [300, 78], [400, 96], [480, 70],
  ];
  return (
    <svg className="ach-hero-confetti" width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 500 110">
      {seeds.map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={i % 3 === 0 ? 2.5 : 1.5}
          fill={
            i % 4 === 0
              ? 'var(--accent)'
              : i % 4 === 1
              ? 'var(--gain)'
              : i % 4 === 2
              ? 'var(--loss)'
              : 'var(--ink-4)'
          }
          opacity={0.4 + (i % 5) * 0.1}
        />
      ))}
    </svg>
  );
}

export function AchievementsView({ onReplayToast }: { data: MatmonData; onReplayToast: () => void }) {
  const journey: JourneyItem[] = [
    { key: 'first_import',       glyph: '✦', title: 'Welcome aboard',     copy: 'First CSV imported.',                  date: new Date(2018, 5, 12),  unlocked: true },
    { key: 'first_10k',          glyph: '◆', title: 'Five digits',         copy: '$10K. Serious money now.',             date: new Date(2018, 7, 3),   unlocked: true },
    { key: 'first_dividend',     glyph: '✿', title: 'First dividend',      copy: 'Your money made money.',               date: new Date(2018, 8, 28),  unlocked: true },
    { key: 'one_year_in',        glyph: '⊙', title: 'One year on the books', copy: 'A whole calendar of returns.',       date: new Date(2019, 5, 12),  unlocked: true },
    { key: 'first_1k_div',       glyph: '✿', title: '$1K in dividends',    copy: 'A steady stream forms.',               date: new Date(2020, 1, 14),  unlocked: true },
    { key: 'survived_drawdown',  glyph: '⌇', title: 'Held through a dip',  copy: 'Down 10% and you held.',               date: new Date(2020, 3, 4),   unlocked: true },
    { key: 'first_100k',         glyph: '◈', title: 'Six digits',          copy: '$100K. Tell someone you trust.',       date: new Date(2021, 2, 21),  unlocked: true },
    { key: 'diversified',        glyph: '✤', title: 'Spread the eggs',     copy: '10 holdings, 3+ sectors.',             date: new Date(2022, 6, 22),  unlocked: true },
    { key: 'five_years_in',      glyph: '⌾', title: 'Five years',          copy: 'Old-timer rights unlocked.',           date: new Date(2023, 5, 12),  unlocked: true },
    { key: 'first_500k',         glyph: '◉', title: 'Half a million',      copy: 'Power of compounding, visible.',       date: new Date(2023, 10, 9),  unlocked: true },
    { key: 'beat_spy_1y',        glyph: '↗', title: 'Beat the S&P',        copy: 'You did the thing.',                   date: new Date(2023, 11, 31), unlocked: true },
    { key: 'maxed_ira',          glyph: '♆', title: 'IRA maxed',           copy: 'Future you sends thanks.',             date: new Date(2024, 3, 12),  unlocked: true },
    { key: 'first_million',      glyph: '☉', title: 'A millionaire',       copy: 'Go buy your mom some flowers.',        date: new Date(2026, 4, 17),  unlocked: true, fresh: true },
    { key: 'maxed_401k',         glyph: '♅', title: '401(k) maxed',        copy: '$5,100 to go this tax year.',          date: new Date(2026, 11, 31), unlocked: false, progress: 0.78, context: '$18,400 of $23,500' },
    { key: 'hsa_covered',        glyph: '⚕', title: 'HSA covers healthcare', copy: 'Triple-tax-advantaged at work.',     date: new Date(2029, 0, 1),   unlocked: false, progress: 0.56, context: '~3 years out at 7% real' },
    { key: 'two_million',        glyph: '☉', title: 'Two commas',          copy: "Don't get weird about it.",            date: new Date(2033, 4, 17),  unlocked: false, progress: 0.60, context: '~7 years out at 7% real' },
    { key: 'hidden_1',           glyph: '★', title: 'Hidden ahead',         copy: 'A surprise is part of the fun.',      date: new Date(2050, 0, 1),   unlocked: false, secret: true },
  ];

  const latest = journey.find(j => j.fresh);
  const upcoming = journey.filter(j => !j.unlocked && !j.secret).slice(0, 3);
  const unlockedList = journey.filter(j => j.unlocked).sort((a, b) => +b.date - +a.date);
  const lockedList = journey.filter(j => !j.unlocked);

  return (
    <div>
      <PageHead
        title="Achievements"
        meta={
          <div>
            <div>
              {unlockedList.length} unlocked · {lockedList.length} ahead
            </div>
            <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Earned, not chased</div>
          </div>
        }
      />

      <AchievementsTrail journey={journey} />

      {latest && (
        <div className="ach-hero">
          <div className="ach-hero-glyph">{latest.glyph}</div>
          <div className="ach-hero-body">
            <div className="ach-hero-eyebrow">Just unlocked · today</div>
            <h2 className="ach-hero-title">{latest.title}</h2>
            <p className="ach-hero-copy">{latest.copy}</p>
            <div className="ach-hero-actions">
              <button className="btn" onClick={onReplayToast}>
                Replay celebration
              </button>
              <button className="btn btn-ghost">Tell a friend</button>
            </div>
          </div>
          <AchievementsConfetti />
        </div>
      )}

      <div className="ach-section-head">
        <h3>Coming up next</h3>
        <span className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
          {upcoming.length} on deck
        </span>
      </div>
      <div className="ach-upcoming">
        {upcoming.map(m => (
          <div className="ach-upcoming-card" key={m.key}>
            <div className="ach-upcoming-glyph">{m.glyph}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ach-upcoming-title">{m.title}</div>
              <div className="ach-upcoming-copy">{m.copy}</div>
              <div className="ach-progress">
                <div className="ach-progress-bar">
                  <div className="ach-progress-fill" style={{ width: `${(m.progress || 0) * 100}%` }} />
                </div>
                <div className="ach-progress-meta">
                  <span className="num">{Math.round((m.progress || 0) * 100)}%</span>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {m.context}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="ach-section-head" style={{ marginTop: 32 }}>
        <h3>Your collection</h3>
        <span className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
          {unlockedList.length} unlocked · {lockedList.length} silhouettes ahead
        </span>
      </div>
      <div className="ach-collection">
        {unlockedList.map(m => (
          <div className={`ach-stamp ${m.fresh ? 'fresh' : ''}`} key={m.key}>
            <div className="ach-stamp-glyph">{m.glyph}</div>
            <div className="ach-stamp-title">{m.title}</div>
            <div className="ach-stamp-date">
              {m.date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
            </div>
          </div>
        ))}
        {lockedList.map(m => (
          <div className="ach-stamp locked" key={m.key}>
            <div className="ach-stamp-glyph">{m.secret ? '?' : m.glyph}</div>
            <div className="ach-stamp-title">{m.secret ? 'Hidden ahead' : m.title}</div>
            <div className="ach-stamp-date">{m.secret ? '???' : m.context || 'On the way'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
