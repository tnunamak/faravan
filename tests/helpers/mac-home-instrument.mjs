// Test-only source instrumentation. Kept outside production modules and their public APIs.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const names = url.endsWith('/lib/v1/app.mjs') ? ['homeView'] :
    url.endsWith('/lib/v1/lender-pace50.mjs') ? ['lendableModelsFor'] :
    url.endsWith('/lib/v1/lending-meter.mjs') ? ['claudeCallHeadroomUsd','worstCallUsd','calculateWorstCallUsd','priceListUsd'] :
    url.endsWith('/lib/v1/litellm-prices.mjs') ? ['lookupPriceRow'] : [];
  if (!names.length) return result;
  let source = String(result.source);
  for (const name of names) source = source.replace(new RegExp('(function '+name+'\\([\\s\\S]*?\\) \\{)'),
    '$1 globalThis.__macHomeCalls?.hit('+JSON.stringify(name)+');');
  return {...result,source};
}
