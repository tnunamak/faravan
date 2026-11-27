import { Sidebar, TabBar, Brand, Avatar, SideSearch, ThisComputer } from './ds/index.mjs';
import { NAV_ITEMS, navCurrent } from './helpers.mjs';
import { machineVM, needsYouCount, setupVM } from './view-models.mjs';
import { enc, circleName } from './shared.jsx';

const items = (count, setupProgress) =>
  NAV_ITEMS.map((item) => ({ ...item, href: '#/' + item.page, count: item.page === 'home' ? count : 0,
    progress: item.page === 'lend' && setupProgress }));

// Sidebar on desktop, bottom tab bar on phones (the 900 px switch is in shell.css).
// The page head is one element: a title row on desktop, the sticky top bar with the avatar on phones.
// There is no circle picker here: circles are a page of their own and a row in the sidebar.
// The element the "Skip to content" link focuses: the start of the main column, so the page heading and the
// connection banner stay in the reading order after it.
export const SKIP_TARGET = 'main-content';

export function Shell({ route, home, devices, approvals, jobs, circles = [], title, subtitle, headingRef, headAction, phoneAction, onSearch, banner, readiness, agents, lendingReadiness = null, lendingReadinessError = false, unavailable, sessionEnded = false, children }) {
  const circle = circles.find(item => item.id === (home?.lending?.circle || home?.circle));
  const setup = readiness && agents ? setupVM({readiness, agents, status:home, devices, circle, lendingReadiness, lendingReadinessError}) : null;
  // Until the lending checks have answered, the dot would be a guess; a failed read leaves it on, as the Setup page does.
  const setupProgress = setup?.kind === 'checklist' && setup.ready === false && (lendingReadiness !== null || lendingReadinessError);
  const nav = items(needsYouCount({ approvals, home, readiness, agents, jobs }), setupProgress),
    current = navCurrent(route.page),
    profileCurrent = route.page === 'settings' ? 'page' : undefined,
    machine = machineVM(home, devices, { readiness, agents, approvals, jobs, unavailable }),
    owner = devices?.ownerName;
  const scopedMachineHold = (route.page === 'circles' || route.page === 'circle' || route.page === 'jobs') && machine.kind === 'need';
  const canRaiseLimit = machine.href === '#/lend/limits/owner-limit';
  return (
    <div class="app swing-app">
      <Sidebar
        items={nav}
        current={current}
        brand={<Brand />}
        search={<SideSearch data-telemetry-control="open-search" href="#/jobs" onOpen={onSearch} />}
        foot={
          <>
            {scopedMachineHold ? (
              canRaiseLimit ? (
                <a class="side-link" href={machine.href}>Raise limit for {machine.name}</a>
              ) : (
                <a class="side-link" href="#/lend">{machine.name}</a>
              )
            ) : (
              <ThisComputer {...machine} href={machine.href || "#/lend"} />
            )}
            <a data-telemetry-control="open-profile" class="side-link" href="#/you" aria-current={profileCurrent}>
              <Avatar personName={owner} id={devices?.fingerprint} size="sm" />
              You
            </a>
          </>
        }
      >
        {circles.length > 0 && (
          <>
            <div class="side-h">Your circles</div>
            {circles.map((c) => (
              <a
                class="side-link ph-no-capture" data-telemetry-private="shell-circle"
                href={'#/circle/' + enc(c.id)}
                aria-current={route.page === 'circle' && route.id === c.id ? 'page' : undefined}
              >
                <Avatar groupName={circleName(c)} id={c.id} size="sm" />
                {circleName(c)}
              </a>
            ))}
          </>
        )}
      </Sidebar>
      <div class="main" id={SKIP_TARGET} tabIndex="-1">
        {title && (
          <header class="page-head">
            <div class="page-heading ph-no-capture" data-telemetry-private="shell-heading">
              <h1 class="t-page" ref={headingRef} tabIndex="-1">
                {title}
              </h1>
              {subtitle && <p class={"t-sm t-2 page-sub"+(route.page==='home'?' home-summary':'')}>{subtitle}</p>}
            </div>
            <div class="hstack-2 page-head-actions">
              {headAction}
              <span class="phone-only">
                <a data-telemetry-control="open-profile" href="#/you" class="hit" aria-current={profileCurrent}>
                  <Avatar personName={owner} id={devices?.fingerprint} />
                  <span class="sr">You</span>
                </a>
              </span>
            </div>
          </header>
        )}
        {!title && (
          <div class="phone-profile-row">
            <a href="#/home" class="phone-brand" aria-label="Faravan home"><Brand inline /></a>
            <a data-telemetry-control="open-profile" href="#/you" class="phone-profile-link" aria-current={profileCurrent}>
              <Avatar personName={owner} id={devices?.fingerprint} size="sm" />
              <span class="sr">You</span>
            </a>
          </div>
        )}
        {phoneAction && <div class="phone-action">{phoneAction}</div>}
        {banner}
        {children}
      </div>
      {!sessionEnded && <TabBar items={nav} current={current} />}
    </div>
  );
}
