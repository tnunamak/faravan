import {randomUUID} from 'node:crypto';

// One synthetic account for protocol/store tests that do not execute provider work.
export const fixtureAccounts=(providerId='codex',modelId='example-model')=>[{
  accountId:'fixture-account',providerId,models:[{id:modelId,enabled:true,efforts:[],defaultEffort:null}]}];
export const accountHeartbeat=accounts=>({boot:randomUUID(),seq:0,intent:{state:'ready'},
  execution:{state:'idle'},blockers:[],agents:[],capabilities:['run_request_v1'],accounts});

export const fixtureAccountOffers=(accounts=fixtureAccounts())=>accounts.flatMap(account=>account.models.filter(model=>model.enabled).map(model=>({providerId:account.providerId,modelId:model.id,effortIds:model.efforts.map(effort=>effort.id)})));
