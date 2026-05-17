import { useEffect, useMemo, useState } from 'react';
import { isTauri } from '../lib/env';
import { BrokerageLogo } from '../components/BrokerageLogo';

const STEPS = ['Welcome', 'About you', 'Your goal', 'Your first account', "You're set"];
// Bigger pool of playful account names; 5 randomly chosen per onboarding session.
const SUGGEST_POOL = [
  'The Lighthouse',
  'The Roost',
  'The Greenhouse',
  'The Workshop',
  'The Hatch',
  'The Annex',
  "My Girlfriend's a Princess Fund",
  "My Boyfriend's a Prince Fund",
  'Future Me Thanks You',
  'The Slow Boat',
  'The Beach House Bet',
  'Operation Touch Grass',
  'The Quiet Wealth',
  'Bagel Money',
  'The Long Lever',
  'Compound, Baby',
  'The Acorn Pile',
  'Dragon Vault',
  'Buy the Dip Society',
  "Don't Touch This",
  'The Patience Project',
  'The Forever Account',
  'Coast Mode',
  'The Rainy Day',
  'My Eventual Cabin',
  'The Slow Cooker',
  'Yacht Optional',
  'The Big Quiet',
];
function pickFunNames(seed: number, count = 5): string[] {
  // Deterministic-per-session shuffle so the user sees a stable set,
  // but a different set on a fresh onboarding session.
  const out = [...SUGGEST_POOL];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(((Math.sin(seed * (i + 1) * 12.9898) + 1) / 2) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, count);
}

type Profile = {
  name: string;
  birthYear: number;
  retireAge: number;
  household: 'single' | 'partnered' | 'family';
  theme: 'light' | 'dark';
};

type Props = {
  onComplete: (state?: { profile: Profile; goal: number }) => void;
  onSkip: () => void;
  /** Live-preview the chosen theme as the user toggles in step 1. */
  onPreviewTheme?: (t: 'light' | 'dark') => void;
};

export function OnboardingView({ onComplete, onSkip, onPreviewTheme }: Props) {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<Profile>({
    name: '',
    birthYear: 1985,
    retireAge: 67,
    household: 'partnered',
    theme: 'light',
  });
  const [goal, setGoal] = useState(3_000_000);
  const [milestoneFocus, setMilestoneFocus] = useState<string[]>([]);
  const [addAccountStep, setAddAccountStep] = useState<'drop' | 'review'>('drop');
  const [accountName, setAccountName] = useState('The Lighthouse');
  const [accountNameMode, setAccountNameMode] = useState<'fun' | 'custom' | 'default'>('fun');
  const [customAccountName, setCustomAccountName] = useState('');

  const next = () => setStep(s => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));

  const canAdvance = (() => {
    if (step === 1) return profile.name.trim().length > 0;
    if (step === 3) return addAccountStep === 'review';
    return true;
  })();

  const inTauri = isTauri();

  return (
    <div className="ob-shell">
      {!inTauri && (
        <div className="ob-titlebar">
          <div className="tl-dots">
            <span className="tl-dot r" />
            <span className="tl-dot y" />
            <span className="tl-dot g" />
          </div>
          <div className="ob-titlebar-title">Matmon · Welcome</div>
          <div style={{ width: 60 }} />
        </div>
      )}

      <div className="ob-rail">
        {STEPS.map((label, i) => (
          <div key={i} className={`ob-rail-step ${i === step ? 'current' : ''} ${i < step ? 'past' : ''}`}>
            <div className="ob-rail-dot">{i < step ? '✓' : i + 1}</div>
            <div className="ob-rail-label">{label}</div>
          </div>
        ))}
        <div className="ob-rail-line">
          <div className="ob-rail-fill" style={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} />
        </div>
      </div>

      <div className="ob-body">
        {step === 0 && <Welcome onStart={next} onSkip={onSkip} />}
        {step === 1 && (
          <ProfileStep profile={profile} setProfile={setProfile} onPreviewTheme={onPreviewTheme} />
        )}
        {step === 2 && (
          <GoalStep
            profile={profile}
            goal={goal}
            setGoal={setGoal}
            milestoneFocus={milestoneFocus}
            setMilestoneFocus={setMilestoneFocus}
          />
        )}
        {step === 3 && (
          <AddAccountStep
            stage={addAccountStep}
            onAdvance={() => setAddAccountStep('review')}
            accountName={accountName}
            setAccountName={setAccountName}
            nameMode={accountNameMode}
            setNameMode={setAccountNameMode}
            customName={customAccountName}
            setCustomName={setCustomAccountName}
          />
        )}
        {step === 4 && (
          <DoneStep
            profile={profile}
            goal={goal}
            accountName={accountName}
            onEnter={() => onComplete({ profile, goal })}
          />
        )}
      </div>

      {step !== 0 && step !== 4 && (
        <div className="ob-footer">
          <button className="btn btn-ghost" onClick={back}>
            Back
          </button>
          <div style={{ flex: 1 }} />
          {step !== 3 && (
            <button className="btn btn-ghost" onClick={onSkip}>
              Skip for now
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={next}
            disabled={!canAdvance}
            style={!canAdvance ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
          >
            {step === 3 ? 'Finish setup' : 'Continue'}
          </button>
        </div>
      )}
    </div>
  );
}

function Welcome({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="ob-welcome">
      <div className="ob-welcome-glyph">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <path d="M28 6 L52 22 L44 50 L12 50 L4 22 Z" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.25" />
          <path d="M28 16 L40 24 L36 38 L20 38 L16 24 Z" fill="none" stroke="var(--accent)" strokeWidth="1.25" />
          <circle cx="28" cy="28" r="3.5" fill="var(--accent)" />
        </svg>
      </div>
      <div className="ob-welcome-eyebrow">Welcome to Matmon</div>
      <h1 className="ob-welcome-title">
        A portfolio tracker
        <br />
        that respects your data.
      </h1>
      <p className="ob-welcome-copy">
        Everything you import stays on this machine. The only data that ever leaves is anonymous ticker requests for
        current prices.
      </p>
      <div className="ob-welcome-bullets">
        <div className="ob-bullet">
          <span className="dot" />
          <span>
            <strong>Private by design.</strong> No account, no login, no telemetry.
          </span>
        </div>
        <div className="ob-bullet">
          <span className="dot" />
          <span>
            <strong>One language.</strong> Math, charts, and CSVs done locally.
          </span>
        </div>
        <div className="ob-bullet">
          <span className="dot" />
          <span>
            <strong>Open source.</strong> Read the code; verify the boundary.
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 28, justifyContent: 'center' }}>
        <button
          className="btn btn-primary"
          onClick={onStart}
          style={{ height: 38, padding: '0 22px', fontSize: 14 }}
        >
          Let's set you up
        </button>
        <button className="btn btn-ghost" onClick={onSkip}>
          Try with a sample portfolio
        </button>
      </div>
      <p
        style={{
          marginTop: 26,
          fontSize: 11.5,
          color: 'var(--ink-4)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        Should take about 90 seconds
      </p>
    </div>
  );
}

function ProfileStep({
  profile,
  setProfile,
  onPreviewTheme,
}: {
  profile: Profile;
  setProfile: (p: Profile) => void;
  onPreviewTheme?: (t: 'light' | 'dark') => void;
}) {
  const set = (k: keyof Profile, v: any) => setProfile({ ...profile, [k]: v });
  const currentAge = 2026 - profile.birthYear;

  // Local string buffers so the user can type a partial value (e.g., "1" on
  // the way to "1985") without the parent's clamp slamming it to the min on
  // every keystroke. We only push valid in-range values up; on blur we clamp
  // and snap back to display the canonical number.
  const [birthStr, setBirthStr] = useState(String(profile.birthYear));
  const [retireStr, setRetireStr] = useState(String(profile.retireAge));
  useEffect(() => setBirthStr(String(profile.birthYear)), [profile.birthYear]);
  useEffect(() => setRetireStr(String(profile.retireAge)), [profile.retireAge]);

  function commitInRange(raw: string, lo: number, hi: number, key: 'birthYear' | 'retireAge') {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= lo && n <= hi) set(key, n);
  }

  function clampAndSet(raw: string, lo: number, hi: number, key: 'birthYear' | 'retireAge'): number {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return profile[key];
    const clamped = Math.max(lo, Math.min(hi, n));
    set(key, clamped);
    return clamped;
  }

  function pickTheme(t: 'light' | 'dark') {
    set('theme', t);
    onPreviewTheme?.(t);
  }

  return (
    <div className="ob-step">
      <div className="ob-step-head">
        <h2 className="ob-step-title">First things first. What should we call you?</h2>
        <p className="ob-step-sub">
          We use this to say hi when you open Matmon. Nothing leaves this device, ever.
        </p>
      </div>

      <div className="ob-form">
        <div className="ob-field">
          <label>Your name</label>
          <input
            type="text"
            placeholder="Justin"
            value={profile.name}
            onChange={e => set('name', e.target.value)}
            className="name-input"
            autoFocus
          />
        </div>

        <div className="ob-field-row">
          <div className="ob-field">
            <label>
              When were you born? <span className="ob-field-hint">For planner defaults</span>
            </label>
            <div className="ob-stepper">
              <button
                onClick={() => set('birthYear', Math.max(1920, profile.birthYear - 1))}
                aria-label="Decrease year"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                value={birthStr}
                min={1920}
                max={2020}
                onChange={e => {
                  setBirthStr(e.target.value);
                  commitInRange(e.target.value, 1920, 2020, 'birthYear');
                }}
                onBlur={e => {
                  const v = clampAndSet(e.target.value, 1920, 2020, 'birthYear');
                  setBirthStr(String(v));
                }}
                className="ob-stepper-input"
                aria-label="Birth year"
              />
              <button
                onClick={() => set('birthYear', Math.min(2020, profile.birthYear + 1))}
                aria-label="Increase year"
              >
                +
              </button>
            </div>
            <div className="ob-field-aside">{currentAge} years old</div>
          </div>

          <div className="ob-field">
            <label>When do you want to clock out?</label>
            <div className="ob-stepper">
              <button
                onClick={() => set('retireAge', Math.max(40, profile.retireAge - 1))}
                aria-label="Decrease retirement age"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                value={retireStr}
                min={40}
                max={85}
                onChange={e => {
                  setRetireStr(e.target.value);
                  commitInRange(e.target.value, 40, 85, 'retireAge');
                }}
                onBlur={e => {
                  const v = clampAndSet(e.target.value, 40, 85, 'retireAge');
                  setRetireStr(String(v));
                }}
                className="ob-stepper-input"
                aria-label="Target retirement age"
              />
              <button
                onClick={() => set('retireAge', Math.min(85, profile.retireAge + 1))}
                aria-label="Increase retirement age"
              >
                +
              </button>
            </div>
            <div className="ob-field-aside">{Math.max(0, profile.retireAge - currentAge)} years out</div>
          </div>
        </div>

        <div className="ob-field">
          <label>Who's in the picture?</label>
          <div className="ob-choice-grid">
            {[
              { id: 'single', label: 'Just me', sub: 'Solo flight' },
              { id: 'partnered', label: 'With a partner', sub: 'Two on the dance floor' },
              { id: 'family', label: 'Family', sub: 'Healthcare math × 2+' },
            ].map(o => (
              <button
                key={o.id}
                className={`ob-choice ${profile.household === o.id ? 'active' : ''}`}
                onClick={() => set('household', o.id as Profile['household'])}
              >
                <div className="ob-choice-label">{o.label}</div>
                <div className="ob-choice-sub">{o.sub}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="ob-field-row">
          <div className="ob-field">
            <label>Default Theme <span className="ob-field-hint">Tap one, the app changes around you</span></label>
            <div className="ob-toggle-pair">
              <button
                className={`ob-toggle ${profile.theme === 'light' ? 'active' : ''}`}
                onClick={() => pickTheme('light')}
              >
                <div className="ob-toggle-label">Light</div>
                <div className="ob-toggle-sub">Cream paper</div>
              </button>
              <button
                className={`ob-toggle ${profile.theme === 'dark' ? 'active' : ''}`}
                onClick={() => pickTheme('dark')}
              >
                <div className="ob-toggle-label">Dark</div>
                <div className="ob-toggle-sub">Late-night ink</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GoalStep({
  profile,
  goal,
  setGoal,
  milestoneFocus,
  setMilestoneFocus,
}: {
  profile: Profile;
  goal: number;
  setGoal: (n: number) => void;
  milestoneFocus: string[];
  setMilestoneFocus: (s: string[]) => void;
}) {
  const yearsOut = Math.max(1, profile.retireAge - (2026 - profile.birthYear));
  const tagline =
    goal < 1_000_000
      ? 'Solid foundation goal'
      : goal < 2_500_000
      ? 'Comfortable retirement number'
      : goal < 5_000_000
      ? 'Ambitious, fully achievable'
      : 'Pillar-of-the-community territory';

  const focusOptions = [
    { id: 'first_million', label: 'First million', hint: 'Crossing $1M' },
    { id: 'beat_spy', label: 'Beat the S&P', hint: 'In a calendar year' },
    { id: 'hsa_covered', label: 'HSA covers health', hint: 'Retirement-ready' },
    { id: 'first_500k', label: 'Half a million', hint: 'On the way up' },
    { id: 'maxed_ira', label: 'Max the IRA', hint: 'Every tax year' },
    { id: 'survived', label: 'Hold through a dip', hint: 'Discipline test' },
  ];

  const toggleFocus = (id: string) => {
    setMilestoneFocus(milestoneFocus.includes(id) ? milestoneFocus.filter(f => f !== id) : [...milestoneFocus, id]);
  };

  return (
    <div className="ob-step">
      <div className="ob-step-head">
        <div className="ob-step-eyebrow">Step 2 · The number you'd love to land on</div>
        <h2 className="ob-step-title">
          {profile.name ? `${profile.name}, what's the number?` : "What's the number?"}
        </h2>
        <p className="ob-step-sub">
          You'll see this as a target line on the Planner. You can change it later, of course.
        </p>
      </div>

      <div className="ob-goal">
        <div className="ob-goal-big">
          <span className="dollar">$</span>
          {(goal / 1_000_000).toFixed(1)}
          <span className="cents">M</span>
        </div>
        <div className="ob-goal-tagline">{tagline}</div>

        <input
          type="range"
          min="500000"
          max="10000000"
          step="50000"
          value={goal}
          onChange={e => setGoal(+e.target.value)}
          className="matmon-slider"
          style={{ width: '100%', marginTop: 18 }}
        />
        <div className="ob-goal-scale">
          <span>$500K</span>
          <span>$2.5M</span>
          <span>$5M</span>
          <span>$10M</span>
        </div>

        <div className="ob-goal-meta">
          <div>
            <span
              className="muted"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Target year
            </span>
            <div className="num" style={{ fontSize: 18, marginTop: 4 }}>
              {2026 + yearsOut}
            </div>
            <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {yearsOut} years out · age {profile.retireAge}
            </div>
          </div>
          <div>
            <span
              className="muted"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              To get there
            </span>
            <div className="num" style={{ fontSize: 18, marginTop: 4 }}>
              ~${Math.round(goal / yearsOut / 12 / 0.7 / 100) * 100}/mo
            </div>
            <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              at 7% real · rough estimate
            </div>
          </div>
        </div>
      </div>

      <div className="ob-milestones">
        <div className="ob-step-eyebrow" style={{ marginBottom: 10 }}>
          Milestones to celebrate · pick a few
        </div>
        <div className="ob-milestone-grid">
          {focusOptions.map(o => (
            <button
              key={o.id}
              onClick={() => toggleFocus(o.id)}
              className={`ob-milestone ${milestoneFocus.includes(o.id) ? 'active' : ''}`}
            >
              <span className="ob-milestone-check">{milestoneFocus.includes(o.id) ? '✓' : ''}</span>
              <div>
                <div className="ob-milestone-label">{o.label}</div>
                <div className="ob-milestone-hint">{o.hint}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AddAccountStep({
  stage,
  onAdvance,
  accountName,
  setAccountName,
  nameMode,
  setNameMode,
  customName,
  setCustomName,
}: {
  stage: 'drop' | 'review';
  onAdvance: () => void;
  accountName: string;
  setAccountName: (s: string) => void;
  nameMode: 'fun' | 'custom' | 'default';
  setNameMode: (m: 'fun' | 'custom' | 'default') => void;
  customName: string;
  setCustomName: (s: string) => void;
}) {
  // Stable random selection per onboarding session — different names each fresh run.
  const suggestNames = useMemo(() => pickFunNames(Date.now() % 9973, 5), []);
  return (
    <div className="ob-step">
      <div className="ob-step-head">
        <div className="ob-step-eyebrow">Step 3 · Bring your numbers in</div>
        <h2 className="ob-step-title">Drop in your first CSV.</h2>
        <p className="ob-step-sub">
          You can keep adding accounts later. Don't see your brokerage in the list? Drop it anyway, we'll fall back
          to a column mapper.
        </p>
      </div>

      {stage === 'drop' && (
        <>
          <div className="dropzone" onClick={onAdvance}>
            <div className="dropzone-glyph">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                <path d="M24 30V8" />
                <path d="M14 18l10-10 10 10" />
                <path d="M8 32v6a2 2 0 0 0 2 2h28a2 2 0 0 0 2-2v-6" />
              </svg>
            </div>
            <div className="dropzone-title">Drop a CSV here</div>
            <div className="dropzone-sub">Or click to browse. Read locally, never uploaded.</div>
            <button
              className="btn btn-primary"
              style={{ marginTop: 18 }}
              onClick={e => {
                e.stopPropagation();
                onAdvance();
              }}
            >
              Use the sample · Fidelity Taxable
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 18 }}>
            {['Fidelity', 'Charles Schwab', 'JP Morgan', 'Human Interest'].map(b => (
              <div
                key={b}
                className="brokerage-card"
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: 12, gap: 6 }}
              >
                <BrokerageLogo name={b} />
                <div className="brokerage-name" style={{ fontSize: 14 }}>
                  {b}
                </div>
                <div className="brokerage-note">Supported</div>
              </div>
            ))}
          </div>
        </>
      )}

      {stage === 'review' && (
        <div className="ob-review">
          <div className="ob-review-detected">
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--ink)' }}>
              Fidelity, with 7 years of history.
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              1,847 transactions parsed locally. Confirm what we figured out below.
            </div>
          </div>
          <div className="ob-review-grid">
            {[
              { k: 'Brokerage', v: 'Fidelity' },
              { k: 'Account type', v: 'Taxable brokerage' },
              { k: 'Currency', v: 'USD' },
              { k: 'Transactions', v: '1,847' },
              { k: 'Holdings', v: '12 positions' },
              { k: 'Date range', v: 'Jan 2019 to May 2026' },
              { k: 'Action types', v: '7 mapped · 0 unknown' },
            ].map(it => (
              <div key={it.k} className="ob-review-item">
                <div className="ob-review-key">{it.k}</div>
                <div className="ob-review-val">{it.v}</div>
              </div>
            ))}
          </div>

          <div className="ob-name-block">
            <div className="ob-step-eyebrow" style={{ marginBottom: 10 }}>
              Name this account
            </div>
            <input
              type="text"
              value={
                nameMode === 'default' ? 'Fidelity Taxable' : nameMode === 'custom' ? customName : accountName
              }
              onChange={e => {
                setNameMode('custom');
                setCustomName(e.target.value);
                setAccountName(e.target.value);
              }}
              placeholder="Type a name, or pick a suggestion below"
              className="name-input"
            />
            <div
              style={{
                marginTop: 14,
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                letterSpacing: '0.06em',
                color: 'var(--ink-4)',
              }}
            >
              Suggestions
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {suggestNames.map(n => (
                <button
                  key={n}
                  onClick={() => {
                    setAccountName(n);
                    setNameMode('fun');
                  }}
                  className={`name-suggest ${nameMode === 'fun' && accountName === n ? 'active' : ''}`}
                >
                  {n}
                </button>
              ))}
              <button
                onClick={() => {
                  setNameMode('default');
                  setAccountName('Fidelity Taxable');
                }}
                className={`name-suggest boring ${nameMode === 'default' ? 'active' : ''}`}
              >
                Just the boring one
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DoneStep({
  profile,
  goal,
  accountName,
  onEnter,
}: {
  profile: Profile;
  goal: number;
  accountName: string;
  onEnter: () => void;
}) {
  return (
    <div className="ob-welcome">
      <div className="ob-welcome-glyph">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <circle cx="28" cy="28" r="24" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.25" />
          <path d="M18 28 L25 35 L38 21" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="ob-welcome-eyebrow">You're set</div>
      <h1 className="ob-welcome-title">Welcome, {profile.name || 'friend'}.</h1>
      <p className="ob-welcome-copy">
        Your numbers are your own again. {accountName} is in your portfolio, your goal is{' '}
        <strong>
          ${(goal / 1_000_000).toFixed(1)}M by {2026 + (profile.retireAge - (2026 - profile.birthYear))}
        </strong>
        , and Matmon is ready when you are.
      </p>
      <div
        style={{
          background: 'var(--paper-2)',
          borderRadius: 14,
          padding: '18px 22px',
          margin: '24px auto 0',
          maxWidth: 460,
          textAlign: 'left',
        }}
      >
        <div className="ob-step-eyebrow" style={{ marginBottom: 10 }}>
          What's next
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--ink-2)' }}>
          <div>→ Drag more CSVs in, Vanguard, Schwab, your 401(k)</div>
          <div>→ Open the Planner and play with the sliders</div>
          <div>→ Find your milestones on the Achievements road</div>
        </div>
      </div>
      <button
        className="btn btn-primary"
        onClick={onEnter}
        style={{ marginTop: 28, height: 38, padding: '0 28px', fontSize: 14 }}
      >
        Take me to Matmon
      </button>
    </div>
  );
}
