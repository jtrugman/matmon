// Brokerage logo with monogram fallback.
//
// When we ship a real image for a brokerage (under src/assets/brokerages/),
// render that. For unknown brokerages, fall back to the colored monogram
// (existing `.brokerage-mark` + `.mark-<id>` styling) so the UI still has
// something to anchor on.

import fidelity from '../assets/brokerages/fidelity.png';
import chase from '../assets/brokerages/chase.png';
import schwab from '../assets/brokerages/schwab.png';
import humaninterest from '../assets/brokerages/humaninterest.png';

const LOGOS: Record<string, string> = {
  fidelity,
  jpmorgan: chase, // JP Morgan and Chase share the same logo
  chase,
  schwab,
  humaninterest,
};

function brokerageKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/** "Charles Schwab" → "charlesschwab" → contains "schwab" → schwab.png.
 *  Direct key wins; otherwise substring-match against the LOGOS keys so
 *  brokerage name variants (Charles Schwab, JPMorgan Self-Directed, etc.)
 *  still resolve. */
function resolveLogo(name: string): string | undefined {
  const k = brokerageKey(name);
  if (LOGOS[k]) return LOGOS[k];
  for (const [key, src] of Object.entries(LOGOS)) {
    if (k.includes(key) || key.includes(k)) return src;
  }
  return undefined;
}

function initials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

type Props = {
  name: string;
  size?: 'small' | 'large';
};

export function BrokerageLogo({ name, size = 'small' }: Props) {
  const key = brokerageKey(name);
  const src = resolveLogo(name);
  const className = `brokerage-mark${size === 'large' ? ' large' : ''} mark-${key}${src ? ' has-logo' : ''}`;
  if (src) {
    return (
      <div className={className}>
        <img src={src} alt={`${name} logo`} draggable={false} />
      </div>
    );
  }
  return <div className={className}>{initials(name)}</div>;
}
