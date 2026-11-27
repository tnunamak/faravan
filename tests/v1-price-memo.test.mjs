import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {currentPriceCatalog, withPriceCatalog, priceListUsd, worstCallUsd, claudeCallHeadroomUsd, emptyTokens,
  effectivePriceCatalog, setLiveListPrices} from '../lib/v1/lending-meter.mjs';
import {lendableModelsFor} from '../lib/v1/lender-pace50.mjs';
import {lookupPriceRow, contextPriceTiers} from '../lib/v1/litellm-prices.mjs';
import {macPriceCatalogs} from './helpers/mac-price-catalogs.mjs';

// The pre-memo arithmetic, independently evaluated on every call. No cached helper is used here.
function freshWorst(catalog, model, {maxPromptTokens, maxOutputTokens}) {
  const hit = lookupPriceRow(catalog.data.list_usd, model);
  if (!hit) return null;
  const prompts = new Set([maxPromptTokens, ...contextPriceTiers(hit[1])
    .flatMap(tier => [tier.threshold,tier.threshold+1]).filter(prompt => prompt <= maxPromptTokens)]);
  let worst = 0;
  for (const prompt of prompts) for (const cls of ['fresh_input','cache_read','cache_write_5m','cache_write_1h']) {
    const tokens = {...emptyTokens(),[cls]:prompt,output:maxOutputTokens};
    worst = Math.max(worst,priceListUsd(model,tokens,{catalog,calls:[{...tokens,prompt}]}).usd);
  }
  return worst;
}
function freshHeadroom(catalog, model) {
  const hit = lookupPriceRow(catalog.data.list_usd,model);
  return hit ? freshWorst(catalog,model,{maxPromptTokens:hit[1].max_input_tokens??1000000,maxOutputTokens:128000}) : null;
}

test('memo results are bit-identical to fresh arithmetic for every priced model and catalog', t => {
  const {stored,merged,rawRows,convertedRows,rawBytes} = macPriceCatalogs();
  assert.equal(rawRows,4554);
  assert.equal(Object.keys(stored.data.list_usd).length,49);
  assert.equal(Object.keys(merged.data.list_usd).length,49);
  t.diagnostic(JSON.stringify({rawRows,convertedRows,rawBytes,effectiveRows:49,claudeRows:21}));
  for (const catalog of [currentPriceCatalog(),stored,merged]) withPriceCatalog(catalog, () => {
    // Two passes exercise cold misses, warm hits, historical/current switching and all context thresholds.
    for (let repeat=0;repeat<2;repeat++) for (const id of Object.keys(catalog.data.list_usd)) {
      for (const model of [id,'anthropic/'+id+'[1m]',id+'-dated-2099']) {
        const expected = freshHeadroom(catalog,model);
        assert.ok(Object.is(claudeCallHeadroomUsd(model),expected),model);
        for (const maxPromptTokens of [0,100000,200000,200001,1000000]) {
          const limits = {maxPromptTokens,maxOutputTokens:128000};
          assert.ok(Object.is(worstCallUsd(model,limits),freshWorst(catalog,model,limits)),model);
        }
      }
    }
    for (const ownerCapUsd of [null,0,1,10,50,Infinity,NaN]) {
      const fresh = Object.keys(catalog.data.list_usd).filter(model => {
        const headroom = freshHeadroom(catalog,model);
        return model.startsWith('claude-') && Number.isFinite(headroom) &&
          (!Number.isFinite(ownerCapUsd) || headroom < ownerCapUsd);
      });
      assert.deepEqual(lendableModelsFor('claude',{ownerCapUsd}),fresh);
      lendableModelsFor('claude',{ownerCapUsd}).pop();
      assert.deepEqual(lendableModelsFor('claude',{ownerCapUsd}),fresh,'callers cannot mutate the cached list');
    }
  });
});

test('live replacement and historical scopes cannot reuse a different catalog\'s memo', () => {
  const original = currentPriceCatalog(), model = 'claude-sonnet-5-5';
  const old = withPriceCatalog(original,()=>claudeCallHeadroomUsd(model));
  try {
    setLiveListPrices({[model]:{provider:'anthropic',fresh_input_per_m:100,output_per_m:200}});
    assert.notEqual(currentPriceCatalog(),original);
    assert.notEqual(claudeCallHeadroomUsd(model),old);
    assert.equal(withPriceCatalog(original,()=>claudeCallHeadroomUsd(model)),old);
    withPriceCatalog(effectivePriceCatalog(),()=>assert.equal(claudeCallHeadroomUsd(model),old));
  } finally {setLiveListPrices({});}
});
