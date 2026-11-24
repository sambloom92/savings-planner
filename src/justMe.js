/**
 * The "Just me" view of a couple's plan: where one partner would stand on
 * their own, for example if they split up.
 *
 * Works on the app's inputs (the household's settings, with the partner's own
 * under `partner`) and returns a one-person version of them:
 * - your own pay, pensions and savings, as entered
 * - `yourSharePct` of the mortgage, other debts, windfalls and one-off
 *   expenses: amounts you'd genuinely owe or receive
 * - living costs, the retirement spending target and essential spending at
 *   `survivorSpendingPct` of the household's: the one-person rate also used
 *   for a survivor. Living alone costs more than half of what two spend
 *   together (Retirement Living Standards; the OECD equivalence scale gives
 *   about two-thirds).
 * - no annuity if it would be bought from the partner's pension
 *
 * The inputs themselves aren't changed, so switching views needs no edits.
 */
export function justMeInputs(p) {
  const share = p.yourSharePct / 100;
  const onePerson = p.survivorSpendingPct / 100;
  const shareOf = (events) => events.map((e) => ({ ...e, amount: e.amount * share }));
  return {
    ...p,
    householdMode: 'single',
    annualLivingExpenses: p.annualLivingExpenses * onePerson,
    targetNetExpenses: p.targetNetExpenses * onePerson,
    essentialExpenses: p.essentialExpenses * onePerson,
    mortgageBalance: p.mortgageBalance * share,
    mortgageOverpayment: p.mortgageOverpayment * share,
    unsecuredBalance: p.unsecuredBalance * share,
    unsecuredMonthly: p.unsecuredMonthly * share,
    windfalls: shareOf(p.windfalls),
    oneOffExpenses: shareOf(p.oneOffExpenses),
    annuityEnabled: p.annuityEnabled && p.annuityOwner !== 'partner',
  };
}
