// Public site config. The client id is not a secret.
// Never put a client secret in this file. Setup steps are in the README.
window.WORKBENCH_CONFIG = {
  owner: "serinshen",
  repo: "bird-workbench",
  branch: "main",
  oauthClientId: "",
  redirectUri: "https://serinshen.github.io/bird-workbench/",
  // Origin of oauth/worker.js, with no path.
  // Example: "https://bird-workbench.example.workers.dev"
  tokenExchangeUrl: "",
  scope: "public_repo",
};
