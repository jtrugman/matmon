import { useCallback, useEffect, useState } from 'react';
import { isTauri } from './lib/env';
import { Sidebar } from './components/Sidebar';
import { MilestoneToast, type ToastMilestone } from './components/MilestoneToast';
import { TweaksPanel, TweakSection, TweakRadio, TweakButton } from './components/TweaksPanel';
import { useTweaks } from './lib/useTweaks';
import { usePortfolio } from './lib/usePortfolio';
import { getSetting, insertAccount, insertTransactions, listAccounts, saveGoalScenario, saveUserProfile, setSetting } from './lib/db/repos';
import { clearDemoData, requestDemoSeed } from './lib/db/seed';
import { slugifyAccountId } from './lib/db/accountId';
import type { OnboardingUpload } from './views/OnboardingView';
import { HomeView } from './views/HomeView';
import { AccountsView } from './views/AccountsView';
import { HoldingsView } from './views/HoldingsView';
import { HoldingDetailView } from './views/HoldingDetailView';
import { TransactionsView } from './views/TransactionsView';
import { PlannerView } from './views/PlannerView';
import { AchievementsView } from './views/AchievementsView';
import { AddAccountView } from './views/AddAccountView';
import { SettingsView } from './views/SettingsView';
import { OnboardingView } from './views/OnboardingView';
import { StubView } from './views/StubView';

const DEFAULTS = {
  theme: 'light' as 'light' | 'dark',
  chartVariant: 'area' as 'area' | 'line' | 'bars',
  showOnboarding: false,
};

const ONBOARDING_DONE_KEY = 'onboarding.completed.v1';

export function App() {
  const { data, reload, refreshLivePrices, newUnlocks, clearNewUnlocks, userName } = usePortfolio();
  const [tweaks, setTweak] = useTweaks(DEFAULTS);

  const [view, setView] = useState('home');
  const [addAccountBrokerage, setAddAccountBrokerage] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<ToastMilestone | null>(null);

  // Navigation helper: when a brokerage button is clicked anywhere in the app,
  // route to Add Account with the brokerage hint prefilled.
  const goAddAccount = useCallback((brokerage?: string) => {
    setAddAccountBrokerage(brokerage);
    setView('import');
  }, []);
  // `null` = haven't checked DB yet (show nothing); true = show onboarding;
  // false = skip straight to the app.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const [selectedHolding, setSelectedHolding] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);

  const openAccount = useCallback((accountId: string) => {
    setSelectedAccount(accountId);
    setView('account-detail');
  }, []);

  // On first mount, ask the DB whether the user has ever completed onboarding.
  // Real users land in onboarding by default; the Tweaks "Restart onboarding"
  // dev affordance still works via setOnboarding(true).
  useEffect(() => {
    (async () => {
      const done = await getSetting(ONBOARDING_DONE_KEY).catch(() => null);
      setOnboarding(done !== 'yes');
    })();
  }, []);

  const openHolding = (sym: string) => {
    setSelectedHolding(sym);
    setView('holding-detail');
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
  }, [tweaks.theme]);

  useEffect(() => {
    // Lets the stylesheet drop the prototype's window-card framing when running
    // inside the real Tauri shell (fixed card → fill the OS window).
    document.documentElement.classList.toggle('tauri', isTauri());
  }, []);

  // Milestone toast is now watcher-driven: when the portfolio watcher reports a
  // fresh unlock, look up its catalog entry (glyph/title/copy) and fire the toast.
  // The previous hardcoded 900ms first_million demo timer has been removed.
  useEffect(() => {
    if (onboarding) return;
    if (newUnlocks.length === 0) return;
    const key = newUnlocks[newUnlocks.length - 1];
    const m = data.achievements.find(a => a.key === key);
    if (m) setToast({ ...m, t: Date.now() });
    clearNewUnlocks();
  }, [onboarding, newUnlocks, data.achievements, clearNewUnlocks]);

  const replayToast = useCallback(() => {
    const m = data.achievements.find(a => a.key === 'first_million');
    if (m) setToast({ ...m, t: Date.now() });
  }, [data]);

  const finishOnboarding = useCallback(
    async (state?: {
      profile: { name: string; birthYear: number; retireAge: number; household: 'single' | 'partnered' | 'family'; theme: 'light' | 'dark' };
      goal: number;
      uploads?: OnboardingUpload[];
    }) => {
      if (state) {
        try {
          await saveUserProfile(state.profile);
          await saveGoalScenario(state.goal, state.profile);
          if (state.profile.theme) setTweak('theme', state.profile.theme);
        } catch {
          // Persistence is best-effort; the user still lands in Matmon either way.
        }
        // Import any CSVs the user dropped in during step 3.
        if (state.uploads && state.uploads.length > 0) {
          // Wipe any lingering demo data so the user only sees their real
          // accounts (handles users who clicked "Try with a sample portfolio"
          // earlier or whose DB was pre-seeded by a previous build).
          try {
            await clearDemoData();
          } catch {
            /* best-effort */
          }
          // Snapshot of IDs already in the DB; we extend it locally as we go so
          // multiple uploads with the same name dedupe within this batch too.
          const existingIds: string[] = [];
          try {
            const existing = await listAccounts();
            for (const row of existing) existingIds.push(row.id);
          } catch {
            /* listAccounts is best-effort; worst case we just dedupe against [] */
          }
          for (const u of state.uploads) {
            try {
              const id = slugifyAccountId(u.accountName, u.brokerage, existingIds);
              existingIds.push(id);
              await insertAccount({
                id,
                name: u.accountName,
                brokerage: u.brokerage,
                account_type: u.accountType,
                currency: 'USD',
                created_at: new Date().toISOString(),
              });
              await insertTransactions(id, u.transactions);
            } catch {
              /* one bad upload shouldn't kill the rest */
            }
          }
        }
      }
      // Persist the "I've seen onboarding" flag so we don't show it next launch.
      await setSetting(ONBOARDING_DONE_KEY, 'yes').catch(() => {});
      setOnboarding(false);
      setTweak('showOnboarding', false);
      setView('home');
      await reload();
    },
    [reload, setTweak],
  );

  // "Try with a sample portfolio" path: marks demo opt-in, runs the seeder,
  // then drops the user into the app. Sets the completed flag so onboarding
  // doesn't reshow.
  const skipWithDemo = useCallback(async () => {
    try {
      await requestDemoSeed();
      await setSetting(ONBOARDING_DONE_KEY, 'yes');
    } catch {
      // Non-fatal.
    }
    setOnboarding(false);
    setTweak('showOnboarding', false);
    setView('home');
    await reload();
  }, [reload, setTweak]);

  const restartOnboarding = useCallback(async () => {
    await setSetting(ONBOARDING_DONE_KEY, 'no').catch(() => {});
    setOnboarding(true);
    setTweak('showOnboarding', true);
  }, [setTweak]);

  // Hold rendering for one tick until we know whether to show onboarding —
  // avoids a flash of the empty Home screen on first launch.
  if (onboarding === null) {
    return <div className="app-shell" style={{ background: 'var(--paper)' }} />;
  }

  if (onboarding) {
    return (
      <>
        <OnboardingView
          onComplete={finishOnboarding}
          onSkip={skipWithDemo}
          onPreviewTheme={t => setTweak('theme', t)}
        />
        {import.meta.env.DEV && (
          <TweaksFloating
            tweaks={tweaks}
            setTweak={setTweak}
            onReplayToast={replayToast}
            onRestartOnboarding={restartOnboarding}
          />
        )}
      </>
    );
  }

  const renderView = () => {
    switch (view) {
      case 'home':
        return (
          <HomeView
            data={data}
            chartVariant={tweaks.chartVariant}
            onNavigate={setView}
            onAddAccount={goAddAccount}
            onRefreshQuotes={refreshLivePrices}
            userName={userName}
          />
        );
      case 'buckets':
        return <AccountsView data={data} onAddAccount={goAddAccount} onOpenAccount={openAccount} />;
      case 'holdings':
        return <HoldingsView data={data} onSelect={openHolding} />;
      case 'account-detail':
        return (
          <HoldingsView
            data={data}
            onSelect={openHolding}
            filterAccountId={selectedAccount ?? undefined}
            onBack={() => setView('buckets')}
          />
        );
      case 'holding-detail': {
        const h = data.holdings.find(x => x.sym === selectedHolding) || data.holdings[0];
        return <HoldingDetailView data={data} holding={h} onBack={() => setView('holdings')} />;
      }
      case 'planner':
        return <PlannerView data={data} />;
      case 'achievements':
        return <AchievementsView data={data} onReplayToast={replayToast} />;
      case 'transactions':
        return <TransactionsView data={data} />;
      case 'import':
        return <AddAccountView prefillBrokerage={addAccountBrokerage} />;
      case 'settings':
        return <SettingsView tweaks={tweaks} setTweak={setTweak} onRestartOnboarding={restartOnboarding} />;
      default:
        return <StubView title={view} />;
    }
  };

  const inTauri = isTauri();

  return (
    <div className="app-shell">
      {!inTauri && (
        <div className="titlebar">
          <div className="tl-dots">
            <span className="tl-dot r" />
            <span className="tl-dot y" />
            <span className="tl-dot g" />
          </div>
          <div className="titlebar-title">Matmon</div>
          <div className="titlebar-side" />
        </div>
      )}
      <div className="body">
        <Sidebar
          current={view}
          onNav={setView}
          theme={tweaks.theme}
          onThemeToggle={() => setTweak('theme', tweaks.theme === 'light' ? 'dark' : 'light')}
        />
        <main className="main">{renderView()}</main>
      </div>

      <MilestoneToast milestone={toast} onDismiss={() => setToast(null)} />

      {import.meta.env.DEV && (
        <TweaksFloating
          tweaks={tweaks}
          setTweak={setTweak}
          onReplayToast={replayToast}
          onRestartOnboarding={restartOnboarding}
        />
      )}
    </div>
  );
}

function TweaksFloating({
  tweaks,
  setTweak,
  onReplayToast,
  onRestartOnboarding,
}: {
  tweaks: typeof DEFAULTS;
  setTweak: (k: any, v?: any) => void;
  onReplayToast: () => void;
  onRestartOnboarding: () => void;
}) {
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Theme">
        <TweakRadio
          label="Mode"
          value={tweaks.theme}
          onChange={v => setTweak('theme', v)}
          options={[
            { label: 'Light', value: 'light' },
            { label: 'Dark', value: 'dark' },
          ]}
        />
      </TweakSection>

      <TweakSection label="Headline chart">
        <TweakRadio
          label="Style"
          value={tweaks.chartVariant}
          onChange={v => setTweak('chartVariant', v)}
          options={[
            { label: 'Area', value: 'area' },
            { label: 'Line', value: 'line' },
            { label: 'Bars', value: 'bars' },
          ]}
        />
      </TweakSection>

      <TweakSection label="Demo">
        <TweakButton label="Replay $1M toast" onClick={onReplayToast} />
        <TweakButton label="Restart onboarding" onClick={onRestartOnboarding} />
      </TweakSection>
    </TweaksPanel>
  );
}
