import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { projectLifecycle } from './ukLifecycle.js';
import { runMonteCarlo } from './ukMonteCarlo.js';
import { FanChart } from './FanChart.jsx';
import { fmtGBPLarge } from './formatters.js';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtGBP = (n) => `£${Math.round(Math.abs(n)).toLocaleString('en-GB')}`;
const fmtPct = (n) => `${n.toFixed(1)}%`;
const fmtAge = (n) => `${n} yrs`;
const fmtYrs = (n) => `${n} yr${n === 1 ? '' : 's'}`;

// ── Constants ─────────────────────────────────────────────────────────────────
const TABS = [
  'Personal',
  'Pension',
  'Savings',
  'Mortgage',
  'Debts',
  'Rates',
  'Retire',
  'Simulation',
];

const PLAN_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'plan1', label: 'Plan 1 (pre-2012)' },
  { value: 'plan2', label: 'Plan 2 (post-2012)' },
  { value: 'plan4', label: 'Plan 4 (Scotland)' },
  { value: 'postgrad', label: 'Postgraduate' },
];

// Default palette
const SERIES_DEFAULT = [
  { key: 'pension', name: 'Pension', color: '#4f8ef7', stackId: 'pos' },
  { key: 'isa', name: 'ISA', color: '#34d399', stackId: 'pos' },
  { key: 'gia', name: 'GIA', color: '#e8b84b', stackId: 'pos' },
  { key: 'mortgage', name: 'Mortgage', color: '#f43f5e', stackId: 'neg' },
  { key: 'unsecuredDebt', name: 'Unsecured Debt', color: '#fb923c', stackId: 'neg' },
  { key: 'studentLoan', name: 'Student Loan', color: '#a78bfa', stackId: 'neg' },
];

// Wong (2011) colourblind-safe palette — distinguishable for deuteranopia,
// protanopia, and tritanopia. Assets above axis; debts below.
const SERIES_HC = [
  { key: 'pension', name: 'Pension', color: '#0072B2', stackId: 'pos' }, // blue
  { key: 'isa', name: 'ISA', color: '#009E73', stackId: 'pos' }, // bluish green
  { key: 'gia', name: 'GIA', color: '#F0E442', stackId: 'pos' }, // yellow
  { key: 'mortgage', name: 'Mortgage', color: '#D55E00', stackId: 'neg' }, // vermillion
  { key: 'unsecuredDebt', name: 'Unsecured Debt', color: '#CC79A7', stackId: 'neg' }, // pink
  { key: 'studentLoan', name: 'Student Loan', color: '#56B4E9', stackId: 'neg' }, // sky blue
];

const CURRENT_YEAR = 2025;

const DEFAULTS = {
  currentAge: 28,
  retirementAge: 65,
  grossIncome: 45_000,
  annualLivingExpenses: 20_000,
  niContributionYears: 3,
  statePensionAge: 67,
  employeePensionPct: 5,
  employerPensionPct: 3,
  pensionBalance: 10_000,
  equityReturnPct: 7,
  bondReturnPct: 3,
  preRetirementEquityPct: 80,
  postRetirementEquityPct: 40,
  glideStartYears: 10,
  glideEndYears: 5,
  isaBalance: 5_000,
  giaBalance: 0,
  giaCostBasis: 0,
  mortgageBalance: 200_000,
  mortgageTermYears: 25,
  mortgageType: 'repayment',
  mortgageOverpayment: 0,
  unsecuredBalance: 5_000,
  unsecuredMonthly: 200,
  studentLoanPlan: '',
  studentLoanBalance: 0,
  studentLoanYears: 0,
  wageGrowthPct: 3,
  mortgageRateType: 'fixed', // 'fixed' or 'boe'
  mortgageRatePct: 4.5,
  mortgageSpreadPct: 1.5,
  unsecuredRateType: 'fixed', // 'fixed' or 'boe'
  unsecuredRatePct: 10.0,
  unsecuredSpreadPct: 15.0,
  boePct: 4.75,
  inflationPct: 2.5,
  fiscalDragPct: 0,
  // Retirement
  maxAge: 90,
  targetNetExpenses: 30_000,
  takePCLS: true,
  // Monte Carlo settings
  mcTrials: 200,
  mcVolatility: 1.0,
  mcBearFreq: 12,
  mcBearSeverity: 0.15,
  mcCrisisPersistence: 0.6,
};

// ── Small components ──────────────────────────────────────────────────────────

// ── Theme ─────────────────────────────────────────────────────────────────────
const THEMES = [
  { value: 'dark', label: 'Dark', title: 'Dark — deep navy' },
  { value: 'hc', label: 'HC', title: 'High contrast — colourblind friendly' },
  { value: 'light', label: 'Light', title: 'Light' },
  { value: 'device', label: 'Auto', title: 'Follow device preference' },
];

// Module-level — not a hook, so direct DOM mutation is fine here.
// Called synchronously before setColorMode() so CSS variables are updated
// before any child useEffect (e.g. the canvas draw) reads them.
function applyDataTheme(value) {
  document.documentElement.dataset.theme =
    value === 'device'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : value;
}

function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const h = (e) => setMobile(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return mobile;
}

const PencilIcon = () => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block' }}
  >
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

function HelpTip({ text }) {
  const [tipPos, setTipPos] = useState(null);
  const ref = useRef(null);

  function show() {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setTipPos({ top: r.bottom + 6, left: Math.max(8, r.left - 220) });
  }

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={() => setTipPos(null)}
        style={{
          cursor: 'help',
          color: 'var(--text-muted)',
          fontSize: 10,
          marginLeft: 5,
          opacity: 0.6,
          userSelect: 'none',
          lineHeight: 1,
        }}
      >
        ⓘ
      </span>
      {tipPos &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: tipPos.top,
              left: tipPos.left,
              width: 240,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-bright)',
              borderRadius: 7,
              padding: '9px 12px',
              fontSize: 11,
              color: 'var(--text-secondary)',
              lineHeight: 1.65,
              zIndex: 9999,
              whiteSpace: 'pre-line',
              boxShadow: 'var(--shadow-tooltip)',
              pointerEvents: 'none',
            }}
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}

function Slider({ label, value, min, max, step, format, onChange, color, allowInput, help }) {
  const [inputStr, setInputStr] = useState(null);
  const inputRef = useRef(null);

  const clamped = Math.max(min, Math.min(max, value));
  const pct = Math.max(0, Math.min(100, ((clamped - min) / (max - min)) * 100));
  const accent = color ?? 'var(--accent-gold)';

  function parseCommit(str) {
    const n = parseFloat(str.replace(/[^0-9.-]/g, ''));
    if (!isNaN(n)) onChange(n);
    setInputStr(null);
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            color: 'var(--text-secondary)',
            fontSize: 11,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {label}
          {help && <HelpTip text={help} />}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {allowInput && inputStr !== null ? (
            <input
              ref={inputRef}
              type="text"
              value={inputStr}
              onChange={(e) => setInputStr(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => parseCommit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  parseCommit(e.target.value);
                  e.target.blur();
                }
                if (e.key === 'Escape') {
                  setInputStr(null);
                  e.target.blur();
                }
              }}
              style={{
                width: 90,
                textAlign: 'right',
                padding: '2px 6px',
                background: 'var(--bg-input)',
                border: '1px solid var(--accent-gold)',
                borderRadius: 4,
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                outline: 'none',
              }}
            />
          ) : (
            <>
              <span
                onClick={
                  allowInput
                    ? () => {
                        setInputStr(format(value));
                        setTimeout(() => inputRef.current?.select(), 0);
                      }
                    : undefined
                }
                style={{
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: allowInput ? 'text' : 'default',
                }}
              >
                {format(value)}
              </span>
              {allowInput && (
                <span
                  onClick={() => {
                    setInputStr(format(value));
                    setTimeout(() => inputRef.current?.select(), 0);
                  }}
                  style={{
                    color: 'var(--text-muted)',
                    opacity: 0.45,
                    cursor: 'text',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <PencilIcon />
                </span>
              )}
            </>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(to right, ${accent} ${pct}%, var(--border-bright) ${pct}%)`,
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          {format(min)}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          {format(max)}
        </span>
      </div>
    </div>
  );
}

function Select({ label, value, options, onChange, help }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center' }}>
        <span
          style={{
            color: 'var(--text-secondary)',
            fontSize: 11,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        {help && <HelpTip text={help} />}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '7px 10px',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-bright)',
          borderRadius: 6,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          cursor: 'pointer',
          outline: 'none',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238b9ab5'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 10px center',
          paddingRight: 28,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, value, optA, optB, onChange, help }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center' }}>
        <span
          style={{
            color: 'var(--text-secondary)',
            fontSize: 11,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        {help && <HelpTip text={help} />}
      </div>
      <div
        style={{
          display: 'flex',
          borderRadius: 6,
          overflow: 'hidden',
          border: '1px solid var(--border-bright)',
        }}
      >
        {[optA, optB].map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1,
              padding: '7px 10px',
              background: value === opt.value ? 'var(--accent-gold)' : 'var(--bg-input)',
              color: value === opt.value ? 'var(--accent-gold-text)' : 'var(--text-secondary)',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              fontSize: 12,
              fontWeight: value === opt.value ? 600 : 400,
              transition: 'all 0.15s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function InfoBox({ children }) {
  return (
    <div
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '8px 12px',
        marginBottom: 20,
        fontSize: 11,
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.65,
      }}
    >
      {children}
    </div>
  );
}

function SecHead({ children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, marginTop: 8 }}>
      <div
        style={{
          width: 3,
          height: 12,
          background: 'var(--accent-gold)',
          borderRadius: 2,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          fontWeight: 600,
        }}
      >
        {children}
      </span>
    </div>
  );
}

function StatCard({ label, value, color, subtitle, help }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderTop: `2px solid ${color}`,
        borderRadius: 10,
        padding: '14px 18px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          color: 'var(--text-muted)',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          marginBottom: 5,
          fontFamily: 'var(--font-body)',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {label}
        {help && <HelpTip text={help} />}
      </div>
      <div
        style={{
          color,
          fontFamily: 'var(--font-mono)',
          fontSize: 18,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
      {subtitle && (
        <div
          style={{
            color: 'var(--text-muted)',
            fontSize: 11,
            marginTop: 3,
            fontFamily: 'var(--font-body)',
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}

// ── Tab content ───────────────────────────────────────────────────────────────
function TabContent({ tab, p, set }) {
  switch (tab) {
    case 'Personal':
      return (
        <>
          <Slider
            label="Current Age"
            value={p.currentAge}
            min={18}
            max={60}
            step={1}
            format={fmtAge}
            onChange={(v) => {
              set('currentAge')(v);
              if (p.retirementAge <= v) set('retirementAge')(v + 1);
            }}
            allowInput
            help="Your current age in whole years. The projection runs from this age to your model horizon."
          />
          <Slider
            label="Retirement Age"
            value={p.retirementAge}
            min={p.currentAge + 1}
            max={80}
            step={1}
            format={fmtAge}
            onChange={(v) => set('retirementAge')(Math.max(v, p.currentAge + 1))}
            allowInput
            help="The age at which you plan to stop working. From this point the model switches to drawdown mode, spending from your pots to meet your target expenses."
          />
          <Slider
            label="Gross Annual Salary"
            value={p.grossIncome}
            min={15_000}
            max={300_000}
            step={1_000}
            format={fmtGBP}
            onChange={set('grossIncome')}
            allowInput
            help="Your pre-tax annual salary. Used to calculate pension contributions (employee and employer). Wage growth applies annually."
          />
          <Slider
            label="Pre-Retirement Living Expenses"
            value={p.annualLivingExpenses}
            min={0}
            max={80_000}
            step={500}
            format={fmtGBP}
            onChange={set('annualLivingExpenses')}
            allowInput
            help="Your annual non-debt living costs during the working years, in today's money — food, utilities, transport, insurance, leisure, etc. Do not include mortgage or debt repayments; those are entered separately. This amount is inflated each year to keep real purchasing power constant. Annual savings are derived automatically as: net take-home − debt payments − living expenses. Retirement spending is a separate parameter in the Retire tab."
          />
          <Slider
            label="NI Qualifying Years"
            value={p.niContributionYears}
            min={0}
            max={35}
            step={1}
            format={fmtYrs}
            onChange={set('niContributionYears')}
            help="National Insurance qualifying years already accrued before the projection starts. Each working year above the Lower Earnings Limit (£6,396) adds one year. Full state pension requires 35 qualifying years; at least 10 are needed for any entitlement."
          />
          <Slider
            label="State Pension Age"
            value={p.statePensionAge}
            min={60}
            max={70}
            step={1}
            format={fmtAge}
            onChange={set('statePensionAge')}
            help="Age at which your state pension begins. Currently 66 for most people, rising to 67 by 2028. If you retire earlier, state pension income starts later in the drawdown phase."
          />
        </>
      );

    case 'Pension':
      return (
        <>
          <Slider
            label="Employee Contribution"
            value={p.employeePensionPct}
            min={0}
            max={50}
            step={0.5}
            format={fmtPct}
            onChange={set('employeePensionPct')}
            color="#4f8ef7"
            allowInput
            help="Your pension contribution as a percentage of gross salary, paid via salary sacrifice. This reduces your taxable income, saving income tax and National Insurance."
          />
          <Slider
            label="Employer Contribution"
            value={p.employerPensionPct}
            min={0}
            max={20}
            step={0.5}
            format={fmtPct}
            onChange={set('employerPensionPct')}
            color="#4f8ef7"
            allowInput
            help="Your employer's pension contribution as a percentage of your gross salary. This is paid on top of your salary and doesn't cost you anything directly — sometimes called 'free money'."
          />
          <Slider
            label="Starting Balance"
            value={p.pensionBalance}
            min={0}
            max={500_000}
            step={1_000}
            format={fmtGBP}
            onChange={set('pensionBalance')}
            color="#4f8ef7"
            allowInput
            help="Your current pension pot value. This is your defined contribution (DC) pension — the pot you own, not a final salary (DB) scheme. Grows with investment returns each year."
          />
          <InfoBox>
            Contributions are via salary sacrifice, reducing both income tax and employee NI. Annual
            allowance: £60,000. PCLS (tax-free lump sum): up to 25%.
          </InfoBox>
        </>
      );

    case 'Savings':
      return (
        <>
          <SecHead>ISA</SecHead>
          <Slider
            label="Starting ISA Balance"
            value={p.isaBalance}
            min={0}
            max={250_000}
            step={1_000}
            format={fmtGBP}
            onChange={set('isaBalance')}
            color="#34d399"
            allowInput
            help="Your current Individual Savings Account (ISA) balance. ISA growth is completely tax-free and withdrawals are not taxed, making it the most efficient savings vehicle after pension."
          />
          <SecHead>GIA</SecHead>
          <Slider
            label="Starting GIA Balance"
            value={p.giaBalance}
            min={0}
            max={250_000}
            step={1_000}
            format={fmtGBP}
            onChange={(v) => {
              set('giaBalance')(v);
              if (p.giaCostBasis > v) set('giaCostBasis')(v);
            }}
            color="#e8b84b"
            allowInput
            help="Your current General Investment Account balance. Unlike an ISA, growth here is subject to Capital Gains Tax (CGT) when you sell. Sometimes called a 'trading account' or 'dealing account'."
          />
          <Slider
            label="GIA Cost Basis"
            value={Math.min(p.giaCostBasis, p.giaBalance)}
            min={0}
            max={Math.max(p.giaBalance, 1)}
            step={100}
            format={fmtGBP}
            onChange={set('giaCostBasis')}
            color="#e8b84b"
            allowInput
            help="The total amount you originally invested in your GIA — your 'book cost'. Used to calculate capital gains. Example: if you invested £10,000 and it grew to £15,000, your cost basis is £10,000 and the gain is £5,000."
          />
          <InfoBox>
            ISA fills first (£20,000/yr limit) — excess goes to GIA. CGT annual exempt amount:
            £3,000. Basic rate 18%, higher rate 24%.
          </InfoBox>
        </>
      );

    case 'Mortgage': {
      const effectiveMortgageRate =
        p.mortgageRateType === 'boe' ? p.boePct + p.mortgageSpreadPct : p.mortgageRatePct;
      return (
        <>
          <Slider
            label="Outstanding Balance"
            value={p.mortgageBalance}
            min={0}
            max={1_000_000}
            step={5_000}
            format={fmtGBP}
            onChange={set('mortgageBalance')}
            color="#f43f5e"
            allowInput
            help="Your remaining mortgage balance. Set to £0 to exclude the mortgage from the projection. Interest and capital repayment are modelled monthly using the interest rate below."
          />
          <Slider
            label="Remaining Term"
            value={p.mortgageTermYears}
            min={1}
            max={40}
            step={1}
            format={fmtYrs}
            onChange={set('mortgageTermYears')}
            color="#f43f5e"
            help="Years remaining on your mortgage. The monthly payment is calculated from this term and the interest rate below. Overpayments reduce the balance faster but don't change the required payment."
          />
          <Toggle
            label="Mortgage Type"
            value={p.mortgageType}
            optA={{ value: 'repayment', label: 'Repayment' }}
            optB={{ value: 'interest-only', label: 'Interest Only' }}
            onChange={set('mortgageType')}
            help="Repayment: capital reduces each month until the mortgage is fully paid off at the end of the term. Interest-only: you pay only interest each month and the full balance remains at term end."
          />
          <Slider
            label="Monthly Overpayment"
            value={p.mortgageOverpayment}
            min={0}
            max={2_000}
            step={25}
            format={fmtGBP}
            onChange={set('mortgageOverpayment')}
            color="#f43f5e"
            allowInput
            help="Extra amount paid toward your mortgage each month, on top of the required payment. Overpayments reduce the outstanding balance faster, saving interest over the life of the mortgage."
          />
          <SecHead>Interest Rate</SecHead>
          <Toggle
            label="Rate type"
            value={p.mortgageRateType}
            optA={{ value: 'fixed', label: 'Fixed rate' }}
            optB={{ value: 'boe', label: 'BoE + spread' }}
            onChange={set('mortgageRateType')}
            help="Fixed: a constant rate (e.g. a fixed-term deal). BoE + spread: a tracker mortgage whose rate moves with the Bank of England base rate plus a fixed margin (e.g. BoE + 1.5%)."
          />
          {p.mortgageRateType === 'fixed' ? (
            <Slider
              label="Mortgage Interest Rate"
              value={p.mortgageRatePct}
              min={0}
              max={15}
              step={0.1}
              format={fmtPct}
              onChange={set('mortgageRatePct')}
              color="#f43f5e"
              allowInput
              help="Fixed annual interest rate on your mortgage."
            />
          ) : (
            <>
              <Slider
                label="BoE Base Rate"
                value={p.boePct}
                min={-5}
                max={10}
                step={0.1}
                format={fmtPct}
                onChange={set('boePct')}
                allowInput
                help="Bank of England base rate. Also used for Plan 1 student loan interest (capped at RPI or BoE+1%)."
              />
              <Slider
                label="Mortgage Spread above BoE"
                value={p.mortgageSpreadPct}
                min={0}
                max={10}
                step={0.1}
                format={fmtPct}
                onChange={set('mortgageSpreadPct')}
                color="#f43f5e"
                allowInput
                help={`Fixed margin added to the BoE base rate to give your tracker mortgage rate. Effective rate: ${fmtPct(p.boePct)} + ${fmtPct(p.mortgageSpreadPct)} = ${fmtPct(effectiveMortgageRate)}.`}
              />
            </>
          )}
          {p.mortgageBalance === 0 && (
            <InfoBox>Set a balance above £0 to include a mortgage in the projection.</InfoBox>
          )}
        </>
      );
    }

    case 'Debts': {
      const effectiveUnsecuredRate =
        p.unsecuredRateType === 'boe' ? p.boePct + p.unsecuredSpreadPct : p.unsecuredRatePct;
      return (
        <>
          <SecHead>Unsecured Debt</SecHead>
          <Slider
            label="Outstanding Balance"
            value={p.unsecuredBalance}
            min={0}
            max={100_000}
            step={500}
            format={fmtGBP}
            onChange={set('unsecuredBalance')}
            color="#fb923c"
            allowInput
            help="Total balance of unsecured debts such as credit cards, personal loans, or overdrafts. Interest accrues monthly at the rate set below."
          />
          <Slider
            label="Monthly Payment"
            value={p.unsecuredMonthly}
            min={0}
            max={3_000}
            step={25}
            format={fmtGBP}
            onChange={set('unsecuredMonthly')}
            color="#fb923c"
            allowInput
            help="Your monthly payment toward unsecured debts. Must exceed the monthly interest charge for the balance to reduce over time. When the debt is repaid, payments stop automatically."
          />
          <Toggle
            label="Rate type"
            value={p.unsecuredRateType}
            optA={{ value: 'fixed', label: 'Fixed rate' }}
            optB={{ value: 'boe', label: 'BoE + spread' }}
            onChange={set('unsecuredRateType')}
            help="Fixed: a constant rate (e.g. a personal loan). BoE + spread: a variable-rate product that tracks the Bank of England base rate (e.g. a tracker credit card or overdraft)."
          />
          {p.unsecuredRateType === 'fixed' ? (
            <Slider
              label="Interest Rate"
              value={p.unsecuredRatePct}
              min={0}
              max={40}
              step={0.1}
              format={fmtPct}
              onChange={set('unsecuredRatePct')}
              color="#fb923c"
              allowInput
              help="Fixed annual interest rate on your unsecured debts (credit cards, personal loans, overdrafts)."
            />
          ) : (
            <>
              <Slider
                label="BoE Base Rate"
                value={p.boePct}
                min={-5}
                max={10}
                step={0.1}
                format={fmtPct}
                onChange={set('boePct')}
                allowInput
                help="Bank of England base rate. Also used for Plan 1 student loan interest (capped at RPI or BoE+1%), and for any BoE-tracker mortgage."
              />
              <Slider
                label="Spread above BoE"
                value={p.unsecuredSpreadPct}
                min={0}
                max={35}
                step={0.1}
                format={fmtPct}
                onChange={set('unsecuredSpreadPct')}
                color="#fb923c"
                allowInput
                help={`Fixed margin added to the BoE base rate for your unsecured debts. Effective rate: ${fmtPct(p.boePct)} + ${fmtPct(p.unsecuredSpreadPct)} = ${fmtPct(effectiveUnsecuredRate)}.`}
              />
            </>
          )}
          <SecHead>Student Loan</SecHead>
          <Select
            label="Repayment Plan"
            value={p.studentLoanPlan}
            options={PLAN_OPTIONS}
            onChange={set('studentLoanPlan')}
            help="Your student loan repayment plan, determined by when and where you studied. Repayments are income-contingent (a percentage of earnings above a threshold) and the balance is written off after the plan term regardless of how much remains."
          />
          {p.studentLoanPlan && (
            <>
              <Slider
                label="Outstanding Balance"
                value={p.studentLoanBalance}
                min={0}
                max={150_000}
                step={1_000}
                format={fmtGBP}
                onChange={set('studentLoanBalance')}
                color="#a78bfa"
                allowInput
                help="Your remaining student loan balance. Interest accrues annually at a rate linked to inflation and (for Plan 1) the BoE base rate. The balance is written off when the plan term expires."
              />
              <Slider
                label="Years Already Repaying"
                value={p.studentLoanYears}
                min={0}
                max={30}
                step={1}
                format={fmtYrs}
                onChange={set('studentLoanYears')}
                color="#a78bfa"
                help="How many years you have already been making student loan repayments. Used to calculate how many years remain until write-off. Plan 1: 25 years. Plan 2/4: 30 years. Postgrad: 30 years."
              />
              <InfoBox>
                Repayments are income-contingent. Interest is linked to inflation + BoE rate
                (plan-dependent). Balance is written off after the plan term.
              </InfoBox>
            </>
          )}
        </>
      );
    }

    case 'Rates': {
      const preEq = p.preRetirementEquityPct / 100;
      const postEq = p.postRetirementEquityPct / 100;
      const eq = p.equityReturnPct / 100;
      const bd = p.bondReturnPct / 100;
      const blendedRateText = `Effective blended rate: ${((preEq * eq + (1 - preEq) * bd) * 100).toFixed(2)}% pre-retirement → ${((postEq * eq + (1 - postEq) * bd) * 100).toFixed(2)}% post-retirement`;
      return (
        <>
          <Slider
            label="Wage Growth Rate"
            value={p.wageGrowthPct}
            min={-5}
            max={10}
            step={0.1}
            format={fmtPct}
            onChange={set('wageGrowthPct')}
            allowInput
            help="Expected annual growth rate of your gross salary. Affects pension contributions, which are a percentage of salary. Can be negative to model pay cuts or career breaks."
          />
          <Slider
            label="Equity return"
            value={p.equityReturnPct}
            min={0}
            max={15}
            step={0.1}
            format={fmtPct}
            onChange={set('equityReturnPct')}
            allowInput
            help="Expected long-run annualised return on the equity portion of your portfolio (e.g. a global index fund), expressed as a geometric mean (CAGR) across a full economic cycle — the same figure you would find in historical data covering booms and recessions. Long-run UK/global equity average is roughly 7–8% nominal. Combined with your equity allocation below to give an effective blended rate used in both the deterministic and Monte Carlo projections."
          />
          <Slider
            label="Bond / cash return"
            value={p.bondReturnPct}
            min={0}
            max={10}
            step={0.1}
            format={fmtPct}
            onChange={set('bondReturnPct')}
            allowInput
            help="Expected long-run annualised return on the bond or cash portion of your portfolio (e.g. gilts, money-market funds), expressed as a geometric mean (CAGR) across a full economic cycle. UK gilt yields have historically been 2–4% nominal. Combined with your equity allocation below to give an effective blended rate used in both the deterministic and Monte Carlo projections."
          />
          <Slider
            label="Pre-retirement equity allocation"
            value={p.preRetirementEquityPct}
            min={0}
            max={100}
            step={1}
            format={(v) => `${v}%`}
            onChange={set('preRetirementEquityPct')}
            allowInput
            help="Percentage of your portfolio in equities during the accumulation phase (before the glide path begins). The remainder is in bonds/cash. A typical growth portfolio holds 70–100% equities."
          />
          <Slider
            label="Post-retirement equity allocation"
            value={p.postRetirementEquityPct}
            min={0}
            max={100}
            step={1}
            format={(v) => `${v}%`}
            onChange={set('postRetirementEquityPct')}
            allowInput
            help="Percentage of your portfolio in equities once the glide path is fully complete. The remainder is in bonds/cash. A typical cautious retirement portfolio holds 30–50% equities to reduce sequence-of-returns risk."
          />
          <InfoBox>{blendedRateText}</InfoBox>
          <Slider
            label="Glide path: start (years before retirement)"
            value={p.glideStartYears}
            min={0}
            max={30}
            step={1}
            format={(v) => `${v} yr${v !== 1 ? 's' : ''}`}
            onChange={set('glideStartYears')}
            allowInput
            help="How many years before your retirement date to begin shifting from the pre-retirement to the post-retirement allocation. E.g. 10 means de-risking starts at retirementAge − 10. Set to 0 to start the transition only at retirement. If this puts the start before your current age, the glide path is already in progress and rates are interpolated accordingly."
          />
          <Slider
            label="Glide path: end (years after retirement)"
            value={p.glideEndYears}
            min={0}
            max={15}
            step={1}
            format={(v) => `${v} yr${v !== 1 ? 's' : ''}`}
            onChange={set('glideEndYears')}
            allowInput
            help="How many years after your retirement date the glide path finishes, reaching the full post-retirement allocation. E.g. 5 means fully de-risked by retirementAge + 5. Set to 0 for an instant switch at retirement."
          />
          <Slider
            label="Inflation Rate"
            value={p.inflationPct}
            min={-5}
            max={10}
            step={0.1}
            format={fmtPct}
            onChange={set('inflationPct')}
            allowInput
            help="Expected annual price inflation (CPI or RPI). Affects retirement expenses (which grow with inflation), student loan interest, and the real value of your annual savings. Can be negative for deflation scenarios."
          />
          <Slider
            label="BoE Base Rate"
            value={p.boePct}
            min={-5}
            max={10}
            step={0.1}
            format={fmtPct}
            onChange={set('boePct')}
            allowInput
            help="Bank of England base rate. Used for Plan 1 student loan interest (capped at RPI or BoE+1%), and as the base for any BoE-tracker mortgage or unsecured debt rates set in the Mortgage and Debts tabs. Student loan interest is always floored at 0%."
          />
          <Slider
            label="Fiscal Drag"
            value={p.fiscalDragPct}
            min={-5}
            max={5}
            step={0.1}
            format={fmtPct}
            onChange={set('fiscalDragPct')}
            allowInput
            help={`How far income tax and NI thresholds drift from inflation each year. Band growth = inflation rate − fiscal drag.\n\n0%: bands rise with inflation — no change in real tax burden.\nPositive (e.g. +2%): bands grow slower than inflation — bracket creep pushes more income into higher bands over time. Setting this equal to the inflation rate models fully frozen bands.\nNegative (e.g. −1%): bands grow faster than inflation — real tax burden falls, as happened when the UK personal allowance was raised sharply in the 2010s.`}
          />
          <InfoBox>
            Debt rates are set per-instrument in the Mortgage and Debts tabs. BoE rate also applies
            to Plan 1/4 student loan interest. All figures are nominal (not inflation-adjusted).
          </InfoBox>
        </>
      );
    }

    case 'Simulation':
      return (
        <>
          <InfoBox>
            These settings control the Monte Carlo simulation. Switch to the Monte Carlo tab in the
            chart to run it.
          </InfoBox>
          <Slider
            label="Trials"
            value={p.mcTrials}
            min={50}
            max={1000}
            step={50}
            format={(v) => `${v}`}
            onChange={set('mcTrials')}
            allowInput
            help="Number of independent lifecycle projections to run. More trials give smoother percentile bands but take longer to compute. 200–500 is a good balance for interactive use."
          />
          <Slider
            label="Volatility"
            value={p.mcVolatility}
            min={0.1}
            max={3}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={set('mcVolatility')}
            allowInput
            help={
              'Scales the standard deviation of the random rate shocks. At 1× (default): investment returns ±8 pp per year (1 sd), macro rates ±0.8 pp.\n\n' +
              'Each year draws fresh rates — this models both sequence-of-returns risk and year-to-year market volatility.\n\n' +
              'At 1×: p90 trial ≈ base + 8 pp in a given year, p10 ≈ base − 8 pp. Increase for a wider fan, decrease for a narrower one.'
            }
          />
          <Slider
            label="Bear market frequency"
            value={p.mcBearFreq}
            min={4}
            max={30}
            step={1}
            format={(v) => `every ${v} yrs`}
            onChange={set('mcBearFreq')}
            allowInput
            help={
              'Average number of years between bear markets (market downturns lasting 1–3 years).\n\n' +
              'At 12 years (default): roughly matches post-war UK/US history. At 4–6 years: more crisis-prone, similar to the 1970s or emerging markets. At 20–30 years: unusually calm conditions.\n\n' +
              'Changing this setting does not alter the long-run expected return — the simulation compensates so the median trial still tracks your chosen return rates. What it does affect is the shape of the fan: more frequent bear markets means more sequence-of-returns risk and a wider spread between p10 and p90.'
            }
          />
          <Slider
            label="Bear market severity"
            value={p.mcBearSeverity}
            min={0.02}
            max={0.4}
            step={0.01}
            format={(v) => `−${(v * 100).toFixed(0)} pp`}
            onChange={set('mcBearSeverity')}
            allowInput
            help={
              'How much a bear market cuts annual investment returns during the downturn.\n\n' +
              'At −15 pp (default): a moderate recession where returns drop roughly 15 pp below the long-run average for 1–2 years. At −30 pp: severe crash conditions (2008-style). At −5 pp: a mild correction only.\n\n' +
              'Like frequency, changing severity does not shift the long-run expected return — the simulation compensates so the median remains anchored to your return rate sliders. Higher severity widens the fan and increases the chance of a bad sequence of returns early in retirement.'
            }
          />
          {/* Crisis persistence toggle */}
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-body)',
                  color: 'var(--text-secondary)',
                }}
              >
                Crisis persistence
              </span>
              <div
                style={{
                  display: 'flex',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  overflow: 'hidden',
                }}
              >
                {[
                  { label: 'Short', value: 0.3 },
                  { label: 'Medium', value: 0.6 },
                  { label: 'Long', value: 0.8 },
                ].map(({ label, value }) => (
                  <button
                    key={value}
                    onClick={() => set('mcCrisisPersistence')(value)}
                    style={{
                      padding: '3px 9px',
                      background:
                        p.mcCrisisPersistence === value ? 'var(--accent-gold)' : 'transparent',
                      border: 'none',
                      color:
                        p.mcCrisisPersistence === value
                          ? 'var(--accent-gold-text)'
                          : 'var(--text-secondary)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: '0.05em',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-body)',
                lineHeight: 1.5,
              }}
            >
              How long elevated volatility lingers after a bear market ends. Short: volatility
              normalises within 1–2 years. Long: unsettled conditions persist for 5+ years, as in
              the aftermath of 2008.
            </p>
          </div>
        </>
      );

    case 'Retire':
      return (
        <>
          <Slider
            label="Target Net Annual Expenses"
            value={p.targetNetExpenses}
            min={5_000}
            max={150_000}
            step={1_000}
            format={fmtGBP}
            onChange={set('targetNetExpenses')}
            allowInput
            help="Your desired annual living costs in retirement, in today's money (food, utilities, leisure, etc.) — exclude mortgage and debt payments, which are modelled separately on top of this figure. The model inflates this each year to maintain the same purchasing power. State pension income offsets it before drawing from your pots."
          />
          <Slider
            label="Model to Age"
            value={p.maxAge}
            min={Math.max(p.retirementAge + 1, 70)}
            max={100}
            step={1}
            format={fmtAge}
            onChange={(v) => set('maxAge')(Math.max(v, p.retirementAge + 1))}
            allowInput
            help="The age to which the retirement drawdown is projected. Use this as your planning horizon. UK average life expectancy is ~82, but financial planning often uses 90–100 to guard against longevity risk."
          />
          <SecHead>Pension Commencement Lump Sum</SecHead>
          <Toggle
            label="Take PCLS at Retirement"
            value={p.takePCLS ? 'yes' : 'no'}
            optA={{ value: 'yes', label: 'Yes' }}
            optB={{ value: 'no', label: 'No' }}
            onChange={(v) => set('takePCLS')(v === 'yes')}
            help={
              p.takePCLS
                ? 'Lump sum taken upfront: 25% of the pension (capped at £268,275) is paid out tax-free at retirement; the rest is drawn down as fully taxable income.'
                : 'Phased withdrawals (UFPLS): the pension stays uncrystallised; each withdrawal is 25% tax-free + 75% taxable income until the £268,275 lifetime allowance is exhausted.'
            }
          />
          <InfoBox>
            {
              'PCLS (Pension Commencement Lump Sum) is a one-off tax-free payment taken when you crystallise your pension at retirement, capped at 25% of the pot or £268,275 lifetime — whichever is lower.\n\n'
            }
            {
              'Yes — the full 25% lump sum is paid out immediately. The cash goes into your ISA first (up to £20k/year), with any surplus added to your GIA at cost. The remaining 75% of the pension is then drawn down as fully taxable income each year.\n\n'
            }
            {
              'No — the pension stays uncrystallised and is accessed via UFPLS (Uncrystallised Fund Pension Lump Sum Payments). Each individual withdrawal is split 25% tax-free + 75% taxable income, with the cumulative tax-free portion tracked against the same £268,275 lifetime Lump Sum Allowance. Once that allowance is exhausted, 100% of each withdrawal becomes taxable.\n\n'
            }
            {
              'Drawdown order each year: tax-free pension (within personal allowance) → CGT-exempt GIA harvest → ISA → taxable GIA → taxable pension.'
            }
          </InfoBox>
        </>
      );

    default:
      return null;
  }
}

// ── Year Detail Panel ─────────────────────────────────────────────────────────

function DetailLine({ label, value, color, indent = 0, bold = false, dim = false }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 8,
        paddingLeft: indent * 10,
        marginBottom: 3,
        opacity: dim ? 0.5 : 1,
      }}
    >
      <span
        style={{
          color: dim ? 'var(--text-muted)' : 'var(--text-secondary)',
          fontSize: 11,
          fontFamily: 'var(--font-body)',
          fontWeight: bold ? 600 : 400,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: color ?? (bold ? 'var(--text-primary)' : 'var(--text-secondary)'),
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: bold ? 600 : 400,
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function DetailSection({ title, accent, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ width: 2, height: 10, background: accent, borderRadius: 1, flexShrink: 0 }} />
        <span
          style={{
            fontSize: 9,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            fontWeight: 600,
          }}
        >
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid var(--border)', margin: '5px 0 6px' }} />;
}

function YearDetailPanel({ row, mobile = false }) {
  if (!row) {
    return (
      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 20px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 11,
          fontFamily: 'var(--font-body)',
          opacity: 0.6,
        }}
      >
        Hover over the chart to see year-by-year details
      </div>
    );
  }

  const isRetirement = row.phase === 'retirement';

  if (!isRetirement) {
    const hasMortgage = row.mortgage?.payment > 0;
    const hasUnsecured = row.unsecuredDebtPayments > 0;
    const hasSL = row.studentLoanRepayment > 0;
    const rate = fmtPct((row.investmentRate ?? 0) * 100);

    return (
      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: mobile ? '14px' : '14px 20px',
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'repeat(3, 1fr)',
          gap: mobile ? '16px 0' : '0 24px',
        }}
      >
        {/* Col 1 — Pay & Tax */}
        <DetailSection title="Pay & Tax" accent="#4f8ef7">
          <DetailLine label="Gross salary" value={fmtGBP(row.grossIncome)} />
          <DetailLine
            label="− Pension sacrifice"
            value={fmtGBP(row.employeeContribution)}
            color="#4f8ef7"
            indent={1}
          />
          <DetailLine label="Adjusted gross" value={fmtGBP(row.adjustedGrossIncome)} dim />
          <DetailLine
            label="− Income tax"
            value={fmtGBP(row.incomeTax)}
            color="#f43f5e"
            indent={1}
          />
          <DetailLine
            label="− Employee NI"
            value={fmtGBP(row.employeeNI)}
            color="#fb923c"
            indent={1}
          />
          {hasSL && (
            <DetailLine
              label="− Student loan"
              value={fmtGBP(row.studentLoanRepayment)}
              color="#a78bfa"
              indent={1}
            />
          )}
          <Divider />
          <DetailLine label="Net take-home" value={fmtGBP(row.netTakeHome)} bold />
        </DetailSection>

        {/* Col 2 — From Net Take-Home */}
        <DetailSection title="From Net Take-Home" accent="#34d399">
          {hasMortgage && (
            <DetailLine
              label="− Mortgage payment"
              value={fmtGBP(row.mortgage.payment)}
              color="#f43f5e"
            />
          )}
          {hasMortgage && (
            <DetailLine
              label="interest"
              value={fmtGBP(row.mortgage.interestCharged)}
              dim
              indent={1}
            />
          )}
          {hasMortgage && (
            <DetailLine label="capital" value={fmtGBP(row.mortgage.capitalRepaid)} dim indent={1} />
          )}
          {hasUnsecured && (
            <DetailLine
              label="− Unsecured debts"
              value={fmtGBP(row.unsecuredDebtPayments)}
              color="#fb923c"
            />
          )}
          {row.livingExpenses != null && row.livingExpenses > 0 && (
            <DetailLine
              label="− Living expenses"
              value={fmtGBP(row.livingExpenses)}
              color="var(--text-muted)"
            />
          )}
          <DetailLine label="→ ISA" value={fmtGBP(row.isaContribution)} color="#34d399" />
          <DetailLine label="→ GIA" value={fmtGBP(row.giaContribution)} color="#e8b84b" />
          <Divider />
          <DetailLine
            label="+ Employer pension (free)"
            value={fmtGBP(row.employerContribution)}
            color="#4f8ef7"
          />
        </DetailSection>

        {/* Col 3 — Pot Balances */}
        <DetailSection title={`Pot Balances · ${rate} growth`} accent="var(--accent-gold)">
          <DetailLine
            label="Pension — opening"
            value={fmtGBP(row.pension.openingBalance)}
            color="#4f8ef7"
          />
          <DetailLine
            label="+ your contribution"
            value={fmtGBP(row.pension.employeeContribution)}
            color="#4f8ef7"
            indent={1}
            dim
          />
          <DetailLine
            label="+ employer contribution"
            value={fmtGBP(row.pension.employerContribution)}
            color="#4f8ef7"
            indent={1}
            dim
          />
          <DetailLine
            label="+ growth"
            value={fmtGBP(row.pension.growthAmount)}
            color="#4f8ef7"
            indent={1}
            dim
          />
          <DetailLine
            label="Pension — closing"
            value={fmtGBP(row.pension.closingBalance)}
            color="#4f8ef7"
            bold
          />
          <DetailLine
            label="ISA — opening"
            value={fmtGBP(row.isa.openingBalance)}
            color="#34d399"
          />
          <DetailLine
            label="+ contributed"
            value={fmtGBP(row.isa.contribution)}
            color="#34d399"
            indent={1}
            dim
          />
          {(row.isa.bedIsaContrib ?? 0) > 0 && (
            <DetailLine
              label="+ bed & ISA"
              value={fmtGBP(row.isa.bedIsaContrib)}
              color="#34d399"
              indent={1}
              dim
            />
          )}
          <DetailLine
            label="+ growth"
            value={fmtGBP(row.isa.growthAmount)}
            color="#34d399"
            indent={1}
            dim
          />
          <DetailLine
            label="ISA — closing"
            value={fmtGBP(row.isa.closingBalance)}
            color="#34d399"
            bold
          />
          <DetailLine
            label="GIA — opening"
            value={fmtGBP(row.gia.openingBalance)}
            color="#e8b84b"
          />
          <DetailLine
            label="+ contributed"
            value={fmtGBP(row.gia.contribution)}
            color="#e8b84b"
            indent={1}
            dim
          />
          {(row.gia.bedIsaGross ?? 0) > 0 && (
            <DetailLine
              label="− bed & ISA (sold)"
              value={fmtGBP(row.gia.bedIsaGross)}
              color="#e8b84b"
              indent={1}
              dim
            />
          )}
          {(row.gia.bedIsaCGT ?? 0) > 0 && (
            <DetailLine
              label="CGT on bed & ISA"
              value={fmtGBP(row.gia.bedIsaCGT)}
              color="#f43f5e"
              indent={2}
              dim
            />
          )}
          <DetailLine
            label="+ growth"
            value={fmtGBP(row.gia.growthAmount)}
            color="#e8b84b"
            indent={1}
            dim
          />
          <DetailLine
            label="GIA — closing"
            value={fmtGBP(row.gia.closingBalance)}
            color="#e8b84b"
            bold
          />
        </DetailSection>
      </div>
    );
  }

  // ── Retirement ────────────────────────────────────────────────────────────
  const hasPCLS = (row.pclsLumpSum ?? 0) > 0;
  const hasSP = row.statePensionGross > 0;
  const hasMortgage = (row.mortgage?.payment ?? 0) > 0;
  const hasUnsecured = (row.unsecuredDebtPayments ?? 0) > 0;
  const hasTFPension = (row.taxFreePensionDrawdown ?? 0) > 0;
  const hasTaxPension = (row.taxablePensionDrawdown ?? 0) > 0;
  const hasShortfall = row.shortfall > 0;

  const mortgagePayment = row.mortgage?.payment ?? 0;
  const unsecuredPayments = row.unsecuredDebtPayments ?? 0;
  const totalObligations = row.targetNetExpenses + mortgagePayment + unsecuredPayments;
  const spNet = row.statePensionNet ?? 0;
  const spCoversLiving = Math.min(spNet, row.targetNetExpenses);
  const fromPotsNeeded = Math.max(0, totalObligations - spCoversLiving);
  const grossFromPots =
    (row.taxFreePensionDrawdown ?? 0) +
    (row.taxablePensionDrawdown ?? 0) +
    (row.isaWithdrawal ?? 0) +
    (row.giaWithdrawal ?? 0);
  const netFromPots = grossFromPots - (row.incomeTax ?? 0) - (row.giaCGT ?? 0);
  const rate = fmtPct((row.investmentRate ?? 0) * 100);

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: mobile ? '14px' : '14px 20px',
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr' : 'repeat(3, 1fr)',
        gap: mobile ? '16px 0' : '0 24px',
      }}
    >
      {/* Col 1 — Obligations */}
      <DetailSection title="Obligations" accent="#f43f5e">
        {hasPCLS && (
          <DetailLine
            label="PCLS lump sum (one-off)"
            value={fmtGBP(row.pclsLumpSum)}
            color="var(--accent-gold)"
          />
        )}
        <DetailLine label="Living expenses" value={fmtGBP(row.targetNetExpenses)} />
        {hasMortgage && (
          <DetailLine label="+ Mortgage payment" value={fmtGBP(mortgagePayment)} color="#f43f5e" />
        )}
        {hasMortgage && (
          <DetailLine
            label="interest"
            value={fmtGBP(row.mortgage.interestCharged)}
            dim
            indent={1}
          />
        )}
        {hasMortgage && (
          <DetailLine label="capital" value={fmtGBP(row.mortgage.capitalRepaid)} dim indent={1} />
        )}
        {hasUnsecured && (
          <DetailLine label="+ Unsecured debts" value={fmtGBP(unsecuredPayments)} color="#fb923c" />
        )}
        <Divider />
        <DetailLine label="Total obligations" value={fmtGBP(totalObligations)} bold />
        {hasSP && (
          <DetailLine
            label="− State pension (net)"
            value={fmtGBP(spCoversLiving)}
            color="#a78bfa"
            indent={1}
          />
        )}
        <Divider />
        <DetailLine label="Needed from pots" value={fmtGBP(fromPotsNeeded)} bold />
      </DetailSection>

      {/* Col 2 — From Your Pots */}
      <DetailSection title="From Your Pots" accent="#4f8ef7">
        {hasTFPension && (
          <DetailLine
            label="Tax-free pension"
            value={fmtGBP(row.taxFreePensionDrawdown)}
            color="#4f8ef7"
          />
        )}
        {hasTaxPension && (
          <DetailLine
            label="Taxable pension (gross)"
            value={fmtGBP(row.taxablePensionDrawdown)}
            color="#4f8ef7"
          />
        )}
        {row.isaWithdrawal > 0 && (
          <DetailLine label="ISA withdrawal" value={fmtGBP(row.isaWithdrawal)} color="#34d399" />
        )}
        {row.giaWithdrawal > 0 && (
          <DetailLine
            label="GIA withdrawal (gross)"
            value={fmtGBP(row.giaWithdrawal)}
            color="#e8b84b"
          />
        )}
        <Divider />
        <DetailLine label="Gross drawn" value={fmtGBP(grossFromPots)} bold />
        {(row.incomeTax ?? 0) > 0 && (
          <DetailLine
            label="− Income tax"
            value={fmtGBP(row.incomeTax)}
            color="#f43f5e"
            indent={1}
          />
        )}
        {(row.giaCGT ?? 0) > 0 && (
          <DetailLine label="− CGT" value={fmtGBP(row.giaCGT)} color="#f43f5e" indent={1} />
        )}
        <Divider />
        <DetailLine
          label="Net from pots"
          value={fmtGBP(netFromPots)}
          bold
          color={hasShortfall ? '#f43f5e' : '#34d399'}
        />
        {hasSP && (
          <DetailLine
            label="+ State pension (net)"
            value={fmtGBP(spCoversLiving)}
            color="#a78bfa"
          />
        )}
        {hasShortfall && (
          <DetailLine label="Shortfall" value={`−${fmtGBP(row.shortfall)}`} color="#f43f5e" bold />
        )}
      </DetailSection>

      {/* Col 3 — Pot Balances */}
      <DetailSection title={`Pot Balances · ${rate} growth`} accent="var(--accent-gold)">
        <DetailLine
          label="Pension — opening"
          value={fmtGBP(row.pension.openingBalance)}
          color="#4f8ef7"
        />
        {row.pension.drawdown > 0 && (
          <DetailLine
            label="− drawn"
            value={fmtGBP(row.pension.drawdown)}
            color="#4f8ef7"
            indent={1}
            dim
          />
        )}
        <DetailLine
          label="+ growth"
          value={fmtGBP(row.pension.growthAmount)}
          color="#4f8ef7"
          indent={1}
          dim
        />
        <DetailLine
          label="Pension — closing"
          value={fmtGBP(row.pension.closingBalance)}
          color="#4f8ef7"
          bold
        />
        <DetailLine label="ISA — opening" value={fmtGBP(row.isa.openingBalance)} color="#34d399" />
        {row.isa.withdrawal > 0 && (
          <DetailLine
            label="− withdrawn"
            value={fmtGBP(row.isa.withdrawal)}
            color="#34d399"
            indent={1}
            dim
          />
        )}
        {(row.isa.bedIsaContrib ?? 0) > 0 && (
          <DetailLine
            label="+ bed & ISA"
            value={fmtGBP(row.isa.bedIsaContrib)}
            color="#34d399"
            indent={1}
            dim
          />
        )}
        <DetailLine
          label="+ growth"
          value={fmtGBP(row.isa.growthAmount)}
          color="#34d399"
          indent={1}
          dim
        />
        <DetailLine
          label="ISA — closing"
          value={fmtGBP(row.isa.closingBalance)}
          color="#34d399"
          bold
        />
        <DetailLine label="GIA — opening" value={fmtGBP(row.gia.openingBalance)} color="#e8b84b" />
        {row.gia.withdrawal > 0 && (
          <DetailLine
            label="− withdrawn"
            value={fmtGBP(row.gia.withdrawal)}
            color="#e8b84b"
            indent={1}
            dim
          />
        )}
        {(row.gia.bedIsaGross ?? 0) > 0 && (
          <DetailLine
            label="− bed & ISA (sold)"
            value={fmtGBP(row.gia.bedIsaGross)}
            color="#e8b84b"
            indent={1}
            dim
          />
        )}
        {(row.gia.bedIsaCGT ?? 0) > 0 && (
          <DetailLine
            label="CGT on bed & ISA"
            value={fmtGBP(row.gia.bedIsaCGT)}
            color="#f43f5e"
            indent={2}
            dim
          />
        )}
        <DetailLine
          label="+ growth"
          value={fmtGBP(row.gia.growthAmount)}
          color="#e8b84b"
          indent={1}
          dim
        />
        <DetailLine
          label="GIA — closing"
          value={fmtGBP(row.gia.closingBalance)}
          color="#e8b84b"
          bold
        />
      </DetailSection>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [p, setP] = useState(() => {
    try {
      const saved = localStorage.getItem('inputs');
      return saved ? { ...DEFAULTS, ...JSON.parse(saved) } : DEFAULTS;
    } catch {
      return DEFAULTS;
    }
  });
  const [activeTab, setActiveTab] = useState('Personal');
  const [realTerms, setRealTerms] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [hoveredRow, setHoveredRow] = useState(null);
  const [copyMsg, setCopyMsg] = useState(null);
  const [pasteMsg, setPasteMsg] = useState(null);
  const [colorMode, setColorMode] = useState(() => localStorage.getItem('colorMode') ?? 'dark');
  // 'det' = deterministic chart  |  'mc' = Monte Carlo fan chart
  const [chartTab, setChartTab] = useState('det');
  const series = colorMode === 'hc' ? SERIES_HC : SERIES_DEFAULT;
  const mobile = useMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Persist inputs to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('inputs', JSON.stringify(p));
  }, [p]);

  // Persist colorMode and, for 'device', keep data-theme in sync with OS preference.
  // data-theme itself is set synchronously via changeColorMode() before each render.
  useEffect(() => {
    localStorage.setItem('colorMode', colorMode);
    if (colorMode === 'device') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const apply = () => applyDataTheme('device');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [colorMode]);

  function changeColorMode(value) {
    applyDataTheme(value); // synchronous — CSS vars correct before any effect runs
    setColorMode(value);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(p, null, 2));
      setCopyMsg('Copied!');
    } catch {
      setCopyMsg('Failed');
    }
    setTimeout(() => setCopyMsg(null), 2000);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not an object');
      setP({ ...DEFAULTS, ...parsed });
      setPasteMsg('Applied!');
    } catch (e) {
      setPasteMsg(e instanceof SyntaxError ? 'Invalid JSON' : 'Failed');
    }
    setTimeout(() => setPasteMsg(null), 2000);
  }

  const set = (key) => (value) => setP((prev) => ({ ...prev, [key]: value }));

  // ── Shared helpers — derive rates + pots from current params ─────────────
  // Used by both the deterministic memo and the Monte Carlo effect so there is
  // a single source of truth for these derivations.
  function buildRates(p) {
    const mortgageRate =
      p.mortgageRateType === 'boe'
        ? (p.boePct + p.mortgageSpreadPct) / 100
        : p.mortgageRatePct / 100;
    const unsecuredRate =
      p.unsecuredRateType === 'boe'
        ? (p.boePct + p.unsecuredSpreadPct) / 100
        : p.unsecuredRatePct / 100;
    const preEq = p.preRetirementEquityPct / 100;
    const postEq = p.postRetirementEquityPct / 100;
    const eqRet = p.equityReturnPct / 100;
    const bdRet = p.bondReturnPct / 100;
    return {
      savingsRate: preEq * eqRet + (1 - preEq) * bdRet,
      retirementRate: postEq * eqRet + (1 - postEq) * bdRet,
      wageGrowthRate: p.wageGrowthPct / 100,
      mortgageRate,
      unsecuredRate,
      inflationRate: p.inflationPct / 100,
      boeRate: p.boePct / 100,
      fiscalDragRate: p.fiscalDragPct / 100,
    };
  }

  function buildPots(p) {
    const pots = {
      pensionBalance: p.pensionBalance,
      isaBalance: p.isaBalance,
      giaBalance: p.giaBalance,
      giaCostBasis: Math.min(p.giaCostBasis, p.giaBalance),
    };
    if (p.mortgageBalance > 0) {
      pots.mortgage = {
        balance: p.mortgageBalance,
        termYears: p.mortgageTermYears,
        type: p.mortgageType,
        monthlyOverpayment: p.mortgageOverpayment,
      };
    }
    if (p.unsecuredBalance > 0) {
      pots.unsecuredDebts = [{ balance: p.unsecuredBalance, monthlyPayment: p.unsecuredMonthly }];
    }
    if (p.studentLoanPlan && p.studentLoanBalance > 0) {
      pots.studentLoan = {
        balance: p.studentLoanBalance,
        repaymentStartYear: CURRENT_YEAR - p.studentLoanYears,
      };
    }
    return pots;
  }

  const { chartData, summary, error } = useMemo(() => {
    try {
      const profile = {
        currentAge: p.currentAge,
        retirementAge: p.retirementAge,
        grossIncome: p.grossIncome,
        annualLivingExpenses: p.annualLivingExpenses,
        employeePensionRate: p.employeePensionPct / 100,
        employerPensionRate: p.employerPensionPct / 100,
        niContributionYears: p.niContributionYears,
        statePensionAge: p.statePensionAge,
        studentLoanPlan: p.studentLoanPlan || null,
      };
      const rates = buildRates(p);
      const pots = buildPots(p);

      const retirementOptions = {
        targetNetAnnualExpenses: p.targetNetExpenses,
        maxAge: p.maxAge,
        takePCLS: p.takePCLS,
        glideStartYears: p.glideStartYears,
        glideEndYears: p.glideEndYears,
      };

      const result = projectLifecycle(profile, rates, pots, retirementOptions);

      const toRow = (row) => ({
        age: row.age,
        phase: row.phase ?? 'accumulation',
        pension: row.pension?.closingBalance ?? 0,
        isa: row.isa?.closingBalance ?? 0,
        gia: row.gia?.closingBalance ?? 0,
        mortgage: -(row.mortgage?.closingBalance ?? 0),
        unsecuredDebt: -(row.unsecuredDebts?.reduce((s, d) => s + (d.closingBalance ?? 0), 0) ?? 0),
        studentLoan: -(row.studentLoan?.closingBalance ?? 0),
        shortfall: row.shortfall ?? 0,
        investmentRate: row.investmentRate ?? null,
        _detail: row, // full nominal row — always unmodified, used by detail panel
      });

      const data = result.yearlyBreakdown.map(toRow);

      // When no retirement phase, append a summary row so the retirement reference line is visible
      if (!result.hasRetirementPhase) {
        const s = result.summary;
        data.push({
          age: p.retirementAge,
          phase: 'accumulation',
          pension: s.pensionPot,
          isa: s.isaBalance,
          gia: s.giaBalance,
          mortgage: -s.mortgageOutstanding,
          unsecuredDebt: -s.unsecuredDebtOutstanding,
          studentLoan: -s.studentLoanOutstanding,
          shortfall: 0,
        });
      }

      return { chartData: data, summary: result.summary, error: null };
    } catch (e) {
      return { chartData: [], summary: null, error: e.message };
    }
  }, [p]);

  // ── Monte Carlo stochastic modelling ───────────────────────────────────────
  // All setState calls live inside the timeout callback (not the effect body)
  // to avoid the react-hooks/set-state-in-effect lint rule.
  // A 150 ms debounce absorbs rapid slider changes.
  const [mcResults, setMcResults] = useState(null);
  const [mcPending, setMcPending] = useState(false);

  useEffect(() => {
    const delay = chartTab === 'mc' ? 150 : 0;
    const tid = setTimeout(() => {
      if (chartTab !== 'mc') {
        setMcResults(null);
        setMcPending(false);
        return;
      }
      setMcPending(true);
      try {
        const mcProfile = {
          currentAge: p.currentAge,
          retirementAge: p.retirementAge,
          grossIncome: p.grossIncome,
          annualLivingExpenses: p.annualLivingExpenses,
          employeePensionRate: p.employeePensionPct / 100,
          employerPensionRate: p.employerPensionPct / 100,
          niContributionYears: p.niContributionYears,
          statePensionAge: p.statePensionAge,
          studentLoanPlan: p.studentLoanPlan || null,
        };
        const mcRates = buildRates(p);
        const mcPots = buildPots(p);
        const mcRetOpts = {
          targetNetAnnualExpenses: p.targetNetExpenses,
          maxAge: p.maxAge,
          takePCLS: p.takePCLS,
          glideStartYears: p.glideStartYears,
          glideEndYears: p.glideEndYears,
        };

        setMcResults(
          runMonteCarlo(mcProfile, mcRates, mcPots, mcRetOpts, {
            trials: p.mcTrials,
            volatility: p.mcVolatility,
            bearFreq: p.mcBearFreq,
            bearSeverity: p.mcBearSeverity,
            crisisPersistence: p.mcCrisisPersistence,
            preRetirementEquity: p.preRetirementEquityPct / 100,
            postRetirementEquity: p.postRetirementEquityPct / 100,
          })
        );
      } catch {
        setMcResults(null);
      }
      setMcPending(false);
    }, delay);

    return () => clearTimeout(tid);
  }, [p, chartTab]);

  // ── Real-terms adjustment ──────────────────────────────────────────────────
  // Divides every monetary value by (1 + inflationRate)^(age − currentAge)
  // so all figures are expressed in today's purchasing power.
  const inflRate = p.inflationPct / 100;

  const displayData = useMemo(() => {
    if (!realTerms || !chartData.length) return chartData;
    return chartData.map((row) => {
      const f = Math.pow(1 / (1 + inflRate), row.age - p.currentAge);
      return {
        ...row,
        pension: row.pension * f,
        isa: row.isa * f,
        gia: row.gia * f,
        mortgage: row.mortgage * f,
        unsecuredDebt: row.unsecuredDebt * f,
        studentLoan: row.studentLoan * f,
        shortfall: row.shortfall * f,
      };
    });
  }, [chartData, realTerms, inflRate, p.currentAge]);

  const displaySummary = useMemo(() => {
    if (!realTerms || !summary) return summary;
    const retF = Math.pow(1 / (1 + inflRate), p.retirementAge - p.currentAge);
    // State pension is nominal at statePensionAge, so use that age for its real-terms factor
    const spF = Math.pow(1 / (1 + inflRate), Math.max(0, summary.statePensionAge - p.currentAge));
    return {
      ...summary,
      pensionPot: summary.pensionPot * retF,
      isaBalance: summary.isaBalance * retF,
      giaBalance: summary.giaBalance * retF,
      mortgageOutstanding: summary.mortgageOutstanding * retF,
      unsecuredDebtOutstanding: summary.unsecuredDebtOutstanding * retF,
      studentLoanOutstanding: summary.studentLoanOutstanding * retF,
      totalSavings: summary.totalSavings * retF,
      totalDebt: summary.totalDebt * retF,
      netWorth: summary.netWorth * retF,
      projectedStatePension: summary.projectedStatePension * spF,
    };
  }, [summary, realTerms, inflRate, p.currentAge, p.retirementAge]);

  // 4% rule: need 25× annual spending as a portfolio (1 / 0.04 = 25).
  // Expressed in the same terms as the chart (real or nominal).
  // In real terms the spending figure is already in today's money, so no inflation needed.
  // In nominal terms we inflate the spending to retirement-date prices first.
  const fourPctTarget = realTerms
    ? p.targetNetExpenses * 25
    : p.targetNetExpenses * 25 * Math.pow(1 + inflRate, p.retirementAge - p.currentAge);

  // First retirement year's year-end row from displayData (already real-terms adjusted).
  // The chart plots closingBalance at every age point, so this matches what the graph shows
  // at retirementAge — keeping stat-card figures consistent with graph hover / axis readings.
  const retYearEndRow = displayData.find((d) => d.phase === 'retirement') ?? null;

  return (
    <div
      style={{
        height: mobile ? 'auto' : '100vh',
        minHeight: mobile ? '100svh' : undefined,
        display: 'flex',
        flexDirection: 'column',
        overflow: mobile ? 'visible' : 'hidden',
      }}
    >
      {/* ── Header ── */}
      <header
        style={{
          padding: mobile ? '10px 14px' : '14px 28px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: mobile ? 'center' : 'baseline',
          flexWrap: 'wrap',
          gap: mobile ? 8 : 14,
          background: 'var(--bg-panel)',
          flexShrink: 0,
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          Savings Planner
        </h1>
        {!mobile && (
          <span
            style={{
              color: 'var(--accent-gold)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.1em',
            }}
          >
            RETIREMENT SAVINGS PROJECTION DASHBOARD
          </span>
        )}
        <div
          style={{
            marginLeft: mobile ? 0 : 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: mobile ? 8 : 16,
            flexWrap: 'wrap',
          }}
        >
          {/* Theme switcher */}
          <div
            style={{
              display: 'flex',
              borderRadius: 5,
              overflow: 'hidden',
              border: '1px solid var(--border-bright)',
            }}
          >
            {THEMES.map(({ value, label, title }) => {
              const active = colorMode === value;
              return (
                <button
                  key={value}
                  onClick={() => changeColorMode(value)}
                  title={title}
                  style={{
                    padding: '4px 10px',
                    background: active ? 'var(--accent-gold)' : 'transparent',
                    color: active ? 'var(--accent-gold-text)' : 'var(--text-muted)',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    transition: 'all 0.15s',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <HelpTip text="Nominal: all figures shown in future pounds (the actual cash amounts at each age). Real: figures are adjusted for inflation and expressed in today's purchasing power, so you can compare values across different ages on a like-for-like basis. Uses the inflation rate set in the Rates tab." />
          <div
            style={{
              display: 'flex',
              borderRadius: 5,
              overflow: 'hidden',
              border: '1px solid var(--border-bright)',
            }}
          >
            {['Nominal', 'Real'].map((opt) => {
              const active = realTerms ? opt === 'Real' : opt === 'Nominal';
              return (
                <button
                  key={opt}
                  onClick={() => setRealTerms(opt === 'Real')}
                  style={{
                    padding: '4px 12px',
                    background: active ? 'var(--accent-gold)' : 'transparent',
                    color: active ? 'var(--accent-gold-text)' : 'var(--text-muted)',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    transition: 'all 0.15s',
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          <HelpTip text="Linear: y-axis uses a linear scale — equal distances represent equal pound amounts. Log: y-axis uses a logarithmic scale — equal distances represent equal percentage growth, making early portfolio growth more visible." />
          <div
            style={{
              display: 'flex',
              borderRadius: 5,
              overflow: 'hidden',
              border: '1px solid var(--border-bright)',
            }}
          >
            {['Lin', 'Log'].map((opt) => {
              const active = logScale ? opt === 'Log' : opt === 'Lin';
              return (
                <button
                  key={opt}
                  onClick={() => setLogScale(opt === 'Log')}
                  style={{
                    padding: '4px 12px',
                    background: active ? 'var(--accent-gold)' : 'transparent',
                    color: active ? 'var(--accent-gold-text)' : 'var(--text-muted)',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    transition: 'all 0.15s',
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          {!mobile && (
            <span
              style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
            >
              ⚠ Illustrative only — not financial advice. England, Wales &amp; Northern Ireland
              residents only.
            </span>
          )}
        </div>
      </header>

      <div
        style={{
          display: 'flex',
          flex: mobile ? undefined : 1,
          flexDirection: mobile ? 'column' : 'row',
          overflow: mobile ? 'visible' : 'hidden',
        }}
      >
        {/* ── Sidebar ── */}
        <aside
          style={{
            width: mobile ? '100%' : 310,
            flexShrink: 0,
            background: 'var(--bg-panel)',
            borderRight: mobile ? 'none' : '1px solid var(--border)',
            borderBottom: mobile ? '1px solid var(--border)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Tab bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: mobile ? `repeat(${TABS.length}, 1fr)` : 'repeat(4, 1fr)',
              overflowX: mobile ? 'auto' : 'visible',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  if (mobile) {
                    if (activeTab === tab && sidebarOpen) setSidebarOpen(false);
                    else {
                      setActiveTab(tab);
                      setSidebarOpen(true);
                    }
                  } else {
                    setActiveTab(tab);
                  }
                }}
                style={{
                  padding: '9px 4px',
                  background: activeTab === tab ? 'var(--bg-card)' : 'transparent',
                  border: 'none',
                  borderBottom:
                    activeTab === tab ? '2px solid var(--accent-gold)' : '2px solid transparent',
                  color: activeTab === tab ? 'var(--accent-gold)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontSize: 11,
                  fontWeight: activeTab === tab ? 600 : 400,
                  letterSpacing: '0.03em',
                  transition: 'all 0.15s',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Scrollable tab content */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '20px 20px 8px',
              display: mobile && !sidebarOpen ? 'none' : 'block',
            }}
          >
            <TabContent tab={activeTab} p={p} set={set} />
          </div>

          {/* Footer actions */}
          <div
            style={{
              padding: '12px 20px',
              borderTop: '1px solid var(--border)',
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {(!mobile || sidebarOpen) && (
              <>
                {/* Copy / Paste JSON */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { label: 'Copy JSON', msg: copyMsg, handler: handleCopy },
                    { label: 'Paste JSON', msg: pasteMsg, handler: handlePaste },
                  ].map(({ label, msg, handler }) => {
                    const isError = msg === 'Failed' || msg === 'Invalid JSON';
                    return (
                      <button
                        key={label}
                        onClick={handler}
                        style={{
                          flex: 1,
                          padding: '7px 4px',
                          background: 'transparent',
                          border: `1px solid ${msg ? (isError ? 'rgba(244,63,94,0.5)' : 'rgba(52,211,153,0.5)') : 'var(--border-bright)'}`,
                          borderRadius: 6,
                          color: msg ? (isError ? '#f87171' : '#34d399') : 'var(--text-secondary)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          cursor: 'pointer',
                          letterSpacing: '0.04em',
                          transition: 'all 0.15s',
                        }}
                        onMouseOver={(e) => {
                          if (!msg) {
                            e.currentTarget.style.borderColor = 'var(--accent-gold)';
                            e.currentTarget.style.color = 'var(--accent-gold)';
                          }
                        }}
                        onMouseOut={(e) => {
                          if (!msg) {
                            e.currentTarget.style.borderColor = 'var(--border-bright)';
                            e.currentTarget.style.color = 'var(--text-secondary)';
                          }
                        }}
                      >
                        {msg ?? label}
                      </button>
                    );
                  })}
                </div>
                {/* Reset */}
                <button
                  onClick={() => {
                    localStorage.removeItem('inputs');
                    setP(DEFAULTS);
                    setActiveTab('Personal');
                  }}
                  style={{
                    width: '100%',
                    padding: '7px',
                    background: 'transparent',
                    border: '1px solid var(--border-bright)',
                    borderRadius: 6,
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-body)',
                    fontSize: 12,
                    cursor: 'pointer',
                    letterSpacing: '0.05em',
                    transition: 'all 0.15s',
                  }}
                  onMouseOver={(e) => {
                    e.target.style.borderColor = 'var(--accent-gold)';
                    e.target.style.color = 'var(--accent-gold)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.borderColor = 'var(--border-bright)';
                    e.target.style.color = 'var(--text-secondary)';
                  }}
                >
                  Reset to Defaults
                </button>
                {/* Done — mobile only */}
                {mobile && (
                  <button
                    onClick={() => setSidebarOpen(false)}
                    style={{
                      width: '100%',
                      padding: '9px',
                      background: 'var(--accent-gold)',
                      border: 'none',
                      borderRadius: 6,
                      color: 'var(--accent-gold-text)',
                      fontFamily: 'var(--font-body)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      letterSpacing: '0.04em',
                    }}
                  >
                    Done
                  </button>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Main content ── */}
        <main
          style={{
            flex: 1,
            padding: mobile ? '14px' : '22px 28px',
            overflowY: mobile ? 'visible' : 'auto',
            minWidth: 0,
          }}
        >
          {/* Error banner */}
          {error && (
            <div
              style={{
                background: 'rgba(244,63,94,0.08)',
                border: '1px solid rgba(244,63,94,0.5)',
                borderRadius: 8,
                padding: '10px 16px',
                marginBottom: 20,
                color: '#f87171',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
              }}
            >
              ⚠ {error}
            </div>
          )}

          {/* Stat cards */}
          {displaySummary &&
            (() => {
              const firstShortfall = displayData.find(
                (d) => d.phase === 'retirement' && d.shortfall > 0
              );
              const lastRetRow = [...displayData].reverse().find((d) => d.phase === 'retirement');
              return (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
                    gap: 12,
                    marginBottom: 22,
                  }}
                >
                  <StatCard
                    label="Net Worth at Retirement"
                    value={fmtGBPLarge(
                      retYearEndRow
                        ? retYearEndRow.pension +
                            retYearEndRow.isa +
                            retYearEndRow.gia +
                            retYearEndRow.mortgage +
                            retYearEndRow.unsecuredDebt +
                            retYearEndRow.studentLoan
                        : displaySummary.netWorth
                    )}
                    color="var(--accent-gold)"
                    subtitle={`Age ${p.retirementAge} · year-end${realTerms ? " · today's £" : ''}`}
                    help="Pension + ISA + GIA balances at the end of your first retirement year, minus any outstanding debts. Matches the chart value at that age. Does not include property equity, defined benefit pensions, or other illiquid assets."
                  />
                  <StatCard
                    label="Pension Pot"
                    value={fmtGBPLarge(
                      retYearEndRow ? retYearEndRow.pension : displaySummary.pensionPot
                    )}
                    color="#4f8ef7"
                    subtitle={`ISA: ${fmtGBPLarge(retYearEndRow ? retYearEndRow.isa : displaySummary.isaBalance)} · GIA: ${fmtGBPLarge(retYearEndRow ? retYearEndRow.gia : displaySummary.giaBalance)}`}
                    help="Your defined contribution pension pot at the end of your first retirement year, after PCLS distribution (if taken), one year of drawdown, and one year of investment growth. Matches the chart value at that age."
                  />
                  <StatCard
                    label={
                      firstShortfall
                        ? 'Shortfall from Age'
                        : lastRetRow
                          ? `Wealth at Age ${p.maxAge}`
                          : 'Total Debt'
                    }
                    value={
                      firstShortfall
                        ? `${firstShortfall.age}`
                        : lastRetRow
                          ? fmtGBPLarge(lastRetRow.pension + lastRetRow.isa + lastRetRow.gia)
                          : displaySummary.totalDebt > 0
                            ? `-${fmtGBPLarge(displaySummary.totalDebt)}`
                            : 'Debt-free'
                    }
                    color={firstShortfall ? '#f43f5e' : '#34d399'}
                    subtitle={
                      firstShortfall
                        ? `Target: ${fmtGBP(p.targetNetExpenses)}/yr · pots exhausted`
                        : lastRetRow
                          ? `Pension: ${fmtGBPLarge(lastRetRow.pension)} · ISA: ${fmtGBPLarge(lastRetRow.isa)}`
                          : displaySummary.totalDebt > 0
                            ? 'at retirement'
                            : 'at retirement'
                    }
                    help={
                      firstShortfall
                        ? `Your pots run out at this age — combined pension, ISA, and GIA can no longer cover the inflation-adjusted target spending of ${fmtGBP(p.targetNetExpenses)}/yr. Consider increasing savings, reducing target expenses, or retiring later.`
                        : lastRetRow
                          ? `Combined pension + ISA + GIA balance at age ${p.maxAge}, after funding all retirement spending. Property equity and other illiquid assets are not included.`
                          : 'Total outstanding debt (mortgage + unsecured + student loan) at retirement.'
                    }
                  />
                  <StatCard
                    label="State Pension"
                    value={
                      displaySummary.projectedStatePension > 0
                        ? `${fmtGBPLarge(displaySummary.projectedStatePension)}/yr`
                        : 'Not eligible'
                    }
                    color={
                      displaySummary.projectedStatePension > 0 ? '#a78bfa' : 'var(--text-muted)'
                    }
                    subtitle={
                      displaySummary.projectedStatePension > 0
                        ? displaySummary.statePensionEligibleAtRetirement
                          ? `From age ${displaySummary.statePensionAge} · ${displaySummary.niYearsAccrued} NI yrs`
                          : `Starts age ${displaySummary.statePensionAge} · ${displaySummary.niYearsAccrued} NI yrs`
                        : `Only ${displaySummary.niYearsAccrued} qualifying NI yrs — need 10`
                    }
                    help="Your projected state pension, based on total NI qualifying years accrued by retirement. This is a real government entitlement (inflation-linked via triple lock), not an investment return. It offsets retirement expenses before drawing from personal pots."
                  />
                </div>
              );
            })()}

          {/* Chart */}
          <div
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '20px 16px 12px 8px',
            }}
          >
            {/* ── Chart card header — 3-column layout keeps tab switcher stable ── */}
            <div
              style={{
                paddingLeft: 16,
                paddingRight: 8,
                marginBottom: 14,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              {/* Left: title + subtitle (flex:1 so it absorbs spare space) */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 17,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    letterSpacing: '-0.01em',
                    marginBottom: 3,
                  }}
                >
                  {chartTab === 'mc' ? 'Monte Carlo Simulation' : 'Asset & Debt Balances by Age'}
                </h2>
                <p
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: 12,
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  {chartTab === 'mc' ? (
                    <>
                      Total portfolio · {p.mcTrials} trials ·{' '}
                      {realTerms
                        ? `Real terms (today's £, ${p.inflationPct}% inflation)`
                        : 'Nominal terms'}
                      {mcPending && (
                        <span style={{ color: 'var(--text-muted)' }}> · computing…</span>
                      )}
                    </>
                  ) : (
                    <>
                      Assets above axis · Debts below ·{' '}
                      {realTerms
                        ? `Real terms (today's £, ${p.inflationPct}% inflation)`
                        : 'Nominal terms'}
                    </>
                  )}
                </p>
              </div>

              {/* Centre: tab switcher + tooltip — fixed, never moves */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  alignSelf: 'center',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    overflow: 'hidden',
                  }}
                >
                  {[
                    { key: 'det', label: 'Deterministic' },
                    { key: 'mc', label: 'Monte Carlo' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setChartTab(key)}
                      style={{
                        padding: '4px 12px',
                        background: chartTab === key ? 'var(--accent-gold)' : 'transparent',
                        border: 'none',
                        color:
                          chartTab === key ? 'var(--accent-gold-text)' : 'var(--text-secondary)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <HelpTip
                  text={
                    'Deterministic: one fixed projection using the exact rates you set in the Rates tab. Useful for understanding how the plan works and stress-testing specific assumptions. Because it uses a single unchanging set of assumptions, it is inherently optimistic — there is no mechanism for things to go wrong beyond what you explicitly model.\n\n' +
                    'Monte Carlo: runs hundreds of simulations, each with a different random sequence of market returns and economic conditions. The fan chart shows the spread of outcomes — the wide band is the 10th–90th percentile range, the narrow band is 25th–75th, and the centre line is the median. The simulation is calibrated so the median trial tracks the deterministic projection — your return rate sliders represent full-cycle expected returns, already inclusive of bear markets. The fan shows what happens when bad years cluster unluckily (p10) or conditions are unusually favourable (p90).\n\n' +
                    'Use Monte Carlo to understand retirement risk — specifically, whether your plan survives bad luck, not just average conditions.'
                  }
                />
              </div>

              {/* Right: tab-specific controls (flex:1, right-aligned) */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 12,
                  alignSelf: 'center',
                }}
              >
                {chartTab === 'det' && (
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                      letterSpacing: '0.04em',
                    }}
                  >
                    4% rule: {fmtGBPLarge(fourPctTarget)}
                    <HelpTip
                      text={
                        'The 4% rule is a retirement planning heuristic: if you withdraw 4% of your portfolio in year one and adjust for inflation each year, historical data suggests the portfolio survives a 30-year retirement. This implies you need 25× your annual spending saved (1 ÷ 0.04 = 25).\n\n' +
                        'This line shows that target in ' +
                        (realTerms ? "today's money." : 'nominal terms at your retirement date.') +
                        '\n\nWhy the model may differ:\n' +
                        '• The model uses year-by-year drawdown with actual tax calculations, so it draws less gross from the pension when income is within the personal allowance.\n' +
                        '• State pension income offsets spending needs, reducing how much the portfolio must provide — the 4% rule ignores guaranteed income sources.\n' +
                        '• The model sequences across ISA, GIA, and pension in a tax-efficient order, whereas the 4% rule assumes a single undifferentiated pot.\n' +
                        '• The 4% rule was calibrated on a 30-year horizon. Longer retirements (e.g. retiring at 55 to age 95) may require a lower safe withdrawal rate of 3–3.5%.'
                      }
                    />
                  </span>
                )}
                {chartTab === 'mc' && (
                  <HelpTip
                    text={
                      `${mcResults ? mcResults.trialCount : 0} trials shown. Each trial varies investment returns (market factor) and inflation / BoE / wage growth (macro factor) using correlated random shocks.\n\n` +
                      'Bands show the 10th–90th percentile range (faint) and 25th–75th range (stronger). Lines show the 5 key percentiles.\n\n' +
                      'Click and hold on a data point to isolate the single trial closest to that percentile at that age. Release to return to the full fan.\n\n' +
                      'Shortfall labels (▼ with age) on the x-axis show when each percentile path runs out of money. Hover to see pot detail from that path.'
                    }
                  />
                )}
              </div>
            </div>

            {/* ── Monte Carlo tab ── */}
            {chartTab === 'mc' && (
              <>
                {mcResults ? (
                  <FanChart
                    percentileData={mcResults.percentileData}
                    portfolioMatrix={mcResults.portfolioMatrix}
                    allPotData={mcResults.allPotData}
                    potSeries={series}
                    repPaths={mcResults.repPaths}
                    realTerms={realTerms}
                    inflRate={inflRate}
                    currentAge={p.currentAge}
                    retirementAge={p.retirementAge}
                    statePensionAge={p.statePensionAge}
                    onHoverRow={(row) => {
                      setHoveredRow(row ?? null);
                    }}
                    fourPctTarget={fourPctTarget}
                    showDetails={true}
                    colorMode={colorMode}
                    logScale={logScale}
                    height={mobile ? 260 : 390}
                  />
                ) : mcPending ? (
                  <div
                    style={{
                      height: mobile ? 260 : 390,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-muted)',
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    Computing {p.mcTrials} trials…
                  </div>
                ) : (
                  <div
                    style={{
                      height: mobile ? 260 : 390,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-muted)',
                      fontSize: 13,
                    }}
                  >
                    No results — check inputs
                  </div>
                )}
              </>
            )}

            {/* ── Deterministic tab ── */}
            {chartTab === 'det' &&
              (chartData.length > 0 ? (
                <FanChart
                  deterministicData={chartData}
                  potSeries={series}
                  realTerms={realTerms}
                  inflRate={inflRate}
                  currentAge={p.currentAge}
                  retirementAge={p.retirementAge}
                  statePensionAge={p.statePensionAge}
                  onHoverRow={(row) => setHoveredRow(row ?? null)}
                  fourPctTarget={fourPctTarget}
                  colorMode={colorMode}
                  logScale={logScale}
                  height={mobile ? 260 : 390}
                />
              ) : (
                <div
                  style={{
                    height: mobile ? 260 : 390,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                    fontSize: 13,
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  {error ? 'Fix the error above to see the projection.' : 'Calculating…'}
                </div>
              ))}

            <YearDetailPanel row={hoveredRow} mobile={mobile} />
          </div>

          {/* Snapshot table — deterministic tab only */}
          {chartTab === 'det' && displayData.length > 0 && (
            <div
              style={{
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                marginTop: 18,
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '13px 20px', borderBottom: '1px solid var(--border)' }}>
                <span
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    fontWeight: 600,
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  Snapshot — every 5 years{realTerms ? ` · real terms (today's £)` : ''}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ background: 'var(--bg-card)' }}>
                      {[
                        'Age',
                        'Pension',
                        'ISA',
                        'GIA',
                        'Mortgage',
                        'Unsecured',
                        'Stud. Loan',
                        'Net Worth',
                        'Shortfall',
                      ].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '9px 14px',
                            textAlign: h === 'Age' ? 'left' : 'right',
                            color: 'var(--text-muted)',
                            fontWeight: 500,
                            fontSize: 10,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayData
                      .filter((d) => (d.age - p.currentAge) % 5 === 0 || d.age === p.retirementAge)
                      .map((d, i) => {
                        const isRetirement = d.age === p.retirementAge;
                        const isRetPhase = d.phase === 'retirement';
                        const netWorth =
                          d.pension + d.isa + d.gia + d.mortgage + d.unsecuredDebt + d.studentLoan;
                        return (
                          <tr
                            key={d.age}
                            style={{
                              background: isRetirement
                                ? 'rgba(232,184,75,0.05)'
                                : isRetPhase
                                  ? 'rgba(79,142,247,0.03)'
                                  : i % 2 === 0
                                    ? 'transparent'
                                    : 'var(--bg-card)',
                              borderLeft: isRetirement
                                ? '2px solid var(--accent-gold)'
                                : '2px solid transparent',
                            }}
                          >
                            <td
                              style={{
                                padding: '8px 14px',
                                color: isRetirement
                                  ? 'var(--accent-gold)'
                                  : 'var(--text-secondary)',
                              }}
                            >
                              {d.age}
                              {isRetirement ? ' ★' : ''}
                            </td>
                            <td
                              style={{ padding: '8px 14px', textAlign: 'right', color: '#4f8ef7' }}
                            >
                              {fmtGBPLarge(d.pension)}
                            </td>
                            <td
                              style={{ padding: '8px 14px', textAlign: 'right', color: '#34d399' }}
                            >
                              {fmtGBPLarge(d.isa)}
                            </td>
                            <td
                              style={{ padding: '8px 14px', textAlign: 'right', color: '#e8b84b' }}
                            >
                              {fmtGBPLarge(d.gia)}
                            </td>
                            <td
                              style={{
                                padding: '8px 14px',
                                textAlign: 'right',
                                color: d.mortgage < 0 ? '#f43f5e' : 'var(--text-muted)',
                              }}
                            >
                              {d.mortgage < 0 ? fmtGBPLarge(d.mortgage) : '—'}
                            </td>
                            <td
                              style={{
                                padding: '8px 14px',
                                textAlign: 'right',
                                color: d.unsecuredDebt < 0 ? '#fb923c' : 'var(--text-muted)',
                              }}
                            >
                              {d.unsecuredDebt < 0 ? fmtGBPLarge(d.unsecuredDebt) : '—'}
                            </td>
                            <td
                              style={{
                                padding: '8px 14px',
                                textAlign: 'right',
                                color: d.studentLoan < 0 ? '#a78bfa' : 'var(--text-muted)',
                              }}
                            >
                              {d.studentLoan < 0 ? fmtGBPLarge(d.studentLoan) : '—'}
                            </td>
                            <td
                              style={{
                                padding: '8px 14px',
                                textAlign: 'right',
                                color: netWorth >= 0 ? 'var(--text-primary)' : '#f43f5e',
                                fontWeight: 500,
                              }}
                            >
                              {fmtGBPLarge(netWorth)}
                            </td>
                            <td
                              style={{
                                padding: '8px 14px',
                                textAlign: 'right',
                                color: d.shortfall > 0 ? '#f43f5e' : 'var(--text-muted)',
                              }}
                            >
                              {d.shortfall > 0 ? fmtGBPLarge(d.shortfall) : isRetPhase ? '—' : ''}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>
      <footer
        style={{
          padding: '10px 28px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          display: 'flex',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <a
          href="https://github.com/sambloom92/savings-planner"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            textDecoration: 'none',
            letterSpacing: '0.06em',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          github.com/sambloom92/savings-planner
        </a>
      </footer>
    </div>
  );
}
