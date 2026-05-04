# Savings Planner

A browser-based retirement savings projection dashboard for residents of England, Wales & Northern Ireland. Projects wealth across pension, ISA, GIA, mortgage, and debt from today to retirement and beyond — all running client-side with no backend required.

## Features

- **Accumulation phase** — models salary growth, pension contributions (employee & employer), ISA/GIA savings, mortgage amortisation, unsecured debts, and student loan repayment year by year
- **Retirement phase** — simulates tax-efficient drawdown across pension (tax-free + taxable), ISA, and GIA (with CGT modelling); state pension eligibility based on NI qualifying years
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
  ukIncomeTax.js          Income tax calculator (2025/26, scalable for fiscal drag)
  ukNationalInsurance.js  NI calculator — Class 1 employee & employer
  ukStudentLoan.js        Student loan repayment (Plans 1, 2, 4, postgrad)
  ukDebt.js               Mortgage and unsecured debt amortisation
  ukISA.js                ISA contribution limits and constants
  ukGIA.js                GIA CGT model (annual exempt amount, basic/higher rates)
  ukPension.js            Pension commencement lump sum (PCLS) calculator
  ukLifecycle.js          Full lifecycle projection engine
  App.jsx                 React UI — sidebar, chart, year-detail panel
```

Each `*.js` module has a corresponding `*.test.js` file with unit tests (no test framework dependency — plain Node assertions via `node:assert`).

## Deployment

The workflow in `.github/workflows/deploy.yml` builds the site and pushes it to GitHub Pages on every merge to `main`. Enable Pages in your repository settings (source: GitHub Actions) before the first deployment.

## License

MIT — see [LICENSE](LICENSE).
