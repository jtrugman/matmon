// Replay celebration: tile-aware unit tests.
//
// The bug Justin reported: clicking "Replay celebration" on the "$1,000 in
// dividends" tile fired the "A millionaire" toast instead. Root cause was
// `replayToast()` hardcoding `first_million`. These tests pin the new
// per-milestone contract end-to-end at the unit layer:
//
//   1. `MilestoneToast` renders whichever milestone the parent slots in.
//   2. Subsequent renders REPLACE the visible toast (single-slot, latest
//      click wins), they do NOT queue.
//   3. Auto-dismiss after 5 seconds.
//   4. Clicking the toast body dismisses immediately.
//   5. AchievementsView passes the clicked tile's `milestoneId` to its
//      `onReplayToast` prop, so the toast can build the right entry.
//   6. `buildShareLine` produces the exact one-liner the "Tell a friend"
//      button writes to the clipboard.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MilestoneToast, type ToastMilestone } from '../src/components/MilestoneToast';
import { AchievementsView, buildShareLine } from '../src/views/AchievementsView';
import * as repos from '../src/lib/db/repos';
import { MILESTONE_BY_KEY } from '../src/lib/milestoneCatalog';
import { MATMON_DATA } from './__fixtures__/sampleData';

function toToast(key: string): ToastMilestone {
  const m = MILESTONE_BY_KEY[key];
  return {
    key: m.key,
    glyph: m.glyph,
    title: m.title,
    copy: m.copy,
    t: Date.now(),
  };
}

describe('MilestoneToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the milestone slotted into its `milestone` prop', () => {
    render(<MilestoneToast milestone={toToast('1k_in_dividends')} onDismiss={() => {}} />);
    expect(screen.getByText('$1,000 in dividends')).toBeInTheDocument();
    expect(screen.getByText(/A small but steady stream forms/i)).toBeInTheDocument();
    // The wrong milestone (the historical bug) must NOT appear.
    expect(screen.queryByText('A millionaire')).not.toBeInTheDocument();
  });

  it('replaces (does not queue) when the milestone prop changes', () => {
    function Harness() {
      const [m, setM] = useState<ToastMilestone | null>(toToast('1k_in_dividends'));
      return (
        <>
          <button onClick={() => setM(toToast('first_million'))}>swap</button>
          <MilestoneToast milestone={m} onDismiss={() => setM(null)} />
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByText('$1,000 in dividends')).toBeInTheDocument();

    act(() => {
      screen.getByText('swap').click();
    });

    // The new milestone is visible.
    expect(screen.getByText('A millionaire')).toBeInTheDocument();
    // The previous milestone is GONE. If queueing were the bug-shaped
    // behaviour we'd still see "$1,000 in dividends" here.
    expect(screen.queryByText('$1,000 in dividends')).not.toBeInTheDocument();
  });

  it('auto-dismisses after 5 seconds', () => {
    const onDismiss = vi.fn();
    render(<MilestoneToast milestone={toToast('first_100k')} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses immediately when the user clicks the toast', () => {
    const onDismiss = vi.fn();
    render(<MilestoneToast milestone={toToast('first_100k')} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('milestone-toast'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses when the user clicks the explicit × button', () => {
    const onDismiss = vi.fn();
    render(<MilestoneToast milestone={toToast('first_100k')} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the milestone slot is null', () => {
    const { container } = render(<MilestoneToast milestone={null} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('rapid clicks: the latest milestone wins (single-slot, not a queue)', () => {
    function Harness() {
      const [m, setM] = useState<ToastMilestone | null>(null);
      return (
        <>
          <button onClick={() => setM(toToast('1k_in_dividends'))}>div</button>
          <button onClick={() => setM(toToast('first_million'))}>mil</button>
          <button onClick={() => setM(toToast('first_100k'))}>k</button>
          <MilestoneToast milestone={m} onDismiss={() => setM(null)} />
        </>
      );
    }
    render(<Harness />);
    act(() => {
      screen.getByText('div').click();
      screen.getByText('mil').click();
      screen.getByText('k').click();
    });
    // Only the LATEST is visible. No queued backlog.
    expect(screen.getByText('Six digits')).toBeInTheDocument();
    expect(screen.queryByText('A millionaire')).not.toBeInTheDocument();
    expect(screen.queryByText('$1,000 in dividends')).not.toBeInTheDocument();
  });
});

describe('AchievementsView replay wiring', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clicking Replay celebration on a stamp passes that stamp\'s milestone key', async () => {
    // Two unlocked milestones in the collection. The fresh window is 24h, so
    // dating both 2 years back keeps the hero out of the way and forces us
    // to interact with the collection grid itself (the path Justin used).
    const longAgo = (year: number) => new Date(`${year}-06-15T00:00:00Z`).toISOString();
    vi.spyOn(repos, 'listAchievements').mockResolvedValue([
      { milestone_key: '1k_in_dividends', unlocked_at: longAgo(2024) },
      { milestone_key: 'first_million', unlocked_at: longAgo(2024) },
    ]);

    const replays: string[] = [];
    render(
      <AchievementsView
        data={MATMON_DATA}
        onReplayToast={(id: string) => replays.push(id)}
      />,
    );

    await waitFor(() => {
      // Both stamps render.
      expect(screen.getByTestId('replay-1k_in_dividends')).toBeInTheDocument();
      expect(screen.getByTestId('replay-first_million')).toBeInTheDocument();
    });

    act(() => {
      screen.getByTestId('replay-1k_in_dividends').click();
    });
    expect(replays).toEqual(['1k_in_dividends']);

    act(() => {
      screen.getByTestId('replay-first_million').click();
    });
    // Each click reports the tile-specific key, never a fixed default.
    expect(replays).toEqual(['1k_in_dividends', 'first_million']);
  });

  it('clicking the hero Replay button passes the fresh milestone\'s key (not a hardcoded one)', async () => {
    // One milestone fresh today, one old.
    vi.spyOn(repos, 'listAchievements').mockResolvedValue([
      {
        milestone_key: '1k_in_dividends',
        unlocked_at: new Date().toISOString(),
      },
      {
        milestone_key: 'first_million',
        unlocked_at: new Date('2020-01-01T00:00:00Z').toISOString(),
      },
    ]);

    const replays: string[] = [];
    render(
      <AchievementsView data={MATMON_DATA} onReplayToast={(id: string) => replays.push(id)} />,
    );

    await waitFor(() => {
      // Hero renders with the fresh milestone.
      expect(screen.getByTestId('ach-hero-1k_in_dividends')).toBeInTheDocument();
    });

    act(() => {
      screen.getByTestId('hero-replay-1k_in_dividends').click();
    });

    // Test isolation: the array contains EXACTLY one entry, the dividends key.
    // The historical bug would have surfaced 'first_million' here.
    expect(replays).toContain('1k_in_dividends');
    expect(replays).not.toContain('first_million');
  });
});

describe('Tell a friend', () => {
  it('buildShareLine includes the milestone title and the catalog copy', () => {
    const m = MILESTONE_BY_KEY['1k_in_dividends'];
    const line = buildShareLine(m);
    expect(line).toContain('$1,000 in dividends');
    expect(line).toContain('A small but steady stream forms.');
  });

  it('clicking Tell a friend on a stamp copies that stamp\'s share line to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // JSDOM exposes `navigator.clipboard` as a getter-only property. We have
    // to defineProperty rather than Object.assign so the override sticks.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    vi.spyOn(repos, 'listAchievements').mockResolvedValue([
      {
        milestone_key: '1k_in_dividends',
        unlocked_at: new Date('2024-06-15T00:00:00Z').toISOString(),
      },
    ]);

    render(<AchievementsView data={MATMON_DATA} onReplayToast={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('share-1k_in_dividends')).toBeInTheDocument();
    });

    act(() => {
      screen.getByTestId('share-1k_in_dividends').click();
    });

    // Allow the awaited writeText to settle.
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const arg = writeText.mock.calls[0][0] as string;
    expect(arg).toContain('$1,000 in dividends');
    expect(arg).toContain('A small but steady stream forms.');
  });

  it('clicking Tell a friend with no clipboard support still surfaces a notice', async () => {
    // Strip the clipboard so the fallback path runs.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    vi.spyOn(repos, 'listAchievements').mockResolvedValue([
      {
        milestone_key: 'first_100k',
        unlocked_at: new Date('2023-04-02T00:00:00Z').toISOString(),
      },
    ]);

    render(<AchievementsView data={MATMON_DATA} onReplayToast={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('share-first_100k')).toBeInTheDocument();
    });

    act(() => {
      screen.getByTestId('share-first_100k').click();
    });

    // No clipboard means we fall through to the inline share-copy notice.
    await waitFor(() => {
      const notice = screen.getByTestId('ach-notice');
      expect(notice).toBeInTheDocument();
      expect(notice.textContent).toMatch(/Six digits/);
    });
  });
});
