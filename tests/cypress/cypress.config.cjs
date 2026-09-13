// Run from the extension root, one instance at a time, after checking the E2E pool:
//   npx cypress run --browser chrome --config-file tests/cypress/cypress.config.cjs
// The specs load the built webview through the layout fixture, so `npm run build` comes first.
module.exports = {
  e2e: {
    specPattern: "tests/cypress/**/*.cy.cjs",
    supportFile: false,
    video: false,
    screenshotOnRunFailure: false,
    viewportHeight: 900,
  },
};
