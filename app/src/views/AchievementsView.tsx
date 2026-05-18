import { useEffect, useState } from 'react';
import { PageHead } from '../components/PageHead';
import type { MatmonData } from '../data';
import { MILESTONE_CATALOG, type MilestoneCatalogEntry } from '../lib/milestoneCatalog';
import { listAchievements } from '../lib/db/repos';

/** A row from the DB, normalized for the view. */
type UnlockRow = { key: string; date: Date };

/** A catalog entry joined with its DB state. */
type JoinedMilestone = MilestoneCatalogEntry & {
  unlocked: boolean;
  /** Unlock date from the DB, null if still locked. */
  date: Date | null;
  /** True if unlocked within the last 24 hours. */
  fresh: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Joins the catalog with the per-user unlock rows. Returns the catalog in its
 * declared order with `unlocked`, `date`, and `fresh` filled in.
 */
function joinCatalogWithUnlocks(unlocks: UnlockRow[], now: Date): JoinedMilestone[] {
  const byKey = new Map(unlocks.map(u => [u.key, u]));
  return MILESTONE_CATALOG.map(entry => {
    const row = byKey.get(entry.key);
    const date = row?.date ?? null;
    const fresh = date != null && now.getTime() - date.getTime() < DAY_MS;
    return { ...entry, unlocked: !!row, date, fresh };
  });
}

/** Horizontal trail showing only milestones the user has actually unlocked, plotted by date. */
function AchievementsTrail({ unlocked, now }: { unlocked: JoinedMilestone[]; now: Date }) {
  // Sort oldest -> newest so the leftmost dot is the earliest unlock.
  const sorted = [...unlocked].sort((a, b) => (a.date!.getTime() - b.date!.getTime()));
  const start = sorted[0].date!;
  // End the trail just past today so the "TODAY" tick lives on the right edge.
  const end = new Date(Math.max(now.getTime(), sorted[sorted.length - 1].date!.getTime()));
  // Pad the span by 30 days on each side so the first/last dots don't kiss the edge.
  const padMs = 30 * DAY_MS;
  const spanStart = new Date(start.getTime() - padMs);
  const spanEnd = new Date(end.getTime() + padMs);
  const span = Math.max(1, spanEnd.getTime() - spanStart.getTime());

  const W = 1000;
  const H = 84;
  const padX = 32;
  const padTop = 20;
  const padBottom = 22;
  const innerW = W - padX * 2;
  const trailY = (H - padBottom + padTop) / 2;

  const xOf = (d: Date) => padX + ((d.getTime() - spanStart.getTime()) / span) * innerW;
  const todayX = xOf(now);

  // Tick marks every two years across the visible span.
  const years: { year: number; x: number }[] = [];
  for (let y = spanStart.getFullYear(); y <= spanEnd.getFullYear(); y += 2) {
    const d = new Date(y, 0, 1);
    if (d >= spanStart && d <= spanEnd) years.push({ year: y, x: xOf(d) });
  }

  return (
    <div className="ach-trail">
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line
          x1={padX}
          y1={trailY}
          x2={todayX}
          y2={trailY}
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.85"
        />

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

        {sorted.map(m => {
          const x = xOf(m.date!);
          const current = m.fresh;
          return (
            <g key={m.key} transform={`translate(${x}, ${trailY})`}>
              {current && <circle r="14" fill="var(--accent)" opacity="0.18" />}
              <circle
                r="8"
                fill={current ? 'var(--accent)' : 'var(--paper)'}
                stroke="var(--accent)"
                strokeWidth={current ? 2 : 1.25}
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

/**
 * Picks up to 3 not-yet-unlocked, non-secret milestones to feature in "Coming up next".
 *
 * Strategy:
 *   1. Value milestones whose threshold is greater than the user's current value,
 *      sorted ascending by threshold (so the nearest one shows first).
 *   2. If we still need more, pad with the next non-value catalog entries that
 *      aren't unlocked and aren't secret (stable catalog order).
 */
function pickUpcoming(joined: JoinedMilestone[], currentValue: number): JoinedMilestone[] {
  const locked = joined.filter(m => !m.unlocked && m.category !== 'secret');

  const nextValue = locked
    .filter(m => m.thresholdValue != null && m.thresholdValue > currentValue)
    .sort((a, b) => (a.thresholdValue! - b.thresholdValue!));

  const nonValue = locked.filter(m => m.thresholdValue == null);

  const out: JoinedMilestone[] = [];
  for (const m of [...nextValue, ...nonValue]) {
    if (out.length >= 3) break;
    out.push(m);
  }
  return out;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function AchievementsView({ data, onReplayToast }: { data: MatmonData; onReplayToast: () => void }) {
  const [unlocks, setUnlocks] = useState<UnlockRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAchievements()
      .then(rows => {
        if (cancelled) return;
        const parsed: UnlockRow[] = rows.map(r => ({
          key: r.milestone_key,
          date: new Date(r.unlocked_at),
        }));
        setUnlocks(parsed);
      })
      .catch(() => {
        if (!cancelled) setUnlocks([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Until we know what's unlocked, render a minimal header so the page doesn't flicker.
  if (unlocks === null) {
    return (
      <div>
        <PageHead title="Achievements" meta={<div className="muted">Loading milestones...</div>} />
      </div>
    );
  }

  const now = new Date();
  const joined = joinCatalogWithUnlocks(unlocks, now);
  const unlockedList = joined.filter(m => m.unlocked).sort((a, b) => b.date!.getTime() - a.date!.getTime());
  const lockedList = joined.filter(m => !m.unlocked);

  // Empty state: no unlocks at all. Show a friendly nudge and stop.
  if (unlockedList.length === 0) {
    return (
      <div>
        <PageHead
          title="Achievements"
          meta={
            <div>
              <div>0 unlocked · {lockedList.length} ahead</div>
              <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>Earned, not chased</div>
            </div>
          }
        />
        <div className="ach-empty">
          <div className="ach-empty-glyph">✦</div>
          <h2 className="ach-empty-title">Your first milestone is right around the corner</h2>
          <p className="ach-empty-copy">Import a CSV and let the numbers do the talking.</p>
        </div>
      </div>
    );
  }

  const fresh = unlockedList.find(m => m.fresh) ?? null;
  const upcoming = pickUpcoming(joined, data.totalValue);

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

      <AchievementsTrail unlocked={unlockedList} now={now} />

      {fresh && (
        <div className="ach-hero">
          <div className="ach-hero-glyph">{fresh.glyph}</div>
          <div className="ach-hero-body">
            <div className="ach-hero-eyebrow">Just unlocked · today</div>
            <h2 className="ach-hero-title">{fresh.title}</h2>
            <p className="ach-hero-copy">{fresh.copy}</p>
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

      {upcoming.length > 0 && (
        <>
          <div className="ach-section-head">
            <h3>Coming up next</h3>
            <span className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
              {upcoming.length} on deck
            </span>
          </div>
          <div className="ach-upcoming">
            {upcoming.map(m => {
              const isValue = m.thresholdValue != null;
              // Real progress for value milestones. Cap at 99 to keep the bar honest
              // about not-yet-met — 100% means unlocked.
              const pct = isValue
                ? Math.max(0, Math.min(99, Math.round((data.totalValue / m.thresholdValue!) * 100)))
                : null;
              return (
                <div className="ach-upcoming-card" key={m.key}>
                  <div className="ach-upcoming-glyph">{m.glyph}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ach-upcoming-title">{m.title}</div>
                    <div className="ach-upcoming-copy">{m.copy}</div>
                    {isValue && pct != null ? (
                      <div className="ach-progress">
                        <div className="ach-progress-bar">
                          <div className="ach-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="ach-progress-meta">
                          <span className="num">{pct}%</span>
                          <span className="muted" style={{ marginLeft: 8 }}>
                            {m.description}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="ach-progress">
                        <div className="ach-progress-meta">
                          <span className="muted">{m.description}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

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
            <div className="ach-stamp-date">{formatDate(m.date!)}</div>
          </div>
        ))}
        {lockedList.map(m => {
          const secret = m.category === 'secret';
          return (
            <div className="ach-stamp locked" key={m.key}>
              <div className="ach-stamp-glyph">{secret ? '?' : m.glyph}</div>
              <div className="ach-stamp-title">{secret ? 'Hidden ahead' : m.title}</div>
              <div className="ach-stamp-date">{secret ? '???' : m.description}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
