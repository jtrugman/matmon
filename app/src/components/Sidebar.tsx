import { Icon } from './Icon';

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
};

export function Sidebar({ current, onNav, theme, onThemeToggle }: Props) {
  const items: NavItem[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'buckets', label: 'Accounts', icon: 'buckets' },
    { id: 'holdings', label: 'Holdings', icon: 'holdings' },
    { id: 'transactions', label: 'Transactions', icon: 'transactions' },
  ];
  const planning: NavItem[] = [
    { id: 'planner', label: 'Planner', icon: 'planner' },
    { id: 'achievements', label: 'Achievements', icon: 'achievements', badge: '13' },
  ];
  const data: NavItem[] = [
    { id: 'import', label: 'Add Account', icon: 'import' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  const renderItem = (it: NavItem) => (
    <div
      key={it.id}
      className={`nav-item ${current === it.id ? 'active' : ''}`}
      onClick={() => onNav(it.id)}
    >
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
          <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            Last quote · Fri 4:00 PM
          </div>
        </div>
      </div>
    </aside>
  );
}
