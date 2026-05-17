import { useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '../lib/env';
import { BrokerageLogo } from '../components/BrokerageLogo';
import { importCsv } from '../lib/importers';
import type { ImporterResult, ParsedTransaction } from '../lib/importers/types';

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

export type OnboardingUpload = {
  fileName: string;
  brokerage: string;
  accountType: string;
  accountName: string;
  transactions: ParsedTransaction[];
};

type Props = {
  onComplete: (state?: { profile: Profile; goal: number; uploads?: OnboardingUpload[] }) => void;
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
  const [uploads, setUploads] = useState<OnboardingUpload[]>([]);

  const next = () => setStep(s => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));

  const canAdvance = (() => {
    if (step === 1) return profile.name.trim().length > 0;
    // Step 3 is the account import; you can advance with or without uploads
    // (skip CTA still works and lands you on the empty Home).
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
        {step === 2 && <GoalStep profile={profile} goal={goal} setGoal={setGoal} />}
        {step === 3 && (
          <AddAccountStep
            uploads={uploads}
            setUploads={setUploads}
          />
        )}
        {step === 4 && (
          <DoneStep
            profile={profile}
            goal={goal}
            uploads={uploads}
            onEnter={() => onComplete({ profile, goal, uploads })}
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
                type="text"
                inputMode="numeric"
                pattern="\d*"
                maxLength={4}
                value={birthStr}
                onChange={e => {
                  // Digits only, cap at 4 chars so the user can't type "19850" past a 4-digit year.
                  const cleaned = e.target.value.replace(/\D/g, '').slice(0, 4);
                  setBirthStr(cleaned);
                  commitInRange(cleaned, 1920, 2020, 'birthYear');
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
                onClick={() => set('retireAge', Math.max(25, profile.retireAge - 1))}
                aria-label="Decrease retirement age"
              >
                −
              </button>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d*"
                maxLength={2}
                value={retireStr}
                onChange={e => {
                  // Digits only, max 2 chars (we cap at 85).
                  const cleaned = e.target.value.replace(/\D/g, '').slice(0, 2);
                  setRetireStr(cleaned);
                  commitInRange(cleaned, 25, 85, 'retireAge');
                }}
                onBlur={e => {
                  const v = clampAndSet(e.target.value, 25, 85, 'retireAge');
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

const GOAL_MIN = 500_000;
const GOAL_MAX = 25_000_000;

function GoalStep({
  profile,
  goal,
  setGoal,
}: {
  profile: Profile;
  goal: number;
  setGoal: (n: number) => void;
}) {
  const yearsOut = Math.max(1, profile.retireAge - (2026 - profile.birthYear));
  const tagline =
    goal < 1_000_000
      ? 'Solid foundation goal'
      : goal < 2_500_000
      ? 'Comfortable retirement number'
      : goal < 5_000_000
      ? 'Ambitious, fully achievable'
      : goal < 10_000_000
      ? 'Pillar-of-the-community territory'
      : 'Generational money';

  // Local string buffer for the typeable goal field, same pattern as the
  // birth-year / retire-age inputs above. Sync down on slider movement.
  const [goalStr, setGoalStr] = useState(formatGoalInput(goal));
  useEffect(() => setGoalStr(formatGoalInput(goal)), [goal]);

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
        <div className="ob-goal-big" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center' }}>
          <span className="dollar">$</span>
          {/* The big number IS the input. Looks like a display until you click. */}
          <input
            type="text"
            inputMode="numeric"
            value={goalStr}
            onChange={e => {
              const cleaned = e.target.value.replace(/[^\d,]/g, '');
              setGoalStr(cleaned);
              const n = parseInt(cleaned.replace(/,/g, ''), 10);
              if (!Number.isNaN(n) && n >= GOAL_MIN && n <= GOAL_MAX) {
                setGoal(n);
              }
            }}
            onBlur={e => {
              const n = parseInt(e.target.value.replace(/,/g, ''), 10);
              const clamped = Number.isNaN(n) ? goal : Math.max(GOAL_MIN, Math.min(GOAL_MAX, n));
              setGoal(clamped);
              setGoalStr(formatGoalInput(clamped));
            }}
            className="ob-goal-input"
            aria-label="Goal in dollars"
          />
        </div>
        <div className="ob-goal-tagline">{tagline}</div>

        <input
          type="range"
          min={GOAL_MIN}
          max={GOAL_MAX}
          step="50000"
          value={goal}
          onChange={e => setGoal(+e.target.value)}
          className="matmon-slider"
          style={{ width: '100%', marginTop: 18 }}
        />
        <div className="ob-goal-scale">
          <span>$500K</span>
          <span>$5M</span>
          <span>$15M</span>
          <span>$25M</span>
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

    </div>
  );
}

function formatGoalInput(n: number): string {
  return n.toLocaleString('en-US');
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  taxable: 'Taxable',
  trad_ira: 'Traditional IRA',
  roth_ira: 'Roth IRA',
  '401k': '401(k)',
  hsa: 'HSA',
  other: 'Brokerage',
  unknown: 'Brokerage',
};

function defaultTechName(brokerage: string, accountType: string): string {
  return `${brokerage} ${ACCOUNT_TYPE_LABEL[accountType] || 'Brokerage'}`.trim();
}

function AddAccountStep({
  uploads,
  setUploads,
}: {
  uploads: OnboardingUpload[];
  setUploads: (u: OnboardingUpload[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Random selection of fun names; stable per session so suggestions don't reshuffle on every keystroke.
  const suggestNames = useMemo(() => pickFunNames(Date.now() % 9973, 5), []);

  async function ingestFiles(files: FileList | File[]) {
    setErrorMsg(null);
    const list = Array.from(files);
    const added: OnboardingUpload[] = [];
    for (const file of list) {
      try {
        const text = await file.text();
        const result: ImporterResult & { importerId: string | null } = importCsv(text);
        if (result.rejectionReason) {
          setErrorMsg(`${file.name}: ${result.rejectionReason}`);
          continue;
        }
        if (!result.importerId || result.transactions.length === 0) {
          setErrorMsg(
            `${file.name}: we couldn't figure this CSV out automatically. After onboarding, drop it in via Add Account for the column-mapping wizard.`,
          );
          continue;
        }
        const brokerage = result.inferences.brokerage;

        // Multi-account file (e.g. Fidelity multi-account export, JPM holdings
        // with multiple accounts): split into one upload per detected account
        // so the user names + types each individually.
        if (result.accountsDetected && result.accountsDetected.length > 0) {
          for (const acc of result.accountsDetected) {
            const type = acc.accountTypeHint === 'unknown' ? 'taxable' : acc.accountTypeHint;
            added.push({
              fileName: `${file.name} · ${acc.name}`,
              brokerage,
              accountType: type,
              accountName: `${brokerage} ${acc.name}`.trim(),
              transactions: acc.transactions,
            });
          }
          continue;
        }

        const accountType = result.inferences.accountType === 'unknown' ? 'taxable' : result.inferences.accountType;
        added.push({
          fileName: file.name,
          brokerage,
          accountType,
          accountName: defaultTechName(brokerage, accountType),
          transactions: result.transactions,
        });
      } catch (e: any) {
        setErrorMsg(`${file.name}: ${e?.message || 'could not read file'}`);
      }
    }
    if (added.length) setUploads([...uploads, ...added]);
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  function removeUpload(i: number) {
    setUploads(uploads.filter((_, idx) => idx !== i));
  }

  function setUploadName(i: number, name: string) {
    setUploads(uploads.map((u, idx) => (idx === i ? { ...u, accountName: name } : u)));
  }
  function setUploadType(i: number, type: string) {
    setUploads(
      uploads.map((u, idx) =>
        idx === i ? { ...u, accountType: type, accountName: defaultTechName(u.brokerage, type) } : u,
      ),
    );
  }

  return (
    <div className="ob-step">
      <div className="ob-step-head">
        <h2 className="ob-step-title">Bring in your accounts.</h2>
        <p className="ob-step-sub">
          Drop one or more CSVs from any supported brokerage. Read locally, never uploaded. You can keep adding
          more later from the sidebar.
        </p>
      </div>

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onClick={pickFile}
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length) void ingestFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          hidden
          onChange={e => {
            if (e.target.files?.length) void ingestFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="dropzone-glyph">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="M24 30V8" />
            <path d="M14 18l10-10 10 10" />
            <path d="M8 32v6a2 2 0 0 0 2 2h28a2 2 0 0 0 2-2v-6" />
          </svg>
        </div>
        <div className="dropzone-title">Drop CSV files here</div>
        <div className="dropzone-sub">Or click to browse. Pick one, or pick a bunch.</div>
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

      {errorMsg && (
        <div
          style={{
            marginTop: 14,
            padding: '10px 14px',
            background: 'var(--paper-3)',
            border: '1px solid var(--loss)',
            color: 'var(--loss)',
            borderRadius: 8,
            fontSize: 12.5,
          }}
        >
          {errorMsg}
        </div>
      )}

      {uploads.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="ob-step-eyebrow" style={{ marginBottom: 10 }}>
            Ready to import · {uploads.length} account{uploads.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {uploads.map((u, i) => (
              <UploadRow
                key={i}
                upload={u}
                suggestNames={suggestNames}
                onName={n => setUploadName(i, n)}
                onType={t => setUploadType(i, t)}
                onRemove={() => removeUpload(i)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadRow({
  upload,
  suggestNames,
  onName,
  onType,
  onRemove,
}: {
  upload: OnboardingUpload;
  suggestNames: string[];
  onName: (n: string) => void;
  onType: (t: string) => void;
  onRemove: () => void;
}) {
  const techName = defaultTechName(upload.brokerage, upload.accountType);
  const isBoring = upload.accountName === techName;
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <BrokerageLogo name={upload.brokerage} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 500 }}>
            {upload.brokerage} · {ACCOUNT_TYPE_LABEL[upload.accountType] || 'Brokerage'}
          </div>
          <div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', marginTop: 2 }}>
            {upload.fileName} · {upload.transactions.length} transactions
          </div>
        </div>
        <select
          value={upload.accountType}
          onChange={e => onType(e.target.value)}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid var(--line)',
            borderRadius: 6,
            background: 'var(--paper)',
            color: 'var(--ink-2)',
          }}
        >
          {Object.entries(ACCOUNT_TYPE_LABEL)
            .filter(([k]) => k !== 'unknown')
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
        <button
          className="btn btn-ghost"
          style={{ height: 28, padding: '0 10px', fontSize: 11.5, color: 'var(--ink-3)' }}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      <input
        type="text"
        value={upload.accountName}
        onChange={e => onName(e.target.value)}
        placeholder="Account name"
        className="name-input"
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {suggestNames.map(n => (
          <button
            key={n}
            onClick={() => onName(n)}
            className={`name-suggest ${upload.accountName === n ? 'active' : ''}`}
          >
            {n}
          </button>
        ))}
        <button
          onClick={() => onName(techName)}
          className={`name-suggest boring ${isBoring ? 'active' : ''}`}
        >
          {techName}
        </button>
      </div>
    </div>
  );
}

function DoneStep({
  profile,
  goal,
  uploads,
  onEnter,
}: {
  profile: Profile;
  goal: number;
  uploads: OnboardingUpload[];
  onEnter: () => void;
}) {
  const goalYear = 2026 + Math.max(1, profile.retireAge - (2026 - profile.birthYear));
  const goalLabel =
    goal >= 1_000_000 ? `$${(goal / 1_000_000).toFixed(goal >= 10_000_000 ? 0 : 1)}M` : `$${Math.round(goal / 1000)}K`;
  const accountBlurb =
    uploads.length === 0
      ? 'No accounts yet. Add one from the sidebar whenever you are ready.'
      : uploads.length === 1
      ? `${uploads[0].accountName} is in your portfolio.`
      : `${uploads.length} accounts are in your portfolio.`;
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
        Your numbers are your own again. {accountBlurb} Your goal is{' '}
        <strong>
          {goalLabel} by {goalYear}
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
