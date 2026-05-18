import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from './Icon';
import { listAchievements } from '../lib/db/repos';
import { networkLog } from '../lib/quotes/log';
import type { NetworkLogEntry } from '../lib/quotes/types';

type NavItem = {
  id: string;
  label: string;
  icon: string;
  badge?: string;
};

type Props = {
  current: string;
  onNav: (id: string) => void;
  theme: string;
  onThemeToggle: () => void;
  /** Bumped whenever the portfolio reloads, so the badge re-reads the DB. */
  achievementsVersion?: number;
};

// useSyncExternalStore needs a stable snapshot. networkLog.list() returns a
// new array every call, so we cache the most recent slice and only refresh
// when subscribe() fires.
let cachedNetSnapshot: NetworkLogEntry[] = networkLog.list();
let netSnapshotDirty = false;
networkLog.subscribe(() => {
  netSnapshotDirty = true;
});

function useLatestNetworkLog(): NetworkLogEntry | null {
  const list = useSyncExternalStore(
    cb => networkLog.subscribe(cb),
    () => {
      if (netSnapshotDirty) {
        cachedNetSnapshot = networkLog.list();
        netSnapshotDirty = false;
      }
      return cachedNetSnapshot;
    },
    () => cachedNetSnapshot,
  );
  return list[0] ?? null;
}

function formatRelativeOrClock(d: Date, now = new Date()): string {
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 6) return `${diffHr}h ago`;
  // Older than 6 hours: render the clock time so users orient against
  // market hours.
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${m} ${period}`;
}

export function Sidebar({ current, onNav, theme, onThemeToggle, achievementsVersion = 0 }: Props) {
  // Real achievement count. Re-reads whenever the portfolio reloads (so the
  // badge updates when a fresh milestone unlocks). 0 = no badge.
  const [achievementCount, setAchievementCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listAchievements();
        if (!cancelled) setAchievementCount(rows.length);
      } catch {
        if (!cancelled) setAchievementCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [achievementsVersion]);

  const latestNet = useLatestNetworkLog();

  const items: NavItem[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'buckets', label: 'Accounts', icon: 'buckets' },
    { id: 'holdings', label: 'Holdings', icon: 'holdings' },
    { id: 'transactions', label: 'Transactions', icon: 'transactions' },
  ];
  const planning: NavItem[] = [
    { id: 'planner', label: 'Planner', icon: 'planner' },
    {
      id: 'achievements',
      label: 'Achievements',
      icon: 'achievements',
      ...(achievementCount > 0 ? { badge: String(achievementCount) } : {}),
    },
  ];
  const data: NavItem[] = [
    { id: 'import', label: 'Add Account', icon: 'import' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  const renderItem = (it: NavItem) => (
    <div key={it.id} className={`nav-item ${current === it.id ? 'active' : ''}`} onClick={() => onNav(it.id)}>
      <span className="nav-icon">
        <Icon name={it.icon} />
      </span>
      <span>{it.label}</span>
      {it.badge && <span className="nav-badge">{it.badge}</span>}
    </div>
  );

  return (
    <aside className="sidebar">
      <button className="brand brand-button" onClick={() => onNav('home')} aria-label="Matmon · Home">
        <div className="brand-mark">Matmon</div>
      </button>

      <div className="nav-group-label">Portfolio</div>
      {items.map(renderItem)}

      <div className="nav-group-label">Planning</div>
      {planning.map(renderItem)}

      <div className="nav-group-label">Data</div>
      {data.map(renderItem)}

      <div className="sidebar-foot">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            className="theme-toggle"
            onClick={onThemeToggle}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          {latestNet && (
            <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              Last quote · {formatRelativeOrClock(latestNet.t)}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
