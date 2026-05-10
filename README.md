# Savings Planner

A browser-based retirement savings projection dashboard for residents of England, Wales & Northern Ireland. Projects wealth across pension, ISA, GIA, mortgage, and debt from today to retirement and beyond — all running client-side with no backend required.

## Features

- **Accumulation phase** — models salary growth, pension contributions (employee & employer), ISA/GIA savings, mortgage amortisation, unsecured debts, and student loan repayment year by year
- **Retirement phase** — simulates tax-efficient drawdown across pension (tax-free + taxable), ISA, and GIA (with CGT modelling); state pension eligibility based on NI qualifying years
- **Glide path** — configurable equity/bond split pre- and post-retirement, with a linear taper over a user-defined window (e.g. start de-risking 10 years before retirement, fully de-risked 5 years after)
- **Monte Carlo simulation** — stochastic fan chart showing p10–p90 outcome bands across hundreds of trials; uses a two-regime Markov model (normal/bear) with fat-tailed (t₅) market shocks and GARCH-like volatility persistence
- **Fiscal drag** — configurable bracket-creep: model frozen, inflation-linked, or real-terms-rising tax bands
- **Real / nominal toggle** — switch between future cash values and today's purchasing power at any time
- **Year detail panel** — hover the chart to see a full breakdown of every money flow for that year
- **Export / import** — copy parameters as JSON and paste them back to save or share a scenario
- **Static site** — no server needed; deployable to GitHub Pages or any CDN

## Tax assumptions

Income tax bands and NI thresholds are based on **2025/26 rates** for **England, Wales & Northern Ireland**. Scottish income tax rates are not modelled.

## Getting started

**Requirements:** Node 20+

```bash
npm install
npm run dev        # start dev server at http://localhost:5173
npm run build      # production build → dist/
npm run preview    # serve the production build locally
```

## Quality checks

```bash
npm test           # run all unit tests
npm run lint       # ESLint
npm run format:check  # Prettier (check only)
npm run format     # Prettier (auto-fix)
```

CI runs lint, format check, and unit tests on every push and pull request. Deployment to GitHub Pages only happens on merges to `main` after all checks pass.

## Project structure

```
src/
  formatters.js           Shared GBP/percentage formatting utilities
  ukIncomeTax.js          Income tax calculator (2025/26, scalable for fiscal drag)
  ukNationalInsurance.js  NI calculator — Class 1 employee & employer
  ukStudentLoan.js        Student loan repayment (Plans 1, 2, 4, postgrad)
  ukDebt.js               Mortgage and unsecured debt amortisation
  ukISA.js                ISA contribution limits and constants
  ukGIA.js                GIA CGT model (annual exempt amount, basic/higher rates)
  ukPension.js            Pension commencement lump sum (PCLS) calculator
  ukLifecycle.js          Full lifecycle projection engine (accumulation + retirement)
  ukMonteCarlo.js         Monte Carlo simulation — two-regime Markov model
  FanChart.jsx            Canvas-based stochastic fan chart React component
  App.jsx                 React UI — sidebar, charts, year-detail panel
```

Each `*.js` module (except `formatters.js`) has a corresponding `*.test.js` file with unit tests (no test framework dependency — plain Node assertions via `node:assert`).

## Monte Carlo model

The simulation (`ukMonteCarlo.js`) runs N independent lifecycle trials (default 200), each with year-by-year stochastic rates drawn from a two-regime Markov model:

- **Regimes**: normal and bear. Each year the model transitions between regimes with configurable frequency and average duration.
- **Shocks**: market returns use a Student-t(ν=5) distribution (fat tails); macro rates (inflation, BoE, wages) use a standard normal.
- **Volatility clustering**: volatility spikes instantly to 2.5× during a bear market and decays back to normal afterward at a rate controlled by the *crisis persistence* setting (short/medium/long).
- **De-risking**: the volatility applied to the retirement-phase rate scales with `postRetirementEquity / preRetirementEquity`, so a more de-risked portfolio experiences proportionally smaller shocks.

Results are displayed as a fan chart (p10/p25/p50/p75/p90 bands). Clicking and holding a data point locks to a single representative trial, showing a stacked pot breakdown (pension / ISA / GIA) and any outstanding debt below the zero axis.

## Glide path

Investment returns are derived from the equity/bond split and the two asset-class return assumptions:

```
effectiveSavingsRate    = preRetirementEquity  × equityReturn + (1 − preRetirementEquity)  × bondReturn
effectiveRetirementRate = postRetirementEquity × equityReturn + (1 − postRetirementEquity) × bondReturn
```

The glide path linearly interpolates between these two rates over the window `[retirementAge − glideStartYears, retirementAge + glideEndYears]`. If the taper start falls before the user's current age, the interpolation still works correctly — the rate at the current age reflects the proportion of the glide path already elapsed. Both bounds are user-configurable (0–30 years before, 0–15 years after).

## Deployment

The workflow in `.github/workflows/deploy.yml` builds the site and pushes it to GitHub Pages on every merge to `main`. Enable Pages in your repository settings (source: GitHub Actions) before the first deployment.

## License

MIT — see [LICENSE](LICENSE).
