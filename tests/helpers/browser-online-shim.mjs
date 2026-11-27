// Test-only. Under `test-sandbox --net none` Chromium has only a loopback interface, so navigator.onLine is false in
// every page, and context.setOffline(false) cannot change that. The Faravan UI reads navigator.onLine once at mount and
// then follows window 'online'/'offline' events (ui/v1/src/main.jsx), so it shows its offline banner and holds the
// actions that need the computer. This shim makes a page report what the test asked for: online, unless the test asked
// for offline (context.setOffline(true), or newContext({offline: true})).
//
// The shim is installed in a document that starts with navigator.onLine false. A document that starts offline because
// the test asked for it stays offline: the shim starts the page offline without an event. Where the browser already
// reports online, nothing is installed and the browser's own emulation and events run as before. A test that calls setOffline(true) still reads offline and gets the 'offline' event; setOffline(false) gets
// the 'online' event back.
//
// installOnlineShim(browserType) wraps launch() on that object, so every context it creates gets the shim. Call it once
// for each BrowserType that opens the Faravan UI: the Playwright configs, and each direct launcher. Calling it twice on
// the same object is a no-op.

const installed = new WeakSet();

// Runs in every new document before the page's own scripts. Starts silently: a page that starts offline gets no event.
function installPageShim() {
  if (window.__faravanOnlineShim || navigator.onLine !== false) return;
  let online = true;
  Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => online});
  window.__faravanOnlineShim = {
    start(value) { online = value; },
    set(value) {
      if (online === value) return;
      online = value;
      window.dispatchEvent(new Event(value ? 'online' : 'offline'));
    },
  };
}

// These two are serialized into the page, so they must not refer to anything in this module.
const setStartState = value => window.__faravanOnlineShim?.start(value);
const setPageState = value => window.__faravanOnlineShim?.set(value);

async function shimContext(context, options) {
  let online = !options?.offline;
  await context.addInitScript(installPageShim);
  // Each later document starts in the state the test last asked for. Init scripts cannot be removed, so an
  // added script simply overrides the earlier one.
  if (!online) await context.addInitScript(setStartState, online);
  const setOffline = context.setOffline.bind(context);
  context.setOffline = async offline => {
    await setOffline(offline);
    if (online === !offline) return;
    online = !offline;
    await context.addInitScript(setStartState, online);
    await Promise.all(context.pages().map(page => page.evaluate(setPageState, online).catch(() => {})));
  };
}

export function installOnlineShim(browserType) {
  if (installed.has(browserType)) return;
  installed.add(browserType);
  const launch = browserType.launch.bind(browserType);
  browserType.launch = async (...args) => {
    const browser = await launch(...args);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      await shimContext(context, options);
      return context;
    };
    return browser;
  };
}
