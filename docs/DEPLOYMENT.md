# Deployment

GitHub Actions. Both repositories keep their existing three-OS release gates.
Bridge produces ZIP, digest, build and protocol fixtures. Extension verifies the
pair and owns marketplace deployment. No rebuild during publication.

## Configure once

- Set real publisher/public URLs. Keep versions and pinned Bridge contract aligned.
- Configure repository remotes. Enable Actions. Run both three-OS gate workflows.
- Extension repository secret: `BRIDGE_ARTIFACT_READ_TOKEN`, Actions read on Bridge.
- Extension environment: `marketplace`. Restrict deployment branches to release branches.
  Assign the release owner as environment reviewer if repository policy requires it.
- VS Code variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`. Entra application or managed
  identity needs Marketplace publisher access. Federated credential subject:
  `repo:OWNER/REPOSITORY:environment:marketplace`; audience `api://AzureADTokenExchange`.
- Chrome variables: `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`.
- Chrome secrets: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, authorized
  for `https://www.googleapis.com/auth/chromewebstore`. Store in GitHub; never source.
- Create the Chrome item and complete store listing, privacy and distribution settings.
  Browser sign-in alone does not configure CI credentials.

Authentication: [VS Code publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
[Azure login](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended),
[Chrome API setup](https://developer.chrome.com/docs/webstore/using-api).

## Release sequence

1. Bridge: run `Release artifact`. Keep successful run ID.
2. Extension: run `Paired release verification`, phase `candidate`, with the Bridge
   repository and run ID. It runs the source gates and retains `candidate-vsix-ATTEMPT`.
3. Download that VSIX and the exact Bridge ZIP. Complete artifact acceptance and bound
   records. Human owns `## Verdict` in `RELEASE_VERDICT.md`; deployment requires `**SHIP...**`.
   Commit evidence records without modifying packaged source or rebuilding the VSIX.
4. Run `Paired release verification`, phase `verify`. Supply the same Bridge run plus
   candidate run ID and attempt. It downloads the tested VSIX, checks its bytes against
   the current build and verifies bound evidence. It never repackages in this phase.
5. On success, download `approved-release-ATTEMPT`. Contains exact VSIX, Bridge ZIP,
   human verdict and SHA-256 manifest. Inspect before deployment.
6. Run `Publish marketplaces` at the verification commit. Supply paired verification
   run ID and attempt. Default target `both`; `bridge` or `vscode` resumes a partial release.

Publication accepts only successful paired workflow attempts from this repository
at the deployment commit. No branch-head rebuild, automatic version bump, tag or push.
VS Code uses the locked VSCE with `--packagePath` and Entra authentication.
Chrome uses [v2 upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
then [publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publish).
Upload completion is polled with a fixed bound. Review is never skipped.

Chrome `PENDING_REVIEW` means submitted, not publicly available. The two stores do
not publish atomically. After any ambiguous network failure, check store state
before retrying; never blindly resubmit. Workflow logs must not expose tokens.

## Artifacts and cleanup

Working-directory ZIP snapshots are not release inputs. Use `source:export` and
`source:verify` for source archives. Keep dependencies, build output and local test
output ignored. Keep the exact verified release ZIP/VSIX until deployment and
artifact acceptance finish. Actions retains approved release sets for 90 days.

## Activation still required

Local workflow validation does not prove hosted delivery. Repository destination,
account configuration, exact-artifact acceptance and a successful hosted run remain
required. Open work: [TODO](../TODO.md). Current verdict: [release verdict](RELEASE_VERDICT.md).
