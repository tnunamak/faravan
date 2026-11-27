// The public half of the key that signs release manifests (update.json). An install
// verifies every manifest against it and never installs anything it cannot verify.
// packaging/apt/README.md says how the key is made and where the private half lives.
// The private key is never in this repository.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAB1aQT1bCZPnpunV9unOuKRndyCAPu2Znl+bxTzOaGKY=
-----END PUBLIC KEY-----
`; // an Ed25519 public key in PEM (SPKI) form
