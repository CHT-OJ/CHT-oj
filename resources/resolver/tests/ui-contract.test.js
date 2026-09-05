import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("award configuration does not permanently recolor ranking rows", async () => {
  const [css, page] = await Promise.all([
    readFile(new URL("../resolver.css", import.meta.url), "utf8"),
    readFile(new URL("../page.js", import.meta.url), "utf8"),
  ]);
  assert.equal(css.includes("resolver-row--award"), false);
  assert.equal(page.includes("resolver-row--award"), false);
  assert.equal(page.includes("resolver-row--award-first"), false);
});

test("avatar and logo visuals keep separate shapes", async () => {
  const css = await readFile(new URL("../resolver.css", import.meta.url), "utf8");
  assert.match(css, /\.resolver-contestant__avatar\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(
    css,
    /\.resolver-contestant__identity \.resolver-contestant__visual--logo\s*\{[^}]*border-radius:\s*0\.15rem/s,
  );
  assert.match(css, /\.resolver-contestant__visual--logo img\s*\{[^}]*object-fit:\s*contain/s);
});

test("presenter setup keeps engine details advanced and the HUD hidden by default", async () => {
  const template = await readFile(
    new URL("../../../templates/contest/spotlight-ranking.html", import.meta.url),
    "utf8",
  );
  assert.match(template, /id="resolver-autoplay"[^>]*checked/);
  assert.match(template, /id="resolver-advanced"[^>]*class="resolver-advanced"/);
  assert.match(template, /id="resolver-hud"[^>]*hidden/);
  assert.match(template, /id="resolver-tie-order"[^>]*type="hidden"[^>]*value="seeded"/);
  assert.match(template, /id="resolver-policy"[^>]*type="hidden"[^>]*value="row-sweep"/);
  assert.match(template, /id="resolver-reveal-highlight"/);
  assert.match(template, /id="resolver-reveal-hold"/);
  assert.match(template, /id="resolver-auto-scroll-automatic"/);
  assert.match(template, /id="resolver-auto-scroll-manual"/);
  assert.equal(template.includes("data-resolver-preset"), false);
  assert.match(template, /id="resolver-snapshot-warning"[^>]*role="region"/);
  assert.match(template, /id="resolver-snapshot-mode"/);
  assert.match(template, /id="resolver-snapshot-generated"/);
  assert.match(template, /id="resolver-snapshot-refresh"[^>]*type="button"/);
});

test("presenter toolbar exposes common actions and uses an accessible icon-only overflow", async () => {
  const template = await readFile(
    new URL("../../../templates/contest/spotlight-ranking.html", import.meta.url),
    "utf8",
  );
  const primaryGroup = template.match(
    /<div class="resolver-toolbar__group">([\s\S]*?)<\/div>\s*<div class="resolver-toolbar__group">/,
  )?.[1];
  const overflowPanel = template.match(
    /<div class="resolver-toolbar__more-panel">([\s\S]*?)<\/div>/,
  )?.[1];

  assert.ok(primaryGroup);
  assert.match(primaryGroup, /id="resolver-play"/);
  assert.match(primaryGroup, /id="resolver-back"/);
  assert.match(primaryGroup, /id="resolver-next"/);
  assert.match(primaryGroup, /id="resolver-reset"/);
  assert.match(primaryGroup, /id="resolver-change-setup"/);
  assert.match(primaryGroup, /id="resolver-fullscreen"/);
  assert.match(primaryGroup, /id="resolver-hide-controls"/);
  assert.match(template, /id="resolver-show-controls"[\s\S]*?hidden/);
  assert.match(template, /<dt>C<\/dt>/);
  assert.ok(overflowPanel);
  assert.match(overflowPanel, /id="resolver-forward"/);
  assert.match(overflowPanel, /id="resolver-replay"/);
  assert.match(overflowPanel, /id="resolver-toggle-hud"/);
  assert.match(overflowPanel, /id="resolver-help"/);
  assert.doesNotMatch(overflowPanel, /id="resolver-next"|id="resolver-change-setup"/);
  assert.match(template, /aria-label="\{\{ _\('More actions'\) \}\}"/);
  assert.match(template, /title="\{\{ _\('More actions'\) \}\}"/);
  assert.match(template, /<span aria-hidden="true">⋯<\/span>/);
  assert.doesNotMatch(template, /\{\{ _\('More'\) \}\}/);

  const page = await readFile(new URL("../page.js", import.meta.url), "utf8");
  assert.match(page, /this\.nodes\.setupSubmit\.disabled = false/);
  assert.match(page, /estimateServerNow/);
  assert.doesNotMatch(page, /Date\.now\(\)/);
  assert.doesNotMatch(page, /if \(this\.session\) \{\s*return;\s*\}/);
});

test("dynamic Resolver rendering does not inject translated or user data as HTML", async () => {
  const [page, bootstrap] = await Promise.all([
    readFile(new URL("../page.js", import.meta.url), "utf8"),
    readFile(new URL("../bootstrap.js", import.meta.url), "utf8"),
  ]);
  assert.equal(page.includes("innerHTML"), false);
  assert.equal(page.includes("insertAdjacentHTML"), false);
  assert.equal(bootstrap.includes("innerHTML"), false);
  assert.match(page, /document\.createTextNode/);
});

test("problem and contestant bulk controls use one semantic batch operation", async () => {
  const page = await readFile(new URL("../page.js", import.meta.url), "utf8");
  assert.match(page, /dataset\.resolverAction = "reveal-problem"/);
  assert.match(page, /getResolvableCellsForProblem/);
  assert.match(page, /getResolvableCellsForContestant/);
  assert.match(page, /session\.revealBatch\(targets\)/);
  assert.match(page, /ManualActionCoordinator/);
  assert.match(page, /event\.target\.closest\("\[data-resolver-secondary-link\]"\)/);
});

test("contestant name is the reveal action and profile navigation is an explicit secondary link", async () => {
  const page = await readFile(new URL("../page.js", import.meta.url), "utf8");
  assert.match(page, /"strong",\s*"resolver-contestant__handle"/s);
  assert.match(page, /profileLink\.dataset\.resolverSecondaryLink = "profile"/);
  assert.match(page, /type: "contestant"/);
  assert.equal(page.includes('element("a", "resolver-contestant__handle"'), false);
});

test("ranking renders with stable participation rows instead of rebuilding the table body", async () => {
  const page = await readFile(new URL("../page.js", import.meta.url), "utf8");
  assert.match(page, /this\.rowElements = new Map\(\)/);
  assert.match(page, /this\.rowElements\.get\(contestantId\)/);
  assert.match(page, /_reorderTableBody\(\[\.\.\.rows, this\._updateTotals\(stats\)\]\)/);
  assert.equal(page.includes("tableBody.replaceChildren(...rows"), false);
});
