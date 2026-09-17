# GitHub Platform Governance

This document records the intended GitHub-level controls around HUQAN. It complements repository code and CI; it does not replace them.

## Repository features

The repository uses:

- Issues for reproducible defects and scoped engineering work;
- Discussions for questions and exploratory design conversations;
- Projects for planning and execution views;
- Wiki for long-form orientation and operator/developer documentation;
- Actions for test, architecture, benchmark, security, conformance, launch-smoke, publishing, and governance checks;
- Releases for tagged public artifacts;
- Dependabot for dependency update automation.

## Main branch ruleset target

`main` should be protected by a repository ruleset with, at minimum:

- pull request required before merge;
- force pushes blocked;
- branch deletion blocked;
- required status checks for the controlling test/security/architecture/conformance/package checks;
- branch required to be up to date before merge where the selected checks depend on current `main`;
- conversation resolution required before merge when review threads exist;
- bypass kept minimal and explicit.

The exact required-check names must be copied from live successful checks. Do not guess names from workflow filenames.

## Release tag ruleset target

Release tags matching `v*` should be protected from deletion or non-fast-forward replacement once published. Release authority remains defined by the publish workflow and package/version/tag binding.

## Security target

- GitHub Private Vulnerability Reporting enabled where available;
- CodeQL / code scanning retained;
- dependency review and audit workflows retained;
- secret scanning / push protection enabled where the repository/account tier supports them;
- Dependabot alerts and security updates enabled where available;
- Actions workflow permissions kept least-privilege.

## Release environment

The `npm-publish` environment is part of release authority. It should remain narrowly scoped to the publish workflow. If GitHub environment protection rules are available, production publishing should require the intended ref/tag boundary and no unrelated workflow should receive publication authority.

## Pull request policy

Repository PRs should use `.github/PULL_REQUEST_TEMPLATE.md` and preserve these invariants when relevant:

- a proposing model cannot approve its own governed mutation;
- unknown or malformed security-sensitive input fails closed;
- receipt/provenance integrity is not weakened;
- workspace/path/authority boundaries remain explicit;
- public surface changes include compatibility and release impact.

## Issue routing

- bugs -> Bug report form;
- bounded capabilities -> Feature request form;
- questions and early design -> Discussions;
- sensitive vulnerabilities -> private vulnerability process in `SECURITY.md`.

## Audit rule

GitHub UI settings are live configuration and may drift from this document. When they disagree, inspect the live repository settings and current Actions behavior before making a claim.
