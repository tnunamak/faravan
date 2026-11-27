// The product's name, as one constant. Telemetry copy, env names and CLI help read it, so a rename edits this file.
// Wire names never use the brand (docs/design/TELEMETRY-WIRE.md), so a rename changes no stored data.
// envPrefix names the variables read first. The legacy variables are named where they are read (telemetry/switch.mjs),
// because the web UI bundles this file and the bundle should carry only the current brand.
export const PRODUCT = Object.freeze({name: 'Faravan', slug: 'faravan', envPrefix: 'FARAVAN'});
