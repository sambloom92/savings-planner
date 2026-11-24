# Changelog

Every change to Savings Planner, newest first. Each release is tagged `vX.Y.Z` on the commit that shipped it, and numbered by [Semantic Versioning](https://semver.org):

- **Major** — saved scenarios or pasted JSON from an earlier version no longer load.
- **Minor** — a new feature, or a change to the model that changes results.
- **Patch** — fixes, wording and presentation.

Versions before 1.0.0 are the early history, up to couple mode. Each pull request adds its entry here and bumps the version in `package.json`; the release is tagged automatically when it merges.

## [1.2.0]

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
