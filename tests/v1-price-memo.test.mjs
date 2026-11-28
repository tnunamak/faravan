import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {currentPriceCatalog, withPriceCatalog, claudeCallHeadroomUsd, effectivePriceCatalog, setLiveListPrices} from "../lib/v1/lending-meter.mjs";

// The pre-memo arithmetic, independently evaluated on every call. No cached helper is used here.

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
