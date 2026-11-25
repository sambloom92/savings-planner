# Changelog

Every change to Savings Planner, newest first. Each release is tagged `vX.Y.Z` on the commit that shipped it, and numbered by [Semantic Versioning](https://semver.org):

- **Major** — the format of saved and copied JSON changes.
- **Minor** — a new feature, or a change to the model that changes results.
- **Patch** — fixes, wording and presentation.

Versions before 1.0.0 are the early history, up to couple mode. Each pull request adds its entry here and bumps the version in `package.json`; the release is tagged automatically when it merges.

## [2.0.0]

### Changed

- **The settings are laid out in four groups** across the top of the sidebar: **You**, **Partner** (with a partner), **Household** and **Assumptions** (#52).
  - You and Partner have the same four tabs: Personal, Pension, State pension, Savings. They hold only that person's inputs, so nothing disappears when you switch between them.
  - Household holds what you share: Spending, Home & debts, Events, Retirement, and with a partner, Couple and Protection.
  - Assumptions holds Economy, Investments and Monte Carlo.
  - Things that were in odd places have moved:
    - all spending is under Spending
    - sex (for life expectancy), working-hours changes and death-in-service are under Personal
    - the student loan is under Savings
    - spending guardrails are under Spending, and working longer if off track is under Retirement; both say they're Monte Carlo only
  - The Bank of England base rate is set once, under Economy. A tracker mortgage or debt shows it, with a link there.
- **Labels are in plain English and sentence case**, for example:
  - _Retirement spending_ (was Target Net Annual Expenses)
  - _Plan until age_ (was Model to Age)
  - _Tax-free lump sum_ (was PCLS)
  - _Amount originally invested_ (was GIA Cost Basis)
  - _National Insurance years so far_ (was NI Qualifying Years)
- **Saved and copied JSON follows the new layout** (schema version 2), with names that match the labels: `you.personal.salary`, `household.spending.retirementSpending`, `assumptions.economy.inflationPct`. JSON saved by earlier versions still loads, and plans saved in your browser carry over. JSON copied from 2.0.0 won't load in earlier versions.

### Added

- **Each of you chooses your own tax-free lump sum** (Pension tab); it was one choice for both. Plans saved before keep the old choice for both of you (#52).

## [1.7.1]

### Fixed

- Monte Carlo is much faster, with the same results (#51):
  - **Spending guardrails** were most of the work. Each retirement year of each trial, they worked out the sustainable spend by trying 30 spends, each projected to the end of the plan. They now prepare each year's figures once, and settle "cut, raise or hold" with one or two tries; the full 30-try search runs only when spending is right at a threshold, so every decision is unchanged.
  - **Trials run on several processor cores at once**, in a pool of Web Workers, instead of one.
  - For a couple planning to 110 with guardrails and 1,000 trials, a run took about 4 seconds in the browser and now takes about 1.4 on a 4-core computer, and less on one with more cores.

## [1.7.0]

### Changed

- In couple mode, while one of you has retired and the other still works, household spending is now halfway between your living costs and your retirement target. It used to stay at living costs until you'd both retired, so a partner working longer could make the plan look worse: their extra pay mostly went on that spending, which couldn't flex in bad markets. A new Household tab setting, _Spending while one of you works_, picks living costs, halfway or the retirement target, and shows the amount. Plans where you retire years apart will see different results (#50).

## [1.6.0]

### Added

- A _Together / Just me_ switch for couples, to compare the household plan with where you'd stand on your own (say, if you split up) without changing any inputs. _Just me_ keeps your own pay, pensions and savings, takes your share of the mortgage, other debts, windfalls and one-off expenses (default 50%, set in the Household tab), and puts living costs and retirement spending at the one-person rate (default 72% of the household's, the same setting the survivor's plan uses). Monte Carlo follows the switch. On a phone it's in the ⋯ menu, and the summary strip says when _Just me_ is on (#49).

### Changed

- The header's household switch reads _Plan for: On my own / With a partner_ (it was _Just me / Couple_), since _Just me_ is now the view switch (#49).

## [1.5.1]

### Fixed

- The app responds quickly again. Monte Carlo now runs in the background, so dragging a slider no longer freezes the page while each run finishes: in couple mode with 1,000 trials, a few seconds of dragging used to lock the page for several seconds at a time. A change made during a run now replaces it. Moving the mouse over the chart redraws only the year detail, and numbers are formatted with one shared formatter. Results are unchanged (#47).

## [1.5.0]

### Changed

- Announced and legislated changes (#46):
  - Income tax and NI thresholds stay frozen until April 2031, as the 2025 and 2026 Budgets set out, instead of rising with inflation from 2027. The fiscal drag setting applies from 2031/32. This means more tax than before in most plans.
  - The state pension age follows the law for your year of birth: 66 if born before 1961, 67 for 1961–1977 and 68 from 1978. It was 67 for everyone. Scenarios saved with the old default of 67 switch to the legal age; any other age you chose is kept.
  - From April 2029, salary sacrifice into a pension above £2,000 a year is charged employee NI. The year detail shows the extra.

## [1.4.0] — 2026-11-24

### Added

- Married couples and civil partners use both people's allowances on either one's investments, as moving investments between them costs no CGT: both £3,000 CGT allowances when selling in retirement and when realising gains each year, and the second £20k ISA allowance through bed and ISA, as far as the CGT allowance covers. Only moves that cost no tax now are made, so results can only improve (#45).
- A partner with little or no pay gets pension tax relief: £2,880 a year from the household's savings goes into their pension, topped up to £3,600 by basic-rate relief, until they're 75, take tax-free cash or start drawing (#45).

## [1.3.0] — 2026-11-24

### Added

- A roadmap of ideas for what comes next, starting with tutorial mode and the proposed triple lock changes. It's on the site under Roadmap in the footer, and anyone can suggest ideas by editing `ROADMAP.md` (#42).

## [1.2.0] — 2026-11-24

### Added

- A changelog: this page, with every change since the first version, and a version tag on each release. The site's footer shows the version and opens the changelog, with a dot when there's something new since your last visit (#41).

## [1.1.0] — 2026-11-24

### Added

- Protection, in couple mode (#40):
  - life cover policies — level term, decreasing term or whole of life; on your life, your partner's, or joint (pays on the first death); in trust or not; paying towards the mortgage or savings — with their premiums as a household cost
  - death-in-service for each of you, as a multiple of salary, paid only while working
  - in "What if one of us dies?": the payouts, and the cover gap — how much more cover, paid on that death, would keep the survivor's plan from ever running short

## [1.0.1] — 2026-11-24

### Fixed

- In couple mode, the survival curve on the Monte Carlo chart is labelled "P(at least one alive)", since that's what it shows (#44).

## [1.0.0] — 2026-11-24

### Added

- Couple mode: plan for two (#39). Each of you has your own pay, tax, pensions, savings, state pension and retirement age; spending, the mortgage, debts and life events are shared. Savings fill both £20k ISAs, and in retirement the drawdown uses both personal allowances, both CGT exemptions and both basic-rate bands. A retiree whose personal allowance would otherwise go unused (say their partner still works) draws pension up to it each year, tax-free, and saves it. Marriage Allowance for married couples and civil partners.
- "What if one of us dies?" (#39): the survivor's plan beside the plan with both alive. Spending falls to the survivor's share (default 72%, from the Retirement Living Standards 2026); pensions, ISAs and investments pass to the survivor by the rules for married or cohabiting couples, including inheritance tax for couples living together and the effect of wills; DB schemes pay a survivor's pension.
- Monte Carlo draws a death age for each of you from your own life table, and reports how often the survivor runs short (#39).

## [0.28.0] — 2026-11-24

### Changed

- The £3,000 capital gains tax allowance is used every year, not only when you sell. Whatever the year's sales leave of it is used at the year end to realise gains and reinvest, which raises the base cost so those gains are never taxed. The year detail shows the gains realised (#43).

## [0.27.2] — 2026-11-23

### Changed

- The projection engine is split into a person and a household, ready for couple mode. No results change (#38).

## [0.27.1] — 2026-11-23

### Added

- A line-chart icon in the browser tab (#37).

## [0.27.0] — 2026-11-23

### Added

- Defined benefit pensions (#36): schemes still building up, left, or already paid, with accrual, revaluation, early and late payment, tax-free cash at the scheme's commutation factor, and the annual allowance at 16× the build-up. DB and DC tax-free cash share one Lump Sum Allowance.

## [0.26.0] — 2026-11-23

### Changed

- Survival comes from the ONS projected cohort life tables (2024-based) for your sex and year of birth, so lifetime solvency includes expected improvements in life expectancy. The Simulation tab shows your average lifespan (#35).

## [0.25.1] — 2026-09-28

### Fixed

- Long help tooltips are readable: they position themselves to fit, scroll, can be pinned open, and open as a sheet on phones (#33).

## [0.25.0] — 2026-09-28

### Added

- Phone layouts that keep the chart on screen while you edit: beside the inputs in landscape, pinned above them in portrait (#32).

## [0.24.1] — 2026-09-28

### Changed

- The annuity's chart marker is a reference line, and the retirement line is labelled as a target when the date is flexible (#31).

### Fixed

- The page no longer scrolls sideways at phone width (#31).

## [0.24.0] — 2026-09-28

### Changed

- Pension balances are labelled as before tax, with an estimate of what they're worth after income tax on the result cards and in the year detail (#30).

## [0.23.0] — 2026-09-28

### Changed

- Tax rates, thresholds and the state pension updated to 2026/27 (#29).

## [0.22.0] — 2026-09-28

### Changed

- State pension: the extra from deferring rises with CPI rather than the triple lock, the on-track check counts the deferral, and if you work past state pension age the pension is paid on top of your salary and you stop paying employee NI (#28).

## [0.21.0] — 2026-09-28

### Added

- Lifetime annuity: buy guaranteed income for life at a chosen age, sized to cover your essential spending or a fixed income, with Monte Carlo reporting how securely your essentials are met (#27).

## [0.20.1] — 2026-09-25

### Fixed

- Typing a value into the guardrail sliders (and bear-market severity) (#26).

## [0.20.0] — 2026-09-25

### Added

- Spending guardrails in Monte Carlo: retirement spending flexes toward what the pot can sustain, between your essential floor and a ceiling (#25).

## [0.19.0] — 2026-09-25

### Added

- Flexible retirement date in Monte Carlo: keep working a few more years in trials that are off track at the target age (#24).

## [0.18.0] — 2026-09-24

### Added

- Voluntary Class 3 top-up: buy National Insurance years between retirement and state pension age to reach the full state pension (#23).

## [0.17.0] — 2026-09-14

### Added

- The annual savings implied by your income and living expenses are shown under the living-expenses input (#22).

## [0.16.0] — 2026-09-14

### Added

- A warning when a manual pension contribution breaches the annual allowance (#21).

## [0.15.0] — 2026-09-13

### Changed

- The Auto contribution targets protecting your personal allowance (taxable income down to £100,000) and matches the employer's threshold (#20).

## [0.14.0] — 2026-09-13

### Added

- Auto (tax-optimal) employee pension contribution, and matched employer contributions (#19).

## [0.13.1] — 2026-09-12

### Fixed

- The projection starts from the current year by the system clock, so year labels stay right as time passes (#18).

## [0.13.0] — 2026-09-12

### Added

- Working-hours changes: part-time work, a phased run-down to retirement or a career break, from a chosen age (#17).

## [0.12.2] — 2026-09-12

### Changed

- The available-funds prompt says that it's about some Monte Carlo trials, not all of them (#16).

## [0.12.1] — 2026-09-12

### Fixed

- Running out of spendable money before the pension can be accessed counts as running short, and the shortfall markers no longer mislead (#15).

## [0.12.0] — 2026-09-11

### Added

- The minimum pension access age: retire before it and spending is bridged from your ISA and GIA until the pension unlocks (#14).

## [0.11.1] — 2026-09-07

### Fixed

- The solvent-for-life readout no longer overflows the chart header on phones (#13).

## [0.11.0] — 2026-07-21

### Added

- Lifetime solvency in Monte Carlo: the chance of never running out of money while you're alive, weighting each shortfall by your chance of being alive then (#12).

## [0.10.0] — 2026-07-21

### Added

- Undo and redo for your inputs (#11).

## [0.9.0] — 2026-07-15

### Added

- An on/off switch for each windfall and one-off expense, to compare plans without deleting them (#10).

## [0.8.0] — 2026-07-15

### Added

- Life events: windfalls, one-off expenses, and a mortgage that starts at a future age (#9).

## [0.7.0] — 2026-07-07

### Changed

- More accurate tax (#8): the personal allowance tapers away above £100,000 (the 60% band to £125,140), the annual allowance tapers for high earners, state pension deferral adds about 5.8% a year, capital gains use the basic-rate band left after income, and NI thresholds were corrected.

## [0.6.0] — 2026-05-11

### Changed

- Monte Carlo rates average out to the rates you set over full economic cycles, instead of counting bear markets twice (#7).

## [0.5.1] — 2026-05-11

### Fixed

- Pre-retirement savings in the Monte Carlo simulation.

## [0.5.0] — 2026-05-11

### Changed

- Savings before retirement come from your take-home pay minus debts and living expenses, instead of being entered directly.

## [0.4.2] — 2026-05-10

### Added

- A link to the source code (#5).

## [0.4.1] — 2026-05-10

### Fixed

- The log-scale axis (#4).

## [0.4.0] — 2026-05-10

### Added

- A log scale for the chart (#3).

### Changed

- Documentation (#2).

## [0.3.0] — 2026-05-10

### Added

- Monte Carlo simulation: a fan chart of outcomes across hundreds of trials (#1).
- An adjustable glide path for de-risking investments around retirement (#1).

## [0.2.0] — 2026-05-07

### Added

- The 4% rule line on the chart.

### Changed

- The totals at retirement say whether they're at the start or end of the year.

### Fixed

- Rounding applied too early in some calculations.

## [0.1.0] — 2026-05-04

### Added

- The first version: a year-by-year projection of pay, pension contributions, ISA and GIA savings, the mortgage, debts and student loan to retirement, then tax-efficient drawdown across pension, ISA and GIA with the state pension; fiscal drag; real and nominal views; a year-detail panel; and saving scenarios as JSON.
