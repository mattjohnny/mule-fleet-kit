# Changelog

## 0.4.1 — proposed, unreleased

This patch is prepared for owner review. It does not authorize a merge, tag,
publication, or consumer update. Distribution continues through immutable GitHub
refs serving committed `dist/`; no npm-registry publication is proposed.

- An exactly empty `RATE_LIMIT_PROBE_KEY` now disables the optional probe and
  emits the existing safe warning while caller attribution and rate limits
  remain active. Whitespace-only and other nonempty keys shorter than 32
  characters after trimming still refuse startup. Valid-key authorization,
  trimming, proxy-conflict refusal, and log privacy remain intact. This is the
  already merged [D23 fix, PR 5](https://github.com/mattjohnny/mule-fleet-kit/pull/5).
- Includes the already merged [development dependency follow-up, PR 4](https://github.com/mattjohnny/mule-fleet-kit/pull/4).
  Express remains a public `>=4` peer; the development Express 5 dependency does
  not upgrade an application's Express runtime.
- Retains the strict mutation gate and the withdrawn September 7 proof history
  documented in the README. No new runtime API or consumer policy is introduced.

Proposed release basis: `6a5cfc3fa1a5a786e270c6862bcdaae36ef6d384`, plus
this version/changelog preparation. After approval, the new `v0.4.1` tag must
point to the final reviewed, merged commit containing version 0.4.1. Recheck
that exact commit and committed distribution before tagging; do not retarget
`v0.4.0` (`75f96ecdd9a8ca623b97408823c8496713993217`).

After the tag exists, each consumer needs explicit manifest and lock re-resolution
to the accepted commit, installed-package and app verification, and separately
authorized deployment acceptance. Portal must declare the accepted 40-character
commit directly in both its manifest and resolved lock entry. Jobs 32 and
Training Days STAB-17 stay open until their release and consumer proof is filed.
