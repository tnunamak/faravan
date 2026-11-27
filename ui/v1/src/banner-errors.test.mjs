import test from 'node:test';
import assert from 'node:assert/strict';
import {bannerErrors} from './banner-errors.mjs';
import {connectionVM} from './view-models.mjs';

const err = (status, code) => Object.assign(new Error(code), {status, code});

test('a 409 network_error on the Jobs list is the circle host not answering; the page cards say so, the banner does not repeat it', () => {
  for (const code of ['network_error', 'unavailable', 'transport_error'])
    assert.equal(connectionVM({errors: bannerErrors({jobs: err(409, code)})}), null, code);
});
test('a 409 conflict still reaches the banner, without a raw status', () => {
  const vm = connectionVM({errors: bannerErrors({jobs: err(409, 'host_too_old')})});
  assert.match(vm.text, /Check the current state before taking another action/);
  assert.doesNotMatch(vm.text, /error 4|409/);
  assert.doesNotMatch(vm.details, /409/);
});
test('a server error loses its status in the banner; a lost session keeps its 401 wording', () => {
  assert.doesNotMatch(connectionVM({errors: bannerErrors({circles: err(500, 'x')})}).text, /error 500|500/);
  assert.equal(connectionVM({errors: bannerErrors({jobs: err(401, 'unauthorized')})}).kind, 'session');
});
test('errors that are not errors are dropped', () => {
  assert.deepEqual(bannerErrors({home: undefined}), {});
});
test('cancelled reads stay invisible through the full banner adapter',()=>{
  assert.equal(connectionVM({connected:true,errors:bannerErrors({jobs:{name:'AbortError'}})}),null);
});
test('a top-level devices timeout remains visible in the connected app shell',()=>{
  assert.equal(connectionVM({connected:true,errors:bannerErrors({devices:{code:'read_timeout'}})}).kind,'error');
});
test('core timeouts, devices errors and 401 still show',()=>{
  assert.equal(connectionVM({connected:true,errors:bannerErrors({home:{code:'read_timeout'}})}).kind,'error');
  assert.equal(connectionVM({connected:true,errors:bannerErrors({devices:err(500,'x')})}).kind,'error');
  assert.equal(connectionVM({connected:true,errors:bannerErrors({devices:err(401,'unauthorized')})}).kind,'session');
  assert.equal(connectionVM({connected:true,errors:bannerErrors({devices:{code:'read_timeout'},home:{code:'read_timeout'}})}).kind,'error');
});
