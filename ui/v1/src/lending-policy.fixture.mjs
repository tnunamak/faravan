// Server-shaped examples for the objective explanation shown on the lending settings page.
export const ZONE = 'America/Chicago';
export const NOW = Date.parse('2026-10-22T04:00:00Z');

export function mockFixture() {
  return {machineCapacity:3, migration:null, accounts:[
    {id:'claude', provider:'claude', label:'Claude', decision:{admitted:true, reason:'objective_lend', objective:{
      schemaVersion:1, policyVersion:'objective/m1', admission:'allowed', reasonCode:'objective_lend',
      strategyId:'automatic', strategyExplanation:'Automatic uses finite whole-week history at week boundaries, or the configured demand model.',
      reasonText:'Lending under the declared demand model.',
      protectionSource:{seven_day:'model',five_hour:'model'}, demandModelId:'model-i-reference',
      demandModelLabel:'Model I reference only: integer unit-point demand (b=1); not empirically calibrated.', nativeMaxBudgetUsd:1.68}}},
    {id:'codex', provider:'codex', label:'Codex', decision:{admitted:true, reason:'objective_lend', objective:{
      schemaVersion:1, policyVersion:'objective/m1', admission:'allowed', reasonCode:'objective_lend',
      strategyId:'automatic', strategyExplanation:'Automatic uses finite whole-week history at week boundaries, or the configured demand model.',
      reasonText:'Lending after protecting the history band.', protectionSource:{weekly:'history',short:'history'},
      nativeMaxBudgetUsd:2.5}}},
  ]};
}
