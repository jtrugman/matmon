export function Icon({ name }: { name: string }) {
  const stroke = 'currentColor';
  const w = 16;
  const props = {
    width: w,
    height: w,
    viewBox: '0 0 16 16',
    fill: 'none' as const,
    stroke,
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...props}>
          <path d="M2.5 7L8 2.5l5.5 4.5v6a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V7Z" />
          <path d="M6.5 13.5V9.5h3v4" />
        </svg>
      );
    case 'buckets':
      return (
        <svg {...props}>
          <rect x="2" y="3" width="5" height="5" rx="1" />
          <rect x="9" y="3" width="5" height="5" rx="1" />
          <rect x="2" y="10" width="5" height="3.5" rx="1" />
          <rect x="9" y="10" width="5" height="3.5" rx="1" />
        </svg>
      );
    case 'brokerage':
      return (
        <svg {...props}>
          <path d="M2.5 6.5h11l-1.5-3h-8l-1.5 3Z" />
          <path d="M3 6.5v6h10v-6" />
          <path d="M6 12.5v-3h4v3" />
        </svg>
      );
    case 'holdings':
      return (
        <svg {...props}>
          <path d="M2.5 13.5h11" />
          <rect x="3.5" y="9.5" width="2" height="4" />
          <rect x="7" y="6" width="2" height="7.5" />
          <rect x="10.5" y="3.5" width="2" height="10" />
        </svg>
      );
    case 'transactions':
      return (
        <svg {...props}>
          <path d="M3 5h10M3 5l2-2M3 5l2 2" />
          <path d="M13 11H3M13 11l-2-2M13 11l-2 2" />
        </svg>
      );
    case 'planner':
      return (
        <svg {...props}>
          <path d="M2.5 13L6 9l3 3 4.5-7" />
          <circle cx="13.5" cy="5" r="0.8" fill={stroke} />
        </svg>
      );
    case 'achievements':
      return (
        <svg {...props}>
          <path d="M5 2.5h6v3a3 3 0 0 1-6 0v-3Z" />
          <path d="M5 4H3.5a2 2 0 0 0 2 2" />
          <path d="M11 4h1.5a2 2 0 0 1-2 2" />
          <path d="M8 8.5v3" />
          <path d="M5.5 13.5h5" />
        </svg>
      );
    case 'import':
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v6M5 8h6" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...props}>
          <path d="M13 9.5A5 5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props} viewBox="0 0 24 24">
          {/* Lucide "cog": proper gear shape that reads at 16x16. */}
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    default:
      return null;
  }
}
