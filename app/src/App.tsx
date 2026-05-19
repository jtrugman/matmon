import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from './lib/env';
import { Sidebar } from './components/Sidebar';
import { MilestoneToast, type ToastMilestone } from './components/MilestoneToast';
import { TweaksPanel, TweakSection, TweakRadio, TweakButton } from './components/TweaksPanel';
import { MILESTONE_BY_KEY } from './lib/milestoneCatalog';
import { useTweaks } from './lib/useTweaks';
import { usePortfolio } from './lib/usePortfolio';
import {
  dedupeDuplicateAccounts,
  getSetting,
  insertTransactions,
  listAccounts,
  saveGoalScenario,
  saveUserProfile,
  setSetting,
  upsertAccountByFingerprint,
  upsertPrice,
} from './lib/db/repos';
import { slugifyAccountId } from './lib/db/accountId';
import { diag } from './lib/db/diag';
import { prefetchLogos } from './lib/logos';
import { backfillHistoricalPrices, filterBackfillSymbols } from './lib/quotes/backfill';
import { backfillInstruments } from './lib/quotes/sector';
import {
  AUTO_REFRESH_ENABLED_KEY,
  AUTO_REFRESH_INTERVAL_KEY,
  AUTO_REFRESH_INTERVALS,
  startAutoRefresh,
  type AutoRefreshController,
  type AutoRefreshIntervalMin,
} from './lib/autoRefresh';
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
import { UniversalTemplateView } from './views/UniversalTemplateView';

const DEFAULTS = {
  theme: 'light' as 'light' | 'dark',
  chartVariant: 'area' as 'area' | 'line' | 'bars',
  showOnboarding: false,
};

const ONBOARDING_DONE_KEY = 'onboarding.completed.v1';
/**
 * Guard key for the one-shot duplicate-account cleanup migration. Once set to
 * "yes" we never run the migration again on this machine. Bumping to v2 is the
 * canonical way to re-run it later if a fresh case of duplication shows up.
 */
const DEDUPE_V1_KEY = 'dedupe.v1.complete';

/**
 * Trailing 4-digit window of a brokerage-assigned account number. Returns the
 * empty string when the input has fewer than 4 digits or is missing. Identical
 * to the per-importer helpers; redefined locally so we don't import from the
 * importers directory just for a 4-line utility.
 */
function lastFourOfRaw(accountNumber: string | undefined): string {
  if (!accountNumber) return '';
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4);
}

export function App() {
  const {
    data,
    loading,
    reload,
    refreshLivePrices,
    newUnlocks,
    clearNewUnlocks,
    userName,
    recoveryNotice,
    recoveryInFlight,
    recoveryProgress,
    recoveryError,
    clearRecoveryError,
    resetRecoveryAttempt,
  } = usePortfolio();
  const [tweaks, setTweak] = useTweaks(DEFAULTS);

  const [view, setView] = useState('home');
  const [addAccountBrokerage, setAddAccountBrokerage] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<ToastMilestone | null>(null);
  // Where the Universal Template view's back link should land. We capture the
  // previous view at navigation time so going back from the template lands the
  // user on the page they came from (typically Add Account).
  const [universalTemplateReturnView, setUniversalTemplateReturnView] = useState<string>('import');

  // Navigation helper: when a brokerage button is clicked anywhere in the app,
  // route to Add Account with the brokerage hint prefilled.
  const goAddAccount = useCallback((brokerage?: string) => {
    setAddAccountBrokerage(brokerage);
    setView('import');
  }, []);
  // Navigation helper: jump to the dedicated Universal Template page. The
  // caller passes the view to come back to ("import" from AddAccountView). For
  // the onboarding shell, AddAccountStep handles its own navigation outside of
  // App.tsx's view router; we still expose this helper for parity with the
  // standalone flow.
  const goUniversalTemplate = useCallback((from?: string) => {
    setUniversalTemplateReturnView(from || 'import');
    setView('universal-template');
  }, []);
  // `null` = haven't checked DB yet (show nothing); true = show onboarding;
  // false = skip straight to the app.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const [selectedHolding, setSelectedHolding] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  // Where the "← Holdings" back button on HoldingDetailView should land. We
  // remember it at navigation time so drilling in from an account-filtered
  // HoldingsView returns to that same filtered view (and not the unfiltered
  // global Holdings page).
  const [holdingDetailReturnView, setHoldingDetailReturnView] = useState<'holdings' | 'account-detail'>(
    'holdings',
  );

  const openAccount = useCallback((accountId: string) => {
    setSelectedAccount(accountId);
    setView('account-detail');
  }, []);

  // On first mount, ask the DB whether the user has ever completed onboarding.
  // Real users land in onboarding by default; the Tweaks "Restart onboarding"
  // dev affordance still works via setOnboarding(true).
  useEffect(() => {
    (async () => {
      diag('app', 'mount: checking onboarding.completed.v1');
      const done = await getSetting(ONBOARDING_DONE_KEY).catch(() => null);
      diag('app', 'mount: onboarding.completed.v1 resolved', { done });
      setOnboarding(done !== 'yes');
    })();
  }, []);

  // Auto-refresh runtime: a single AutoRefreshController instance lives
  // for the life of the app shell. When the user toggles the setting in
  // SettingsView, the callback below tears down the old controller and
  // builds a new one with the fresh (enabled, intervalMin) pair. On cold
  // boot we read the persisted settings from the DB; defaults are OFF /
  // 5m per Justin's spec. The runtime calls refreshLivePrices() on every
  // foreground tick.
  const autoRefreshCtrlRef = useRef<AutoRefreshController | null>(null);
  const refreshLivePricesRef = useRef(refreshLivePrices);
  useEffect(() => {
    refreshLivePricesRef.current = refreshLivePrices;
  }, [refreshLivePrices]);
  const rebuildAutoRefresh = useCallback(
    (enabled: boolean, intervalMin: AutoRefreshIntervalMin) => {
      autoRefreshCtrlRef.current?.stop();
      autoRefreshCtrlRef.current = null;
      if (!enabled) return;
      autoRefreshCtrlRef.current = startAutoRefresh({
        enabled: true,
        intervalMin,
        // Wrap in a closure so the freshest refreshLivePrices reference is
        // always the one called; useCallback rotates the identity when the
        // holdings list changes.
        refresh: () => refreshLivePricesRef.current(),
      });
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [enabledRaw, intervalRaw] = await Promise.all([
          getSetting(AUTO_REFRESH_ENABLED_KEY).catch(() => null),
          getSetting(AUTO_REFRESH_INTERVAL_KEY).catch(() => null),
        ]);
        if (cancelled) return;
        const enabled = enabledRaw === 'yes';
        let interval: AutoRefreshIntervalMin = 5;
        const parsed = Number(intervalRaw);
        if (
          Number.isFinite(parsed) &&
          AUTO_REFRESH_INTERVALS.includes(parsed as AutoRefreshIntervalMin)
        ) {
          interval = parsed as AutoRefreshIntervalMin;
        }
        rebuildAutoRefresh(enabled, interval);
      } catch {
        // Defaults: OFF, no timer.
      }
    })();
    return () => {
      cancelled = true;
      autoRefreshCtrlRef.current?.stop();
      autoRefreshCtrlRef.current = null;
    };
  }, [rebuildAutoRefresh]);

  // One-shot duplicate-account cleanup migration. Runs once per machine,
  // gated by settings.dedupe.v1.complete. This rescues users (like Justin)
  // who imported the same CSV multiple times during onboarding/debugging
  // before the upsertAccountByFingerprint fix landed: their DB has 16 JPM
  // rows (4 unique × 4 imports each), 15 of which are empty skeletons. The
  // migration collapses each (brokerage, last4) group down to one canonical
  // account, reassigning any transactions onto the canonical row first.
  //
  // Idempotent: a second run finds every group at size 1 and is a no-op.
  // We still set the flag so we don't even pay the listAccounts() roundtrip.
  useEffect(() => {
    (async () => {
      try {
        const done = await getSetting(DEDUPE_V1_KEY).catch(() => null);
        if (done === 'yes') {
          diag('app', `mount: ${DEDUPE_V1_KEY} already set, skipping dedupe`);
          return;
        }
        diag('app', `mount: running one-shot ${DEDUPE_V1_KEY} dedupe migration`);
        const result = await dedupeDuplicateAccounts();
        diag('app', `mount: dedupe migration complete`, result);
        await setSetting(DEDUPE_V1_KEY, 'yes');
        // If we actually merged anything, kick a portfolio reload so the
        // Accounts page reflects the cleaned-up state immediately.
        if (result.merged > 0) {
          try {
            await reload();
          } catch (e) {
            console.error('[matmon] reload after dedupe migration failed', e);
          }
        }
      } catch (e) {
        console.error('[matmon-diag] dedupe migration failed', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openHolding = (sym: string) => {
    setSelectedHolding(sym);
    // Capture where we came from so the detail view's back button returns to
    // the right place. From the account-filtered HoldingsView we go back to
    // 'account-detail'; from anywhere else (the unfiltered Holdings page,
    // Home, etc.) we go back to 'holdings'.
    setHoldingDetailReturnView(view === 'account-detail' ? 'account-detail' : 'holdings');
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

  /**
   * Build a fresh ToastMilestone for the requested milestone and slot it into
   * the single toast state. Each call REPLACES the previous toast rather than
   * queueing (single-slot semantics: latest click wins, so a rapid second
   * click on a different tile shows that tile's milestone immediately).
   *
   * Source of truth:
   *   1. Prefer the joined achievement row from `data.achievements` so the
   *      unlock date appears alongside title + copy on the toast for an
   *      already-unlocked stamp.
   *   2. Fall back to the static catalog. This covers the dev "Replay $1M
   *      toast" button (the catalog has every milestone, including ones the
   *      user hasn't unlocked) and any race where `data.achievements` hasn't
   *      hydrated yet.
   *
   * The previous implementation hardcoded `'first_million'` regardless of
   * which tile the user clicked. That was the bug: clicking "Replay
   * celebration" on the "$1,000 in dividends" tile showed the millionaire
   * toast. Threading the milestone key through fixes it at the root.
   */
  const replayToast = useCallback(
    (milestoneId = 'first_million') => {
      const joined = data.achievements.find(a => a.key === milestoneId);
      if (joined) {
        setToast({
          key: joined.key,
          glyph: joined.glyph,
          title: joined.title,
          copy: joined.copy,
          date: joined.date,
          t: Date.now(),
        });
        return;
      }
      const cat = MILESTONE_BY_KEY[milestoneId];
      if (cat) {
        setToast({
          key: cat.key,
          glyph: cat.glyph,
          title: cat.title,
          copy: cat.copy,
          t: Date.now(),
        });
      }
    },
    [data],
  );

  const finishOnboarding = useCallback(
    async (state?: {
      profile: {
        name: string;
        birthYear: number;
        retireAge: number;
        household: 'single' | 'partnered' | 'family';
        theme: 'light' | 'dark';
      };
      goal: number;
      uploads?: OnboardingUpload[];
    }) => {
      diag('onboarding', 'finishOnboarding: enter', {
        hasState: !!state,
        name: state?.profile.name,
        goal: state?.goal,
        uploadCount: state?.uploads?.length ?? 0,
      });
      // Tracks whether the onboarding-time backfill actually landed at
      // least one symbol's bars in the prices table. Lifted out of the
      // nested `if (state.uploads)` so the post-import "set recovery
      // flag" block below can read it. False when there are no uploads,
      // when every symbol failed, or when state itself is missing. We
      // only set the flag when this is true; otherwise leave it off so
      // the next launch's recovery probe gets another shot.
      let backfillLandedAnyBars = false;
      if (state) {
        try {
          diag('onboarding', 'finishOnboarding: saving profile');
          await saveUserProfile(state.profile);
          diag('onboarding', 'finishOnboarding: saving goal scenario');
          await saveGoalScenario(state.goal, state.profile);
          if (state.profile.theme) setTweak('theme', state.profile.theme);
        } catch (e) {
          // Persistence is best-effort; the user still lands in Matmon either
          // way. Surface the cause so a silent saveUserProfile failure (which
          // would result in the post-onboarding "Hey there" greeting because
          // loadUserProfile returns null) is visible during dev/debug.
          console.error('[matmon] onboarding profile persistence failed', e);
        }
        // Import any CSVs the user dropped in during step 3.
        if (state.uploads && state.uploads.length > 0) {
          // Snapshot of IDs already in the DB; we extend it locally as we go so
          // multiple uploads with the same name dedupe within this batch too.
          // We still keep the slug-collision list around so upsertAccountByFingerprint
          // gets a fresh, non-colliding slug when it DOES create a new row.
          const existingIds: string[] = [];
          try {
            const existing = await listAccounts();
            for (const row of existing) existingIds.push(row.id);
          } catch (e) {
            console.error('[matmon] listAccounts pre-import dedupe failed', e);
          }
          // Collect every unique ticker across all uploads so we can kick off
          // a single best-effort logo prefetch at the end of the import.
          const tickersForLogos: string[] = [];
          for (const u of state.uploads) {
            try {
              const desiredId = slugifyAccountId(u.accountName, u.brokerage, existingIds);
              const last4 = lastFourOfRaw(u.accountNumber);
              // upsertAccountByFingerprint returns the canonical account ID:
              // either the desired one (new) or the existing row's ID (re-import).
              // This is the root-cause fix for the duplicate-account bug; subsequent
              // insertTransactions calls land on the canonical row whose rowHash
              // dedupe will correctly skip already-imported rows.
              const { id } = await upsertAccountByFingerprint(
                {
                  id: desiredId,
                  name: u.accountName,
                  brokerage: u.brokerage,
                  account_type: u.accountType,
                  currency: 'USD',
                  created_at: new Date().toISOString(),
                },
                last4,
              );
              existingIds.push(id);
              await insertTransactions(id, u.transactions);
              for (const t of u.transactions) {
                if (t.symbol) tickersForLogos.push(t.symbol);
              }
              // Holdings-only importers (JPM positions) carry the current
              // market mark alongside the lot's cost basis. Persist those so
              // portfolio.ts can value positions at market, not at cost.
              if (u.marketPrices && u.marketPrices.length > 0) {
                for (const mp of u.marketPrices) {
                  try {
                    await upsertPrice(mp.symbol, mp.asOf, mp.price);
                  } catch (e) {
                    // A single bad price shouldn't block the rest. Surface so
                    // we notice when a holdings file silently loses its market
                    // marks (which would leave portfolio value at $0 even
                    // though insertTransactions succeeded).
                    console.error('[matmon] upsertPrice failed during onboarding', e);
                  }
                }
              }
            } catch (e) {
              // One bad upload shouldn't kill the rest, but a SILENT failure
              // here would mean the user finishes onboarding and lands on Home
              // with $0 (the symptom Justin reported). Loud-fail in the console.
              console.error('[matmon] upload persistence failed during onboarding', e);
            }
          }
          // Fire-and-forget logo prefetch. Never await; if it fails the UI
          // just shows the monogram fallback.
          if (tickersForLogos.length > 0) {
            void prefetchLogos(tickersForLogos);
          }
          // Backfill historical daily closes for every imported symbol so
          // the portfolio NAV chart renders REAL mark-to-market rather than
          // a qty-accumulation curve. We AWAIT this: blocking the onboarding
          // spinner here is the right tradeoff because the chart on the
          // landing screen is the single most prominent piece of UI, and
          // showing the "+323% YTD" garbage that comes from the missing
          // history would be a worse first impression than waiting a few
          // extra seconds.
          //
          // Per-symbol failures are non-fatal: backfillHistoricalPrices
          // returns { ok, failed } and never throws. A symbol with no
          // history just gets a forward-fill gap in the chart.
          const backfillSymbols = filterBackfillSymbols(
            state.uploads.flatMap(u => u.transactions.map(t => t.symbol)),
          );
          if (backfillSymbols.length > 0) {
            // Earliest tx date across every upload: the lower bound for
            // the price-fetch window. If any user uploaded transactions
            // before 2000, the chart can rebuild that far back.
            let earliest = new Date();
            for (const u of state.uploads) {
              for (const t of u.transactions) {
                if (t.date < earliest) earliest = t.date;
              }
            }
            try {
              diag('onboarding', 'finishOnboarding: starting price backfill', {
                symbols: backfillSymbols.length,
                earliest: earliest.toISOString().slice(0, 10),
              });
              const result = await backfillHistoricalPrices(backfillSymbols, earliest);
              backfillLandedAnyBars = result.ok.length > 0;
              diag('onboarding', 'finishOnboarding: price backfill complete', {
                ok: result.ok.length,
                failed: result.failed.length,
              });
            } catch (e) {
              // backfillHistoricalPrices never throws (it returns failed[]
              // for per-symbol failures), but defensively guard in case a
              // future version changes the contract. A backfill failure
              // should NEVER block onboarding completion.
              console.error('[matmon] price backfill threw during onboarding', e);
            }
            // Sector / industry backfill. Fire-and-forget: the Holdings view
            // renders "--" while the fetch is in flight so the user isn't
            // blocked. The freshly-landed sectors show up on the next natural
            // portfolio rebuild (next nav, next refresh quotes, etc.). We
            // intentionally DON'T call reload() here: reload re-runs
            // maybeRunRecovery which can re-trigger the price backfill in a
            // CORS-blocked browser-dev environment.
            void (async () => {
              try {
                diag('onboarding', 'finishOnboarding: starting sector backfill', {
                  symbols: backfillSymbols.length,
                });
                const result = await backfillInstruments(backfillSymbols);
                diag('onboarding', 'finishOnboarding: sector backfill complete', {
                  ok: result.ok.length,
                  notFound: result.notFound.length,
                  failed: result.failed.length,
                });
              } catch (e) {
                console.error('[matmon] sector backfill threw during onboarding', e);
              }
            })();
          }
        }
      }
      // Persist the "I've seen onboarding" flag so we don't show it next launch.
      diag('onboarding', 'finishOnboarding: setting onboarding.completed.v1=yes');
      await setSetting(ONBOARDING_DONE_KEY, 'yes').catch(e => {
        console.error('[matmon] setSetting(onboarding.completed) failed', e);
      });
      // Mark the one-shot price-recovery flag as complete ONLY when the
      // onboarding-time backfill actually landed at least one symbol's
      // bars in the prices table. When EVERY symbol failed (Yahoo CORS-
      // blocked in browser dev, or Yahoo down) we leave the flag OFF so
      // the next launch (typically in Tauri, which sidesteps CORS via the
      // HTTP plugin) gets another shot via the recovery probe in
      // usePortfolio.maybeRunRecovery. Without this guard a single failed
      // dev-mode onboarding could permanently strand a real user on the
      // qty-accumulation legacy chart, which is exactly the bug that
      // produced the diagonal-line + +283% YTD report.
      if (backfillLandedAnyBars) {
        await setSetting('backfill.recovery.v1.complete', 'yes').catch(() => {});
      } else {
        diag('onboarding', 'finishOnboarding: backfill landed no bars, leaving recovery flag off');
      }
      // Reload portfolio BEFORE we flip onboarding off, so HomeView mounts
      // with the freshly-imported data already in state. The previous order
      // (flip-then-reload) caused a render with stale empty data, surfacing
      // as "Hey there" and "$0" until the next tick.
      try {
        diag('onboarding', 'finishOnboarding: reloading portfolio');
        await reload();
      } catch (e) {
        console.error('[matmon] reload after onboarding failed', e);
      }
      diag('onboarding', 'finishOnboarding: complete, transitioning to home view');
      setOnboarding(false);
      setTweak('showOnboarding', false);
      setView('home');
    },
    [reload, setTweak],
  );

  /**
   * "Skip for now" path from the intermediate onboarding steps. No demo seed,
   * no fake portfolio: we just mark onboarding done and land the user on an
   * empty Home with the empty-state CTAs. The user can come back and import a
   * CSV from the sidebar whenever they want.
   */
  const skipOnboarding = useCallback(async () => {
    try {
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

  // Hold rendering for one tick until we know whether to show onboarding;
  // avoids a flash of the empty Home screen on first launch.
  if (onboarding === null) {
    return <div className="app-shell" style={{ background: 'var(--paper)' }} />;
  }

  if (onboarding) {
    return (
      <>
        <OnboardingView
          onComplete={finishOnboarding}
          onSkip={skipOnboarding}
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
            onReload={reload}
            userName={userName}
            recoveryInFlight={recoveryInFlight}
            recoveryProgress={recoveryProgress}
            loading={loading}
          />
        );
      case 'buckets':
        return <AccountsView data={data} onAddAccount={goAddAccount} onOpenAccount={openAccount} />;
      case 'holdings':
        return <HoldingsView data={data} onSelect={openHolding} onAddAccount={goAddAccount} />;
      case 'account-detail':
        return (
          <HoldingsView
            data={data}
            onSelect={openHolding}
            filterAccountId={selectedAccount ?? undefined}
            onBack={() => setView('buckets')}
            onAddAccount={goAddAccount}
            onReloadPortfolio={reload}
          />
        );
      case 'holding-detail': {
        const h = data.holdings.find(x => x.sym === selectedHolding) || data.holdings[0];
        return <HoldingDetailView data={data} holding={h} onBack={() => setView(holdingDetailReturnView)} />;
      }
      case 'planner':
        return <PlannerView data={data} />;
      case 'achievements':
        return <AchievementsView data={data} onReplayToast={replayToast} onAddAccount={goAddAccount} />;
      case 'transactions':
        return <TransactionsView data={data} onAddAccount={goAddAccount} />;
      case 'import':
        return (
          <AddAccountView
            prefillBrokerage={addAccountBrokerage}
            onReloadPortfolio={reload}
            onUseUniversalTemplate={() => goUniversalTemplate('import')}
          />
        );
      case 'universal-template':
        return (
          <UniversalTemplateView
            backLabel={universalTemplateReturnView === 'import' ? 'Add Account' : 'Home'}
            onBack={() => setView(universalTemplateReturnView)}
            onComplete={async () => {
              await reload();
              setView('home');
            }}
          />
        );
      case 'settings':
        return (
          <SettingsView
            tweaks={tweaks}
            setTweak={setTweak}
            onRestartOnboarding={restartOnboarding}
            onReloadPortfolio={reload}
            onResetRecoveryAttempt={resetRecoveryAttempt}
            onAutoRefreshChange={rebuildAutoRefresh}
          />
        );
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
          achievementsVersion={data.achievements.length}
        />
        <main className="main">{renderView()}</main>
      </div>

      <MilestoneToast milestone={toast} onDismiss={() => setToast(null)} />

      {recoveryNotice && (
        // One-shot global recovery banner. Triggered by usePortfolio when an
        // existing user opens the app for the first time after the
        // historical-backfill feature ships, OR after a future reset that
        // clears the prices table. The banner sits in the bottom-right
        // corner using the same toast-container slot so it doesn't push
        // page content around. We render it via a data attribute so the
        // Playwright spec can target it without coupling to fragile CSS.
        // The inline indicator inside HomeView's chart slot is the primary
        // signal; this toast is a secondary confirmation that lives in the
        // corner so views other than Home still see something is happening.
        <div
          className="toast-container"
          role="status"
          aria-live="polite"
          data-testid="recovery-toast"
        >
          <div className="toast">
            <div className="toast-glyph">⟳</div>
            <div style={{ flex: 1 }}>
              <div className="toast-title">Loading chart history</div>
              <div className="toast-body">{recoveryNotice}</div>
            </div>
          </div>
        </div>
      )}

      {recoveryError && !recoveryNotice && (
        // Failure banner: shown when the most recent recovery attempt
        // failed to land ANY bars. We never show this concurrently with
        // the loading toast above (the !recoveryNotice gate) so the user
        // doesn't see two toasts fighting for attention. Click anywhere
        // to dismiss; the actual fix lives in Settings, Market data.
        //
        // Positioned ABOVE the standard toast slot (bottom: 110px instead
        // of 24px) so it never overlaps a concurrent milestone toast and
        // can't intercept pointer events that the user intended for the
        // toast below it. The container keeps pointer-events: none from
        // the .toast-container base style; only the inner clickable
        // .toast region accepts clicks (for dismissal).
        <div
          className="toast-container"
          role="alert"
          aria-live="assertive"
          data-testid="recovery-error-toast"
          style={{ bottom: 110 }}
        >
          <div
            className="toast"
            onClick={clearRecoveryError}
            style={{ cursor: 'pointer', borderColor: 'var(--loss)' }}
          >
            <div className="toast-glyph" style={{ color: 'var(--loss)' }}>
              !
            </div>
            <div style={{ flex: 1 }}>
              <div className="toast-title">Couldn't load chart history</div>
              <div className="toast-body">{recoveryError}</div>
            </div>
          </div>
        </div>
      )}

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
