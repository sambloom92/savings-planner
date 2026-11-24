# Savings Planner

A browser-based retirement savings projection dashboard for residents of England, Wales & Northern Ireland. Projects wealth across pension, ISA, GIA, mortgage, and debt from today to retirement and beyond — all running client-side with no backend required.

## Features

- **Accumulation phase** — models salary growth, pension contributions (employee & employer), ISA/GIA savings, mortgage amortisation, unsecured debts, and student loan repayment year by year
- **Employer matching** — the employer contribution can be _Fixed_ (paid unconditionally) or _Matched_: the employer pays its full rate only once you contribute a required minimum, and nothing below it. This captures any scheme — 1:1, non-1:1, or tiered — by its top rung (e.g. "put in 6% to get 12%": required 6%, employer 12%), assuming you take the full offer
- **Tax-optimal contribution** — switch the employee contribution to _Auto_ and the app solves for the salary-sacrifice rate that protects your tax-free personal allowance: it brings taxable income down to £100,000, the point above which the allowance tapers away (an effective 60% marginal rate up to £125,140). Capped by the £60,000 annual allowance (tapered for high earners) and never sacrificing below the personal allowance; income already under £100k needs nothing. With matching on, it also contributes at least up to the match cap to capture all the free employer money — settling for a partial match only when doubling up would otherwise breach the allowance
- **Retirement phase** — simulates tax-efficient drawdown across pension (tax-free + taxable), ISA, and GIA (with CGT modelling); state pension eligibility based on NI qualifying years, with optional deferral (≈5.8% more per year deferred; the extra rises with CPI while the base keeps the triple lock). If you keep working past state pension age, the pension is paid from then (or from your deferred claim age) and taxed on top of your salary; employee NI stops and further years no longer add qualifying years
- **Defined benefit pensions** — add final salary or career average schemes from their benefit statements: still building up, left (deferred), or already being paid. An active scheme builds up each working year at its accrual rate on your pay and grows at its in-service rate (e.g. CPI + 1.5%, or with pay for final salary); member contributions get income tax relief but not NI relief (net pay), and the build-up counts towards the annual allowance at 16× (so the Auto DC contribution allows for it). From the chosen payment age the pension is adjusted for early or late payment and pays a guaranteed, taxable income that rises with CPI (optionally capped or level), counted before your pots are drawn — including in the flexible-retirement, guardrail and annuity calculations. You can swap pension for the maximum tax-free cash at the scheme's commutation factor (HMRC's 25% limit), and any automatic lump sum is supported; DB and DC tax-free cash share one Lump Sum Allowance
- **Couple mode** — switch the header from _Just me_ to _Couple_ to plan for two. Each of you has your own pay, tax, NI, student loan, pension, ISA, GIA, state pension, DB schemes and retirement age (a You / Partner switch picks whose settings the sidebar shows); spending, the mortgage, debts, life events and the assumptions are shared, and the plan runs until the younger of you reaches the Model to Age. While you both work, savings are what's left after household costs and fill both £20k ISAs before the GIA (held by the lower earner). Once either of you retires, any gap is drawn across both of you in tax order — each fills their own personal allowance and CGT exemption, then the ISAs, taxable GIA, and taxable pension drawn so both incomes rise together (both basic-rate bands fill before either pays higher rate). Married couples and civil partners get Marriage Allowance where it costs nothing
- **What if one of us dies?** — in couple mode, pick who dies and when to see the survivor's plan beside the plan with both alive. Household spending falls to the survivor's share (default 72%, from the Retirement Living Standards 2026), the deceased's pay, state pension and any annuity stop, and their money passes to the survivor: pensions to the nominated beneficiary (tax-free to draw if they died before 75, taxed as income after), ISAs as ISAs for a spouse but as cash for a cohabiting partner, investments with their base cost reset, and any DB survivor's pension. Couples living together pay inheritance tax at 40% above the £325,000 nil-rate band on savings and — from April 2027 — pensions (the home is left out), and without wills the survivor keeps only the pensions. In Monte Carlo each trial draws a death age for each of you from your own ONS cohort life table; "solvent for life" counts a shortfall only while one of you is alive, and the survivor's chance of running short is reported too
- **Protection** — in couple mode, list your life cover (level term, decreasing term or whole of life; on your life, your partner's, or joint paying on the first death; in trust or not; paying towards the mortgage or savings) with the premium from your policy or a quote, and each partner's death-in-service (a multiple of salary, paid only while working). Premiums are a household cost while each policy runs. In the "what if one of us dies?" plan the payouts reach the survivor — straight away and outside the estate if in trust, otherwise through the estate (taxed for a cohabiting couple) — and the panel shows the **cover gap**: how much more cover, paid on that death, would keep the survivor's plan from ever running short. Monte Carlo deaths pay out too. The app sizes cover but doesn't price it
- **Pension access age** — models the Normal Minimum Pension Age (NMPA; 55 today, rising to 57 in April 2028): if you retire before it, the pension is locked, spending is bridged from ISA/GIA until you reach it, and any gap shows as a shortfall. Marked on the chart alongside retirement and state pension ages
- **Voluntary Class 3 top-up** — optional auto top-up of the state pension: fills the gap toward the full 35 qualifying years by buying Class 3 NI for the years between retirement and state pension age (~£957/yr, 2026/27), funded from the pots via the normal drawdown order. Recomputes on every input change; only buys years it can reach the 10-year minimum with, never exceeds 35, and buys fewer years (never fabricating money) when the pots can't afford them
- **Lifetime annuity** — optionally convert part of the pension into income guaranteed for life, bought once at a chosen age (default 75; earliest is the pension access age). Sized by an income target in today's money: either **cover your essential expenses** (state pension + annuity, after tax, meet your essential spending) or a **fixed income**; if the pension can't afford the target it buys what it can. Inflation-linked (default) or level; the rate defaults to an illustrative UK table by age and type and can be overridden with a real quote. Taxed as income on top of the state pension; on the UFPLS path 25% of the pension used is paid tax-free first. Applies to both the central projection and Monte Carlo, where it reports how securely your **essentials are met for life** (mortality-weighted) — the figure an annuity protects — alongside the usual full-target solvency. Simplified: single life, no guarantee period, rate fixed at purchase
- **Essential expenses** — the non-negotiable part of your retirement target, shared by the spending-guardrails floor and the annuity's "cover essentials" sizing. Any guaranteed income (state pension + annuity) beyond a year's needs is saved rather than lost
- **Glide path** — configurable equity/bond split pre- and post-retirement, with a linear taper over a user-defined window (e.g. start de-risking 10 years before retirement, fully de-risked 5 years after)
- **Monte Carlo simulation** — stochastic fan chart showing p10–p90 outcome bands across hundreds of trials; uses a two-regime Markov model (normal/bear) with fat-tailed (t₅) market shocks and GARCH-like volatility persistence
- **Flexible retirement date** — optional behavioural model (Monte Carlo only): in trials where the plan is clearly off track at the target age — say a downturn has just cut into the ISA — keep working a few more years (up to a configurable cap) rather than retiring straight into the shortfall. Each trial re-checks affordability annually using *central* (expected) return assumptions, never peeking at its own future market path, and stops as soon as the plan looks fundable; on-track trials retire exactly on time. The de-risking glide path stays anchored to the original target age. Lifts the lower fan bands and lifetime-solvency figure, and reports how often — and by how much — retirement was postponed across trials. The central deterministic projection always retires at the target
- **Spending guardrails** — optional behavioural model (Monte Carlo only): flex retirement spending year by year toward what the pot can *sustainably* support. Each year the trial solves for the constant real spend its current pot could fund to the horizon under central assumptions (accounting for the state pension and pension-access age, never peeking at its own future returns); if actual spending has drifted above that level it is trimmed a step, and if it is comfortably below it is restored — bounded by a hard **floor** (your essential expenses) and a **ceiling** (% of target). At the default 100% ceiling this is "recovery only" — raises can undo earlier cuts but never exceed the target, so surpluses accrue as a bigger cushion; a higher ceiling turns on the prosperity rule (spend more in good times). Converts many would-be shortfalls into survivable spending squeezes — lifting lifetime solvency at the cost of a lower realised standard of living in bad trials, which a dedicated spending fan and summary make explicit. The central deterministic projection always spends the target
- **Lifetime solvency** — mortality-weighted probability of never running out of money *while alive*: each trial that runs dry is discounted by the chance you live to experience it, so dying with money left counts as success. Death rates come from the ONS projected cohort life tables (2024-based, UK) for your sex and year of birth, so they include projected improvements in life expectancy; the Simulation tab shows the resulting average lifespan. Shown alongside the simpler fixed-horizon figure, with a survival curve overlaid on the fan chart
- **Fiscal drag** — configurable bracket-creep: model frozen, inflation-linked, or real-terms-rising tax bands
- **Windfalls** — discrete life events (inheritance, asset sale, gift) that add money to the GIA at a chosen age; amounts are in today's money (net of fees/taxes), inflated to the event year, marked on the chart, and swept into ISA headroom over time
- **One-off expenses** — discrete outflows (house deposit, wedding, helping children) at a chosen age, funded in tax-efficiency order (unallocated savings → GIA → ISA, never the pension); unfundable amounts are reported as shortfalls, not borrowed
- **Working-hours changes** — discrete points where employment income steps to a percentage of full-time (part-time work, a phased ramp-down to retirement, or a career break). Income and both employee and employer pension contributions scale pro-rata, with tax, NI, student loan and savings following automatically; a year whose reduced pay falls below the NI Lower Earnings Limit stops counting toward the state pension. Marked ◆ on the chart
- **Deferred mortgage start** — the mortgage can begin at a future age to model a planned property purchase (pair with a one-off expense for the deposit); the balance is inflated to the purchase year
- **Real / nominal toggle** — switch between future cash values and today's purchasing power at any time
- **All balances / available funds toggle** — view the whole pot, or only money spendable at each age (the pension is excluded before its access age); a prompt flags when spendable funds run out while a locked pension keeps the total balance above zero
- **Year detail panel** — hover the chart to see a full breakdown of every money flow for that year
- **Phone layouts** — on a phone the chart stays on screen while you edit: beside the inputs in landscape, pinned above them in portrait, with only the inputs scrolling. Headline results sit in a one-line summary; the full result cards, Monte Carlo readouts and snapshot table, the view options, and undo/scenario actions are each one tap away, and tapping the chart shows that year's breakdown. Sliders get −/+ step buttons and long explanations fold away. Typed values apply after a short pause everywhere, without needing Enter
- **Export / import** — copy parameters as JSON and paste them back to save or share a scenario
- **Static site** — no server needed; deployable to GitHub Pages or any CDN

## Tax assumptions

Income tax bands, NI thresholds, student loan thresholds, the state pension and other allowances are based on **2026/27 rates** for **England, Wales & Northern Ireland** (income tax thresholds remain frozen at their 2025/26 levels). Scottish income tax rates are not modelled.

Pension balances (chart, table, result cards) are shown **before** the income tax due when the money is withdrawn — objective, and what a pension statement shows. Next to them, the result cards and year detail panel give a rough **≈ after-tax** figure: basic-rate (20%) tax on the taxable part of the pot. The taxable part itself is exact: all of it once the tax-free lump sum has been taken, otherwise everything except the 25% that can still come out tax-free (within the Lump Sum Allowance left). The 20% is a stated simplification, not a forecast — your real rate depends on your other income and how fast you draw. Spending, shortfalls and success rates don't use this estimate: every modelled withdrawal is taxed exactly.

Note for Plan 4 student loan users: Plan 4 loans are held by Scottish students, who typically pay **Scottish income tax** — which this model does not implement. Plan 4 repayments themselves (9% above the threshold) and interest are modelled correctly since they do not depend on income tax bands, but the income tax figures will follow rUK bands rather than Scottish ones.

## Why property equity is not modelled

The projection counts your **mortgage as a liability but never counts your home as an asset**. This asymmetry is deliberate, not an oversight:

- **The mortgage is a contractual cash-flow commitment.** It must be serviced every month regardless of what your house is worth, so it belongs in the projection as a real drain on income.
- **Home equity is not a drawable pot.** Accessing it means either downsizing (a discrete, costly event that depends on finding a buyer) or equity release (compound roll-up interest, age-gated loan-to-value caps). Neither resembles a smooth "draw £X per year" income stream, and modelling it as one would misrepresent how the money can actually be reached.
- **A safety net that hides failure defeats the tool's purpose.** The most useful output of the projection — especially the Monte Carlo view — is showing *when a plan fails*. If shortfalls were silently backfilled from home equity, a plan that only survives by consuming the roof over your head would look identical to one that genuinely works. The tool is designed to surface that distinction, not paper over it.

If you want to explore a downsizing scenario, add a **windfall** (Events tab) at the age you expect to sell, for the expected net proceeds in today's money after transaction costs. To model a future first purchase, add a **one-off expense** for the deposit and set the mortgage's **start age** (Mortgage tab) to the purchase year. The projection stays honest — the base case still shows any shortfall — while letting you compare outcomes side by side.

The same reasoning applies to defined benefit pensions and other illiquid assets: the headline net worth figure covers **pension + ISA + GIA minus debts** only.

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

## Versions and changelog

Every change is listed in [CHANGELOG.md](CHANGELOG.md), which the site shows under **What's new** in the footer. Versions follow [Semantic Versioning](https://semver.org): a **major** version means saved scenarios or pasted JSON from before it won't load, a **minor** version adds a feature or changes results, and a **patch** fixes things.

Ideas for what comes next live in [ROADMAP.md](ROADMAP.md), shown on the site under **Roadmap** — add one by editing the file.

To release a change, the pull request adds its entry at the top of `CHANGELOG.md` and sets the same version in `package.json` (a test checks they match). When it merges, the **Tag releases** workflow tags that commit `vX.Y.Z`. `releases.json` records the releases made before the workflow existed; `node scripts/tag-releases.mjs --dry-run` shows what would be tagged.

## Project structure

```
src/
  formatters.js           Shared GBP/percentage formatting utilities
  ukIncomeTax.js          Income tax calculator (2026/27, scalable for fiscal drag)
  ukNationalInsurance.js  NI calculator — Class 1 employee & employer
  ukStudentLoan.js        Student loan repayment (Plans 1, 2, 4, postgrad)
  ukDebt.js               Mortgage and unsecured debt amortisation
  ukISA.js                ISA contribution limits and constants
  ukGIA.js                GIA CGT model (annual exempt amount, basic/higher rates)
  ukPension.js            Pension: PCLS, annual-allowance taper, tax-optimal contribution solver, after-tax estimate
  ukDefinedBenefit.js     Defined benefit rules: early/late factors, commutation limit, 16× pension input, increases
  ukLifecycle.js          Lifecycle projection engine: the household year loop (spending, debts, events, drawdown order)
  ukLifecyclePerson.js    One person in the projection: pay and tax, pots, state/DB pensions, lump sums, drawdown steps
  ukEstate.js             A death in couple mode: inheritance tax, what passes to the survivor, the estate snapshot
  ukProtection.js         The cover gap: extra life cover a survivor would need (couple mode)
  changelog.js            Reads CHANGELOG.md for the in-app What's new panel
  ukMonteCarlo.js         Monte Carlo simulation — two-regime Markov model
  ukMortality.js          UK survival model (ONS cohort life tables) for lifetime solvency
  ukMortalityTable.js     ONS 2024-based cohort death rates by sex and year of birth (generated)
  ukAnnuity.js            Illustrative UK lifetime-annuity rates by age and type
  FanChart.jsx            Canvas-based stochastic fan chart React component
  App.jsx                 React UI — sidebar, charts, year-detail panel
scripts/
  build_ons_mortality_table.py  Regenerates ukMortalityTable.js from the ONS qx spreadsheet
  compare-engine.mjs            Checks the engine gives identical results to a git ref (for refactors)
  tag-releases.mjs              Tags each release vX.Y.Z on main (run by the Tag releases workflow)
```

Each `*.js` module (except `formatters.js` and the generated `ukMortalityTable.js`) has a corresponding `*.test.js` file with unit tests (no test framework dependency — plain Node assertions via `node:assert`).

When restructuring the engine without meaning to change any numbers, run `node scripts/compare-engine.mjs` (optionally a git ref, default `origin/main`, and `--count N`). It runs a few hundred seeded random scenarios — every feature, including invalid inputs and Monte Carlo runs — through both versions and reports the first difference.

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
