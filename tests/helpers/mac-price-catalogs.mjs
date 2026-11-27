// Synthetic shapes only: no captured user catalog or credentials.
import {effectivePriceCatalog} from '../../lib/v1/lending-meter.mjs';
import {parseLiteLLM} from '../../lib/v1/litellm-prices.mjs';

export function macPriceCatalogs() {
  const aliases = Object.fromEntries(Array.from({length:4}, (_, i) => ['gpt-6-synthetic-'+i,
    {provider:'openai',max_input_tokens:200000,fresh_input_per_m:4+i,output_per_m:20+i}]));
  const stored = effectivePriceCatalog(aliases);
  const document = {};
  for (const [model, row] of Object.entries(stored.data.list_usd)) document[model] = {
    litellm_provider:row.provider, mode:'chat',max_input_tokens:300000,
    input_cost_per_token:0.00002,output_cost_per_token:0.0001,
    input_cost_per_token_above_200k_tokens:0.00004,output_cost_per_token_above_200k_tokens:0.00015,
  };
  for (let i=Object.keys(document).length;i<4554;i++) document['embedding-or-image-'+i] = {
    litellm_provider:i%2 ? 'openai' : 'other',mode:i%2 ? 'embedding' : 'image_generation',
    input_cost_per_token:0.000001,output_cost_per_token:0.000001,description:'synthetic metadata '.repeat(20),
  };
  const converted = parseLiteLLM({attempted_at:0,document});
  return {stored, merged:effectivePriceCatalog(converted), rawRows:Object.keys(document).length,
    convertedRows:Object.keys(converted).length,rawBytes:Buffer.byteLength(JSON.stringify({attempted_at:0,document}))};
}
